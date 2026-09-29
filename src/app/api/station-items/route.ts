import { NextResponse } from "next/server";
import { db } from "@/db";
import { siteSettings, stationShiftClaims, ticketItems, tickets } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { and, eq, notInArray, asc, desc, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { requireStaffOrAdmin, readStaffSession, readAdminSession } from "@/lib/session";
import { publish, CHANNELS } from "@/lib/realtime";
import { sendPushToNamedStaff, sendPushToRoles } from "@/lib/push";
import { stationProgressAlerts, ticketOwner } from "@/lib/alerts";
import { stationOf, type StationName } from "@/lib/stations";
import { allLinesFinished, isBillSent, isLineHeld, isLineServedByPrint, isTableReleased } from "@/lib/order-release";
import { etStartOfToday } from "@/lib/timezone";
import {
  baristaViewer,
  canRegisterClaim,
  claimShiftFor,
  filterBaristaLive,
  handoverPhase,
  lineAcceptedOwner,
  lineDoneOwner,
  type HandoverClaim,
  type HandoverShift,
} from "@/lib/shift-handover";

/** The four crews that receive work (see @/lib/stations). */
type Station = StationName;

/**
 * THE BARISTA HAND-OVER (owner, Sept 2026) — the only lane with a registered
 * owner per shift. Kitchen, juice and buna keep the old open board: everyone
 * logged in sees the same work. See @/lib/shift-handover for the rules.
 */
const HANDOVER_STATION: Station = "barista";
const SPLIT_KEY = "shift_split_hour";
const DEFAULT_SPLIT_HOUR = 14;

async function readSplitHour(): Promise<number> {
  try {
    const rows = await db.select().from(siteSettings).where(eq(siteSettings.key, SPLIT_KEY));
    const n = Number(rows[0]?.value);
    return Number.isInteger(n) && n >= 1 && n <= 23 ? n : DEFAULT_SPLIT_HOUR;
  } catch {
    return DEFAULT_SPLIT_HOUR;
  }
}

/** Today's two barista owners (null while nobody has accepted a drink yet). */
async function readBaristaClaims(dayKey: string | null): Promise<{ morning: HandoverClaim | null; afternoon: HandoverClaim | null }> {
  const owners = { morning: null as HandoverClaim | null, afternoon: null as HandoverClaim | null };
  if (!dayKey) return owners;
  try {
    const rows = await db
      .select()
      .from(stationShiftClaims)
      .where(and(eq(stationShiftClaims.station, HANDOVER_STATION), eq(stationShiftClaims.dayKey, dayKey)));
    for (const r of rows) {
      const claim: HandoverClaim = { shift: r.shiftName as HandoverShift, staffName: String(r.staffName || "").trim(), claimedAt: r.claimedAt };
      if (claim.shift === "morning") owners.morning = claim;
      else if (claim.shift === "afternoon") owners.afternoon = claim;
    }
  } catch {
    /* a claims hiccup must never blank the crew's board */
  }
  return owners;
}

/** The whole hand-over picture for one moment (and it IS one moment: now). */
async function baristaHandoverNow() {
  const splitHour = await readSplitHour();
  const info = handoverPhase(new Date(), splitHour);
  const owners = await readBaristaClaims(info.dayKey);
  return { info, owners };
}

async function authorizedStation(): Promise<Station | "admin" | null> {
  // THE CREW'S OWN SESSION WINS (owner's bug report, 29 Sept 2026): the
  // cafe's tablets and phones are also used to look at /admin, and an admin
  // cookie lives SEVEN days. This function used to answer "admin" the moment
  // that cookie existed, which silently switched the whole barista hand-over
  // off on that device: the shift was never registered and every logged-in
  // barista saw the full board again. A station crew member is now always
  // treated as his own lane; the admin session stays the fallback for a lane
  // nobody signed in for.
  const staff = await readStaffSession();
  // A crew may only ever read its OWN lane: buna makers see buna lines, the
  // barista sees the drinks, the kitchen sees the food, juice sees the juices.
  if (staff?.role === "barista" || staff?.role === "kitchen" || staff?.role === "buna" || staff?.role === "juice") return staff.role as Station;
  if (await readAdminSession()) return "admin";
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
 *
 * ?printCleared=1 → the bills the cashier printed in the last 15 minutes that
 * carried this crew's lines. The print SERVES the food (owner's decision,
 * Sept 2026), so those lines left the live list — this feed lets the station
 * screen tell a print-clear apart from a cancellation and stay quiet about it.
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
    // ── CANCELLED WORK (the crew's PROOF, owner's decision, Sept 2026) ──
    // A cancelled order used to simply VANISH from this list, so a cook who
    // had already started it had nothing to point at: "did it really come
    // through? was it really cancelled?" Now every cancellation — a whole
    // order voided by the waiter or the cashier, or a single line removed off
    // a bill that is still open — is served here as a red record the crew
    // reads and dismisses with Okay. It is never work: it never counts as
    // sold, and the Done/Accept buttons are replaced by the Okay dismiss.
    const cancelledOnly = searchParams.get("cancelled") === "1";
    // ── PRINT-CLEARED FEED (owner's decision, Sept 2026) ──
    // The cashier's ✓ PRINTED tap means the order is done and served, so the
    // bill's lines leave the live list below the same second. A card that
    // vanishes for THAT reason is good news, not the "stop preparing" alarm —
    // this feed names the bills she printed in the last 15 minutes (that had
    // this crew's lines), so the station screen can tell a print-clear apart
    // from a cancellation and show a quiet ✓ toast instead of ringing.
    const printClearedOnly = searchParams.get("printCleared") === "1";
    if (!cancelledOnly && printClearedOnly) {
      const since = new Date(Date.now() - 15 * 60 * 1000);
      const printedBills = await db
        .select({ id: tickets.id, tableName: tickets.tableName, orderNumber: tickets.orderNumber, printedAt: tickets.printedAt })
        .from(tickets)
        .where(and(isNotNull(tickets.printedAt), gte(tickets.printedAt, since), notInArray(tickets.status, ["cancelled"])))
        .orderBy(desc(tickets.printedAt));
      if (printedBills.length === 0) return NextResponse.json([], { headers: { "Cache-Control": "no-store" } });
      const mine = await db
        .select({ id: ticketItems.id, ticketId: ticketItems.ticketId })
        .from(ticketItems)
        .where(
          and(
            eq(ticketItems.stationName, station),
            eq(ticketItems.removed, false),
            // Held lines never reached this crew, so they are not "cleared
            // from their board" either.
            sql`COALESCE(${ticketItems.released}, true) = true`,
            inArray(ticketItems.ticketId, printedBills.map((p) => p.id))
          )
        );
      const withMine = new Set(mine.map((m) => m.ticketId));
      return NextResponse.json(
        printedBills
          .filter((p) => withMine.has(p.id))
          .map((p) => ({ id: p.id, tableName: p.tableName, orderNumber: p.orderNumber, printedAt: p.printedAt })),
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    if (cancelledOnly) {
      const since = new Date();
      since.setDate(since.getDate() - 2);

      // 1. Whole orders that were cancelled (status is terminal).
      const cancelledTickets = await db
        .select({
          id: tickets.id,
          tableName: tickets.tableName,
          orderNumber: tickets.orderNumber,
          orderType: tickets.orderType,
          serviceNote: tickets.serviceNote,
          status: tickets.status,
          totalAmount: tickets.totalAmount,
          createdBy: tickets.createdBy,
          confirmedBy: tickets.confirmedBy,
          createdAt: tickets.createdAt,
          updatedAt: tickets.updatedAt,
          closedAt: tickets.closedAt,
        })
        .from(tickets)
        .where(and(eq(tickets.status, "cancelled"), gte(tickets.closedAt, since)))
        .orderBy(desc(tickets.closedAt));

      // 2. Lines taken off a bill that is STILL open (the guest changed their
      //    mind on one dish). The row stays on the bill as removed, so it is
      //    the same proof the crew needs for a whole cancellation.
      const openRows = await db
        .select({
          id: tickets.id,
          tableName: tickets.tableName,
          orderNumber: tickets.orderNumber,
          orderType: tickets.orderType,
          serviceNote: tickets.serviceNote,
          status: tickets.status,
          totalAmount: tickets.totalAmount,
          createdBy: tickets.createdBy,
          confirmedBy: tickets.confirmedBy,
          createdAt: tickets.createdAt,
          updatedAt: tickets.updatedAt,
          itemsEditedAt: tickets.itemsEditedAt,
        })
        .from(tickets)
        .where(notInArray(tickets.status, ["paid", "cancelled", "closed", "pending_waiter"]));

      const wantedIds = [...cancelledTickets.map((t) => t.id), ...openRows.map((t) => t.id)];
      const cancelledItems = wantedIds.length === 0
        ? []
        : await db
            .select()
            .from(ticketItems)
            .where(
              and(
                eq(ticketItems.stationName, station),
                inArray(ticketItems.ticketId, wantedIds),
                // Only work the crew could actually have received: a held
                // guest line never reached them, so its cancellation is not
                // their business.
                sql`COALESCE(${ticketItems.released}, true) = true`
              )
            )
            .orderBy(asc(ticketItems.id));

      const byTicket = new Map<number, any[]>();
      for (const it of cancelledItems) {
        if (!byTicket.has(it.ticketId)) byTicket.set(it.ticketId, []);
        byTicket.get(it.ticketId)!.push(it);
      }

      const shapeItem = (it: any) => ({
        id: it.id,
        name: it.name,
        quantity: it.quantity,
        notes: it.notes,
        stationStatus: it.stationStatus,
        stationStatusBy: it.stationStatusBy,
        stationStatusAt: it.stationStatusAt,
        createdAt: it.createdAt,
        removed: it.removed === true,
      });

      const rows: any[] = [];
      for (const t of cancelledTickets) {
        const items = (byTicket.get(t.id) || []).filter((it: any) => it.removed !== true);
        if (items.length === 0) continue;
        rows.push({
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
          cancelledAt: t.closedAt || t.updatedAt,
          wholeOrder: true,
          items: items.map(shapeItem),
        });
      }
      for (const t of openRows) {
        const items = (byTicket.get(t.id) || []).filter((it: any) => it.removed === true);
        if (items.length === 0) continue;
        rows.push({
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
          cancelledAt: t.itemsEditedAt || t.updatedAt,
          wholeOrder: false,
          items: items.map(shapeItem),
        });
      }
      rows.sort((a, b) => new Date(b.cancelledAt || 0).getTime() - new Date(a.cancelledAt || 0).getTime());
      return NextResponse.json(rows, { headers: { "Cache-Control": "no-store" } });
    }

    // ── THE RELEASE RULE (shared by the live list and the history) ──
    // A bill is released the moment staff SEND it: a waiter's ACCEPT & SEND
    // (or a staff-sent new order, which is sent at creation), or the cashier's
    // CONFIRM & SEND on a held QR order. From that second on, EVERY released
    // line on the bill the original order AND anything the waiter added later
    // is the crew's work immediately, exactly like the cashier and the waiter
    // see it. Two things stay invisible here:
    //   • a HELD bill: her plain accept of a QR order only acknowledges it
    //     (alarms stop, nothing sent), so a confirmed bill with neither a
    //     confirmed_at nor a printed_at stamp releases NOTHING until she taps
    //     CONFIRM & SEND;
    //   • a guest top-up on an already-sent bill (ticket_items.released =
    //     false): the guest's phone order never reaches a station on its own,
    //     it waits for the cashier's or the waiter's confirmation.
    const releasedItems = (
      confirmedAt: Date | string | null,
      printedAt: Date | string | null,
      items: any[]
    ) => {
      if (!isBillSent({ confirmedAt, printedAt })) return [];
      return items.filter((it: any) => !isLineHeld(it));
    };

    // THE PRINT SERVES THE FOOD (owner's decision, Sept 2026). The cashier's
    // ✓ PRINTED tap means the order is done and served, so every line that was
    // on the printed receipt leaves this dashboard at once — the print itself
    // stamps those lines done (see the PUT in tickets/route.ts), which is why
    // "finished on or before the last print" is exactly "served with a
    // receipt". That is the rule for ALL four crews now (it used to be buna
    // only, and kitchen/barista/juice items lingered on the boards overnight
    // whenever nobody tapped Done). What still shows on a printed bill:
    //   • a pending/accepted line — live work. If it was released only AFTER
    //     the print (a guest top-up the staff just confirmed), the receipt
    //     never covered it and the crews must still make it;
    //   • a line finished AFTER the print — receipt #2 is still pending, so it
    //     stays as a crossed-out reminder until the cashier prints again;
    //   • the buna lane stays read-only as before: its DONE lines never show.
    const liveItemsForStation = (
      confirmedAt: Date | string | null,
      printedAt: Date | string | null,
      items: any[]
    ) => {
      const released = releasedItems(confirmedAt, printedAt, items);
      const printedTicket = { printedAt };
      return released.filter((it: any) => {
        if (station === "buna" && it.stationStatus === "done") return false;
        return !isLineServedByPrint(it, printedTicket);
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
            // A guest top-up staff have not confirmed yet is not their work.
            sql`COALESCE(${ticketItems.released}, true) = true`,
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
          // A guest top-up staff have not confirmed yet is not their work.
          sql`COALESCE(${ticketItems.released}, true) = true`,
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

    // ── THE BARISTA HAND-OVER (owner, Sept 2026) ──
    // A logged-in BARISTA gets the live list cut for his own pair of eyes:
    // pending lines only while his shift may still accept them, his own
    // accepted lines until they are done or printed, and every other barista's
    // lines only as silent shadows (`taken`) so his alarms stay honest. The
    // kitchen, juice and buna lanes (and any admin looking over a shoulder)
    // keep the full open board exactly as before. The `shift` block feeds the
    // 20-minute hand-over countdown and the standby screen on the tablet.
    if (station === HANDOVER_STATION && stationRole === HANDOVER_STATION) {
      const session = await readStaffSession();
      const viewerName = String(session?.name || "").trim();
      const { info, owners } = await baristaHandoverNow();
      const rule = baristaViewer({
        name: viewerName,
        phase: info.phase,
        morningOwner: owners.morning?.staffName || null,
        afternoonOwner: owners.afternoon?.staffName || null,
      });
      const view = filterBaristaLive(payload, { name: viewerName, seesPending: rule.seesPending });
      return NextResponse.json(
        {
          tickets: view,
          serverTime: new Date().toISOString(),
          shift: {
            phase: info.phase,
            splitHour: info.splitHour,
            windowStart: info.windowStart.toISOString(),
            windowEnd: info.windowEnd.toISOString(),
            seesPending: rule.seesPending,
            canAcceptPending: rule.canAcceptPending,
            myShift: rule.myShift,
            // A full-day barista: he kept the morning and continued.
            alsoMorning: rule.alsoMorning,
            // The standby screen names whoever holds the board away from me,
            // and the buttons I may tap right now.
            blockedBy: rule.blockedBy,
            canTakeOverMorning: rule.canTakeOverMorning,
            canContinueAfternoon: rule.canContinueAfternoon,
            owners: {
              morning: owners.morning
                ? { name: owners.morning.staffName, at: owners.morning.claimedAt ? new Date(owners.morning.claimedAt).toISOString() : null }
                : null,
              afternoon: owners.afternoon
                ? { name: owners.afternoon.staffName, at: owners.afternoon.claimedAt ? new Date(owners.afternoon.claimedAt).toISOString() : null }
                : null,
            },
          },
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

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
        // Hand-over reads (barista lane): who already owns this line?
        stationStatus: ticketItems.stationStatus,
        stationStatusBy: ticketItems.stationStatusBy,
        stationAcceptedBy: ticketItems.stationAcceptedBy,
        stationDoneBy: ticketItems.stationDoneBy,
      })
      .from(ticketItems)
      .where(eq(ticketItems.id, Number(body.itemId)))
      .limit(1);
    if (existing.length === 0) return NextResponse.json({ error: "Item not found" }, { status: 404 });
    if (stationRole !== "admin" && existing[0].stationName !== stationRole) {
      return NextResponse.json({ error: "Item belongs to another station" }, { status: 403 });
    }

    // ── THE BARISTA HAND-OVER (owner, Sept 2026) ──
    // Barista lane only, staff taps only (an admin acting for the crew keeps
    // the old free hand): every accepted line belongs to ONE pair of hands,
    // and the first accept of a shift REGISTERS the acceptor as that shift's
    // owner for the day. Who accepted a drink is the one who finishes it.
    if (stationRole === HANDOVER_STATION) {
      const session = await readStaffSession();
      const viewerName = String(session?.name || "").trim();
      const line = existing[0];
      const acceptedBy = lineAcceptedOwner(line);
      const doneBy = lineDoneOwner(line);

      if (nextStatus === "accepted") {
        // A line already taken stays with its owner — the second tapper hears
        // a name, never a silent overwrite (this is where the "missed item"
        // arguments used to start).
        if (acceptedBy && acceptedBy !== viewerName) {
          return NextResponse.json({ error: `Already accepted • ${acceptedBy} is on it` }, { status: 409 });
        }
        const { info, owners } = await baristaHandoverNow();
        const rule = baristaViewer({
          name: viewerName,
          phase: info.phase,
          morningOwner: owners.morning?.staffName || null,
          afternoonOwner: owners.afternoon?.staffName || null,
        });
        if (!acceptedBy && !rule.canAcceptPending) {
          if (rule.myShift === "morning") {
            return NextResponse.json(
              { error: "Your hand-over window has ended • finish the drinks you accepted" },
              { status: 403 }
            );
          }
          const holder = info.phase === "open" ? owners.morning : owners.afternoon;
          const holderShift = info.phase === "open" ? "morning" : "afternoon";
          return NextResponse.json(
            { error: holder ? `${holder.staffName} is the ${holderShift} shift today • new orders are only on their screen` : "New orders are not yours to take right now" },
            { status: 403 }
          );
        }
        // THE FIRST DRINK REGISTERS YOU: not holding any claim yet, this
        // accept makes the shift yours. The unique (station, day, shift)
        // index decides a same-second race; the loser hears who won.
        if (!rule.myShift && info.dayKey) {
          const intended = claimShiftFor(new Date(), info.splitHour);
          const gate = canRegisterClaim({
            name: viewerName,
            claimShift: intended,
            morningOwner: owners.morning?.staffName || null,
            afternoonOwner: owners.afternoon?.staffName || null,
          });
          if (!gate.ok) {
            return NextResponse.json(
              {
                error:
                  gate.reason === "double-shift"
                    ? "You already hold the morning shift today • one person can not hold both shifts"
                    : `${gate.holder} registered as the ${intended} shift first`,
              },
              { status: 409 }
            );
          }
          const inserted = await db
            .insert(stationShiftClaims)
            .values({ station: HANDOVER_STATION, dayKey: info.dayKey, shiftName: intended, staffName: viewerName })
            .onConflictDoNothing()
            .returning({ id: stationShiftClaims.id });
          if (inserted.length === 0 && owners.morning?.staffName !== viewerName && owners.afternoon?.staffName !== viewerName) {
            // Lost the race between our read and our write: read who won.
            const fresh = await readBaristaClaims(info.dayKey);
            const winner = intended === "morning" ? fresh.morning : fresh.afternoon;
            if (winner && winner.staffName !== viewerName) {
              return NextResponse.json({ error: `${winner.staffName} registered as the ${intended} shift first` }, { status: 409 });
            }
          }
        }
      } else if (nextStatus === "done") {
        // WHO ACCEPTS, FINISHES (owner's rule: the accepter clicks Done).
        // Unowned legacy lines (accepted before this rule) stay finishable.
        const owner = acceptedBy || doneBy;
        if (owner && owner !== viewerName) {
          return NextResponse.json({ error: `Only ${owner} can finish this drink • they accepted it` }, { status: 403 });
        }
      } else {
        // nextStatus === "pending" (un-accept): only the owner hands it back.
        if (acceptedBy && acceptedBy !== viewerName) {
          return NextResponse.json({ error: `Only ${acceptedBy} can hand this drink back` }, { status: 403 });
        }
      }
    }

    // CREW-ACTION AUDIT: stamp WHO pressed it and WHEN, so a "done" nobody
    // remembers pressing can always be traced to a person and a minute. An
    // admin acting on a crew's behalf is stamped as admin, never as the crew.
    const actorName =
      stationRole === "admin" ? "admin" : (await readStaffSession())?.name || stationRole;
    const stampAt = new Date();
    // BARISTA HAND-OVER: the accept writes ownership, so it must also WIN
    // ownership atomically — during the 20-minute window two baristas can tap
    // the same pending line in the same second. The WHERE clause lets the
    // write land only while the line is still unowned (or already mine): the
    // loser gets 0 rows back and hears the winner's name, never a silent
    // steal. (The checks above answer fast; this covers the last millisecond.)
    const baristaAcceptGuard =
      stationRole === HANDOVER_STATION && nextStatus === "accepted"
        ? sql`(${ticketItems.stationAcceptedBy} IS NULL OR ${ticketItems.stationAcceptedBy} = '' OR ${ticketItems.stationAcceptedBy} = ${String(actorName).slice(0, 100)})`
        : null;
    const updated = await db
      .update(ticketItems)
      .set({
        stationStatus: nextStatus,
        stationStatusBy: String(actorName).slice(0, 100),
        stationStatusAt: new Date(),
        // Shift report: keep the accept AND the done step separately.
        ...(nextStatus === "accepted"
          ? { stationAcceptedBy: String(actorName).slice(0, 100), stationAcceptedAt: stampAt }
          : nextStatus === "done"
            ? { stationDoneBy: String(actorName).slice(0, 100), stationDoneAt: stampAt }
            : { stationDoneBy: null, stationDoneAt: null }),
      })
      .where(baristaAcceptGuard ? and(eq(ticketItems.id, Number(body.itemId)), baristaAcceptGuard) : eq(ticketItems.id, Number(body.itemId)))
      .returning();
    if (updated.length === 0 && baristaAcceptGuard) {
      const nowOwned = await db
        .select({ stationAcceptedBy: ticketItems.stationAcceptedBy })
        .from(ticketItems)
        .where(eq(ticketItems.id, Number(body.itemId)))
        .limit(1);
      const owner = String(nowOwned[0]?.stationAcceptedBy || "").trim();
      return NextResponse.json({ error: `Already accepted • ${owner || "another barista"} is on it` }, { status: 409 });
    }

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

    // A RELEASED BILL CLOSES ITSELF (owner's decision, Sept 2026)
    // The cashier's PRINT already cleared the table, and the waiters kept
    // forgetting the last tap, so a finished bill used to sit "open" forever.
    // Now: once every live line on a bill whose table was already freed is
    // done, the bill closes itself. Nothing is lost — the EFD receipt is the
    // money record and the bill stays in Printed Today and in the reports.
    try {
      const bill = await db
        .select({
          status: tickets.status,
          orderType: tickets.orderType,
          printedAt: tickets.printedAt,
          tableName: tickets.tableName,
        })
        .from(tickets)
        .where(eq(tickets.id, existing[0].ticketId))
        .limit(1);
      if (bill.length > 0 && isTableReleased(bill[0]) && bill[0].status !== "closed") {
        const siblings = await db
          .select({ stationStatus: ticketItems.stationStatus })
          .from(ticketItems)
          .where(and(eq(ticketItems.ticketId, existing[0].ticketId), eq(ticketItems.removed, false)));
        if (allLinesFinished(siblings)) {
          await db
            .update(tickets)
            .set({ status: "closed", closedAt: new Date(), closedBy: "cashier print", updatedAt: new Date() })
            .where(and(eq(tickets.id, existing[0].ticketId), eq(tickets.status, bill[0].status)));
        }
      }
    } catch {
      // A cleanup hiccup must never fail the crew's Done tap.
    }

    publish(CHANNELS.orders);
    return NextResponse.json(updated[0]);
  } catch (error) {
    console.error("[station-items PUT error]", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

/**
 * POST — the two barista SHIFT actions (owner's decision, Sept 2026).
 *
 *   { action: "take-morning" }       — "No, this is my shift, add me"
 *   { action: "continue-afternoon" } — "I will continue as afternoon shift"
 *
 * Both are barista-lane only, and both need a SIGNED-IN barista (the admin
 * session can act on items, but a shift belongs to a person, never to the
 * owner looking over a shoulder).
 *
 * THE MORNING CAN BE TAKEN. While the morning shift is still live (phase
 * "open") and somebody else holds it, another barista may take it over. The
 * claim moves to him AND every drink the previous man had already accepted
 * but not finished moves with it, so nothing is left in a pair of hands that
 * is no longer allowed to work: the previous barista walks back to the
 * standby screen, exactly as the owner described it. (The AFTERNOON is never
 * taken this way: it changes hands only through the morning owner continuing
 * into it.)
 *
 * THE MORNING CAN CONTINUE. Once the 20-minute window has closed, the day's
 * morning owner may register himself as the afternoon owner, but only while
 * NOBODY else holds the afternoon. This is the one explicit door to a
 * full-day barista; accepting drinks never writes a double shift.
 */
export async function POST(request: Request) {
  const __auth = await requireStaffOrAdmin();
  if (!__auth.ok) return __auth.response;
  await ensureTablesExist();
  const stationRole = await authorizedStation();
  if (stationRole !== HANDOVER_STATION) {
    return NextResponse.json({ error: "Barista station role required" }, { status: 403 });
  }
  try {
    const body = await request.json().catch(() => null);
    const action = String(body?.action || "");
    const session = await readStaffSession();
    const viewerName = String(session?.name || "").trim();
    if (!viewerName) return NextResponse.json({ error: "Sign in as a barista first" }, { status: 403 });

    const { info, owners } = await baristaHandoverNow();
    if (!info.dayKey) return NextResponse.json({ error: "Could not read the day" }, { status: 500 });

    if (action === "take-morning") {
      if (info.phase !== "open") {
        return NextResponse.json({ error: "The morning shift is over • it can not be taken anymore" }, { status: 409 });
      }
      const holder = owners.morning;
      if (!holder) {
        return NextResponse.json({ error: "Nobody holds the morning shift yet • accept your first drink" }, { status: 409 });
      }
      if (holder.staffName === viewerName) {
        return NextResponse.json({ ok: true, action, staffName: viewerName });
      }
      // 1. Move the claim itself. The WHERE clause names the man who holds it
      //    right now, so a same-second race ends with exactly one winner: the
      //    second tapper matches no row and hears that the shift moved.
      const moved = await db
        .update(stationShiftClaims)
        .set({ staffName: viewerName, claimedAt: new Date() })
        .where(
          and(
            eq(stationShiftClaims.station, HANDOVER_STATION),
            eq(stationShiftClaims.dayKey, info.dayKey),
            eq(stationShiftClaims.shiftName, "morning"),
            eq(stationShiftClaims.staffName, holder.staffName)
          )
        )
        .returning({ id: stationShiftClaims.id });
      if (moved.length === 0) {
        const fresh = await readBaristaClaims(info.dayKey);
        const winner = fresh.morning;
        return NextResponse.json(
          { error: winner && winner.staffName !== viewerName ? `${winner.staffName} took the morning shift first` : "The morning shift already changed hands" },
          { status: 409 }
        );
      }
      // 2. The drinks he had already accepted come with the shift: the man who
      //    left can no longer finish them, and a started drink must never sit
      //    ownerless. Finished lines keep HIS name — that work was his.
      await db
        .update(ticketItems)
        .set({ stationAcceptedBy: viewerName, stationStatusBy: viewerName, stationStatusAt: new Date() })
        .where(
          and(
            eq(ticketItems.stationName, HANDOVER_STATION),
            eq(ticketItems.removed, false),
            eq(ticketItems.stationStatus, "accepted"),
            sql`COALESCE(NULLIF(${ticketItems.stationAcceptedBy}, ''), ${ticketItems.stationStatusBy}) = ${holder.staffName}`
          )
        );
      publish(CHANNELS.orders);
      return NextResponse.json({ ok: true, action, staffName: viewerName, from: holder.staffName });
    }

    if (action === "continue-afternoon") {
      if (info.phase !== "after") {
        return NextResponse.json({ error: "The hand-over window is still running • wait for the counter" }, { status: 409 });
      }
      if (!owners.morning || owners.morning.staffName !== viewerName) {
        return NextResponse.json({ error: "Only today's morning barista can continue into the afternoon" }, { status: 403 });
      }
      if (owners.afternoon && owners.afternoon.staffName !== viewerName) {
        return NextResponse.json({ error: `${owners.afternoon.staffName} already holds the afternoon shift` }, { status: 409 });
      }
      if (owners.afternoon?.staffName === viewerName) {
        return NextResponse.json({ ok: true, action, staffName: viewerName });
      }
      const inserted = await db
        .insert(stationShiftClaims)
        .values({ station: HANDOVER_STATION, dayKey: info.dayKey, shiftName: "afternoon", staffName: viewerName })
        .onConflictDoNothing()
        .returning({ id: stationShiftClaims.id });
      if (inserted.length === 0) {
        const fresh = await readBaristaClaims(info.dayKey);
        const winner = fresh.afternoon;
        if (winner && winner.staffName !== viewerName) {
          return NextResponse.json({ error: `${winner.staffName} already holds the afternoon shift` }, { status: 409 });
        }
      }
      publish(CHANNELS.orders);
      return NextResponse.json({ ok: true, action, staffName: viewerName });
    }

    return NextResponse.json({ error: "Unknown shift action" }, { status: 400 });
  } catch (error) {
    console.error("[station-items POST error]", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
