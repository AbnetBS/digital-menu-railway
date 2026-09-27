import { NextResponse } from "next/server";
import { db } from "@/db";
import { cafeTables, tickets } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq, asc, and, notInArray } from "drizzle-orm";
import { requireAdmin, readStaffSession, readAdminSession } from "@/lib/session";
import { publish, CHANNELS } from "@/lib/realtime";
import { isTableReleased } from "@/lib/order-release";

// Tables joined with their live status derived from active tickets.
//
// Public callers (the customer QR menu) only need each table's id + name to
// display "Table N", so they receive a minimal shape. Staff/admin receive the
// full live operational status (occupancy, active ticket id, running total).
export async function GET() {
  const staff = await readStaffSession();
  const admin = await readAdminSession();
  const isStaff = Boolean(staff || admin);

  await ensureTablesExist();
  try {
    const tables = await db.select().from(cafeTables).orderBy(asc(cafeTables.sortOrder), asc(cafeTables.id));

    if (!isStaff) {
      // Public: no operational status, no active-ticket totals.
      return NextResponse.json(tables.map((t) => ({ id: t.id, name: t.name, sortOrder: t.sortOrder })));
    }

    const activeTickets = await db
      .select()
      .from(tickets)
      .where(notInArray(tickets.status, ["paid", "cancelled", "closed"]));

    const result = tables.map((t) => {
      // PRINT FREES THE TABLE (owner's decision, Sept 2026): the cashier's
      // ✓ PRINTED tap also clears the table, because the waiters kept
      // forgetting to. A dine-in bill carrying printed_at is finished for the
      // floor, so it never shows up as this table's open bill again — the next
      // guest's order becomes the table's current bill (newest one wins), and
      // a table with nothing but released bills reads as free.
      const openBills = activeTickets
        .filter((x) => x.tableId === t.id && !isTableReleased(x))
        .sort((a, b) => b.id - a.id);
      const tk = openBills[0];
      let status: "available" | "waiting" | "occupied" | "preparing" | "ready-for-payment" = "available";
      if (tk) {
        if (tk.status === "pending_waiter") status = "waiting";
        else if (tk.status === "ready_for_payment" || tk.status === "completed") status = "ready-for-payment";
        // Print-queue mode: once the cashier printed the bill, the crew is
        // working on it — same board color as the classic "preparing" state.
        else if (tk.status === "preparing" || tk.status === "printed") status = "preparing";
        else status = "occupied"; // confirmed — accepted: the crew is cooking, the cashier is printing
      }
      return {
        id: t.id,
        name: t.name,
        sortOrder: t.sortOrder,
        status,
        activeTicketStatus: tk ? tk.status : null,
        activeTicketId: tk ? tk.id : null,
        activeTicketTotal: tk ? tk.totalAmount : 0,
        // Who is handling this table: the confirmer if set, else the order creator.
        activeTicketBy: tk ? tk.confirmedBy || tk.createdBy || null : null,
        // Group 8: how long the table has been open, and whether the guest has
        // already tapped "bring us the bill" from their own phone.
        activeTicketAt: tk?.createdAt ? new Date(tk.createdAt).toISOString() : null,
        activeTicketReceiptRequestedAt: tk?.receiptRequestedAt
          ? new Date(tk.receiptRequestedAt).toISOString()
          : null,
        activeTicketReceiptRequestedBy: tk?.receiptRequestedBy || null,
      };
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const __auth = await requireAdmin();
  if (!__auth.ok) return __auth.response;
  await ensureTablesExist();
  try {
    const body = await request.json();
    const name = body.name || `Table ${Math.floor(Math.random() * 900 + 100)}`;
    const newTable = await db.insert(cafeTables).values({ name, sortOrder: Number(body.sortOrder || 0) }).returning();
    publish(CHANNELS.orders);
    return NextResponse.json(newTable[0]);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const __auth = await requireAdmin();
  if (!__auth.ok) return __auth.response;
  await ensureTablesExist();
  try {
    const body = await request.json();
    if (!body.id) return NextResponse.json({ error: "ID required" }, { status: 400 });
    const updated = await db
      .update(cafeTables)
      .set({ name: body.name, sortOrder: Number(body.sortOrder ?? 0) })
      .where(eq(cafeTables.id, body.id))
      .returning();
    publish(CHANNELS.orders);
    return NextResponse.json(updated[0]);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const __auth = await requireAdmin();
  if (!__auth.ok) return __auth.response;
  await ensureTablesExist();
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });
    // A table with a LIVE bill can never be deleted: the boards join bills to
    // tables, so the bill would vanish from every screen while the kitchen
    // still cooks it. Close the bill first, then delete the table.
    const live = await db
      .select({ id: tickets.id, orderType: tickets.orderType, printedAt: tickets.printedAt })
      .from(tickets)
      .where(and(eq(tickets.tableId, Number(id)), notInArray(tickets.status, ["paid", "cancelled", "closed"])));
    const stillOpen = live.filter((t) => !isTableReleased(t));
    if (stillOpen.length > 0) {
      return NextResponse.json({ error: "This table has an open bill. Close it first, then delete the table." }, { status: 400 });
    }
    await db.delete(cafeTables).where(eq(cafeTables.id, Number(id)));
    publish(CHANNELS.orders);
    return NextResponse.json({ success: true, id: Number(id) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export const dynamicParams = true;
