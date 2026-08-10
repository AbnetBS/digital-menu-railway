import { NextResponse } from "next/server";
import { db } from "@/db";
import { tickets, ticketItems, cafeTables } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { DEFAULT_CATEGORY_ROUTING } from "@/lib/initial-data";
import { eq, asc, desc, and, notInArray, inArray } from "drizzle-orm";

async function recomputeTotal(ticketId: number) {
  const items = await db.select().from(ticketItems).where(and(eq(ticketItems.ticketId, ticketId), eq(ticketItems.removed, false)));
  const total = items.reduce((s, i) => s + i.price * i.quantity, 0);
  await db.update(tickets).set({ totalAmount: total, updatedAt: new Date() }).where(eq(tickets.id, ticketId));
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

// GET: ?active=1 → active tickets (with items); ?all=1 → everything
//      ?paid=1&limit=N → ONLY the N most recent PAID tickets, WITHOUT items —
//      the lightweight payload for the cashier's "Recently Paid" panel
//      (history cards render only table/method/total, so items are wasted bytes).
// TRAFFIC FIX: list responses EXCLUDE receipt photos (they're heavy base64 polygons).
// Receipts are fetched on-demand via /api/tickets/receipt?id=X when someone clicks "View Receipt".
export async function GET(request: Request) {
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
  await ensureTablesExist();
  try {
    const body = await request.json();
    const { tableId, items, waiterName, source } = body;
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

    const isCustomer = source === "customer";
    const initialStatus = isCustomer ? "pending_waiter" : "confirmed";

    // ── IDEMPOTENCY CHECK (Group 1) ──
    // A retry/double-tap of the SAME submission must never duplicate the order.
    // If the first item of this submission is already recorded, the whole order
    // was already applied → return it unchanged (the kitchen won't cook twice).
    if (idemKey) {
      const keyRow = await db
        .select({ ticketId: ticketItems.ticketId })
        .from(ticketItems)
        .where(eq(ticketItems.idempotencyKey, idemProbe))
        .limit(1);
      if (keyRow.length > 0) {
        const existing = await db.select().from(tickets).where(eq(tickets.id, keyRow[0].ticketId)).limit(1);
        if (existing.length > 0) {
          const replayItems = await db
            .select()
            .from(ticketItems)
            .where(eq(ticketItems.ticketId, existing[0].id))
            .orderBy(asc(ticketItems.id));
          return NextResponse.json({
            ...existing[0],
            items: replayItems,
            totalAmount: existing[0].totalAmount,
            merged: false,
            duplicate: true,
          });
        }
      }
    }

    const tableRows = await db.select().from(cafeTables).where(eq(cafeTables.id, Number(tableId)));
    const tableName = tableRows[0]?.name || `Table ${tableId}`;

    // One active bill per table — merge items into it
    const activeTickets = await db
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
        await db.update(tickets).set({ status: "confirmed" }).where(eq(tickets.id, ticketId));
      }
    } else {
      const created = await db
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
      await db
        .update(tickets)
        .set({ orderNumber: `FANA-${ticketId}` })
        .where(eq(tickets.id, ticketId));
    }

    // Read category → station routing (owner-configured in admin, fallback to defaults)
    let routing: Record<string, "barista" | "kitchen"> = DEFAULT_CATEGORY_ROUTING;
    try {
      const { siteSettings } = await import("@/db/schema");
      const { eq: eqSet } = await import("drizzle-orm");
      const rows = await db.select().from(siteSettings).where(eqSet(siteSettings.key, "category_routing"));
      if (rows.length > 0 && rows[0].value) routing = JSON.parse(rows[0].value);
    } catch {
      /* fallback to defaults */
    }

    // Insert the submission's items. If a CONCURRENT duplicate of this exact
    // submission already inserted rows, the UNIQUE index on (ticket_id, key)
    // rejects ours → we return the already-recorded bill instead.
    try {
      for (let idx = 0; idx < items.length; idx++) {
        const it = items[idx];
        const catSlug = String(it.category || "").toLowerCase();
        const stationName = routing[catSlug] || "kitchen";
        await db.insert(ticketItems).values({
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
      // 23505 = unique_violation → this submission was already recorded
      if (idemKey && (err as { code?: string })?.code === "23505") {
        const dup = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
        if (dup.length > 0) {
          const dupItems = await db
            .select()
            .from(ticketItems)
            .where(eq(ticketItems.ticketId, ticketId))
            .orderBy(asc(ticketItems.id));
          return NextResponse.json({
            ...dup[0],
            items: dupItems,
            totalAmount: dup[0].totalAmount,
            merged: activeTickets.length > 0,
            duplicate: true,
          });
        }
      }
      throw err;
    }

    const total = await recomputeTotal(ticketId);

    const finalTicket = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    return NextResponse.json({ ...finalTicket[0], totalAmount: total, merged: activeTickets.length > 0 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PUT: update ticket status / payment method / receipt photo
export async function PUT(request: Request) {
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
    if (body.paymentMethod !== undefined) updates.paymentMethod = body.paymentMethod;
    // Payment status is validated against the allowed set (independent of order status).
    if (body.paymentStatus !== undefined) {
      if (!PAYMENT_STATUSES.includes(body.paymentStatus)) {
        return NextResponse.json({ error: "Invalid payment status" }, { status: 400 });
      }
      updates.paymentStatus = body.paymentStatus;
    }
    if (body.receiptImage !== undefined) updates.receiptImage = body.receiptImage;
    if (body.status === "paid" || body.status === "cancelled") updates.closedAt = new Date();

    const updated = await db.update(tickets).set(updates).where(eq(tickets.id, body.id)).returning();
    return NextResponse.json(updated[0]);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE: cancel/erase a ticket fully
export async function DELETE(request: Request) {
  await ensureTablesExist();
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });
    await db.delete(ticketItems).where(eq(ticketItems.ticketId, Number(id)));
    await db.delete(tickets).where(eq(tickets.id, Number(id)));
    return NextResponse.json({ success: true, id: Number(id) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
