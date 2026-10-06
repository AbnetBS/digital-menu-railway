import { NextResponse } from "next/server";
import { db } from "@/db";
import { categories, siteSettings, ticketEvents, ticketItems, tickets } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { and, eq, gte, inArray, or } from "drizzle-orm";
import { readAdminSession, readStaffSession } from "@/lib/session";
import { STATION_SALES_VISIBILITY_KEY, isStationSalesVisible } from "@/lib/station-sales-visibility";
import { isStationName, type StationName } from "@/lib/stations";
import {
  buildStationSales,
  salesPeriodCutoff,
  salesPeriodOf,
  type SalesPeriod,
} from "@/lib/station-sales";

/**
 * GET /api/station-sales?period=today|yesterday|dayBefore|week|month
 *
 * The crew's own "Items sold" tab: what THIS kitchen / barista / juice maker
 * sold, per menu category, for the period they tapped, split into the two piles
 * they can choose (accepted / done). All the counting rules live in the pure
 * `@/lib/station-sales` module — this route only authenticates and reads the
 * rows.
 *
 * An action belongs to the day it was TAPPED, never to the day the bill was
 * opened, so a late order finished after midnight lands on the right day for
 * the person who finished it. Removed lines and cancelled bills are not sold.
 *
 * An owner (admin session) may ask for any station with `?station=kitchen` and,
 * optionally, one person with `?staff=Abel`; without `staff` the whole crew's
 * taps are counted together.
 */
