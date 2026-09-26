import { isCashierOrderLocked, CORRECTION_LOCK_MESSAGE } from "@/lib/cashier-corrections";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { tickets, ticketItems, cafeTables, menuItems, announcements, orderSubmissions, siteSettings, ticketEvents } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { DEFAULT_CATEGORY_ROUTING } from "@/lib/initial-data";
import { effectivePrice } from "@/lib/price";
import { eq, asc, desc, and, notInArray, inArray, sql, gt, gte, lt, isNotNull, isNull, or } from "drizzle-orm";
import { deleteOrphanedCdnImages, persistImageRef } from "@/lib/image-store";
import { requireStaffOrAdmin, requireAdmin, readStaffSession } from "@/lib/session";
import { publish, CHANNELS } from "@/lib/realtime";
import { checkSharedIpRateLimit, VENUE_POLICIES } from "@/lib/rate-limit";
import { calculateDailyPromotionLinePrices, isDailyPromotionOrderable, parseDailyPromotion } from "@/lib/daily-promotion";
import { canMergeLines } from "@/lib/order-lines";
import { recordTicketEvent, summarizeSubmissionLines } from "@/lib/ticket-audit";
import { sendPushToRoles, CUSTOMER_ALERT_RING } from "@/lib/push";
import { ticketStatusAlerts, withoutActor } from "@/lib/alerts";
import { stationForOrder, stationOf, type StationName } from "@/lib/stations";
import { isBillSent } from "@/lib/order-release";
import { etStartOfToday, etStartOfCalendarDay } from "@/lib/timezone";
import { nextGroupNumberToday, nextGroupNumberInTx, groupLabel } from "@/lib/group-orders";

/**
 * Customer order limits are TWO-TIER (per table + per venue) because every guest
 * in the room arrives through the SAME public IP — café WiFi NAT or a mobile
 * carrier's CGNAT — so a plain per-IP cap would limit the whole restaurant
 * instead of one person, and at lunch time real guests would get HTTP 429 and be
 * unable to order. Numbers: `VENUE_POLICIES.customerOrder`.
 */

/** A folded line may never grow past this (defensive; a single submission is capped at 100). */
const MAX_MERGED_LINE_QUANTITY = 999;

/**
 * Is the `order_submissions` table usable? Checked ONCE per process, OUTSIDE any
 * transaction (a failed statement would poison the transaction it ran in). If an
 * old database somehow never got the Group 8 migration, ordering keeps working
 * exactly as before — the submission record is simply skipped and the legacy
 * per-item idempotency probe still guards against duplicates.
 */
let submissionsTableUsable: boolean | null = null;
let submissionsProbedAt = 0;
/** A failed probe is retried this often — a late migration needs no restart. */
const SUBMISSIONS_REPROBE_MS = 60_000;

async function canRecordSubmissions(): Promise<boolean> {
  if (submissionsTableUsable === true) return true;
  if (submissionsTableUsable === false && Date.now() - submissionsProbedAt < SUBMISSIONS_REPROBE_MS) {
    return false;
  }
  try {
    await db.execute(sql`SELECT 1 FROM order_submissions LIMIT 1`);
    submissionsTableUsable = true;
  } catch {
    submissionsTableUsable = false;
    submissionsProbedAt = Date.now();
  }
  return submissionsTableUsable;
}

function normalizeOrderType(value: unknown): "dine_in" | "outdoor" {
  return String(value || "dine_in").toLowerCase() === "outdoor" ? "outdoor" : "dine_in";
}

function normalizeServiceNote(value: unknown): string | null {
  const note = String(value || "").trim().slice(0, 500);
  return note ? note : null;
}

function normalizeOutdoorTableName(label: unknown): string {
  const trimmed = String(label || "").trim().replace(/\s+/g, " ");
  if (!trimmed) return "OUTDOOR";
  // GROUP bills are numbered by the SERVER (see @/lib/group-orders), so a
  // label that already says GROUP is passed through untouched.
  const prefixed = /^(outdoor|group)\b/i.test(trimmed) ? trimmed : `OUTDOOR • ${trimmed}`;
  return prefixed.slice(0, 50);
}

function outdoorTableId(): number {
  // Synthetic table id for outdoor tickets. MUST stay inside the Postgres
  // `integer` (int32) range of tickets.table_id: a timestamp-based id
  // (~1.8e15) overflowed the column and failed EVERY outdoor insert with
  // "integer out of range" — the cashier only ever saw "Could not submit
  // order. Please call your waiter." Negative ids can never collide with real
  // cafe_tables rows (serials start at 1); a freak collision between two
  // ACTIVE outdoor tickets is retried with a fresh id (see POST below).
  return -(1_000_000 + Math.floor(Math.random() * 2_140_000_000));
}

function actorRoleOf(source: string, orderType: "dine_in" | "outdoor"): string {
  if (source === "customer") return "customer";
  if (orderType === "outdoor") return "cashier";
  return "waiter";
}

// The transaction client and the root Drizzle client share the query methods used here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function recomputeTotal(client: any, ticketId: number) {
  const items = await client.select().from(ticketItems).where(and(eq(ticketItems.ticketId, ticketId), eq(ticketItems.removed, false)));
  const total = items.reduce((s: number, i: { price: number; quantity: number }) => s + i.price * i.quantity, 0);
  await client.update(tickets).set({ totalAmount: total, updatedAt: new Date() }).where(eq(tickets.id, ticketId));
  return total;
}

/**
 * Allowed ticket status transitions (Group 1) — prevents accidental, skipped or
 * backwards moves (e.g. paid → preparing, or double-paid). Same-status updates are
 * allowed as an idempotent no-op; paid/cancelled are terminal.
 *
 * GROUP 9 (print-queue mode) adds the Fana workflow:
 *   confirmed → printed  (cashier keyed the bill into the EFD/POS and printed)
 *   printed  → closed    (waiter physically cleared the table — bill closed,
 *                         table free; payment itself lives in the EFD/POS world)
 * Full-payment deployments simply never send these two transitions.
 */
const TICKET_STATUS_TRANSITIONS: Record<string, string[]> = {
  pending_waiter: ["confirmed", "cancelled"],
  confirmed: ["preparing", "ready_for_payment", "printed", "cancelled"],
  printed: ["closed", "cancelled"],
  // "closed" is also reachable from the classic mid-flow states so a deployment
  // that switches to print-queue mode never traps bills that were already in
  // flight (the owner's EFD/POS stays the money record either way).
  preparing: ["ready_for_payment", "closed", "cancelled"],
  ready_for_payment: ["completed", "closed", "cancelled"],
  completed: ["paid", "closed", "cancelled"],
  paid: [],
  cancelled: [],
};

/** Statuses that mean "this bill is finished — the table can be re-seated". */
const INACTIVE_TICKET_STATUSES = ["paid", "cancelled", "closed"] as const;

/** Payment status is separate from order status (food done ≠ paid). */
const PAYMENT_STATUSES = ["unpaid", "paid", "paid_cash", "paid_telebirr", "paid_cbe", "paid_card"] as const;

/** Payment methods this cafe records. "online" kept for legacy rows. */
const PAYMENT_METHODS = ["cash", "telebirr", "cbe", "card", "online"] as const;

