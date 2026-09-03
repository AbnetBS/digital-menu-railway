import { NextResponse } from "next/server";
import { db } from "@/db";
import { tickets, ticketItems, cafeTables, menuItems, announcements, orderSubmissions } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { DEFAULT_CATEGORY_ROUTING } from "@/lib/initial-data";
import { effectivePrice } from "@/lib/price";
import { eq, asc, desc, and, notInArray, inArray, sql, gt, isNotNull } from "drizzle-orm";
import { deleteOrphanedCdnImages, persistImageRef } from "@/lib/image-store";
import { requireStaffOrAdmin, requireAdmin } from "@/lib/session";
import { publish, CHANNELS } from "@/lib/realtime";
import { checkSharedIpRateLimit, VENUE_POLICIES } from "@/lib/rate-limit";
import { calculateDailyPromotionLinePrices, isDailyPromotionOrderable, parseDailyPromotion } from "@/lib/daily-promotion";
import { canMergeLines } from "@/lib/order-lines";

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
const PAYMENT_STATUSES = ["unpaid", "paid_cash", "paid_telebirr", "paid_cbe", "paid_card"] as const;

/** Payment methods this cafe records. "online" kept for legacy rows. */
const PAYMENT_METHODS = ["cash", "telebirr", "cbe", "card", "online"] as const;

