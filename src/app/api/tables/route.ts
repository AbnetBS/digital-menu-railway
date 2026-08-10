import { NextResponse } from "next/server";
import { db } from "@/db";
import { cafeTables, tickets } from "@/db/schema";
import { ensureDbSeeded, invalidateDbSeeded } from "@/lib/seed-db";
import { ensureTablesExist } from "@/db/migrate";
import { eq, asc, and, notInArray } from "drizzle-orm";

// Tables joined with their live status derived from active tickets
export async function GET() {
  await ensureTablesExist();
  await ensureDbSeeded();
  try {
    const tables = await db.select().from(cafeTables).orderBy(asc(cafeTables.sortOrder), asc(cafeTables.id));

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
      };
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  await ensureTablesExist();
  try {
    const body = await request.json();
    const name = body.name || `Table ${Math.floor(Math.random() * 900 + 100)}`;
    const newTable = await db.insert(cafeTables).values({ name, sortOrder: Number(body.sortOrder || 0) }).returning();
    return NextResponse.json(newTable[0]);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  await ensureTablesExist();
  try {
    const body = await request.json();
    if (!body.id) return NextResponse.json({ error: "ID required" }, { status: 400 });
    const updated = await db
      .update(cafeTables)
      .set({ name: body.name, sortOrder: Number(body.sortOrder ?? 0) })
      .where(eq(cafeTables.id, body.id))
      .returning();
    return NextResponse.json(updated[0]);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  await ensureTablesExist();
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });
    await db.delete(cafeTables).where(eq(cafeTables.id, Number(id)));
    invalidateDbSeeded(); // table may now be empty → self-heal on next read
    return NextResponse.json({ success: true, id: Number(id) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export const dynamicParams = true;