export async function GET(request: Request) {
  const staff = await readStaffSession();
  const isAdmin = staff ? false : !!(await readAdminSession());
  if (!staff && !isAdmin) {
    return NextResponse.json({ error: "Station login required" }, { status: 401 });
  }
  await ensureTablesExist();

  const params = new URL(request.url).searchParams;
  const period: SalesPeriod = salesPeriodOf(params.get("period"));

  // Whose numbers, and for which crew: a logged-in crew member only ever sees
  // their OWN lane and their OWN taps; an admin picks the lane on the query.
  let station: StationName;
  let person: string | null;
  if (staff) {
    // A waiter or a cashier has no making lane of their own here.
    if (!isStationName(staff.role)) {
      return NextResponse.json({ error: "Station login required" }, { status: 403 });
    }
    station = staff.role;
    person = staff.name || null;
  } else {
    const wanted = params.get("station");
    station = isStationName(wanted) ? wanted : "kitchen";
    person = (params.get("staff") || "").trim() || null;
  }

  try {
    const settings = await db
      .select({ key: siteSettings.key, value: siteSettings.value })
      .from(siteSettings)
      .where(inArray(siteSettings.key, [STATION_SALES_VISIBILITY_KEY, "cashier_mode"]));
    const visibilityRaw = settings.find((setting) => setting.key === STATION_SALES_VISIBILITY_KEY)?.value;
    // Admins can inspect every lane; a crew login is denied only while its
    // admin-controlled sales view is switched off (the feature is not deleted).
    if (staff && !isStationSalesVisible(visibilityRaw, station)) {
      return NextResponse.json({ error: "Station sales are hidden by the admin", code: "STATION_SALES_HIDDEN" }, { status: 403 });
    }
    const printQueueMode = settings.find((setting) => setting.key === "cashier_mode")?.value !== "full";

    // One bounded read: this station's lines touched since the period's oldest
    // Ethiopian midnight, including changes to an older ticket that was just
    // printed or closed during this period.
    const cutoff = salesPeriodCutoff(period);
    const rows = await db
      .select({
        id: ticketItems.id,
        ticketId: ticketItems.ticketId,
        name: ticketItems.name,
        category: ticketItems.category,
        price: ticketItems.price,
        quantity: ticketItems.quantity,
        removed: ticketItems.removed,
        stationStatus: ticketItems.stationStatus,
        stationStatusBy: ticketItems.stationStatusBy,
        stationStatusAt: ticketItems.stationStatusAt,
        stationAcceptedBy: ticketItems.stationAcceptedBy,
        stationAcceptedAt: ticketItems.stationAcceptedAt,
        stationDoneBy: ticketItems.stationDoneBy,
        stationDoneAt: ticketItems.stationDoneAt,
        createdAt: ticketItems.createdAt,
        ticketStatus: tickets.status,
        ticketPrintedAt: tickets.printedAt,
        ticketCreatedAt: tickets.createdAt,
        ticketClosedAt: tickets.closedAt,
        ticketUpdatedAt: tickets.updatedAt,
      })
      .from(ticketItems)
      .leftJoin(tickets, eq(tickets.id, ticketItems.ticketId))
      .where(
        and(
          eq(ticketItems.stationName, station),
          eq(ticketItems.removed, false),
          or(
            gte(ticketItems.stationAcceptedAt, cutoff),
            gte(ticketItems.stationDoneAt, cutoff),
            // Lines stamped before the accept/done columns existed only carry
            // the LAST tap — without this they would read as an empty day.
            gte(ticketItems.stationStatusAt, cutoff),
            // A ticket may have been opened earlier but printed/closed today.
            gte(tickets.printedAt, cutoff),
            gte(tickets.closedAt, cutoff),
            gte(tickets.updatedAt, cutoff),
            gte(tickets.createdAt, cutoff),
            // In full-payment mode, post-close records qualify by sale time.
            gte(ticketItems.createdAt, cutoff)
          )
        )
      );

    // The owner's own wording for each category slug ("hot-drinks" → "Hot
    // Drinks"), the same mapping the reports use.
    const ticketIds = [...new Set(rows.map((row) => row.ticketId))];
    const [cats, printEvents] = await Promise.all([
      db.select({ slug: categories.slug, name: categories.name }).from(categories),
      ticketIds.length
        ? db.select({
            ticketId: ticketEvents.ticketId,
            itemId: ticketEvents.itemId,
            eventType: ticketEvents.eventType,
            fromValue: ticketEvents.fromValue,
            toValue: ticketEvents.toValue,
            createdAt: ticketEvents.createdAt,
          })
            .from(ticketEvents)
            .where(and(inArray(ticketEvents.ticketId, ticketIds), inArray(ticketEvents.eventType, ["ticket_printed", "item_quantity_changed"])))
        : Promise.resolve([]),
    ]);
    const categoryNames: Record<string, string> = {};
    for (const c of cats) if (c.slug && c.slug !== "all") categoryNames[c.slug] = c.name;
    const printEventsByTicket = new Map<number, Array<Date | string | null>>();
    const quantityEventsByTicket = new Map<number, Array<{
      itemId: number | null;
      eventType: string;
      fromValue: string | null;
      toValue: string | null;
      createdAt: Date | null;
    }>>();
    for (const event of printEvents) {
      if (event.eventType === "ticket_printed") {
        const events = printEventsByTicket.get(event.ticketId) || [];
        events.push(event.createdAt);
        printEventsByTicket.set(event.ticketId, events);
      } else if (event.eventType === "item_quantity_changed") {
        const events = quantityEventsByTicket.get(event.ticketId) || [];
        events.push(event);
        quantityEventsByTicket.set(event.ticketId, events);
      }
    }

    const salesRows = rows.map((row) => ({
      ...row,
      ticketPrintEvents: printEventsByTicket.get(row.ticketId) || [],
      ticketQuantityEvents: quantityEventsByTicket.get(row.ticketId) || [],
      ticketSaleAt: row.ticketPrintedAt || row.ticketClosedAt || row.ticketUpdatedAt || row.ticketCreatedAt,
    }));
    const report = buildStationSales({ period, station, staff: person, rows: salesRows, categoryNames, printQueueMode });
    // A CREW SCREEN ALSO GETS ITS WHOLE LANE'S PILES (owner, 29 Sept 2026:
    // "make it to show the total sale"). The signed-in person's own numbers
    // stay the report itself (the shift report cross-checks them one to one),
    // but the lane's total is what the crew reads on their own screen when the
    // tablet is signed in as somebody who did not tap today — or when the
    // cashier's print closed the lines before they were tapped. Same rows,
    // same rules, me = everybody.
    const lane = staff
      ? buildStationSales({ period, station, staff: null, rows: salesRows, categoryNames, printQueueMode }).modes
      : undefined;
    return NextResponse.json(lane ? { ...report, lane } : report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[station-sales error]", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
