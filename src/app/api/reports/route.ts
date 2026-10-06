import { NextResponse } from "next/server";
import { db } from "@/db";
import { tickets, ticketItems, categories, orderSubmissions, ticketEvents, staffUsers, siteSettings } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { and, inArray, or, gt, eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/session";
import { isLegacyAuditNote } from "@/lib/shift-report";
import { stationOf, STATION_NAMES, type StationName } from "@/lib/stations";
import { receiptPrintTimes, saleLinesForTicket, sumSaleItems, type SalesItemEventLike } from "@/lib/printed-sales";
import {
  isTodayET,
  isYesterdayET,
  isDayBeforeYesterdayET,
  isWithinEtDays,
  isOnEtDayDaysAgo,
  etHour,
  etDayKeyDaysAgo,
  etStartOfDaysAgo,
} from "@/lib/timezone";

// Day boundaries follow the ETHIOPIAN wall clock (see @/lib/timezone), never
// the server's: the office PC and the report must agree on what "today" is.
// Every window here is a CALENDAR window (isWithinEtDays / isOnEtDayDaysAgo),
// so "Last 30 Days" is exactly 30 Ethiopian days — today plus the 29 before it
// — and slides forward one day at a time instead of resetting each month.


/**
 * PERIOD REPORTS (owner, Sept 2026): ?period=today (default) | yesterday |
 * dayBefore | week | month. The five summary cards are ALWAYS all-period (they
 * are the selector), but every section below them — station cross-check, KPIs,
 * peak hours, highest-selling, categories, receipts and the printed-bills
 * archive — describes ONLY the selected period. Callers without ?period= get
 * exactly the old today-based response (the order-history feed never takes a
 * period).
 *
 * `dayBefore` is the day BEFORE yesterday: the cross-checker sometimes has to
 * settle a bill pile two mornings later, and "Last 7 Days" mixes it with six
 * other days.
 */
const PERIOD_LABELS = {
  today: "Today",
  yesterday: "Yesterday",
  dayBefore: "Day Before Yesterday",
  week: "Last 7 Days",
  month: "Last 30 Days",
} as const;
type Period = keyof typeof PERIOD_LABELS;

/**
 * How many EAT calendar days each period covers, and how far back it starts.
 * `today`/`yesterday`/`dayBefore` are ONE day each; `week` is today + the 6
 * days before it, `month` today + the 29 days before it — exactly 30 days,
 * never "since the 1st of the month".
 */
const PERIOD_START_DAYS_AGO: Record<Period, number> = {
  today: 0,
  yesterday: 1,
  dayBefore: 2,
  week: 6,
  month: 29,
};
const PERIOD_LENGTH_DAYS: Record<Period, number> = {
  today: 1,
  yesterday: 1,
  dayBefore: 1,
  week: 7,
  month: 30,
};

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function quoted(value: string | null | undefined): string {
  const text = String(value || "").trim();
  return text ? `“${text}”` : "empty";
}

function historyStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    done: "Done",
    edited_printed: "Edited & Printed",
    edited_cancelled: "Edited & Cancelled",
    cancelled: "Cancelled",
  };
  return labels[status] || status;
}

function humanTicketStatus(status: string | null | undefined): string {
  const value = String(status || "");
  const labels: Record<string, string> = {
    pending_waiter: "pending waiter",
    ready_for_payment: "ready for payment",
  };
  return labels[value] || value.replace(/_/g, " ");
}

/**
 * The one-time audit backfill wrote technical notes ("Legacy print
 * backfill"...) on old bills. The label already says what happened, so those
 * notes are dropped instead of shown to staff.
 */
function auditDetail(details: string | null | undefined): string | null {
  return details && !isLegacyAuditNote(details) ? details : null;
}

