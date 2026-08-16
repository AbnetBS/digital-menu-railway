import { NextResponse } from "next/server";
import { db } from "@/db";
import { cafeTables, tickets } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq, asc, and, notInArray } from "drizzle-orm";
import { requireAdmin, readStaffSession, readAdminSession } from "@/lib/session";
import { publish, CHANNELS } from "@/lib/realtime";

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
      .where(notInArray(tickets.status, ["paid", "cancelled"]));

    const result = tables.map((t) => {
      const tk = activeTickets.find((x) => x.tableId === t.id);
      let status: "available" | "waiting" | "occupied" | "preparing" | "ready-for-payment" = "available";
      if (tk) {
        if (tk.status === "pending_waiter") status = "waiting";
        else if (tk.status === "ready_for_payment" || tk.status === "completed") status = "ready-for-payment";
        else if (tk.status === "preparing") status = "preparing";
        else status = "occupied"; // confirmed
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
    await db.delete(cafeTables).where(eq(cafeTables.id, Number(id)));
    publish(CHANNELS.orders);
    return NextResponse.json({ success: true, id: Number(id) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export const dynamicParams = true;
