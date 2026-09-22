import { NextResponse } from "next/server";
import { db } from "@/db";
import { ticketItems, tickets } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { and, eq, notInArray, asc, desc, gte, inArray } from "drizzle-orm";
import { requireStaffOrAdmin, readStaffSession, readAdminSession } from "@/lib/session";
import { publish, CHANNELS } from "@/lib/realtime";
import { sendPushToNamedStaff, sendPushToRoles } from "@/lib/push";
import { stationProgressAlerts, ticketOwner } from "@/lib/alerts";
import { stationOf, type StationName } from "@/lib/stations";
import { etStartOfToday } from "@/lib/timezone";

/** The four crews that receive work (see @/lib/stations). */
type Station = StationName;

async function authorizedStation(): Promise<Station | "admin" | null> {
  if (await readAdminSession()) return "admin";
  const staff = await readStaffSession();
  // A crew may only ever read its OWN lane: buna makers see buna lines, the
  // barista sees the drinks, the kitchen sees the food, juice sees the juices.
  if (staff?.role === "barista" || staff?.role === "kitchen" || staff?.role === "buna" || staff?.role === "juice") return staff.role as Station;
  return null;
}

/**
 * GET /api/station-items?station=barista|kitchen|buna|juice[&history=1]
 * Returns open tickets carrying items for this crew station ONLY.
 *
 * ?history=1 → "Today's History": every order this crew RECEIVED today (the
 * paper stack they used to keep), open or already closed, with each line's
 * progress. Same release rule as the live list, so a held bill never shows up
 * as work they already did.
 */