// GET: ?active=1 → active tickets (with items); ?all=1 → everything
//      ?paid=1&limit=N → ONLY the N most recent PAID tickets, WITHOUT items —
//      the lightweight payload for the cashier's "Recently Paid" panel
//      (history cards render only table/method/total, so items are wasted bytes).
//      ?finished=1&limit=N → the N most recent FINISHED bills (paid OR closed
//      by table-clear) without items — the print-queue cashier's "Printed Today"
//      history. Closed bills never pass through "paid", so both count as done.
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
    const limit = Math.min(200, Math.max(1, Number(searchParams.get("limit") || 100)));

    let list;
    if (activeOnly) {
      list = await db.select().from(tickets).where(notInArray(tickets.status, [...INACTIVE_TICKET_STATUSES])).orderBy(desc(tickets.updatedAt));
    } else if (paidOnly) {
      // Only the most recent paid bills — no items, no receipt, small response.
      list = await db.select().from(tickets).where(eq(tickets.status, "paid")).orderBy(desc(tickets.updatedAt)).limit(limit);
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

    // Paid-history payload doesn't need items at all (cards show table/method/total only).
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
    if (needItems) {
      const printedIds = slim
        .filter((t) => (t as { printedAt?: string | Date | null }).printedAt)
        .map((t) => (t as { id: number }).id);
      if (printedIds.length > 0) {
        try {
          const counted = await db
            .select({ ticketId: orderSubmissions.ticketId, n: sql<number>`count(*)::int` })
            .from(orderSubmissions)
            .innerJoin(tickets, eq(tickets.id, orderSubmissions.ticketId))
            .where(
              and(
                inArray(orderSubmissions.ticketId, printedIds),
                isNotNull(tickets.printedAt),
                gt(orderSubmissions.createdAt, tickets.printedAt)
              )
            )
            .groupBy(orderSubmissions.ticketId);
          for (const row of counted) unprintedByTicket.set(row.ticketId, Number(row.n));
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

    await ensureTablesExist();
    // Idempotency key: unique per submission, generated client-side. Same key =
    // same submission → replays are returned as-is, never re-applied.
    const idemKey = body.idempotencyKey ? String(body.idempotencyKey).slice(0, 64) : "";
    // Each ITEM row stores a derived key (<key>#<index>) so the UNIQUE index on
    // (ticket_id, idempotency_key) accepts every row of one submission while still
    // rejecting a second insert of the same submission. The first row's derived
    // key (<key>#0) is the canonical "has this submission been recorded?" probe.
    const idemProbe = idemKey ? `${idemKey}#0` : "";

    if (!tableId || !items || items.length === 0) {
      return NextResponse.json({ error: "Table and items required" }, { status: 400 });
    }

    const initialStatus = isCustomer ? "pending_waiter" : "confirmed";
    const recordSubmissions = idemKey ? await canRecordSubmissions() : false;

    const transactionResult = await db.transaction(async (tx) => {
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

    const tableRows = await tx.select().from(cafeTables).where(eq(cafeTables.id, Number(tableId)));
    const tableName = tableRows[0]?.name || `Table ${tableId}`;

    // One active bill per table — merge items into it
    const activeTickets = await tx
      .select()
      .from(tickets)
      .where(and(eq(tickets.tableId, Number(tableId)), notInArray(tickets.status, [...INACTIVE_TICKET_STATUSES])));

    let ticketId: number;

    if (activeTickets.length > 0) {
      ticketId = activeTickets[0].id;
      // customer adding more items before waiter confirmation → keep pending_waiter
      // waiter adding more items to confirmed bill → stays confirmed; if at payment stage → move back to confirmed
      const cur = activeTickets[0];
      if (!isCustomer && cur.status === "ready_for_payment") {
        await tx.update(tickets).set({ status: "confirmed" }).where(eq(tickets.id, ticketId));
      }
    } else {
      try {
        const created = await tx
          .insert(tickets)
          .values({
            tableId: Number(tableId),
            tableName,
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
        // GROUP 5 — one-active-bill-per-table is enforced by a partial UNIQUE
        // index. If a CONCURRENT first order for this table won the race, our
        // insert is rejected (23505) → fall back to merging into that bill
        // instead of creating a second active ticket for the same table.
        const pgErr = (err as { code?: string; cause?: { code?: string } }) ?? {};
        if (pgErr.code === "23505" || pgErr.cause?.code === "23505") {
          const existing = await tx
            .select()
            .from(tickets)
            .where(and(eq(tickets.tableId, Number(tableId)), notInArray(tickets.status, [...INACTIVE_TICKET_STATUSES])))
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
    let routing: Record<string, "barista" | "kitchen"> = DEFAULT_CATEGORY_ROUTING;
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
        ticketRows.push({ menuItemId: menuId, name: it.name, category: it.category || "", price: Number(it.price), quantity: qty, notes: it.notes || "" });
        continue;
      }

      const customerNotes = String(it.notes || "").trim().slice(0, 500);
      const notes = [`Daily special: ${promotionLine.title}`, customerNotes].filter(Boolean).join(" — ");
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
    try {
      for (let idx = 0; idx < ticketRows.length; idx++) {
        const it = ticketRows[idx];
        const catSlug = String(it.category || "").toLowerCase();
        const stationName = routing[catSlug] || "kitchen";
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
    } catch (err) {
      throw err;
    }

    const total = await recomputeTotal(tx, ticketId);

    const finalTicket = await tx.select().from(tickets).where(eq(tickets.id, ticketId));
    return { ticket: finalTicket[0], total, merged: activeTickets.length > 0 };
    });

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
  try {
    const body = await request.json();
    if (!body.id) return NextResponse.json({ error: "Ticket ID required" }, { status: 400 });

    const rows = await db.select().from(tickets).where(eq(tickets.id, Number(body.id)));
    if (rows.length === 0) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    const cur = rows[0];

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
    // Record WHO confirmed the order (waiter or cashier accepting a customer QR
    // order). Only the confirmed transition stamps this, so it never overwrites
    // the original createdBy or the later verifiedBy.
    if (body.status === "confirmed") {
      updates.confirmedBy = body.confirmedBy ? String(body.confirmedBy).slice(0, 100) : cur.confirmedBy || "(staff)";
    }
    // GROUP 9 (print-queue): the cashier keyed the bill into the EFD/POS and
    // printed the order paper. Re-printing after additions simply refreshes the
    // stamp (same transition printed → printed is an idempotent no-op above).
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
    // GROUP 8 — the guest asked for the bill from their own phone; staff clear the
    // flag once the receipt has actually reached the table. This is the ONLY thing
    // a guest request can influence, and clearing it never moves the order status.
    if (body.receiptRequested === false || body.receiptRequested === null) {
      updates.receiptRequestedAt = null;
    }

    // GROUP 5 — payment verification audit: record WHO marked the bill paid and
    // WHEN (the cashier's receipt-verification step for digital/card payments).
    // Only the paid transition stamps these; nothing else can overwrite them.
    if (body.status === "paid") {
      updates.verifiedBy = body.verifiedBy ? String(body.verifiedBy).slice(0, 100) : cur.verifiedBy || "(cashier)";
      updates.verifiedAt = new Date();
    }

    let updated;
    if (persistedReceipt !== undefined) {
      updated = await db.transaction(async (tx) => {
        updates.receiptImage = await persistImageRef(persistedReceipt, tx);
        return tx.update(tickets).set(updates).where(
          body.status && body.status !== cur.status
            ? and(eq(tickets.id, body.id), eq(tickets.status, cur.status))
            : eq(tickets.id, body.id)
        ).returning();
      });
    } else {
      updated = await db.update(tickets).set(updates).where(
        body.status && body.status !== cur.status
          ? and(eq(tickets.id, body.id), eq(tickets.status, cur.status))
          : eq(tickets.id, body.id)
      ).returning();
    }

    if (!updated[0]) return NextResponse.json({ error: "Ticket was changed by another staff member. Refresh and try again." }, { status: 409 });

    // If the receipt photo was replaced/cleared, drop the old cdn_images row.
    if (body.receiptImage !== undefined) {
      await deleteOrphanedCdnImages([cur.receiptImage]);
    }

    publish(CHANNELS.orders);
    return NextResponse.json(updated[0]);
  } catch (error) {
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
    await db.delete(ticketItems).where(eq(ticketItems.ticketId, Number(id)));
    await db.delete(tickets).where(eq(tickets.id, Number(id)));
    if (existing.length > 0) await deleteOrphanedCdnImages([existing[0].receiptImage]);
    publish(CHANNELS.orders);
    return NextResponse.json({ success: true, id: Number(id) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
