import { NextResponse } from "next/server";
import { db } from "@/db";
import { tickets, ticketItems, cafeTables, menuItems } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { DEFAULT_CATEGORY_ROUTING } from "@/lib/initial-data";
import { effectivePrice } from "@/lib/price";
import { eq, asc, desc, and, notInArray, inArray } from "drizzle-orm";
import { deleteOrphanedCdnImages, persistImageRef } from "@/lib/image-store";
import { requireStaffOrAdmin, requireAdmin } from "@/lib/session";
import { publish, CHANNELS } from "@/lib/realtime";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

const CUSTOMER_ORDER_LIMIT = 30;
const CUSTOMER_ORDER_WINDOW_MS = 10 * 60 * 1000;

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
 */
const TICKET_STATUS_TRANSITIONS: Record<string, string[]> = {
  pending_waiter: ["confirmed", "cancelled"],
  confirmed: ["preparing", "ready_for_payment", "cancelled"],
  preparing: ["ready_for_payment", "cancelled"],
  ready_for_payment: ["completed", "cancelled"],
  completed: ["paid", "cancelled"],
  paid: [],
  cancelled: [],
};

/** Payment status is separate from order status (food done ≠ paid). */
const PAYMENT_STATUSES = ["unpaid", "paid_cash", "paid_telebirr", "paid_cbe", "paid_card"] as const;

/** Payment methods this cafe records. "online" kept for legacy rows. */
const PAYMENT_METHODS = ["cash", "telebirr", "cbe", "card", "online"] as const;

// GET: ?active=1 → active tickets (with items); ?all=1 → everything
//      ?paid=1&limit=N → ONLY the N most recent PAID tickets, WITHOUT items —
//      the lightweight payload for the cashier's "Recently Paid" panel
//      (history cards render only table/method/total, so items are wasted bytes).
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
    const limit = Math.min(200, Math.max(1, Number(searchParams.get("limit") || 100)));

    let list;
    if (activeOnly) {
      list = await db.select().from(tickets).where(notInArray(tickets.status, ["paid", "cancelled"])).orderBy(desc(tickets.updatedAt));
    } else if (paidOnly) {
      // Only the most recent paid bills — no items, no receipt, small response.
      list = await db.select().from(tickets).where(eq(tickets.status, "paid")).orderBy(desc(tickets.updatedAt)).limit(limit);
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
    const needItems = !paidOnly;

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

    const result = slim.map((t) => ({
      ...t,
      receiptImage: null, // keep field defined so clients know it needs fetching on demand
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
  try {
    const body = await request.json();
    const { tableId, items, waiterName, source } = body;

    // Public customers may submit orders (source === "customer") → these become
    // `pending_waiter` and must be confirmed by staff. Any other source (waiter
    // submitting as "confirmed") is a staff action and requires an authenticated
    // staff/admin session — so a public request cannot impersonate a waiter.
    const isCustomer = source === "customer";
    if (isCustomer) {
      const rl = checkRateLimit(`customer-order:${getClientIp(request)}`, CUSTOMER_ORDER_LIMIT, CUSTOMER_ORDER_WINDOW_MS);
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

    const transactionResult = await db.transaction(async (tx) => {
    // ── IDEMPOTENCY CHECK (Group 1) ──
    // A retry/double-tap of the SAME submission must never duplicate the order.
    // If the first item of this submission is already recorded, the whole order
    // was already applied → return it unchanged (the kitchen won't cook twice).
    if (idemKey) {
      const keyRow = await tx
        .select({ ticketId: ticketItems.ticketId })
        .from(ticketItems)
        .where(eq(ticketItems.idempotencyKey, idemProbe))
        .limit(1);
      if (keyRow.length > 0) {
        const existing = await tx.select().from(tickets).where(eq(tickets.id, keyRow[0].ticketId)).limit(1);
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
      .where(and(eq(tickets.tableId, Number(tableId)), notInArray(tickets.status, ["paid", "cancelled"])));

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
            .where(and(eq(tickets.tableId, Number(tableId)), notInArray(tickets.status, ["paid", "cancelled"])))
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

    for (const it of items) {
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
      it.price = priceById.get(menuId);
      it.quantity = qty;
    }

    // Insert the submission's items. If a CONCURRENT duplicate of this exact
    // submission already inserted rows, the UNIQUE index on (ticket_id, key)
    // rejects ours → we return the already-recorded bill instead.
    try {
      for (let idx = 0; idx < items.length; idx++) {
        const it = items[idx];
        const catSlug = String(it.category || "").toLowerCase();
        const stationName = routing[catSlug] || "kitchen";
        await tx.insert(ticketItems).values({
          ticketId,
          menuItemId: it.menuItemId ?? null,
          name: it.name,
          category: it.category || "",
          price: Number(it.price),
          quantity: Number(it.quantity || 1),
          notes: it.notes || "",
          stationName,
          stationStatus: "pending",
          idempotencyKey: idemKey ? `${idemKey}#${idx}` : null,
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
    if (body.status === "paid" || body.status === "cancelled") updates.closedAt = new Date();
    // Record WHO confirmed the order (waiter or cashier accepting a customer QR
    // order). Only the confirmed transition stamps this, so it never overwrites
    // the original createdBy or the later verifiedBy.
    if (body.status === "confirmed") {
      updates.confirmedBy = body.confirmedBy ? String(body.confirmedBy).slice(0, 100) : cur.confirmedBy || "(staff)";
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