// GET: ?active=1 → active tickets (with items); ?all=1 → everything
//      ?paid=1&limit=N → ONLY the N most recent PAID tickets, WITHOUT items —
//      the lightweight payload for the cashier's "Recently Paid" panel
//      (history cards render only table/method/total, so items are wasted bytes).
//      ?printedToday=1 → every bill with printedAt TODAY (any status: printed,
//      later closed), newest print first, WITH items (cards expand to the bill
//      detail). "Printed Today" is the cashier's daily cross-check against the
//      EFD receipt count, so it must count HER action (the print) — a bill
//      enters the list the moment she taps ✓ PRINTED, not when the waiter
//      clears the table, and cleared bills STAY (they were printed today).
//      ?printedDate=YYYY-MM-DD → the same list for ANY OTHER day, so the
//      cashier can also open "Printed Yesterday" (late-night cross-checks,
//      morning shift hand-over) — same rules, just a different calendar day.
//      ?finished=1&limit=N → legacy finished-bills query (paid OR closed by
//      table-clear); kept for older clients/tests.
// TRAFFIC FIX: list responses EXCLUDE receipt photos (they're heavy base64 polygons).
// Receipts are fetched on-demand via /api/tickets/receipt?id=X when someone clicks "View Receipt".
export async function GET(request: Request) {
  const __auth = await requireStaffOrAdmin();
  if (!__auth.ok) return __auth.response;
  await ensureTablesExist();
  try {
    const { searchParams } = new URL(request.url);
    const activeOnly = searchParams.get("active") === "1";
    const paidOnly = searchParams.get("paid") === "1";
    const finishedOnly = searchParams.get("finished") === "1";
    // "Printed Today": bills keyed into the EFD since ETHIOPIAN midnight (see
    // @/lib/timezone) — old bills can never pollute the cashier's daily
    // cross-check, and a bill printed today stays today even after the waiter
    // clears the table (it is still printed; it is not lost).
    const printedTodayOnly = searchParams.get("printedToday") === "1";
    // "Printed Yesterday" (or any past day): same window, different date.
    const printedDateParam = searchParams.get("printedDate");
    const limit = Math.min(200, Math.max(1, Number(searchParams.get("limit") || 100)));

    // GROUP ORDERS: the waiter's composer asks "what will the next group
    // number be?" so it can show "This will be Group 8" before sending. The
    // number the SERVER assigns at send time is the truth; this is a display
    // prediction only.
    if (searchParams.get("nextGroup") === "1") {
      return NextResponse.json({ nextGroup: await nextGroupNumberToday() });
    }

    // ONE BILL BY ID (owner, Sept 2026): a released bill — a dine-in bill the
    // cashier printed, or a table that turned over — is deliberately absent
    // from ?active=1, yet staff still have to OPEN it: the waiter confirms the
    // lines a guest added to a bill she already sent, the cashier confirms the
    // same lines on her screen, and the waiter keeps serving a table whose
    // bill was printed minutes ago. ?id=<ticket> returns exactly that bill
    // with its items, whatever its release state.
    const oneTicketId = Number(searchParams.get("id") || 0);
    if (oneTicketId > 0) {
      const rows = await db.select().from(tickets).where(eq(tickets.id, oneTicketId)).limit(1);
      if (rows.length === 0) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
      const oneItems = await db.select().from(ticketItems).where(eq(ticketItems.ticketId, oneTicketId)).orderBy(asc(ticketItems.id));
      const one = { ...rows[0] } as Record<string, unknown>;
      delete one.receiptImage;
      return NextResponse.json([
        { ...one, receiptImage: null, unprintedSubmissions: 0, unprintedCustomerSubmissions: 0, unprintedStaffSubmissions: 0, items: oneItems },
      ]);
    }

    let list;
    if (activeOnly) {
      list = await db.select().from(tickets).where(notInArray(tickets.status, [...INACTIVE_TICKET_STATUSES])).orderBy(desc(tickets.updatedAt));
    } else if (paidOnly) {
      // Only the most recent paid bills — no items, no receipt, small response.
      list = await db.select().from(tickets).where(eq(tickets.status, "paid")).orderBy(desc(tickets.updatedAt)).limit(limit);
    } else if (printedTodayOnly || printedDateParam) {
      // Every bill printed on the given ETHIOPIAN calendar day (default:
      // today), printed → later closed, newest print first. CANCELLED bills
      // are excluded: a voided order is not a sale and must never sit in her
      // cross-check pile. Cards carry items so a tap expands the full bill.
      // ?printedDate=YYYY-MM-DD moves the window to that EAT calendar day
      // ("Printed Yesterday"); an invalid date simply keeps today.
      const dateMatch = printedDateParam ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(printedDateParam) : null;
      const startOfToday = dateMatch
        ? etStartOfCalendarDay(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]))
        : etStartOfToday();
      const endOfDay = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
      list = await db
        .select()
        .from(tickets)
        .where(and(isNotNull(tickets.printedAt), gte(tickets.printedAt, startOfToday), lt(tickets.printedAt, endOfDay), notInArray(tickets.status, ["cancelled"])))
        .orderBy(desc(tickets.printedAt));
    } else if (finishedOnly) {
      // Print-queue history: closed bills (table cleared) + paid bills, newest first.
      list = await db.select().from(tickets).where(inArray(tickets.status, ["paid", "closed"])).orderBy(desc(tickets.updatedAt)).limit(limit);
    } else {
      list = await db.select().from(tickets).orderBy(desc(tickets.updatedAt)).limit(limit);
    }

    // list WITHOUT the receiptImage column (heavy payload), kept for CSV missing fallback key
    const slim = list.map((t) => {
      const clone: Record<string, unknown> = { ...t };
      delete clone.receiptImage;
      return clone;
    });

    // Paid/finished-history cards render only table/method/total (no items);
    // the Printed Today cards EXPAND to the full bill, so they carry items.
    const needItems = !paidOnly && !finishedOnly;

    // PERFORMANCE: only fetch items for the tickets being returned — never the
    // whole ticket_items table (it grows forever). Group by ticketId once.
    const ticketIds = slim.map((t) => (t as { id: number }).id);
    const items = needItems && ticketIds.length > 0
      ? await db.select().from(ticketItems).where(inArray(ticketItems.ticketId, ticketIds)).orderBy(asc(ticketItems.id))
      : [];

    const itemsByTicket = new Map<number, typeof items>();
    for (const it of items) {
      if (!itemsByTicket.has(it.ticketId)) itemsByTicket.set(it.ticketId, []);
      itemsByTicket.get(it.ticketId)!.push(it);
    }

    // GROUP 9 (print-queue): count order submissions accepted AFTER the cashier's
    // last print. > 0 → this printed bill received additions → the cashier queue
    // re-shows the card as "TABLE X — ADDED" so she prints the bill again (the
    // old paper world's "print a second receipt and hand the guest two papers").
    // Submissions are used (not items) because a folded line updates an existing
    // item row without inserting anything, while every submission records a row.
    const unprintedByTicket = new Map<number, number>();
    const unprintedCustomerByTicket = new Map<number, number>();
    const unprintedStaffByTicket = new Map<number, number>();
    if (needItems) {
      const printedIds = slim
        .filter((t) => (t as { printedAt?: string | Date | null }).printedAt)
        .map((t) => (t as { id: number }).id);
      if (printedIds.length > 0) {
        try {
          const counted = await db
            .select({
              ticketId: orderSubmissions.ticketId,
              source: orderSubmissions.source,
              n: sql<number>`count(*)::int`,
            })
            .from(orderSubmissions)
            .innerJoin(tickets, eq(tickets.id, orderSubmissions.ticketId))
            .where(
              and(
                inArray(orderSubmissions.ticketId, printedIds),
                isNotNull(tickets.printedAt),
                gt(orderSubmissions.createdAt, tickets.printedAt)
              )
            )
            .groupBy(orderSubmissions.ticketId, orderSubmissions.source);
          for (const row of counted) {
            const count = Number(row.n) || 0;
            unprintedByTicket.set(row.ticketId, (unprintedByTicket.get(row.ticketId) || 0) + count);
            if (row.source === "customer") {
              unprintedCustomerByTicket.set(row.ticketId, (unprintedCustomerByTicket.get(row.ticketId) || 0) + count);
            } else {
              unprintedStaffByTicket.set(row.ticketId, (unprintedStaffByTicket.get(row.ticketId) || 0) + count);
            }
          }
        } catch {
          // order_submissions missing on a very old DB → additions flag simply
          // stays 0; the queue itself keeps working (same graceful mode as POST).
        }
      }
    }

    const result = slim.map((t) => ({
      ...t,
      receiptImage: null, // keep field defined so clients know it needs fetching on demand
      unprintedSubmissions: unprintedByTicket.get((t as { id: number }).id) || 0,
      unprintedCustomerSubmissions: unprintedCustomerByTicket.get((t as { id: number }).id) || 0,
      unprintedStaffSubmissions: unprintedStaffByTicket.get((t as { id: number }).id) || 0,
      items: itemsByTicket.get((t as { id: number }).id) || [],
    }));

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST: customer (QR) or waiter submits order — creates new ticket OR merges into active ticket for that table
// customer source → pending_waiter; waiter source → confirmed
export async function POST(request: Request) {
  // Kept OUTSIDE the try so the concurrency backstop at the bottom can identify a
  // raced duplicate submission even after its transaction rolled back.
  let racedKey = "";
  try {
    const body = await request.json();
    racedKey = body?.idempotencyKey ? String(body.idempotencyKey).slice(0, 64) : "";
    const { tableId, items, waiterName, source } = body;
    const orderType = normalizeOrderType(body?.orderType);
    const serviceNote = normalizeServiceNote(body?.serviceNote);
    const outdoorLabel = normalizeOutdoorTableName(body?.outdoorLabel || body?.tableName);

    // Public customers may submit orders (source === "customer") → these become
    // `pending_waiter` and must be confirmed by staff. Any other source (waiter
    // submitting as "confirmed") is a staff action and requires an authenticated
    // staff/admin session — so a public request cannot impersonate a waiter.
    const isCustomer = source === "customer";
    if (isCustomer) {
      const rl = checkSharedIpRateLimit("customer-order", request, Number(tableId) || 0, VENUE_POLICIES.customerOrder);
      if (!rl.allowed) {
        return NextResponse.json(
          { error: "Too many order attempts. Please wait a few minutes and try again." },
          { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } }
        );
      }
    }
    if (!isCustomer) {
      const __auth = await requireStaffOrAdmin();
      if (!__auth.ok) return __auth.response;
    }
    if (isCustomer && orderType === "outdoor") {
      return NextResponse.json({ error: "Outdoor orders are entered by staff only" }, { status: 403 });
    }
    // WHO is really sending? For staff submissions the SESSION decides the
    // audit role — a WAITER sending a group order must be recorded as the
    // waiter (the old guess said "cashier" for every outdoor order, which was
    // only true for the cashier's own outdoor composer).
    const senderSession = !isCustomer ? await readStaffSession() : null;
    // GROUP ORDERS (owner's decision, Sept 2026): chairs get dragged around,
    // different peoples share one table, some sit with no table at all. The
    // billing unit is the GROUP OF PEOPLE: the waiter's composer sends
    // groupOrder: true and the SERVER stamps the bill "GROUP <n>" (numbered
    // daily, never reused) — the client can never pick or forge a number.
    const isGroupOrder = orderType === "outdoor" && body?.groupOrder === true;

    await ensureTablesExist();
    // Idempotency key: unique per submission, generated client-side. Same key =
    // same submission → replays are returned as-is, never re-applied.
    const idemKey = body.idempotencyKey ? String(body.idempotencyKey).slice(0, 64) : "";
    // Each ITEM row stores a derived key (<key>#<index>) so the UNIQUE index on
    // (ticket_id, idempotency_key) accepts every row of one submission while still
    // rejecting a second insert of the same submission. The first row's derived
    // key (<key>#0) is the canonical "has this submission been recorded?" probe.
    const idemProbe = idemKey ? `${idemKey}#0` : "";

    if (!items || items.length === 0) {
      return NextResponse.json({ error: "Items required" }, { status: 400 });
    }
    // Outdoor orders live outside the real table grid, so they get their own
    // synthetic ticket/table id. Dine-in orders still require a real table.
    // `let` because an outdoor unique-violation retry draws a fresh id.
    let tableIdNum = orderType === "outdoor" ? outdoorTableId() : Number(tableId);
    if (orderType !== "outdoor" && (!Number.isInteger(tableIdNum) || tableIdNum <= 0)) {
      return NextResponse.json({ error: "Valid table required" }, { status: 400 });
    }

    const initialStatus = isCustomer ? "pending_waiter" : "confirmed";
    const recordSubmissions = idemKey ? await canRecordSubmissions() : false;

    const runSubmission = () =>
      db.transaction(async (tx) => {
    // ── IDEMPOTENCY CHECK (Group 1, extended by Group 8) ──
    // A retry/double-tap of the SAME submission must never duplicate the order.
    // Two records are checked, either of which proves the submission was applied:
    //   (a) `order_submissions` — the submission itself. This is the one that
    //       still works when every line of the submission was FOLDED into an
    //       existing row (Group 8) and therefore inserted no item rows at all.
    //   (b) the legacy per-item key `<key>#0` — submissions recorded before (a)
    //       existed, and any order placed while (a) was unavailable.
    if (idemKey) {
      let recordedTicketId: number | null = null;
      if (recordSubmissions) {
        const subRow = await tx
          .select({ ticketId: orderSubmissions.ticketId })
          .from(orderSubmissions)
          .where(eq(orderSubmissions.idempotencyKey, idemKey))
          .limit(1);
        recordedTicketId = subRow[0]?.ticketId ?? null;
      }
      if (recordedTicketId === null) {
        const keyRow = await tx
          .select({ ticketId: ticketItems.ticketId })
          .from(ticketItems)
          .where(eq(ticketItems.idempotencyKey, idemProbe))
          .limit(1);
        recordedTicketId = keyRow[0]?.ticketId ?? null;
      }
      if (recordedTicketId !== null) {
        const existing = await tx.select().from(tickets).where(eq(tickets.id, recordedTicketId)).limit(1);
        if (existing.length > 0) {
          const replayItems = await tx
            .select()
            .from(ticketItems)
            .where(eq(ticketItems.ticketId, existing[0].id))
            .orderBy(asc(ticketItems.id));
          return {
            ticket: existing[0],
            items: replayItems,
            total: existing[0].totalAmount,
            merged: false,
            duplicate: true,
          };
        }
      }
    }

    const tableRows = orderType === "outdoor"
      ? []
      : await tx.select().from(cafeTables).where(eq(cafeTables.id, Number(tableId)));
    // The table must really exist: a QR code for a deleted table (or a forged
    // id) must never create a phantom bill that no board shows while the
    // kitchen still cooks it.
    if (orderType !== "outdoor" && tableRows.length === 0) {
      return NextResponse.json({ error: "This table is no longer available. Please call your waiter." }, { status: 400 });
    }
    let tableName = orderType === "outdoor" ? outdoorLabel : tableRows[0].name;

    // One active bill per real table — outdoor orders are always their own
    // ticket, so they never merge into another outdoor run. ONE exception
    // (group orders, Sept 2026): a staff submission may aim at ONE open
    // outdoor bill (`targetTicketId`), so the waiter can add another round to
    // the same group's bill instead of printing a new one per round. The
    // target must itself be outdoor and still active; anything else simply
    // falls through to a fresh ticket.
    //
    // PRINT FREES THE TABLE (owner's decision, Sept 2026): a dine-in bill the
    // cashier already printed is finished for the floor, so it is NOT the
    // table's open bill any more: the next guest (or the waiter keying at the
    // table) opens a brand new bill instead of adding to a printed one. That is
    // the whole point of the cashier's tap clearing the table, because once the
    // EFD receipt went out nobody can tell which bill a late item belongs to.
    const targetTicketId = Number(body?.targetTicketId) || 0;
    const activeTickets = orderType === "outdoor"
      ? targetTicketId > 0
        ? await tx
            .select()
            .from(tickets)
            .where(
              and(
                eq(tickets.id, targetTicketId),
                eq(tickets.orderType, "outdoor"),
                notInArray(tickets.status, [...INACTIVE_TICKET_STATUSES])
              )
            )
        : []
      : await tx
          .select()
          .from(tickets)
          .where(
            and(
              eq(tickets.tableId, tableIdNum),
              notInArray(tickets.status, [...INACTIVE_TICKET_STATUSES]),
              // A printed dine-in bill no longer occupies its table.
              or(eq(tickets.orderType, "outdoor"), isNull(tickets.printedAt))
            )
          );

    let ticketId: number;
    const actorName = waiterName || (isCustomer ? "Customer (QR)" : "Waiter");
    const actorRole = senderSession?.role || actorRoleOf(String(source || ""), orderType);

    if (activeTickets.length > 0) {
      ticketId = activeTickets[0].id;
      // Another round on a group bill: the SERVER-side label of the target
      // wins, whatever the client may have sent.
      if (isGroupOrder) tableName = activeTickets[0].tableName;
      // customer adding more items before waiter confirmation → keep pending_waiter
      // waiter adding more items to confirmed bill → stays confirmed; if at payment stage → move back to confirmed
      const cur = activeTickets[0];
      if (!isCustomer && cur.status === "ready_for_payment") {
        await tx.update(tickets).set({ status: "confirmed" }).where(eq(tickets.id, ticketId));
      }
    } else {
      // A NEW group bill takes its number under the advisory lock, so two
      // waiters creating groups in the same instant still get consecutive
      // numbers (never the same one twice).
      if (isGroupOrder) tableName = groupLabel(await nextGroupNumberInTx(tx));
      try {
        const created = await tx
          .insert(tickets)
          .values({
            tableId: tableIdNum,
            tableName,
            orderType,
            serviceNote,
            status: initialStatus,
            totalAmount: 0,
            createdBy: waiterName || (isCustomer ? "Customer (QR)" : "Waiter"),
          })
          .returning();
        ticketId = created[0].id;
        // Guaranteed-unique order number — derived from the DB serial (FANA-<id>),
        // never random, so collisions are impossible by construction.
        await tx
          .update(tickets)
          .set({ orderNumber: `FANA-${ticketId}` })
          .where(eq(tickets.id, ticketId));
      } catch (err) {
        // Outdoor tickets each get their OWN bill and must never merge into
        // another ticket: a unique violation here can only be a freak
        // synthetic-id collision, which the whole-transaction retry below
        // resolves with a fresh id — so rethrow without the dine-in fallback.
        if (orderType === "outdoor") throw err;
        // GROUP 5 — one-active-bill-per-table is enforced by a partial UNIQUE
        // index. If a CONCURRENT first order for this table won the race, our
        // insert is rejected (23505) → fall back to merging into that bill
        // instead of creating a second active ticket for the same table.
        const pgErr = (err as { code?: string; cause?: { code?: string } }) ?? {};
        if (pgErr.code === "23505" || pgErr.cause?.code === "23505") {
          const existing = await tx
            .select()
            .from(tickets)
            .where(
              and(
                eq(tickets.tableId, tableIdNum),
                notInArray(tickets.status, [...INACTIVE_TICKET_STATUSES]),
                // A printed dine-in bill no longer occupies its table.
                or(eq(tickets.orderType, "outdoor"), isNull(tickets.printedAt))
              )
            )
            .limit(1);
          if (existing.length > 0) {
            ticketId = existing[0].id;
          } else {
            throw err; // not a duplicate-active-ticket error → surface it
          }
        } else {
          throw err;
        }
      }
    }

    // Read category → station routing (owner-configured in admin, fallback to defaults)
    let routing: Record<string, "barista" | "kitchen" | "juice"> = DEFAULT_CATEGORY_ROUTING;
    try {
      const { siteSettings } = await import("@/db/schema");
      const { eq: eqSet } = await import("drizzle-orm");
      const rows = await tx.select().from(siteSettings).where(eqSet(siteSettings.key, "category_routing"));
      if (rows.length > 0 && rows[0].value) routing = JSON.parse(rows[0].value);
    } catch {
      /* fallback to defaults */
    }

    // ── PRICE & QUANTITY INTEGRITY (server-side authority) ──
    // The client sends menuItemId; the authoritative unit price is resolved
    // from the menu server-side (including active sale pricing via
    // effectivePrice) and quantities are validated, so a manipulated client —
    // including an anonymous POST to the public customer endpoint — cannot
    // submit negative/arbitrary prices or absurd quantities that would corrupt
    // bills, revenue, and reports.
    const orderedMenuIds: number[] = [];
    const seenIds = new Set<number>();
    for (const it of items) {
      const mid = Number(it.menuItemId);
      if (Number.isFinite(mid) && mid > 0 && !seenIds.has(mid)) {
        seenIds.add(mid);
        orderedMenuIds.push(mid);
      }
    }
    const menuRows =
      orderedMenuIds.length > 0
        ? await tx.select().from(menuItems).where(inArray(menuItems.id, orderedMenuIds))
        : [];
    const priceById = new Map(menuRows.map((m) => [m.id, effectivePrice(m).price]));
    // Which ordered items are TRADITIONAL BUNA: those leave the category
    // routing entirely and are made by the buna makers at their own place.
    const bunaById = new Map(menuRows.map((m) => [m.id, Boolean(m.isBuna)]));
    // Per-item station override (owner's "Extra Things" fix, Sept 2026): a
    // coffee cup is the barista's, a take away bag is the kitchen's — the
    // override wins over the category routing, null = follow the routing.
    const overrideById = new Map(menuRows.map((m) => [m.id, (m.stationOverride as string | null) ?? null]));

    // ── DAILY PROMOTION INTEGRITY ──
    // The browser may name a Daily Board promotion, but it can never choose its
    // menu items, quantities, active period, or price. Those are re-read from
    // the announcement here before a normal ticket is created.
    const promotionPayloadIndexes = new Map<number, number[]>();
    for (let payloadIndex = 0; payloadIndex < items.length; payloadIndex++) {
      const it = items[payloadIndex];
      const hasPromotionId = it.promotionId !== undefined && it.promotionId !== null && it.promotionId !== "";
      const hasPromotionItemIndex = it.promotionItemIndex !== undefined && it.promotionItemIndex !== null && it.promotionItemIndex !== "";
      if (!hasPromotionId) {
        if (hasPromotionItemIndex) return NextResponse.json({ error: "Invalid daily promotion item" }, { status: 400 });
        continue;
      }
      const promotionId = Number(it.promotionId);
      if (!Number.isInteger(promotionId) || promotionId < 1) {
        return NextResponse.json({ error: "Invalid daily promotion" }, { status: 400 });
      }
      const indexes = promotionPayloadIndexes.get(promotionId) || [];
      indexes.push(payloadIndex);
      promotionPayloadIndexes.set(promotionId, indexes);
    }

    const promotionLineByPayloadIndex = new Map<number, { title: string; unitPrices: number[] }>();
    const promotionIds = [...promotionPayloadIndexes.keys()];
    if (promotionIds.length > 0) {
      const promotionRows = await tx.select().from(announcements).where(inArray(announcements.id, promotionIds));
      const promotionById = new Map(promotionRows.map((promotion) => [promotion.id, promotion]));

      for (const [promotionId, payloadIndexes] of promotionPayloadIndexes) {
        const announcement = promotionById.get(promotionId);
        const promotion = announcement ? parseDailyPromotion(announcement.promotionItems) : null;
        if (!announcement || !promotion || !isDailyPromotionOrderable(promotion, announcement)) {
          return NextResponse.json({ error: "This daily promotion is not currently available" }, { status: 409 });
        }
        if (payloadIndexes.length !== promotion.items.length) {
          return NextResponse.json({ error: "Promotion items no longer match this offer" }, { status: 409 });
        }

        let linePrices;
        try {
          linePrices = calculateDailyPromotionLinePrices(promotion, (menuItemId) => priceById.get(menuItemId) ?? -1);
        } catch {
          return NextResponse.json({ error: "Promotion menu items are no longer available" }, { status: 409 });
        }

        const usedPromotionItemIndexes = new Set<number>();
        for (const payloadIndex of payloadIndexes) {
          const it = items[payloadIndex];
          const promotionItemIndex = Number(it.promotionItemIndex);
          if (
            !Number.isInteger(promotionItemIndex) ||
            promotionItemIndex < 0 ||
            promotionItemIndex >= promotion.items.length ||
            usedPromotionItemIndexes.has(promotionItemIndex)
          ) {
            return NextResponse.json({ error: "Promotion items no longer match this offer" }, { status: 409 });
          }
          usedPromotionItemIndexes.add(promotionItemIndex);

          const configuredItem = promotion.items[promotionItemIndex];
          if (Number(it.menuItemId) !== configuredItem.menuItemId || Number(it.quantity) !== configuredItem.quantity) {
            return NextResponse.json({ error: "Promotion items no longer match this offer" }, { status: 409 });
          }
          promotionLineByPayloadIndex.set(payloadIndex, { title: announcement.title, unitPrices: linePrices[promotionItemIndex].unitPrices });
        }
      }
    }

    // Expand promotion lines into their authoritative unit-price entries. This
    // preserves an exact integer combo total even where a configured item has a
    // quantity greater than one, while the resulting ticket remains standard
    // ticket_items for the existing kitchen/cashier/waiter workflow.
    const ticketRows: Array<{ menuItemId: number; name: string; category: string; price: number; quantity: number; notes: string }> = [];
    for (let payloadIndex = 0; payloadIndex < items.length; payloadIndex++) {
      const it = items[payloadIndex];
      const qty = Number(it.quantity);
      if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty < 1 || qty > 100) {
        return NextResponse.json({ error: `Invalid quantity for "${it.name}"` }, { status: 400 });
      }
      const menuId = Number(it.menuItemId);
      const menuRow = menuRows.find((m) => m.id === menuId);
      if (!Number.isFinite(menuId) || menuId <= 0 || !menuRow) {
        return NextResponse.json({ error: `Unknown menu item "${it.name}"` }, { status: 400 });
      }
      if (!menuRow.isAvailable) {
        return NextResponse.json({ error: `Menu item "${it.name}" is currently out of stock` }, { status: 409 });
      }

      const promotionLine = promotionLineByPayloadIndex.get(payloadIndex);
      // A client-supplied price (including 0) is always overwritten. Promotion
      // prices are only the unit prices calculated from trusted DB data above.
      it.price = priceById.get(menuId);
      it.quantity = qty;
      if (!promotionLine) {
        // The NAME and CATEGORY come from the menu row, never from the client:
        // a phone holding a cached menu could otherwise store a stale name on
        // the bill — or worse, route the line to the wrong crew through an
        // outdated category. (Prices were already server-side; this closes the
        // same hole for the other two fields the crews and bills read.)
        ticketRows.push({ menuItemId: menuId, name: menuRow.name, category: menuRow.category, price: Number(it.price), quantity: qty, notes: it.notes || "" });
        continue;
      }

      const customerNotes = String(it.notes || "").trim().slice(0, 500);
      const notes = [`Daily special: ${promotionLine.title}`, customerNotes].filter(Boolean).join(" • ");
      for (const unitPrice of promotionLine.unitPrices) {
        ticketRows.push({ menuItemId: menuId, name: menuRow.name, category: menuRow.category, price: unitPrice, quantity: 1, notes });
      }
    }

    // ── GROUP 8: fold a repeated dish into the line already on the bill ──
    // Ordering tea, then ordering tea again ten minutes later used to leave the
    // bill reading "1 Tea, 1 Sandwich, 1 Tea" on the waiter, cashier, kitchen and
    // receipt screens. Identical lines that the crew has NOT started yet are now
    // added to the existing row instead (canMergeLines is the single rule, and it
    // keeps Daily Board offer lines, removed lines and already-accepted/done lines
    // separate on purpose).
    //
    // RELEASE GATE (owner's decision, Sept 2026): a line may only ever fold into
    // a row with the SAME release state. A guest top-up on a bill that was
    // already sent must NOT silently grow a line the kitchen already has: the
    // new units wait for staff confirmation, so they get their own held row
    // (and a held top-up folds into the earlier held one). Staff keying stays
    // instant, so it folds into released rows exactly like before.
    const billAlreadySent = activeTickets.length > 0 && isBillSent(activeTickets[0]);
    const holdNewLines = isCustomer && billAlreadySent;
    const mergeCandidates =
      activeTickets.length > 0
        ? await tx
            .select()
            .from(ticketItems)
            .where(
              and(
                eq(ticketItems.ticketId, ticketId),
                eq(ticketItems.removed, false),
                eq(ticketItems.stationStatus, "pending")
              )
            )
        : [];
    let mergedLineCount = 0;

    // Insert the submission's items. If a CONCURRENT duplicate of this exact
    // submission already inserted rows, the UNIQUE index on (ticket_id, key)
    // rejects ours → we return the already-recorded bill instead.
    // submissionStations remembers which crews THIS submission fed, so the
    // instant-release push below rings exactly those crews — never a crew
    // with nothing new in it. Folded lines count too: growing a pending "2
    // Tea" to "4 Tea" is new work for that crew.
    const submissionStations = new Set<StationName>();
    try {
      for (let idx = 0; idx < ticketRows.length; idx++) {
        const it = ticketRows[idx];
        const catSlug = String(it.category || "").toLowerCase();
        // A menu item flagged "Traditional Buna" always goes to the BUNA crew,
        // whatever category it sits in; an item with a per-item override (e.g.
        // "Extra Things") goes to ITS crew; everything else follows the owner's
        // category routing (barista | kitchen | juice), defaulting to kitchen.
        const stationName = stationForOrder(
          routing,
          catSlug,
          bunaById.get(Number(it.menuItemId)) === true,
          overrideById.get(Number(it.menuItemId))
        );
        submissionStations.add(stationName);
        const incoming = {
          ticketId,
          menuItemId: it.menuItemId,
          name: it.name,
          price: Number(it.price),
          notes: it.notes || "",
          stationName,
          removed: false,
        };

        const target = mergeCandidates.find(
          (row) =>
            // Only fold into a row in the same release state (see above): a
            // held top-up never hides inside a line the crew already has.
            (row.released ?? true) === !holdNewLines &&
            canMergeLines(row, incoming) &&
            (Number(row.quantity) || 0) + it.quantity <= MAX_MERGED_LINE_QUANTITY
        );
        if (target) {
          const foldedQuantity = (Number(target.quantity) || 0) + it.quantity;
          // Keep the in-memory copy in sync so a second identical line in this
          // same submission folds into the same row rather than inserting a new one.
          target.quantity = foldedQuantity;
          await tx
            .update(ticketItems)
            .set({ quantity: foldedQuantity })
            .where(eq(ticketItems.id, target.id));
          mergedLineCount += 1;
          continue;
        }

        const inserted = await tx
          .insert(ticketItems)
          .values({
            ticketId,
            menuItemId: it.menuItemId,
            name: it.name,
            category: it.category || "",
            price: Number(it.price),
            quantity: it.quantity,
            notes: it.notes || "",
            stationName,
            stationStatus: "pending",
            // A guest top-up on an already-sent bill waits for the cashier's or
            // the waiter's confirmation before any station screen shows it.
            released: !holdNewLines,
            idempotencyKey: idemKey ? `${idemKey}#${idx}` : null,
          })
          .returning();
        if (inserted[0]) mergeCandidates.push(inserted[0]);
      }

      // Record the submission itself, so a retry is still recognised even when
      // every one of its lines was folded into an existing row above.
      if (recordSubmissions) {
        await tx.insert(orderSubmissions).values({
          ticketId,
          idempotencyKey: idemKey,
          source: isCustomer ? "customer" : "staff",
          waiterName: waiterName ? String(waiterName).slice(0, 100) : null,
          lines: ticketRows.length,
          mergedLines: mergedLineCount,
        });
      }
      if (activeTickets.length === 0) {
        await recordTicketEvent(tx, {
          ticketId,
          eventType: "ticket_created",
          actorName,
          actorRole,
          source: isCustomer ? "customer" : "staff",
          details:
            orderType === "outdoor"
              ? `Outdoor order created${serviceNote ? ` • ${serviceNote}` : ""}`
              : isCustomer
              ? "New QR order created"
              : "New staff order created",
        });
      }
      await recordTicketEvent(tx, {
        ticketId,
        eventType: "submission_added",
        actorName,
        actorRole,
        source: isCustomer ? "customer" : "staff",
        fromValue: mergedLineCount > 0 ? String(mergedLineCount) : null,
        toValue: String(ticketRows.length),
        details: summarizeSubmissionLines(ticketRows.map((line) => ({ name: line.name, quantity: line.quantity }))),
      });
    } catch (err) {
      throw err;
    }

    const total = await recomputeTotal(tx, ticketId);

    // A STAFF submission is SENT the moment it is placed: the waiter stood at
    // the table and read the order back to the guest, so there is nothing to
    // hold. The release stamp is written AFTER the item rows exist so the crew
    // push below finds every line. (A customer QR submission gets NO stamp —
    // it waits for an accept, and in print-queue mode the cashier's accept
    // only holds it until her CONFIRM & SEND.)
    if (!isCustomer && activeTickets.length === 0) {
      await tx.update(tickets).set({ confirmedAt: new Date() }).where(eq(tickets.id, ticketId));
      await recordTicketEvent(tx, {
        ticketId,
        eventType: "ticket_sent",
        actorName,
        actorRole,
        source: "staff",
        fromValue: "draft",
        toValue: orderType === "outdoor" ? "outdoor_sent" : "confirmed",
        details:
          orderType === "outdoor"
            ? `${senderSession?.role === "waiter" ? "Waiter" : "Cashier"} sent a new outdoor order to the stations`
            : "Waiter sent a new order to the stations",
      });
    }

    const finalTicket = await tx.select().from(tickets).where(eq(tickets.id, ticketId));
    return {
      ticket: finalTicket[0],
      total,
      merged: activeTickets.length > 0,
      // True when this submission added lines that are HELD from the stations
      // until staff confirm them (a guest top-up on an already-sent bill).
      held: holdNewLines,
      submissionStations: [...submissionStations] as StationName[],
    };
      });

    // Outdoor retry: two outdoor tickets drawing the same synthetic table id
    // (or a concurrent duplicate submission racing this one) fails the whole
    // transaction with a unique violation — and a rolled-back transaction
    // leaves nothing behind, so just run it again with a fresh id. The
    // idempotency probe at the top of the transaction keeps a retry from ever
    // duplicating the bill (a raced duplicate returns as `duplicate: true`).
    let transactionResult!: Awaited<ReturnType<typeof runSubmission>>;
    for (let attempt = 0; ; attempt++) {
      if (orderType === "outdoor" && attempt > 0) tableIdNum = outdoorTableId();
      try {
        transactionResult = await runSubmission();
        break;
      } catch (err) {
        const pgErr = (err as { code?: string; cause?: { code?: string } }) ?? {};
        const uniqueViolation =
          pgErr.code === "23505" ||
          pgErr.cause?.code === "23505" ||
          /duplicate key/i.test(String(err));
        if (orderType === "outdoor" && uniqueViolation && attempt + 1 < 5) continue;
        throw err;
      }
    }

    if (transactionResult instanceof NextResponse) return transactionResult;
    if (transactionResult.duplicate) {
      return NextResponse.json({
        ...transactionResult.ticket,
        items: transactionResult.items,
        totalAmount: transactionResult.total,
        merged: transactionResult.merged,
        duplicate: true,
      });
    }
    publish(CHANNELS.orders);

    // ── GROUP 10 (pocket mode): ring every relevant phone — including browsers
    // that are CLOSED. Fire-and-forget by design: a push outage must never
    // delay or fail an order.
    // RELEASE RULE (owner's decision, Sept 2026): the SEND releases the food,
    // never the print. A staff-sent new order is sent at creation, and food a
    // WAITER adds later to a SENT bill lands on the crew's list the same
    // second — the cashier, the waiter and every crew with new lines in this
    // submission are all rung at once. Only three bills keep the crews quiet:
    // a bill nobody accepted yet (pending_waiter — the waiter's job to
    // confirm), a HELD bill (the cashier accepted the QR order but has not
    // sent it — the guest may still add more, and the crews see none of it
    // until CONFIRM & SEND), and a guest top-up on an already-sent bill (the
    // new lines are HELD until the cashier or the waiter confirms them — see
    // ticket_items.released).
    //
    // WAITER TOP-UP ALARMS: a guest ordering from their phone hears nothing
    // from staff, so EVERY customer submission must ring the waiter — not just
    // the first one. A submission that merges into an existing bill (pending,
    // confirmed, printed, ...) rings the waiter on a DISTINCT per-event tag
    // (fana-qr-add-<ticket>-<submission>), because reusing the original
    // fana-qr-<id> tag would silently REPLACE the previous notification instead
    // of ringing as a new event. The cashier pushes below are UNCHANGED — she
    // keeps exactly the signals she already had. Staff-originated sends
    // (isCustomer false) ring nobody extra on the waiter side: the waiter
    // keying items herself already knows what she did — but the CREWS with new
    // lines are still rung, because a waiter keying a juice cannot shout it
    // across the room to the juice maker's tablet.
    {
      const pushed = transactionResult.ticket;
      const merged = transactionResult.merged;
      // Are this submission's lines held back from the stations?
      const holdNewLines = transactionResult.held === true;
      // One tag per submission: the idempotency key is unique per order submit
      // (legacy clients without one fall back to a timestamp, still unique).
      const additionTag = `fana-qr-add-${pushed.id}-${idemKey || Date.now()}`;
      if (isCustomer && pushed.status === "pending_waiter") {
        // Brand-new QR order AND top-ups on a still-pending bill: nobody has
        // confirmed them yet, so BOTH the waiter (who walks to the table) and
        // the cashier (who coordinates the room) must hear it — a guest's
        // order never reaches a station without a human confirmation. Merges
        // use the per-submission tag so each top-up rings as its own
        // notification.
        void sendPushToRoles(["waiter", "cashier"], {
          title: merged ? "🍽 Guest added items" : "🍽 New QR order",
          body: `${pushed.tableName} • ${transactionResult.total} ETB • tap to confirm`,
          tag: merged ? additionTag : `fana-qr-${pushed.id}`,
          // A GUEST just acted: 3 second alarm burst, hard vibration, and a
          // Confirm button right on the lock screen.
          ...CUSTOMER_ALERT_RING,
          ticketId: pushed.id,
          action: "confirm",
        }).catch(() => {});
      } else if (isCustomer && holdNewLines) {
        // A guest added to a bill that was ALREADY sent: the new lines wait on
        // the cashier's and the waiter's screens until one of them confirms
        // them to the stations (see ticket_items.released). The crews are NOT
        // rung here — there is nothing new on their lists yet, and the
        // confirmation below is what wakes them.
        void sendPushToRoles(["waiter", "cashier"], {
          title: "🍽 Guest added items",
          body: `${pushed.tableName} • confirm before the stations get them`,
          tag: additionTag,
          ...CUSTOMER_ALERT_RING,
          ticketId: pushed.id,
          action: "confirm",
        }).catch(() => {});
      } else {
        // INSTANT RELEASE: the crews already have these lines on their lists
        // (see station-items) — the cashier's card shows the new items only so
        // she keys just those into the EFD for receipt #2, but she is NOT the
        // gate for the kitchen anymore.
        if (pushed.status === "printed") {
          // Additions landed on a bill the cashier already keyed into the EFD —
          // she prints the second receipt for the NEW items only (her queue
          // card shows exactly those, never the whole bill again). The crews
          // were already rung for them below.
          void sendPushToRoles(["cashier"], {
            title: "⚠ Items ADDED",
            body: `${pushed.tableName} • new items on the bill, print receipt #2`,
            tag: `fana-add-${pushed.id}`,
            ...(isCustomer ? CUSTOMER_ALERT_RING : {}),
            ticketId: pushed.id,
          }).catch(() => {});
        } else if (pushed.status === "confirmed" && !pushed.confirmedAt && !pushed.printedAt) {
          // The bill is HELD: the cashier accepted the guest's QR order but has
          // not sent it yet. The guest adding more just grows the pile she will
          // release ONCE — nothing to print yet, and the crews still see none
          // of it, so only she is told.
          void sendPushToRoles(["cashier"], {
            title: "🍽 Guest added items",
            body: `${pushed.tableName} • held bill is now ${transactionResult.total} ETB • CONFIRM & SEND when they finish`,
            tag: `fana-hold-add-${pushed.id}`,
            ...(isCustomer ? CUSTOMER_ALERT_RING : {}),
            ticketId: pushed.id,
          }).catch(() => {});
        } else {
          void sendPushToRoles(["cashier"], {
            title: "🧾 To print",
            body: `${pushed.tableName} • ${transactionResult.total} ETB`,
            tag: `fana-print-${pushed.id}`,
          }).catch(() => {});
        }
        // Customer top-up merged into an existing bill → the waiter must hear
        // it too. Still-pending bill: her job is to go confirm. Confirmed or
        // printed bill: her job is to check the updated bill.
        if (isCustomer && merged) {
          void sendPushToRoles(["waiter"], {
            title: "🍽 Guest added items",
            body:
              pushed.status === "pending_waiter"
                ? `${pushed.tableName} • ${transactionResult.total} ETB • tap to confirm`
                : `${pushed.tableName} • guest added items • ${transactionResult.total} ETB`,
            tag: additionTag,
            // Same guest-grade alarm: she cannot predict a top-up either.
            ...CUSTOMER_ALERT_RING,
            ticketId: pushed.id,
            action: pushed.status === "pending_waiter" ? "confirm" : null,
          }).catch(() => {});
        }
      }
      // ── INSTANT-RELEASE CREW PUSH ──
      // The lines of THIS submission are already on the crew's lists. Ring
      // exactly the crews that received new work — a drinks-only top-up never
      // wakes the kitchen, and a held or still-pending bill rings nobody here
      // (there is nothing on their lists yet). A guest top-up on an
      // already-sent bill rings nobody either: it is HELD until staff confirm
      // it, and that confirmation is what wakes the crews. One tag per
      // submission, so each addition rings as its own event instead of
      // replacing the last one.
      try {
        const billSent = !!(pushed.confirmedAt || pushed.printedAt);
        const newStations = (transactionResult.submissionStations || []) as StationName[];
        if (!holdNewLines && billSent && pushed.status !== "pending_waiter" && newStations.length > 0) {
          const single = newStations.length === 1 ? newStations[0] : null;
          const title =
            single === "buna" ? "🫖 New buna"
            : single === "juice" ? "🧃 New juices"
            : single === "barista" ? "☕ New drinks"
            : single === "kitchen" ? "👨‍🍳 New items to cook"
            : "👨‍🍳 New items";
          void sendPushToRoles(newStations, {
            title,
            body: merged
              ? `${pushed.tableName} • added to the order • check your station list`
              : `${pushed.tableName} • new order • start now`,
            tag: `fana-station-add-${pushed.id}-${idemKey || Date.now()}`,
            urgent: true,
            // One ring per event: no route may pass a repeat above 0.
            repeat: 0,
          }).catch(() => {});
        }
      } catch {
        // A push hiccup must never fail an order submission.
      }
    }

    return NextResponse.json({ ...transactionResult.ticket, totalAmount: transactionResult.total, merged: transactionResult.merged });
  } catch (error) {
    // CONCURRENCY BACKSTOP (Group 8): two identical submissions raced and the
    // UNIQUE index on order_submissions rejected the second one. The first is
    // already on the bill, so return THAT bill instead of an error — the kitchen
    // still never cooks twice.
    const failure = String(error);
    if (racedKey && failure.includes("order_submissions") && (failure.includes("23505") || /duplicate key/i.test(failure))) {
      try {
        const recorded = await db
          .select({ ticketId: orderSubmissions.ticketId })
          .from(orderSubmissions)
          .where(eq(orderSubmissions.idempotencyKey, racedKey))
          .limit(1);
        const ticketId = recorded[0]?.ticketId;
        if (ticketId) {
          const ticket = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
          if (ticket.length > 0) {
            const items = await db
              .select()
              .from(ticketItems)
              .where(eq(ticketItems.ticketId, ticketId))
              .orderBy(asc(ticketItems.id));
            return NextResponse.json({
              ...ticket[0],
              items,
              totalAmount: ticket[0].totalAmount,
              merged: false,
              duplicate: true,
            });
          }
        }
      } catch {
        // fall through to the friendly error below
      }
    }

    // Never leak raw SQL/driver errors to customers (they were seeing strings
    // like "column idempotency_key does not exist"). Log the full detail
    // server-side and return one friendly, actionable message instead.
    console.error("[tickets POST] order submission failed:", error);
    return NextResponse.json(
      { error: "Could not submit order. Please call your waiter." },
      { status: 500 }
    );
  }
}

