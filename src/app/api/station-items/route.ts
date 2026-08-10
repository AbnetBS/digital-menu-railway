import { NextResponse } from "next/server";
import { db } from "@/db";
import { ticketItems, tickets } from "@/db/schema";
import { and, eq, notInArray, asc } from "drizzle-orm";

type Station = "barista" | "kitchen";

/**
 * GET /api/station-items?station=barista|kitchen
 * Returns open tickets carrying items for this crew station ONLY.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const stationQuery = (searchParams.get("station") || "kitchen").toLowerCase();
    const station: Station = stationQuery === "barista" ? "barista" : "kitchen";

    const allItems = await db
      .select()
      .from(ticketItems)
      .where(and(eq(ticketItems.stationName, station), eq(ticketItems.removed, false)))
      .orderBy(asc(ticketItems.id));

    if (allItems.length === 0) return NextResponse.json([], { headers: { "Cache-Control": "no-store" } });

    const open = await db.select().from(tickets).where(notInArray(tickets.status, ["paid", "cancelled"]));

    const map = new Map<number, any[]>();
    for (const it of allItems) {
      if (!map.has(it.ticketId)) map.set(it.ticketId, []);
      map.get(it.ticketId)!.push(it);
    }

    const payload = open
      .filter((t) => map.has(t.id))
      .map((t) => ({
        id: t.id,
        tableName: t.tableName,
        orderNumber: t.orderNumber,
        status: t.status,
        totalAmount: t.totalAmount,
        items: map.get(t.id) || [],
      }));

    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[station-items error]", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

/** PUT — station crew accepts/completes their items at start/finish of prep work */
export async function PUT(request: Request) {
  try {
    const body = await request.json();
    if (!body.itemId || !body.stationStatus) {
      return NextResponse.json({ error: "itemId and stationStatus required" }, { status: 400 });
    }
    const updated = await db
      .update(ticketItems)
      .set({ stationStatus: String(body.stationStatus) })
      .where(eq(ticketItems.id, Number(body.itemId)))
      .returning();
    return NextResponse.json(updated[0]);
  } catch (error) {
    console.error("[station-items PUT error]", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