function buildAuditEvent(event: typeof ticketEvents.$inferSelect) {
  const actor = event.actorName ? ` • ${event.actorName}` : "";
  switch (event.eventType) {
    case "ticket_created":
      return {
        id: event.id,
        eventType: event.eventType,
        actorName: event.actorName,
        actorRole: event.actorRole,
        source: event.source,
        itemId: event.itemId,
        itemName: event.itemName,
        fromValue: event.fromValue,
        toValue: event.toValue,
        details: event.details,
        createdAt: toIso(event.createdAt),
        label: "Order created",
        detail: auditDetail(event.details),
      };
    case "submission_added":
      return {
        id: event.id,
        eventType: event.eventType,
        actorName: event.actorName,
        actorRole: event.actorRole,
        source: event.source,
        itemId: event.itemId,
        itemName: event.itemName,
        fromValue: event.fromValue,
        toValue: event.toValue,
        details: event.details,
        createdAt: toIso(event.createdAt),
        label: `${event.source === "customer" ? "Guest" : event.actorRole === "cashier" ? "Cashier" : "Waiter"} added items${actor}`,
        detail: auditDetail(event.details),
      };
    case "item_quantity_changed":
      return {
        id: event.id,
        eventType: event.eventType,
        actorName: event.actorName,
        actorRole: event.actorRole,
        source: event.source,
        itemId: event.itemId,
        itemName: event.itemName,
        fromValue: event.fromValue,
        toValue: event.toValue,
        details: event.details,
        createdAt: toIso(event.createdAt),
        label: `Quantity changed • ${event.itemName || "item"}${actor}`,
        detail: `${event.fromValue || "?"} → ${event.toValue || "?"}`,
      };
    case "item_notes_changed":
      return {
        id: event.id,
        eventType: event.eventType,
        actorName: event.actorName,
        actorRole: event.actorRole,
        source: event.source,
        itemId: event.itemId,
        itemName: event.itemName,
        fromValue: event.fromValue,
        toValue: event.toValue,
        details: event.details,
        createdAt: toIso(event.createdAt),
        label: `Note changed • ${event.itemName || "item"}${actor}`,
        detail: `${quoted(event.fromValue)} → ${quoted(event.toValue)}`,
      };
    case "item_removed":
      return {
        id: event.id,
        eventType: event.eventType,
        actorName: event.actorName,
        actorRole: event.actorRole,
        source: event.source,
        itemId: event.itemId,
        itemName: event.itemName,
        fromValue: event.fromValue,
        toValue: event.toValue,
        details: event.details,
        createdAt: toIso(event.createdAt),
        label: `Item removed • ${event.itemName || "item"}${actor}`,
        detail: event.fromValue || auditDetail(event.details),
      };
    case "ticket_sent":
      return {
        id: event.id,
        eventType: event.eventType,
        actorName: event.actorName,
        actorRole: event.actorRole,
        source: event.source,
        itemId: event.itemId,
        itemName: event.itemName,
        fromValue: event.fromValue,
        toValue: event.toValue,
        details: event.details,
        createdAt: toIso(event.createdAt),
        label: `Sent to stations${actor}`,
        detail: auditDetail(event.details),
      };
    case "ticket_printed":
      return {
        id: event.id,
        eventType: event.eventType,
        actorName: event.actorName,
        actorRole: event.actorRole,
        source: event.source,
        itemId: event.itemId,
        itemName: event.itemName,
        fromValue: event.fromValue,
        toValue: event.toValue,
        details: event.details,
        createdAt: toIso(event.createdAt),
        label: `Printed${actor}`,
        detail: auditDetail(event.details),
      };
    case "status_changed":
      return {
        id: event.id,
        eventType: event.eventType,
        actorName: event.actorName,
        actorRole: event.actorRole,
        source: event.source,
        itemId: event.itemId,
        itemName: event.itemName,
        fromValue: event.fromValue,
        toValue: event.toValue,
        details: event.details,
        createdAt: toIso(event.createdAt),
        label: `Status${actor}`,
        detail: `${humanTicketStatus(event.fromValue)} → ${humanTicketStatus(event.toValue)}`,
      };
    default:
      return {
        id: event.id,
        eventType: event.eventType,
        actorName: event.actorName,
        actorRole: event.actorRole,
        source: event.source,
        itemId: event.itemId,
        itemName: event.itemName,
        fromValue: event.fromValue,
        toValue: event.toValue,
        details: event.details,
        createdAt: toIso(event.createdAt),
        label: event.eventType.replace(/_/g, " "),
        detail: auditDetail(event.details),
      };
  }
}

