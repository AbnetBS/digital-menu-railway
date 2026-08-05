import { NextResponse } from "next/server";
import { db } from "@/db";
import { tickets, ticketItems } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq, and } from "drizzle-orm";

async function recomputeTotal(ticketId: number) {
  const items = await db
    .select()
    .from(ticketItems)
    .where(and(eq(ticketItems.ticketId, ticketId), eq(ticketItems.removed, false)));
  const total = items.reduce((s, i) => s + i.price * i.quantity, 0);
  await db.update(tickets).set({ totalAmount: total, updatedAt: new Date() }).where(eq(tickets.id, ticketId));
  return total;
}

// PUT: edit item quantity or notes (waiter can adjust before payment)
export async function PUT(request: Request) {
  await ensureTablesExist();
  try {
    const body = await request.json();
    if (!body.itemId) return NextResponse.json({ error: "Item ID required" }, { status: 400 });

    const updates: Record<string, unknown> = {};
    if (body.quantity !== undefined) updates.quantity = Math.max(1, Number(body.quantity));
    if (body.notes !== undefined) updates.notes = String(body.notes);

    const updated = await db.update(ticketItems).set(updates).where(eq(ticketItems.id, body.itemId)).returning();
    if (updated[0]) await recomputeTotal(updated[0].ticketId);
    return NextResponse.json(updated[0]);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE: cashier removes unavailable item (soft-remove, stays visible as removed)
export async function DELETE(request: Request) {
  await ensureTablesExist();
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    const hard = searchParams.get("hard") === "1";
    if (!id) return NextResponse.json({ error: "Item ID required" }, { status: 400 });

    const rows = await db.select().from(ticketItems).where(eq(ticketItems.id, Number(id)));
    if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (hard) {
      await db.delete(ticketItems).where(eq(ticketItems.id, Number(id)));
    } else {
      await db.update(ticketItems).set({ removed: true }).where(eq(ticketItems.id, Number(id)));
    }

    await recomputeTotal(rows[0].ticketId);
    return NextResponse.json({ success: true, id: Number(id) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
