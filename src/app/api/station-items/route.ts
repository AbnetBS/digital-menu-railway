import { NextResponse } from "next/server";
import { db } from "@/db";
import { ticketItems, tickets } from "@/db/schema";
import { and, eq, notInArray, asc, inArray } from "drizzle-orm";
import { requireStaffOrAdmin } from "@/lib/session";
import { publish, CHANNELS } from "@/lib/realtime";

type Station = "barista" | "kitchen";

/**
 * GET /api/station-items?station=barista|kitchen
 * Returns open tickets carrying items for this crew station ONLY.
 */
export async function GET(request: Request) {
  const __auth = await requireStaffOrAdmin();
  if (!__auth.ok) return __auth.response;
  try {
    const { searchParams } = new URL(request.url);
    const stationQuery = (searchParams.get("station") || "kitchen").toLowerCase();
    const station: Station = stationQuery === "barista" ? "barista" : "kitchen";

    // GROUP 6 — bound the item read to OPEN tickets only. Previously this
    // fetched EVERY historical item for the station (e.g. ~15k rows at 10k
    // tickets) every 8s and then filtered in JS. Now: read the small set of
    // open ticket ids first, then fetch only THEIR items for this station.
    const open = await db
      .select({
        id: tickets.id,
        tableName: tickets.tableName,
        orderNumber: tickets.orderNumber,
        status: tickets.status,
        totalAmount: tickets.totalAmount,
        createdBy: tickets.createdBy,
        confirmedBy: tickets.confirmedBy,
      })
      .from(tickets)
      .where(notInArray(tickets.status, ["paid", "cancelled"]));

    if (open.length === 0) return NextResponse.json([], { headers: { "Cache-Control": "no-store" } });

    const openIds = open.map((t) => t.id);
    const allItems = await db
      .select()
      .from(ticketItems)
      .where(
        and(
          eq(ticketItems.stationName, station),
          eq(ticketItems.removed, false),
          inArray(ticketItems.ticketId, openIds)
        )
      )
      .orderBy(asc(ticketItems.id));

    if (allItems.length === 0) return NextResponse.json([], { headers: { "Cache-Control": "no-store" } });

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
        createdBy: t.createdBy,
        confirmedBy: t.confirmedBy,
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
  const __auth = await requireStaffOrAdmin();
  if (!__auth.ok) return __auth.response;
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
    publish(CHANNELS.orders);
    return NextResponse.json(updated[0]);
  } catch (error) {
    console.error("[station-items PUT error]", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
