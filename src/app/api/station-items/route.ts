import { NextResponse } from "next/server";
import { db } from "@/db";
import { ticketItems, tickets } from "@/db/schema";
import { and, eq, notInArray, asc, inArray } from "drizzle-orm";
import { requireStaffOrAdmin, readStaffSession, readAdminSession } from "@/lib/session";
import { publish, CHANNELS } from "@/lib/realtime";
import { sendPushToRoles } from "@/lib/push";
import { stationProgressAlerts } from "@/lib/alerts";

type Station = "barista" | "kitchen";

async function authorizedStation(): Promise<Station | "admin" | null> {
  if (await readAdminSession()) return "admin";
  const staff = await readStaffSession();
  if (staff?.role === "barista" || staff?.role === "kitchen") return staff.role;
  return null;
}

/**
 * GET /api/station-items?station=barista|kitchen
 * Returns open tickets carrying items for this crew station ONLY.
 */
export async function GET(request: Request) {
  const __auth = await requireStaffOrAdmin();
  if (!__auth.ok) return __auth.response;
  const stationRole = await authorizedStation();
  if (!stationRole) return NextResponse.json({ error: "Station role required" }, { status: 403 });
  try {
    const { searchParams } = new URL(request.url);
    const stationQuery = (searchParams.get("station") || "kitchen").toLowerCase();
    const requested: Station = stationQuery === "barista" ? "barista" : "kitchen";
    const station: Station = stationRole === "admin" ? requested : stationRole;

    // GROUP 6 — bound the item read to OPEN tickets only. Previously this
    // fetched EVERY historical item for the station (e.g. ~15k rows at 10k
    // tickets) every 8s and then filtered in JS. Now: read the small set of
    // open ticket ids first, then fetch only THEIR items for this station.
    // (Group 9: a CLOSED bill — waiter cleared the table — is no longer open,
    // so the station lists drop it exactly like paid/cancelled ones.)
    const open = await db
      .select({
        id: tickets.id,
        tableName: tickets.tableName,
        orderNumber: tickets.orderNumber,
        status: tickets.status,
        totalAmount: tickets.totalAmount,
        receiptRequestedAt: tickets.receiptRequestedAt,
        createdBy: tickets.createdBy,
        confirmedBy: tickets.confirmedBy,
        // Group 8: the crew needs to know WHEN the order arrived (and how long it
        // has been waiting), not just that it exists.
        createdAt: tickets.createdAt,
        updatedAt: tickets.updatedAt,
        // Group 11: the print stamp decides which items the crew may cook.
        printedAt: tickets.printedAt,
      })
      .from(tickets)
      .where(notInArray(tickets.status, ["paid", "cancelled", "closed", "pending_waiter", "confirmed"]));

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

    // GROUP 11 (release gate): in the print-queue workflow the EFD/POS receipt
    // must EXIST before the crew starts cooking — "nothing gets cooked without
    // a bill". A waiter sending an order only moves it to the CASHIER's queue;
    // the kitchen/barista lists receive it when she taps ✓ PRINTED (status
    // "printed"). Additions that land on an already-printed bill stay invisible
    // to the crew until she prints AGAIN: only items that existed at the last
    // print (item created_at <= printed_at) are released. (Full-payment mode
    // uses the classic release: the cashier's "Accept → Kitchen" move to
    // "preparing" — the status filter above already handles both.)
    const releasedItems = (status: string, printedAt: Date | string | null, items: any[]) => {
      if (status !== "printed" || !printedAt) return items; // preparing/…: all items released
      const cutoff = new Date(printedAt).getTime();
      return items.filter((it) => {
        if (!it.createdAt) return true; // legacy rows without a timestamp → released
        return new Date(it.createdAt).getTime() <= cutoff;
      });
    };

    const payload = open
      .filter((t) => map.has(t.id))
      .map((t) => {
        const items = releasedItems(t.status, t.printedAt, map.get(t.id) || []);
        return {
          id: t.id,
          tableName: t.tableName,
          orderNumber: t.orderNumber,
          status: t.status,
          totalAmount: t.totalAmount,
          createdBy: t.createdBy,
          confirmedBy: t.confirmedBy,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          // A guest asking for the bill is the crew's cue that the table is waiting.
          receiptRequestedAt: t.receiptRequestedAt,
          items,
        };
      })
      .filter((t) => t.items.length > 0);

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
  const stationRole = await authorizedStation();
  if (!stationRole) return NextResponse.json({ error: "Station role required" }, { status: 403 });
  try {
    const body = await request.json();
    if (!body.itemId || !body.stationStatus) {
      return NextResponse.json({ error: "itemId and stationStatus required" }, { status: 400 });
    }
    const existing = await db
      .select({
        id: ticketItems.id,
        stationName: ticketItems.stationName,
        ticketId: ticketItems.ticketId,
        name: ticketItems.name,
        quantity: ticketItems.quantity,
      })
      .from(ticketItems)
      .where(eq(ticketItems.id, Number(body.itemId)))
      .limit(1);
    if (existing.length === 0) return NextResponse.json({ error: "Item not found" }, { status: 404 });
    if (stationRole !== "admin" && existing[0].stationName !== stationRole) {
      return NextResponse.json({ error: "Item belongs to another station" }, { status: 403 });
    }

    const updated = await db
      .update(ticketItems)
      .set({ stationStatus: String(body.stationStatus) })
      .where(eq(ticketItems.id, Number(body.itemId)))
      .returning();

    // ── THE ALERT THAT WAS MISSING COMPLETELY ──
    // The crew finishing a dish rang nobody, so food sat on the pass until a
    // waiter happened to look at her screen. Now every station action wakes
    // the waiter's phone, and the last finished item says "whole order ready".
    try {
      const item = existing[0];
      const ticketRows = await db
        .select({ id: tickets.id, tableName: tickets.tableName, totalAmount: tickets.totalAmount })
        .from(tickets)
        .where(eq(tickets.id, item.ticketId))
        .limit(1);
      if (ticketRows.length > 0) {
        // Is anything on this bill still unfinished (any station)?
        const siblings = await db
          .select({ id: ticketItems.id, stationStatus: ticketItems.stationStatus })
          .from(ticketItems)
          .where(and(eq(ticketItems.ticketId, item.ticketId), eq(ticketItems.removed, false)));
        const wholeOrderReady = siblings.every((row) =>
          row.id === item.id ? String(body.stationStatus) === "done" : row.stationStatus === "done"
        );
        const alerts = stationProgressAlerts(String(body.stationStatus), {
          id: ticketRows[0].id,
          tableName: ticketRows[0].tableName,
          totalAmount: ticketRows[0].totalAmount,
          station: String(item.stationName || ""),
          itemName: item.name,
          quantity: item.quantity,
          wholeOrderReady,
        });
        for (const alert of alerts) {
          void sendPushToRoles(alert.roles, {
            title: alert.title,
            body: alert.body,
            tag: alert.tag,
            urgent: alert.urgent,
            repeat: alert.repeat,
          }).catch(() => {});
        }
      }
    } catch {
      // A push hiccup must never fail the crew's tap.
    }

    publish(CHANNELS.orders);
    return NextResponse.json(updated[0]);
  } catch (error) {
    console.error("[station-items PUT error]", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