function deriveHistory(ticket: typeof tickets.$inferSelect, events: Array<typeof ticketEvents.$inferSelect>) {
  const sortedEvents = [...events].sort(
    (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
  );
  const auditTrail = sortedEvents.map(buildAuditEvent);
  const editEvents = auditTrail.filter((event) =>
    ["item_quantity_changed", "item_notes_changed", "item_removed", "item_edited"].includes(event.eventType)
  );
  const hasEdits = editEvents.length > 0 || !!ticket.itemsEditedAt;
  const status =
    ticket.status === "cancelled"
      ? hasEdits
        ? "edited_cancelled"
        : "cancelled"
      : hasEdits && !!ticket.printedAt
      ? "edited_printed"
      : "done";
  const changeSummary = editEvents
    .slice(-3)
    .map((event) => event.detail || event.label)
    .filter(Boolean)
    .join(" • ");

  return {
    historyStatus: status,
    historyStatusLabel: historyStatusLabel(status),
    historyChangeSummary: changeSummary || null,
    auditTrail,
  };
}

export async function GET(request: Request) {
  const __auth = await requireAdmin();
  if (!__auth.ok) return __auth.response;
  await ensureTablesExist();
  const rawPeriod = new URL(request.url).searchParams.get("period");
  const period: Period =
    rawPeriod === "yesterday" || rawPeriod === "dayBefore" || rawPeriod === "week" || rawPeriod === "month"
      ? rawPeriod
      : "today";
  try {
    // WHICH MONEY SYSTEM is this cafe on? The owner's Settings switch
    // (cashier_mode): "print-queue" (the EFD workflow Fana runs) counts a bill
    // the moment the cashier taps ✓ PRINTED; "full" records payments in the app
    // instead and never prints. Unreadable setting → the print-queue default.
    let printQueueMode = true;
    try {
      const modeRows = await db.select().from(siteSettings).where(eq(siteSettings.key, "cashier_mode"));
      printQueueMode = String(modeRows[0]?.value || "print-queue") !== "full";
    } catch {
      /* unreadable setting → the default (print-queue) */
    }

    // RETENTION (owner's decision, Sept 2026): NOTHING is ever deleted here —
    // the reports and the order history simply READ a rolling window of exactly
    // 30 Ethiopian calendar days: today plus the 29 days before it. On 1 Oct
    // the window is 2 Sep – 1 Oct, so 1 Sep drops out of the report that same
    // day and the paper always covers exactly 30 days. It never resets on the
    // 1st of a month, and the rows stay in the database (only old receipt
    // PHOTOS are swept, by /api/tickets/cleanup).
    //
    // PERFORMANCE: scoping the tickets query in SQL keeps this endpoint from
    // loading the entire table forever; items are fetched ONLY for those
    // tickets. printedAt joins the cutoff list because a bill printed inside
    // the window is a window sale even if it was opened before it.
    const cutoff = etStartOfDaysAgo(PERIOD_START_DAYS_AGO.month);

    const allTickets = await db
      .select()
      .from(tickets)
      .where(
        or(
          gt(tickets.createdAt, cutoff),
          gt(tickets.updatedAt, cutoff),
          gt(tickets.closedAt, cutoff),
          gt(tickets.printedAt, cutoff)
        )
      );

    type ItemRow = typeof ticketItems.$inferSelect;
    type EventRow = typeof ticketEvents.$inferSelect;
    const ticketIds = allTickets.map((ticket) => ticket.id);
    const emptyItems: ItemRow[] = [];
    const emptyEvents: EventRow[] = [];
    const [cats, waiters, recentStaffSubmissions, allItems, receiptEvents] = await Promise.all([
      db.select().from(categories),
      db.select().from(staffUsers),
      db.select().from(orderSubmissions).where(gt(orderSubmissions.createdAt, cutoff)),
      ticketIds.length
        ? db.select().from(ticketItems).where(inArray(ticketItems.ticketId, ticketIds))
        : Promise.resolve(emptyItems),
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
        : Promise.resolve(emptyEvents),
    ]);

    const itemsByTicket = new Map<number, ItemRow[]>();
    for (const item of allItems) {
      if (!itemsByTicket.has(item.ticketId)) itemsByTicket.set(item.ticketId, []);
      itemsByTicket.get(item.ticketId)!.push(item);
    }
    const printEventsByTicket = new Map<number, Array<Date | string | null>>();
    const quantityEventsByTicket = new Map<number, SalesItemEventLike[]>();
    for (const event of receiptEvents) {
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

    type ReceiptLine = { item: ItemRow; soldAt: Date | string | null | undefined };
    const saleLinesByTicket = new Map<number, ReceiptLine[]>();
    for (const ticket of allTickets) {
      const lines = saleLinesForTicket(
        ticket,
        itemsByTicket.get(ticket.id) || [],
        printQueueMode,
        printEventsByTicket.get(ticket.id) || [],
        quantityEventsByTicket.get(ticket.id) || [],
      );
      saleLinesByTicket.set(ticket.id, lines);
    }
    const soldQuantityByTicket = new Map<number, Map<number, number>>();
    for (const [ticketId, lines] of saleLinesByTicket) {
      const quantities = new Map<number, number>();
      for (const line of lines) {
        quantities.set(line.item.id, (quantities.get(line.item.id) || 0) + (Number(line.item.quantity) || 0));
      }
      soldQuantityByTicket.set(ticketId, quantities);
    }

    // A separate receipt is a separate sale moment. Group each ticket's lines
    // by the first cashier print at/after the line was added; a reprint of new
    // additions never moves or recounts the original receipt lines.
    type PeriodSaleTicket = (typeof allTickets)[number] & {
      saleAmount: number;
      saleLines: ReceiptLine[];
      saleItems: ItemRow[];
    };
    const ticketsSoldDuring = (inDate: (date: Date | string | null | undefined) => boolean): PeriodSaleTicket[] =>
      allTickets.flatMap((ticket) => {
        const lines = (saleLinesByTicket.get(ticket.id) || []).filter((line) => line.soldAt && inDate(line.soldAt));
        if (!lines.length) return [];
        const saleItems = lines.map((line) => line.item);
        return [{
          ...ticket,
          saleAmount: sumSaleItems(saleItems),
          saleLines: lines,
          saleItems,
        }];
      });
    const todayTickets = ticketsSoldDuring(isTodayET);
    const yesterdayTickets = ticketsSoldDuring(isYesterdayET);
    const dayBeforeTickets = ticketsSoldDuring(isDayBeforeYesterdayET);
    const weekTickets = ticketsSoldDuring((date) => isWithinEtDays(date, PERIOD_LENGTH_DAYS.week));
    const monthTickets = ticketsSoldDuring((date) => isWithinEtDays(date, PERIOD_LENGTH_DAYS.month));

    const sumOf = (rows: PeriodSaleTicket[]) => rows.reduce((sum, ticket) => sum + ticket.saleAmount, 0);
    const todayRevenue = sumOf(todayTickets);
    const yesterdayRevenue = sumOf(yesterdayTickets);
    const dayBeforeRevenue = sumOf(dayBeforeTickets);
    const weeklyRevenue = sumOf(weekTickets);
    const monthlyRevenue = sumOf(monthTickets);
    const todayOrders = todayTickets.length;
    const averageOrderValue = todayOrders > 0 ? Math.round(todayRevenue / todayOrders) : 0;

    // Last 7 days daily sales - sliding window, 7th day removed when new day starts
    // Each day is Ethiopian calendar day, not 24h window
    const last7DaysSales = Array.from({ length: 7 }, (_, i) => {
      const daysAgo = i; // 0 = today, 1 = yesterday, etc.
      const dayTickets = revenueTickets.filter((t) => isOnEtDayDaysAgo(soldAt(t), daysAgo));
      const dayKey = etDayKeyDaysAgo(daysAgo);
      const revenue = sumOf(dayTickets);
      const orders = dayTickets.length;
      const label = daysAgo === 0 ? "Today" : daysAgo === 1 ? "Yesterday" : `${daysAgo} days ago`;
      return {
        date: dayKey || "",
        dayKey: dayKey || "",
        label,
        revenue,
        orders,
      };
    }).reverse(); // oldest first for display: 6 days ago -> today

    // Every section below describes ONLY the selected period. The five summary
    // sets above stay all-period (they feed the selector cards).
    const scopeTickets =
      period === "yesterday" ? yesterdayTickets
      : period === "dayBefore" ? dayBeforeTickets
      : period === "week" ? weekTickets
      : period === "month" ? monthTickets
      : todayTickets;
    const inScopeDay =
      period === "yesterday" ? isYesterdayET
      : period === "dayBefore" ? isDayBeforeYesterdayET
      : period === "week" ? (d: Date | string | null | undefined) => isWithinEtDays(d, PERIOD_LENGTH_DAYS.week)
      : period === "month" ? (d: Date | string | null | undefined) => isWithinEtDays(d, PERIOD_LENGTH_DAYS.month)
      : isTodayET;

    // The exact EAT calendar dates this response covers, so the screen and the
    // printed paper can say "2 Sep 2026 – 1 Oct 2026" instead of leaving the
    // cross-checker guessing which 30 days they are holding.
    const periodRange = {
      from: etDayKeyDaysAgo(PERIOD_START_DAYS_AGO[period]),
      to: etDayKeyDaysAgo(PERIOD_START_DAYS_AGO[period] - PERIOD_LENGTH_DAYS[period] + 1),
      days: PERIOD_LENGTH_DAYS[period],
    };
    // The three single-day cards name their real date too ("Yesterday • 30 Sep").
    const dayKeys = {
      today: etDayKeyDaysAgo(0),
      yesterday: etDayKeyDaysAgo(1),
      dayBefore: etDayKeyDaysAgo(2),
    };

    // GROUP 4 / ITEM 2 — scope item reads to what the report ACTUALLY uses:
    //  • popular-items, category-sales & the STATION CROSS-CHECK need items of
    //    the SELECTED PERIOD'S sold tickets only
    //  • order history needs items of the newest 200 closed tickets only
    //  • the printed-bills archive (the admin's copy of the cashier's daily
    //    cross-check list) needs items of every bill printed in the period
    const saleAmountByTicketInScope = new Map(scopeTickets.map((ticket) => [ticket.id, ticket.saleAmount]));

    // ── PRINTED ARCHIVE (the paper world's receipt pile, registered as history) ──
    // Every bill the cashier keyed into the EFD in the selected period, whatever
    // happened to it afterwards (still open, later cleared). Cancelled bills are
    // excluded: a voided order is not a sale. Same rule as the cashier's own
    // "Printed Today" panel, so the two lists always agree on the today period.
    // Long periods cap the CARD list (a month of bills would bury the page and
    // the payload) but the TOTAL below always covers the whole period.
    const ARCHIVE_CAP = 60;
    const printedPeriodTickets = allTickets
      .filter((ticket) => ticket.status !== "cancelled" && receiptPrintTimes(ticket, printEventsByTicket.get(ticket.id) || []).some(inScopeDay))
      .sort((a, b) => new Date(b.printedAt || 0).getTime() - new Date(a.printedAt || 0).getTime());
    const archiveCapped = printedPeriodTickets.length > ARCHIVE_CAP;
    const printedTodayTickets = archiveCapped ? printedPeriodTickets.slice(0, ARCHIVE_CAP) : printedPeriodTickets;
    const printedTodayIds = printedTodayTickets.map((t) => t.id);
    const printedTodayTotal = printedPeriodTickets.reduce((sum, ticket) => {
      const receiptItems = (saleLinesByTicket.get(ticket.id) || [])
        .filter((line) => line.soldAt && inScopeDay(line.soldAt))
        .map((line) => line.item);
      return sum + sumSaleItems(receiptItems);
    }, 0);

    // Full-payment deployments never print, so there the paid/completed bills of
    // the period ARE the archive. In PRINT-QUEUE mode the archive is the EFD
    // receipt pile EXACTLY (owner's decision, Sept 2026): a bill the cashier
    // never keyed in has no paper, so it must not sit in the list the
    // cross-checker counts against her receipts — that is how "the report says
    // more than the EFD" confusion starts.
    const paidTodayIds = printQueueMode
      ? []
      : scopeTickets.filter((t) => !t.printedAt && !printedTodayIds.includes(t.id)).map((t) => t.id);

    const orderHistoryTickets = allTickets
      .filter((t) => t.status === "paid" || t.status === "completed" || t.status === "cancelled" || t.status === "closed")
      .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
      .slice(0, 200);
    const historyTicketIds = orderHistoryTickets.map((t) => t.id);

    const historySet = new Set(historyTicketIds);
    const historyItems = allItems.filter((item) => historySet.has(item.ticketId));
    const historyEvents = historyTicketIds.length
      ? await db.select().from(ticketEvents).where(inArray(ticketEvents.ticketId, historyTicketIds))
      : emptyEvents;
    const historyEventsByTicket = new Map<number, EventRow[]>();
    for (const event of historyEvents) {
      if (!historyEventsByTicket.has(event.ticketId)) historyEventsByTicket.set(event.ticketId, []);
      historyEventsByTicket.get(event.ticketId)!.push(event);
    }

    // Peak selling hours — the period's orders grouped by hour of the day.
    // Hours are read on the ETHIOPIAN wall clock, like the office PC shows.
    const hourAgg: Array<{ hour: number; orders: number; revenue: number }> = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      orders: 0,
      revenue: 0,
    }));
    const ticketIdsByHour = Array.from({ length: 24 }, () => new Set<number>());
    for (const ticket of scopeTickets) {
      for (const line of ticket.saleLines) {
        if (!line.soldAt) continue;
        const hour = etHour(line.soldAt as Date);
        ticketIdsByHour[hour].add(ticket.id);
        hourAgg[hour].revenue += (Number(line.item.price) || 0) * (Number(line.item.quantity) || 0);
      }
    }
    for (let hour = 0; hour < hourAgg.length; hour += 1) {
      hourAgg[hour].orders = ticketIdsByHour[hour].size;
    }
    const hourlySales = hourAgg.filter((h) => h.orders > 0);
    const peakHour =
      hourlySales.length > 0 ? hourlySales.reduce((a, b) => (b.revenue > a.revenue ? b : a), hourlySales[0]) : null;

    // Popular items, categories, and station totals use exactly the active lines
    // included in each ticket's printed receipt (or paid lines in full mode).
    const todayItems = scopeTickets.flatMap((ticket) => ticket.saleItems);
    const totalItems = todayItems.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
    const itemAgg = new Map<string, { quantity: number; revenue: number }>();
    for (const it of todayItems) {
      const cur = itemAgg.get(it.name) || { quantity: 0, revenue: 0 };
      cur.quantity += it.quantity;
      cur.revenue += it.price * it.quantity;
      itemAgg.set(it.name, cur);
    }
    const categoryNames = cats.filter((c) => c.slug !== "all").map((c) => ({ slug: c.slug, name: c.name }));
    const itemToCatName = (slug: string | null | undefined) =>
      categoryNames.find((c) => c.slug === slug)?.name || slug || "General";

    const popularItems = Array.from(itemAgg.entries())
      .map(([name, v]) => ({ name, quantity: v.quantity, revenue: v.revenue }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 8);

    // Sales by category — units AND revenue, so the printed report can show
    // both the amount sold and the total price per category.
    const catAgg = new Map<string, { quantity: number; revenue: number }>();
    for (const it of todayItems) {
      const cName = itemToCatName(it.category);
      const cur = catAgg.get(cName) || { quantity: 0, revenue: 0 };
      cur.quantity += it.quantity;
      cur.revenue += it.price * it.quantity;
      catAgg.set(cName, cur);
    }
    const categorySales = Array.from(catAgg.entries())
      .map(([category, v]) => ({ category, quantity: v.quantity, revenue: v.revenue }))
      .sort((a, b) => b.revenue - a.revenue);

    // ── CROSS-CHECK BY STATION (the paper world's four stacks) ──
    // Before this system, the cross-checker collected the kitchen's, the
    // barista's, the buna makers' and the juice maker's order papers, added each
    // pile, and compared the total with the cashier's EFD receipts. This is the
    // same four piles from the period's sold bills: per station the number of
    // bills it had lines on, the units it made and the ETB those lines add up to.
    type StationAgg = { orders: Set<number>; quantity: number; revenue: number };
    type StationItemAgg = Map<string, { quantity: number; revenue: number }>;
    const stationAgg = new Map<StationName, StationAgg>();
    for (const s of STATION_NAMES) stationAgg.set(s, { orders: new Set(), quantity: 0, revenue: 0 });
    const stationItemAgg = new Map<StationName, StationItemAgg>();
    for (const s of STATION_NAMES) stationItemAgg.set(s, new Map());
    for (const it of todayItems) {
      const station = stationOf(it.stationName);
      const agg = stationAgg.get(station)!;
      agg.orders.add(it.ticketId);
      agg.quantity += it.quantity;
      agg.revenue += it.price * it.quantity;
      const perItem = stationItemAgg.get(station)!;
      const cur = perItem.get(it.name) || { quantity: 0, revenue: 0 };
      cur.quantity += it.quantity;
      cur.revenue += it.price * it.quantity;
      perItem.set(it.name, cur);
    }
    const stationSales = STATION_NAMES.map((station) => {
      const agg = stationAgg.get(station)!;
      return { station, orders: agg.orders.size, quantity: agg.quantity, revenue: agg.revenue };
    });
    const stationItems = STATION_NAMES.flatMap((station) =>
      Array.from(stationItemAgg.get(station)!.entries())
        .map(([name, v]) => ({ station, name, quantity: v.quantity, revenue: v.revenue }))
        .sort((a, b) => b.quantity - a.quantity)
    );

    // Payment method statistics (kept for historical bills; the report UI no
    // longer shows methods — the EFD is the money system of record)
    const payAgg = new Map<string, { count: number; revenue: number }>();
    for (const t of scopeTickets) {
      const m = t.paymentMethod || "cash";
      const cur = payAgg.get(m) || { count: 0, revenue: 0 };
      cur.count += 1;
      cur.revenue += t.saleAmount;
      payAgg.set(m, cur);
    }
    const paymentStats = Array.from(payAgg.entries()).map(([method, v]) => ({
      method,
      count: v.count,
      revenue: v.revenue,
    }));

    // Waiter ranking (selected interval): separate counts for accepted orders
    // and directly created/sent submissions, plus a click-through list of the
    // underlying orders so the owner can audit each name.
    const ticketById = new Map(allTickets.map((ticket) => [ticket.id, ticket]));
    const waiterNames = new Set<string>();
    const cashierNames = new Set(
      waiters.filter((staff) => staff.role === "cashier").map((staff) => String(staff.name || "").trim()).filter(Boolean)
    );
    for (const staff of waiters) {
      if (staff.role === "waiter" && String(staff.name || "").trim()) waiterNames.add(String(staff.name || "").trim());
    }
    for (const submission of recentStaffSubmissions) {
      if (submission.source === "staff" && submission.waiterName && String(submission.waiterName).trim()) {
        const ticket = ticketById.get(submission.ticketId);
        if (ticket?.orderType !== "outdoor") waiterNames.add(String(submission.waiterName).trim());
      }
    }
    for (const ticket of allTickets) {
      const confirmer = String(ticket.confirmedBy || "").trim();
      if (!confirmer || /^customer/i.test(confirmer) || /^waiter$/i.test(confirmer) || cashierNames.has(confirmer)) continue;
      waiterNames.add(confirmer);
    }

    const acceptedOrders = allTickets
      .filter((ticket) => {
        const confirmer = String(ticket.confirmedBy || "").trim();
        return Boolean(confirmer) && waiterNames.has(confirmer) && inScopeDay(ticket.confirmedAt);
      })
      .map((ticket) => ({
        waiterName: String(ticket.confirmedBy || "").trim(),
        kind: "accepted" as const,
        ticketId: ticket.id,
        tableName: ticket.tableName,
        orderNumber: ticket.orderNumber,
        orderType: ticket.orderType,
        serviceNote: ticket.serviceNote,
        status: ticket.status,
        totalAmount: saleAmountByTicketInScope.get(ticket.id) || 0,
        happenedAt: toIso(ticket.confirmedAt),
        createdAt: toIso(ticket.createdAt),
        confirmedAt: toIso(ticket.confirmedAt),
        printedAt: toIso(ticket.printedAt),
        detail: ticket.orderType === "outdoor" ? "Accepted outdoor order" : "Accepted order",
      }));

    const directOrders = recentStaffSubmissions
      .filter((submission) => submission.source === "staff" && submission.waiterName && inScopeDay(submission.createdAt))
      .flatMap((submission) => {
        const ticket = ticketById.get(submission.ticketId);
        const waiterName = String(submission.waiterName || "").trim();
        if (!ticket || !waiterName || ticket.orderType === "outdoor") return [];
        return [{
          waiterName,
          kind: "direct" as const,
          ticketId: ticket.id,
          tableName: ticket.tableName,
          orderNumber: ticket.orderNumber,
          orderType: ticket.orderType,
          serviceNote: ticket.serviceNote,
          status: ticket.status,
          totalAmount: saleAmountByTicketInScope.get(ticket.id) || 0,
          happenedAt: toIso(submission.createdAt),
          createdAt: toIso(ticket.createdAt),
          confirmedAt: toIso(ticket.confirmedAt),
          printedAt: toIso(ticket.printedAt),
          detail: `${submission.lines || 0} line(s) sent${submission.mergedLines ? ` • ${submission.mergedLines} merged` : ""}`,
        }];
      });

    const waiterOrders = [...acceptedOrders, ...directOrders].sort(
      (a, b) => new Date(b.happenedAt || 0).getTime() - new Date(a.happenedAt || 0).getTime()
    );
    const waiterRanking = [...waiterNames]
      .map((name) => {
        const acceptedCount = acceptedOrders.filter((order) => order.waiterName === name).length;
        const directCount = directOrders.filter((order) => order.waiterName === name).length;
        return {
          name,
          acceptedOrders: acceptedCount,
          directOrders: directCount,
          totalActions: acceptedCount + directCount,
        };
      })
      .filter((row) => row.acceptedOrders > 0 || row.directOrders > 0)
      .sort((a, b) => b.totalActions - a.totalActions || b.acceptedOrders - a.acceptedOrders || b.directOrders - a.directOrders || a.name.localeCompare(b.name));

    // Receipt METADATA list only — photos load on demand via /api/tickets/receipt?id=
    const receipts = scopeTickets
      .filter((t) => t.receiptImage)
      .map((t) => ({
        id: t.id,
        tableName: t.tableName,
        method: t.paymentMethod || "online",
        totalAmount: t.saleAmount,
        closedAt: t.closedAt ? String(t.closedAt) : null,
      }))
      .slice(0, 30);

    // The printed-bills archive for the owner — the same bills the cashier
    // sees below her tables, WITH items so each card opens the full bill for
    // the cross-check. (In full-payment mode the period's paid bills are
    // appended, because nothing there is ever printed. Long periods show the
    // newest ARCHIVE_CAP bills; the total above still covers everything.)
    //
    // Post-print additions remain visible for the cross-checker, but are not
    // sale lines until a later print gives them an EFD receipt of their own.
    const afterPrintOf = (t: { id: number; printedAt: Date | string | null }, items: ItemRow[]) => {
      if (!printQueueMode || !t.printedAt) return { count: 0, amount: 0 };
      const soldQuantities = soldQuantityByTicket.get(t.id) || new Map<number, number>();
      const pending = items.flatMap((item) => {
        if (item.removed) return [];
        const quantity = Math.max(0, (Number(item.quantity) || 0) - (soldQuantities.get(item.id) || 0));
        return quantity > 0 ? [{ item, quantity }] : [];
      });
      return {
        count: pending.length,
        amount: pending.reduce((sum, line) => sum + (Number(line.item.price) || 0) * line.quantity, 0),
      };
    };

    const printedToday = printedTodayTickets.map((t) => {
      const items = itemsByTicket.get(t.id) || [];
      const pending = afterPrintOf(t, items);
      return {
        ...t,
        totalAmount: saleAmountByTicketInScope.get(t.id) || 0,
        items,
        itemsAfterPrint: pending.count,
        itemsAfterPrintAmount: pending.amount,
      };
    });
    for (const id of paidTodayIds) {
      const t = scopeTickets.find((x) => x.id === id);
      if (t) {
        const items = itemsByTicket.get(id) || [];
        const pending = afterPrintOf(t, items);
        printedToday.push({
          ...t,
          totalAmount: saleAmountByTicketInScope.get(t.id) || 0,
          items,
          itemsAfterPrint: pending.count,
          itemsAfterPrintAmount: pending.amount,
        });
      }
    }
    // "Not on an EFD receipt yet" figure for the bills whose lines were actually
    // loaded — the newest ARCHIVE_CAP bills of the period (a whole month of item
    // rows is never fetched, by design). The UI says so when the list is capped,
    // so the cross-checker knows the figure covers the bills she can see.
    const pendingAll = printedToday.map((t) => afterPrintOf(t, t.items));
    const printedPending = {
      bills: pendingAll.filter((p) => p.count > 0).length,
      items: pendingAll.reduce((s, p) => s + p.count, 0),
      amount: pendingAll.reduce((s, p) => s + p.amount, 0),
      partial: archiveCapped,
    };

    // Full order history (completed/paid/closed/cancelled), newest first, with
    // items + payment + receipt. Items come from the scoped historyItems query
    // (bounded to these 200 tickets).
    const orderHistory = orderHistoryTickets.map((t) => ({
      ...t,
      items: historyItems.filter((i) => i.ticketId === t.id),
      ...deriveHistory(t, historyEventsByTicket.get(t.id) || []),
    }));

    return NextResponse.json({
      todayRevenue,
      yesterdayRevenue,
      dayBeforeRevenue,
      weeklyRevenue,
      monthlyRevenue,
      todayOrders,
      yesterdayOrders: yesterdayTickets.length,
      dayBeforeOrders: dayBeforeTickets.length,
      weekOrders: weekTickets.length,
      monthOrders: monthTickets.length,
      averageOrderValue,
      popularItems,
      categorySales,
      paymentStats,
      receipts,
      orderHistory,
      waiterRanking,
      waiterOrders,
      hourlySales,
      peakHour,
      // Cross-check by station (selected period): the four station piles.
      stationSales,
      stationItems,
      // The printed-bills archive + its total (compare with the EFD receipt pile).
      printedTodayTotal,
      printedToday,
      // Lines sold in the period that are NOT on an EFD receipt yet (added to an
      // already-printed bill, waiting for the cashier's receipt #2). Explains a
      // pile difference instead of leaving the cross-checker to find it.
      printedPending,
      // Which period the sections above describe + helpers for the UI.
      period,
      periodLabel: PERIOD_LABELS[period],
      // The exact Ethiopian calendar dates this response covers (rolling window:
      // "month" is today + the 29 days before it, never a calendar month).
      periodRange,
      dayKeys,
      // Which money workflow the figures come from: "print-queue" (only bills the
      // cashier tapped ✓ PRINTED count) or "full" (paid/completed bills count).
      cashierMode: printQueueMode ? "print-queue" : "full",
      totalItems,
      archiveCapped,
      archiveTotal: printedPeriodTickets.length + paidTodayIds.length,
      // Last 7 days daily sales - sliding window, 7th day removed when new day starts
      last7DaysSales,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