// PUT: update ticket status / payment method / receipt photo
export async function PUT(request: Request) {
  const __auth = await requireStaffOrAdmin();
  if (!__auth.ok) return __auth.response;
  await ensureTablesExist();
  // WHO is doing this? Used only to skip alerting the actor's own role: the
  // cashier tapping PRINTED must not make her own tablet ring.
  const actor = await readStaffSession();
  try {
    const body = await request.json();
    if (!body.id) return NextResponse.json({ error: "Ticket ID required" }, { status: 400 });

    const rows = await db.select().from(tickets).where(eq(tickets.id, Number(body.id)));
    if (rows.length === 0) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    const cur = rows[0];
    const actorName = actor?.name || (__auth.session.kind === "admin" ? "admin" : null);
    const actorRole = actor?.role || (__auth.session.kind === "admin" ? "admin" : null);
    const statusChanged = Boolean(body.status && body.status !== cur.status);

    // ── STATUS TRANSITION GUARD (Group 1) ──
    // Only allow the real workflow: pending_waiter → confirmed → preparing →
    // ready_for_payment → completed → paid (cancellable at any active step).
    // Prevents accidents like skipping states or double-marking paid.
    if (body.status && body.status !== cur.status) {
      const allowed = TICKET_STATUS_TRANSITIONS[cur.status] || [];
      if (!allowed.includes(body.status)) {
        return NextResponse.json(
          { error: `Cannot change order status from "${cur.status}" to "${body.status}"` },
          { status: 400 }
        );
      }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.status) updates.status = body.status;
    if (body.serviceNote !== undefined) updates.serviceNote = normalizeServiceNote(body.serviceNote);
    // Payment method is validated (GROUP 5) — only the methods this cafe actually
    // records may be stored; an invalid value is rejected instead of silently saved.
    if (body.paymentMethod !== undefined) {
      if (body.paymentMethod !== null && !PAYMENT_METHODS.includes(body.paymentMethod)) {
        return NextResponse.json({ error: "Invalid payment method" }, { status: 400 });
      }
      updates.paymentMethod = body.paymentMethod || null;
    }
    // Payment status is validated against the allowed set (independent of order status).
    if (body.paymentStatus !== undefined) {
      if (!PAYMENT_STATUSES.includes(body.paymentStatus)) {
        return NextResponse.json({ error: "Invalid payment status" }, { status: 400 });
      }
      updates.paymentStatus = body.paymentStatus;
    }
    // Receipt persistence and ticket update share one transaction so a failed
    // ticket write cannot leave a newly inserted image blob orphaned.
    let persistedReceipt: string | undefined;
    if (body.receiptImage !== undefined) persistedReceipt = String(body.receiptImage);
    if (body.status === "paid" || body.status === "cancelled" || body.status === "closed") updates.closedAt = new Date();

    // ── QR HOLD FLOW (owner's decision, Sept 2026) ──
    // When the CASHIER accepts a guest's QR order in print-queue mode she only
    // ACKNOWLEDGES it: the alarms stop on every device, but nothing goes to the
    // crews yet because the guest may still add more items. Her CONFIRM & SEND
    // tap (body.send) releases the bill; only then does the normal ✓ PRINTED
    // step appear. Everyone else who confirms — a waiter or a buna maker who
    // verified the order with the guest in person, or any confirmation while
    // the owner runs full-payment mode — still sends immediately, like before.
    const sendRequested = body.send === true;
    let holdAfterConfirm = false;
    if (body.status === "confirmed" && body.status !== cur.status && !sendRequested) {
      let cashierMode = "print-queue";
      try {
        const modeRows = await db.select().from(siteSettings).where(eq(siteSettings.key, "cashier_mode"));
        cashierMode = modeRows[0]?.value || "print-queue";
      } catch {
        /* unreadable setting → the default (print-queue) */
      }
      holdAfterConfirm = cashierMode === "print-queue" && actor?.role === "cashier";
    }

    // Record WHO confirmed the order (waiter or cashier accepting a customer QR
    // order). Only the confirmed transition stamps this, so it never overwrites
    // the original createdBy or the later verifiedBy.
    if (body.status === "confirmed") {
      updates.confirmedBy = body.confirmedBy ? String(body.confirmedBy).slice(0, 100) : cur.confirmedBy || "(staff)";
      // The crew's release stamp: everything on the bill right now goes to
      // every crew with lines on it (kitchen, barista, buna, juice). A HELD
      // accept (cashier, print-queue) deliberately skips it — the bill waits
      // for her CONFIRM & SEND below.
      if (!holdAfterConfirm) updates.confirmedAt = new Date();
    }
    // CONFIRM & SEND — the cashier's release tap on a held bill. Stamps the
    // release moment (and the acceptor, if nobody was recorded yet). Idempotent
    // by design: a bill that was already sent or printed keeps its original
    // stamp.
    if (sendRequested && !cur.confirmedAt && !cur.printedAt) {
      updates.confirmedAt = new Date();
      if (!updates.confirmedBy) {
        updates.confirmedBy = body.confirmedBy ? String(body.confirmedBy).slice(0, 100) : cur.confirmedBy || "(staff)";
      }
      // Sending an order nobody had accepted yet also accepts it.
      if (!updates.status && cur.status === "pending_waiter") updates.status = "confirmed";
    }
    // ── THE RELEASE GATE (owner's decision, Sept 2026) ──
    // A guest top-up on an already-sent bill is born HELD (ticket_items
    // .released = false): it waits on the cashier's and the waiter's screens
    // until one of them confirms it. THIS is that confirmation — the release
    // of a whole bill (a waiter's ✓ ACCEPT & SEND, or the cashier's
    // CONFIRM & SEND) also releases every held line on it, so the crews see
    // the complete bill in one go instead of half of it.
    const releasesTheBill =
      (body.status === "confirmed" && !holdAfterConfirm) || sendRequested;
    // GROUP 9 (print-queue): the cashier keyed the bill into the EFD/POS and
    // printed the order paper. Re-printing after additions simply refreshes the
    // stamp (same transition printed → printed is an idempotent no-op above).
    //
    // PRINT FREES THE TABLE (owner's decision, Sept 2026): for a DINE-IN bill
    // this tap is also the "table cleared" the waiters kept forgetting — the
    // floor boards show the table as free and the next guest opens a NEW bill,
    // so a late item can never land on a receipt that already went out. The
    // crews keep the bill on their lists until every line is finished (the
    // print is EFD audit only), and the bill closes itself once they are done.
    // Outdoor/group bills are exempt: a group takes more rounds on the same
    // bill, so their print stays a re-print.
    if (body.status === "printed") {
      updates.printedAt = new Date();
      updates.printedBy = body.printedBy ? String(body.printedBy).slice(0, 100) : cur.printedBy || "(cashier)";
    }
    // GROUP 9 (print-queue): the waiter physically cleared the table — the bill
    // is closed and the table becomes free. Payment is deliberately NOT touched:
    // the EFD/POS remains the financial system of record.
    if (body.status === "closed") {
      updates.closedBy = body.closedBy ? String(body.closedBy).slice(0, 100) : cur.closedBy || "(waiter)";
    }
    // GROUP 8 — guest or waiter asked for the bill; staff clear the
    // flag once the receipt has actually reached the table.
    if (body.receiptRequested === false || body.receiptRequested === null) {
      updates.receiptRequestedAt = null;
      updates.receiptRequestedBy = null;
    } else if (body.receiptRequested === true) {
      updates.receiptRequestedAt = new Date();
      updates.receiptRequestedBy = body.receiptRequestedBy
        ? String(body.receiptRequestedBy).slice(0, 100)
        : actorName || "staff";
    }

    // GROUP 5 — payment verification audit: record WHO marked the bill paid and
    // WHEN (the cashier's receipt-verification step for digital/card payments).
    // Only the paid transition stamps these; nothing else can overwrite them.
    if (body.status === "paid") {
      updates.verifiedBy = body.verifiedBy ? String(body.verifiedBy).slice(0, 100) : cur.verifiedBy || "(cashier)";
      updates.verifiedAt = new Date();
    }

    // Crews whose held lines this tap released (filled inside the transaction).
    let releasedStations: StationName[] = [];
    const updated = await db.transaction(async (tx) => {
      if (body.status === "cancelled" && __auth.session.kind === "staff" && actorRole === "cashier") {
        const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, cur.id)).for("update");
        const items = await tx.select().from(ticketItems).where(eq(ticketItems.ticketId, cur.id)).for("update");
        if (!ticket || isCashierOrderLocked({ ...ticket, items })) throw new Error(CORRECTION_LOCK_MESSAGE);
      }
      if (persistedReceipt !== undefined) updates.receiptImage = await persistImageRef(persistedReceipt, tx);
      const rows = await tx.update(tickets).set(updates).where(
        body.status && body.status !== cur.status
          ? and(eq(tickets.id, body.id), eq(tickets.status, cur.status))
          : eq(tickets.id, body.id)
      ).returning();

      // RELEASE THE HELD LINES (owner's decision, Sept 2026)
      // This tap released the bill (a waiter's ACCEPT & SEND, or the cashier's
      // CONFIRM & SEND), so every line a guest added while it was waiting is
      // released with it: the station screens pick the rows up on their next
      // refresh, exactly like the rest of the bill. Only rows still held are
      // touched, so this is safe to repeat.
      if (rows[0] && releasesTheBill) {
        const releasedRows = await tx
          .update(ticketItems)
          .set({ released: true })
          .where(and(eq(ticketItems.ticketId, rows[0].id), eq(ticketItems.released, false)))
          .returning({ stationName: ticketItems.stationName });
        releasedStations = [...new Set(releasedRows.map((r) => stationOf(r.stationName)))];
      }

      // Buna makers use their lane as a read-only request list. They do not tap
      // Accept or Done; once the cashier prints the EFD/order paper, the buna
      // request is considered cleared and leaves their dashboard. New buna
      // additions after a print are separate pending rows and clear on the next
      // print.
      if (rows[0] && body.status === "printed") {
        await tx
          .update(ticketItems)
          .set({
            stationStatus: "done",
            stationStatusBy: String(updates.printedBy || actorName || "(cashier)").slice(0, 100),
            stationStatusAt: new Date(),
            stationDoneBy: String(updates.printedBy || actorName || "(cashier)").slice(0, 100),
            stationDoneAt: new Date(),
          })
          .where(
            and(
              eq(ticketItems.ticketId, rows[0].id),
              eq(ticketItems.stationName, "buna"),
              eq(ticketItems.removed, false),
              sql`COALESCE(${ticketItems.stationStatus}, '') <> 'done'`
            )
          );
      }
      return rows;
    });

    if (!updated[0]) return NextResponse.json({ error: "Ticket was changed by another staff member. Refresh and try again." }, { status: 409 });

    // If the receipt photo was replaced/cleared, drop the old cdn_images row.
    if (body.receiptImage !== undefined) {
      await deleteOrphanedCdnImages([cur.receiptImage]);
    }

    try {
      if (sendRequested && !cur.confirmedAt && !cur.printedAt) {
        await recordTicketEvent(db, {
          ticketId: updated[0].id,
          eventType: "ticket_sent",
          actorName,
          actorRole,
          source: updated[0].orderType === "outdoor" ? "outdoor" : "staff",
          fromValue: cur.status,
          toValue: updated[0].status,
          details:
            updated[0].orderType === "outdoor"
              ? `Outdoor order released to the stations${updated[0].serviceNote ? ` • ${updated[0].serviceNote}` : ""}`
              : "Held bill released to the stations",
        });
      }
      if (statusChanged) {
        await recordTicketEvent(db, {
          ticketId: updated[0].id,
          eventType: "status_changed",
          actorName,
          actorRole,
          fromValue: cur.status,
          toValue: String(body.status),
          details: `Status changed from ${cur.status} to ${body.status}`,
        });
      }
      if (body.status === "printed") {
        await recordTicketEvent(db, {
          ticketId: updated[0].id,
          eventType: "ticket_printed",
          actorName,
          actorRole,
          fromValue: cur.printedAt ? "reprint" : "first_print",
          toValue: "printed",
          details:
            updated[0].orderType === "outdoor"
              ? "Cashier printed the outdoor order receipt"
              : cur.printedAt
              ? "Cashier re-printed the bill"
              : "Cashier printed the bill and cleared the table",
        });
      }
      if (releasedStations.length > 0) {
        await recordTicketEvent(db, {
          ticketId: updated[0].id,
          eventType: "additions_released",
          actorName,
          actorRole,
          source: "staff",
          fromValue: "held",
          toValue: "released",
          details: `Guest additions confirmed to the stations: ${releasedStations.join(", ")}`,
        });
      }
      if (body.receiptRequested === true) {
        await recordTicketEvent(db, {
          ticketId: updated[0].id,
          eventType: "bill_requested",
          actorName: String(updates.receiptRequestedBy || actorName || "waiter"),
          actorRole: actorRole ? String(actorRole) : "waiter",
          source: "staff",
          details: `Bill requested for ${updated[0].tableName} by ${String(updates.receiptRequestedBy || actorName || "waiter")}`,
        });
      }
    } catch {
      // The bill itself is already updated — never fail the workflow over audit logging.
    }

    // ── THE PRINT IS EFD AUDIT ONLY (instant release, owner's decision) ──
    // The crews already received every line the moment it was ordered (see the
    // POST instant-release push): a print must never re-ring them for food
    // they already have on their lists. The matrix below keeps printed and
    // preparing silent on purpose — the screens still update everywhere.

    // ── EVERY STATUS CHANGE RINGS THE ROLES THAT MUST REACT ──
    // Before, only the print/preparing moment pushed anyone, so a waiter with
    // her phone in a pocket never learned that a bill was confirmed, that the
    // guest was ready to pay, or that an order had been CANCELLED while the
    // kitchen was still cooking it. The matrix in @/lib/alerts covers the whole
    // workflow; the actor's own role is skipped so nobody rings themselves.
    //
    // QR HOLD FLOW: the SEND tap rings exactly the roles an acceptance used to
    // ring (the crews with lines on the bill, the cashier, the waiter). A HELD
    // accept rings NOBODY — there is nothing for anyone to do yet; every screen
    // updates and the guest alarm stops because the pending event is answered.
    const releasedBySend = sendRequested && !cur.confirmedAt && !cur.printedAt;
    const alertStatus = statusChanged ? String(body.status) : releasedBySend ? "confirmed" : null;
    if (alertStatus && !(alertStatus === "confirmed" && holdAfterConfirm)) {
      try {
        // WHICH CREWS DOES THIS BILL ACTUALLY INVOLVE? Accepting used to wake
        // every crew at once, so the kitchen was woken for a drinks-only table
        // and the buna makers for every macchiato. The release alert is now
        // built per crew that really has a line on the ticket — and so is the
        // cancellation alarm (a voided juice must not ring the kitchen).
        let billStations: StationName[] = [];
        if (alertStatus === "confirmed" || alertStatus === "cancelled") {
          const crewRows = await db
            .select({ stationName: ticketItems.stationName })
            .from(ticketItems)
            .where(and(eq(ticketItems.ticketId, updated[0].id), eq(ticketItems.removed, false)));
          billStations = [...new Set(crewRows.map((r) => stationOf(r.stationName)))];
        }
        const alerts = withoutActor(
          ticketStatusAlerts(alertStatus, {
            id: updated[0].id,
            tableName: updated[0].tableName,
            totalAmount: updated[0].totalAmount,
            orderNumber: updated[0].orderNumber,
            stations: billStations,
          }),
          actor?.role
        );
        for (const alert of alerts) {
          void sendPushToRoles(alert.roles, {
            title: alert.title,
            body: alert.body,
            tag: alert.tag,
            urgent: alert.urgent,
            repeat: alert.repeat,
          }).catch(() => {});
        }
      } catch {
        // An alert hiccup must never fail a status change.
      }
    }

    // GUEST ADDITIONS RELEASED (owner's decision, Sept 2026): staff just
    // confirmed the lines a guest added to an already-sent bill, so those
    // lines are on the crews' lists NOW. Ring exactly the crews that received
    // new work — a drinks-only top-up never wakes the kitchen. The status
    // alerts above already cover a whole-bill release, so this only fires for
    // the additions-only confirmation.
    if (releasedStations.length > 0) {
      try {
        const single = releasedStations.length === 1 ? releasedStations[0] : null;
        const title =
          single === "buna" ? "\u{1FAD6} New buna"
          : single === "juice" ? "\u{1F9C3} New juices"
          : single === "barista" ? "\u2615 New drinks"
          : single === "kitchen" ? "\u{1F468}\u200D\u{1F373} New items to cook"
          : "\u{1F468}\u200D\u{1F373} New items";
        void sendPushToRoles(releasedStations, {
          title,
          body: `${updated[0].tableName} • guest added items • check your station list`,
          tag: `fana-station-add-${updated[0].id}-${Date.now()}`,
          urgent: true,
          repeat: 0,
        }).catch(() => {});
      } catch {
        // A push hiccup must never fail a confirmation.
      }
    }

    publish(CHANNELS.orders);
    return NextResponse.json(updated[0]);
  } catch (error) {
    if (error instanceof Error && error.message === CORRECTION_LOCK_MESSAGE) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE: permanently erase a ticket/order (admin "Order History" tab only).
// This deletes financial records, so it must be ADMIN-only — a waiter/cashier
// must not be able to permanently delete bills/history.
export async function DELETE(request: Request) {
  const __auth = await requireAdmin();
  if (!__auth.ok) return __auth.response;
  await ensureTablesExist();
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });
    const existing = await db.select().from(tickets).where(eq(tickets.id, Number(id)));
    if (existing.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    // A LIVE bill can never be deleted: the crews may be cooking it this
    // second, and a vanished bill would leave ghost food and an EFD mismatch.
    // Only finished bills (paid, completed, closed, cancelled) may go — close
    // or cancel the bill first, then delete its history.
    if (!["paid", "completed", "closed", "cancelled"].includes(existing[0].status)) {
      return NextResponse.json({ error: "Only finished bills can be deleted. Close or cancel this bill first." }, { status: 400 });
    }
    await db.delete(ticketItems).where(eq(ticketItems.ticketId, Number(id)));
    await db.delete(orderSubmissions).where(eq(orderSubmissions.ticketId, Number(id)));
    await db.delete(ticketEvents).where(eq(ticketEvents.ticketId, Number(id)));
    await db.delete(tickets).where(eq(tickets.id, Number(id)));
    await deleteOrphanedCdnImages([existing[0].receiptImage]);
    publish(CHANNELS.orders);
    return NextResponse.json({ success: true, id: Number(id) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