export async function GET(request: Request) {
  const __auth = await requireStaffOrAdmin();
  if (!__auth.ok) return __auth.response;
  await ensureTablesExist();
  const stationRole = await authorizedStation();
  if (!stationRole) return NextResponse.json({ error: "Station role required" }, { status: 403 });
  try {
    const { searchParams } = new URL(request.url);
    // Anything unrecognised falls back to the kitchen lane, exactly as before.
    const station: Station = stationRole === "admin" ? stationOf(searchParams.get("station")) : stationRole;
    const historyOnly = searchParams.get("history") === "1";

    // ── THE RELEASE RULE (shared by the live list and the history) ──
    // A bill is released the moment staff SEND it: a waiter's ✓ ACCEPT & SEND
    // (or a staff-sent new order, which is sent at creation), or the cashier's
    // CONFIRM & SEND on a held QR order. From that second on, EVERY line on
    // the bill — the original order AND anything added later by the waiter or
    // the guest's own phone — is the crew's work immediately, exactly like the
    // cashier and waiter see it. The cashier's print is only the EFD receipt
    // for kitchen, barista and juice. Buna is read-only: print clears its
    // already-visible request instead of waiting for a Done tap.
    // The ONLY thing still held back is a HELD bill: her plain accept of a QR
    // order only acknowledges it (alarms stop, nothing sent), so a confirmed
    // bill with neither a confirmed_at nor a printed_at stamp releases NOTHING
    // until she taps CONFIRM & SEND.
    const isHeld = (confirmedAt: Date | string | null, printedAt: Date | string | null) =>
      !confirmedAt && !printedAt;

    const releasedItems = (
      confirmedAt: Date | string | null,
      printedAt: Date | string | null,
      items: any[]
    ) => {
      if (isHeld(confirmedAt, printedAt)) return [];
      return items;
    };

    // Buna makers only need a read-only work list. They do not press Accept or
    // Done; the cashier's EFD print clears the buna request. Future prints mark
    // the lines done, and this cutoff also hides any older pending buna rows
    // that were printed before this rule existed. Additions created after the
    // last print still appear until the cashier prints receipt #2.
    const liveItemsForStation = (
      confirmedAt: Date | string | null,
      printedAt: Date | string | null,
      items: any[]
    ) => {
      const released = releasedItems(confirmedAt, printedAt, items);
      if (station !== "buna") return released;
      const printedMs = printedAt ? new Date(printedAt).getTime() || 0 : 0;
      return released.filter((it: any) => {
        if (it.stationStatus === "done") return false;
        if (!printedMs) return true;
        const createdMs = it.createdAt ? new Date(it.createdAt).getTime() || 0 : 0;
        return createdMs > printedMs;
      });
    };

    if (historyOnly) {
      // ── TODAY'S HISTORY ──
      // Every order this crew received today: the bill was SENT today, or it
      // received new lines today (additions land instantly now, without a
      // print), or it was printed today. Scoped to the last 48h of tickets so
      // a late-night order is still found, without ever scanning the table.
      const since = new Date();
      since.setDate(since.getDate() - 2);
      const recent = await db
        .select({
          id: tickets.id,
          tableName: tickets.tableName,
          orderNumber: tickets.orderNumber,
          orderType: tickets.orderType,
          serviceNote: tickets.serviceNote,
          status: tickets.status,
          createdBy: tickets.createdBy,
          confirmedBy: tickets.confirmedBy,
          createdAt: tickets.createdAt,
          updatedAt: tickets.updatedAt,
          closedAt: tickets.closedAt,
          printedAt: tickets.printedAt,
          confirmedAt: tickets.confirmedAt,
        })
        .from(tickets)
        .where(gte(tickets.createdAt, since))
        .orderBy(desc(tickets.id));

      if (recent.length === 0) return NextResponse.json([], { headers: { "Cache-Control": "no-store" } });

      const recentIds = recent.map((t) => t.id);
      const recentItems = await db
        .select()
        .from(ticketItems)
        .where(
          and(
            eq(ticketItems.stationName, station),
            eq(ticketItems.removed, false),
            inArray(ticketItems.ticketId, recentIds)
          )
        )
        .orderBy(asc(ticketItems.id));

      const byTicket = new Map<number, any[]>();
      for (const it of recentItems) {
        if (!byTicket.has(it.ticketId)) byTicket.set(it.ticketId, []);
        byTicket.get(it.ticketId)!.push(it);
      }

      // "Today" on the ETHIOPIAN wall clock, like the office PC shows.
      const startOfTodayMs = etStartOfToday().getTime();
      const isToday = (d: Date | string | null) =>
        d ? new Date(d).getTime() >= startOfTodayMs : false;

      const rows = [];
      for (const t of recent) {
        const items = byTicket.get(t.id) || [];
        if (items.length === 0) continue;
        // Held bills release nothing, so they never appear as work already done.
        const released = releasedItems(t.confirmedAt, t.printedAt, items);
        if (released.length === 0) continue;
        // Did this crew receive work from this bill TODAY? The send, the
        // print, or any of their own lines landing all count — an addition to
        // yesterday's bill is today's work for them.
        const receivedToday =
          isToday(t.confirmedAt) ||
          isToday(t.printedAt) ||
          released.some((it: any) => isToday(it.createdAt));
        if (!receivedToday) continue;
        // Newest activity first: the latest of the send, the print and their
        // own newest line.
        const stamps = [t.confirmedAt, t.printedAt, ...released.map((it: any) => it.createdAt)]
          .filter(Boolean)
          .map((d) => new Date(d as Date | string).getTime())
          .filter((n) => Number.isFinite(n));
        const releasedMs = stamps.length > 0 ? Math.max(...stamps) : Date.now();
        rows.push({
          id: t.id,
          tableName: t.tableName,
          orderNumber: t.orderNumber,
          orderType: t.orderType,
          serviceNote: t.serviceNote,
          status: t.status,
          createdBy: t.createdBy,
          confirmedBy: t.confirmedBy,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          closedAt: t.closedAt,
          printedAt: t.printedAt,
          confirmedAt: t.confirmedAt,
          releasedAt: new Date(releasedMs),
          items: released.map((it: any) => ({
            id: it.id,
            name: it.name,
            quantity: it.quantity,
            notes: it.notes,
            stationStatus: it.stationStatus,
            stationStatusBy: it.stationStatusBy || null,
            stationStatusAt: it.stationStatusAt || null,
            createdAt: it.createdAt,
          })),
        });
      }
      // Newest work first.
      rows.sort((a, b) => new Date(b.releasedAt).getTime() - new Date(a.releasedAt).getTime());
      return NextResponse.json(rows, { headers: { "Cache-Control": "no-store" } });
    }

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
        orderType: tickets.orderType,
        serviceNote: tickets.serviceNote,
        status: tickets.status,
        totalAmount: tickets.totalAmount,
        receiptRequestedAt: tickets.receiptRequestedAt,
        createdBy: tickets.createdBy,
        confirmedBy: tickets.confirmedBy,
        // Group 8: the crew needs to know WHEN the order arrived (and how long it
        // has been waiting), not just that it exists.
        createdAt: tickets.createdAt,
        updatedAt: tickets.updatedAt,
        // The release stamps: a bill with NEITHER is held (cashier accepted a
        // QR order but has not sent it yet) and releases nothing.
        printedAt: tickets.printedAt,
        confirmedAt: tickets.confirmedAt,
      })
      .from(tickets)
      // WORKFLOW (owner's decision, Sept 2026): the SEND releases the food,
      // not the print. The moment a waiter taps ✓ ACCEPT & SEND (or the
      // cashier taps CONFIRM & SEND on a held QR order) the ticket becomes
      // "confirmed" with a release stamp and every crew with lines on it —
      // kitchen, barista, buna, juice — plus the cashier all receive it in the
      // same second. Food ADDED later lands the same second too: the cashier
      // still keys it into the EFD and prints receipt #2, but the crew never
      // waits for that tap. A cashier's plain accept HOLDS the bill (no stamp,
      // nothing released). Only orders nobody has accepted yet (pending_waiter)
      // stay hidden here.
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

    const payload = open
      .filter((t) => map.has(t.id))
      .map((t) => {
        const items = liveItemsForStation(t.confirmedAt, t.printedAt, map.get(t.id) || []);
        return {
          id: t.id,
          tableName: t.tableName,
          orderNumber: t.orderNumber,
          orderType: t.orderType,
          serviceNote: t.serviceNote,
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
  await ensureTablesExist();
  const stationRole = await authorizedStation();
  if (!stationRole) return NextResponse.json({ error: "Station role required" }, { status: 403 });
  try {
    const body = await request.json();
    if (!body.itemId || !body.stationStatus) {
      return NextResponse.json({ error: "itemId and stationStatus required" }, { status: 400 });
    }
    // Only the three real crew actions exist — anything else is rejected
    // instead of being stored as a garbage status no screen understands.
    const nextStatus = String(body.stationStatus);
    if (nextStatus !== "pending" && nextStatus !== "accepted" && nextStatus !== "done") {
      return NextResponse.json({ error: "stationStatus must be pending, accepted or done" }, { status: 400 });
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

    // CREW-ACTION AUDIT: stamp WHO pressed it and WHEN, so a "done" nobody
    // remembers pressing can always be traced to a person and a minute. An
    // admin acting on a crew's behalf is stamped as admin, never as the crew.
    const actorName =
      stationRole === "admin" ? "admin" : (await readStaffSession())?.name || stationRole;
    const updated = await db
      .update(ticketItems)
      .set({ stationStatus: nextStatus, stationStatusBy: String(actorName).slice(0, 100), stationStatusAt: new Date() })
      .where(eq(ticketItems.id, Number(body.itemId)))
      .returning();

    // ── THE ALERT THAT WAS MISSING COMPLETELY ──
    // The crew finishing a dish rang nobody, so food sat on the pass until a
    // waiter happened to look at her screen. Now every station action wakes
    // the waiter's phone, and the last finished item says "whole order ready".
    try {
      const item = existing[0];
      const ticketRows = await db
        .select({
          id: tickets.id,
          tableName: tickets.tableName,
          totalAmount: tickets.totalAmount,
          orderType: tickets.orderType,
          confirmedBy: tickets.confirmedBy,
          createdBy: tickets.createdBy,
        })
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
          row.id === item.id ? nextStatus === "done" : row.stationStatus === "done"
        );
        const alerts = stationProgressAlerts(nextStatus, {
          id: ticketRows[0].id,
          tableName: ticketRows[0].tableName,
          totalAmount: ticketRows[0].totalAmount,
          station: String(item.stationName || ""),
          itemName: item.name,
          quantity: item.quantity,
          wholeOrderReady,
        });
        // OWNER-ONLY (owner's decision, Sept 2026): "food ready" rings the
        // waiter who accepted/sent this table — not every waiter on duty. An
        // unowned ticket (QR order nobody accepted) still rings all waiters.
        const owner = ticketOwner(ticketRows[0].confirmedBy, ticketRows[0].createdBy);
        for (const alert of alerts) {
          const payload = {
            title: alert.title,
            body: alert.body,
            tag: alert.tag,
            urgent: alert.urgent,
            repeat: alert.repeat,
          };
          if (ticketRows[0].orderType === "outdoor" && alert.roles.length === 1 && alert.roles[0] === "waiter") {
            if (wholeOrderReady) {
              void sendPushToRoles(["cashier"], {
                ...payload,
                title: "🔔 OUTDOOR ORDER READY",
                body: `${ticketRows[0].tableName} • the whole outdoor order is ready to deliver`,
                tag: `fana-outdoor-ready-${ticketRows[0].id}`,
              }).catch(() => {});
            }
          } else if (owner && alert.roles.length === 1 && alert.roles[0] === "waiter") {
            void sendPushToNamedStaff("waiter", owner, payload).catch(() => {});
          } else {
            void sendPushToRoles(alert.roles, payload).catch(() => {});
          }
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
