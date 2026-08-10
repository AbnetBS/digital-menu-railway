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

// GET: ?active=1 → active tickets (with items); ?all=1 → everything
// TRAFFIC FIX: list responses EXCLUDE receipt photos (they're heavy base64 polygons).
// Receipts are fetched on-demand via /api/tickets/receipt?id=X when someone clicks "View Receipt".
export async function GET(request: Request) {
  await ensureTablesExist();
  try {
    const { searchParams } = new URL(request.url);
    const activeOnly = searchParams.get("active") === "1";

    const list = activeOnly
      ? await db.select().from(tickets).where(notInArray(tickets.status, ["paid", "cancelled"])).orderBy(desc(tickets.updatedAt))
      : await db.select().from(tickets).orderBy(desc(tickets.updatedAt)).limit(100);

    // list WITHOUT the receiptImage column (heavy payload), kept for CSV missing fallback key
    const slim = list.map((t) => {
      const clone: Record<string, unknown> = { ...t };
      delete clone.receiptImage;
      return clone;
    });

    // PERFORMANCE: only fetch items for the tickets being returned — never the
    // whole ticket_items table (it grows forever). Group by ticketId once.
    const ticketIds = slim.map((t) => (t as { id: number }).id);
    const items = ticketIds.length > 0
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

    if (!tableId || !items || items.length === 0) {
      return NextResponse.json({ error: "Table and items required" }, { status: 400 });
    }

    const isCustomer = source === "customer";
    const initialStatus = isCustomer ? "pending_waiter" : "confirmed";

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

    for (const it of items) {
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
      });
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

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.status) updates.status = body.status;
    if (body.paymentMethod !== undefined) updates.paymentMethod = body.paymentMethod;
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
