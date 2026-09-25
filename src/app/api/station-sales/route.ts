import { NextResponse } from "next/server";
import { db } from "@/db";
import { categories, ticketItems, tickets } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { and, eq, gte, or } from "drizzle-orm";
import { readAdminSession, readStaffSession } from "@/lib/session";
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
 * sold, per menu category, for the period they tapped, split into the three
 * piles they can choose (accepted / done / combined). All the counting rules
 * live in the pure `@/lib/station-sales` module — this route only authenticates
 * and reads the rows.
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
    // One bounded read: this station's lines touched since the period's oldest
    // Ethiopian midnight (the day matching itself happens in the pure module,
    // so a rolling "Last 7 Days" can never drop today again).
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
        ticketStatus: tickets.status,
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
            gte(ticketItems.stationStatusAt, cutoff)
          )
        )
      );

    // The owner's own wording for each category slug ("hot-drinks" → "Hot
    // Drinks"), the same mapping the reports use.
    const cats = await db.select({ slug: categories.slug, name: categories.name }).from(categories);
    const categoryNames: Record<string, string> = {};
    for (const c of cats) if (c.slug && c.slug !== "all") categoryNames[c.slug] = c.name;

    const report = buildStationSales({ period, station, staff: person, rows, categoryNames });
    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[station-sales error]", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
