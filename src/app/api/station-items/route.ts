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
      // WORKFLOW (owner's decision, Sept 2026): staff ACCEPTANCE releases the
      // food, not the print. The moment a waiter taps ✓ ACCEPT & SEND (or the
      // cashier confirms a QR order) the ticket becomes "confirmed" and the
      // kitchen, the barista AND the cashier all receive it in the same second.
      // The cashier still keys it into the EFD and prints, but the crew no
      // longer waits for that tap. Only orders nobody has accepted yet
      // (pending_waiter) stay hidden here.
      .where(notInArray(tickets.status, ["paid", "cancelled", "closed", "pending_waiter"]));

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

    // RELEASE RULE (replaces the old "wait for the print" gate): every live item
    // on an accepted ticket is released. Dishes a guest adds to a bill that is
    // already accepted go straight onto the crew's list too — the waiter and
    // the cashier both get the loud guest alarm for them, so nothing is
    // unnoticed, and nobody has to tap anything to get the food cooking.
    const releasedItems = (_status: string, _printedAt: Date | string | null, items: any[]) => items;

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
