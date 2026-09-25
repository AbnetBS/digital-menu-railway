/**
 * STATION SALES — the crew's own "Items sold" tab (kitchen / barista / juice).
 *
 * WHY THIS FILE EXISTS (owner, Sept 2026): the first version of that tab always
 * answered "0 items • 0 ETB", whatever the crew had actually made. Two bugs:
 *
 *   1. THE DAY WINDOW WAS EMPTY. "Today" ran from EAT midnight today to the
 *      same helper called with a NEGATIVE day count, and `etStartOfDaysAgo`
 *      clamps negatives to zero — so the window started and ended at the SAME
 *      instant and could never contain a tap. "Last 7 Days" used that same
 *      negative-day end, so it silently dropped today as well.
 *   2. "COMBINED" MEANT ALMOST NOTHING. It counted only lines this person
 *      accepted AND somebody else finished, so on a station with one person on
 *      duty (the normal case) it was permanently zero.
 *
 * Both are fixed here, and the counting rules now match the shift report the
 * cross-checker already trusts:
 *
 *   • every period is a LIST OF ETHIOPIAN CALENDAR DAY KEYS (today, yesterday,
 *     the day before yesterday, the last 7 days, the last 30 days) matched with
 *     `etDayKey`, exactly like `buildShiftReport` does — a day can never be
 *     zero-width again, and a rolling window always includes today;
 *   • an action belongs to the day it was TAPPED, not the day the bill was
 *     opened: an order sent at 23:50 and finished at 00:10 counts on the day
 *     the person pressed Done;
 *   • ACCEPTED = the lines this person tapped Accept on, DONE = the lines they
 *     tapped Done on, COMBINED = every line they touched (accept OR done),
 *     each line counted ONCE — the same attribution the shift report's
 *     per-person pile uses, so the two papers agree;
 *   • lines stamped before the accept/done columns existed are still counted,
 *     through the last-tap fallback (`station_status_by` / `station_status_at`);
 *   • the pile is grouped by menu CATEGORY with a subtotal per category, which
 *     is what the crew asked to see ("what did I sell, in which category");
 *   • removed lines and CANCELLED bills never count as sold.
 *
 * PURE: no database, no Next.js, no React. The API route feeds rows in, the
 * regression test (scripts/verify-station-sales.ts) feeds fixtures in.
 */
import { etDayKey, etDayKeyDaysAgo, etStartOfDaysAgo } from "@/lib/timezone";

/* ─── PERIODS (the date buttons on the crew screen) ───────────────────────── */

export type SalesPeriod = "today" | "yesterday" | "dayBefore" | "week" | "month";

/** The buttons in the order the crew taps them. */
export const SALES_PERIODS: SalesPeriod[] = ["today", "yesterday", "dayBefore", "week", "month"];

export const SALES_PERIOD_LABELS: Record<SalesPeriod, string> = {
  today: "Today",
  yesterday: "Yesterday",
  dayBefore: "Day Before Yesterday",
  week: "Last 7 Days",
  month: "Last 30 Days",
};

/** How far back the period starts, in Ethiopian calendar days (today = 0). */
export const SALES_PERIOD_START_DAYS_AGO: Record<SalesPeriod, number> = {
  today: 0,
  yesterday: 1,
  dayBefore: 2,
  week: 6,
  month: 29,
};

/** How many Ethiopian calendar days the period covers (the last day is today's). */
export const SALES_PERIOD_LENGTH_DAYS: Record<SalesPeriod, number> = {
  today: 1,
  yesterday: 1,
  dayBefore: 1,
  week: 7,
  month: 30,
};

/** True when `value` names one of the five periods. */
export function isSalesPeriod(value: unknown): value is SalesPeriod {
  return typeof value === "string" && (SALES_PERIODS as string[]).includes(value);
}

/** Anything unrecognised falls back to TODAY, the button the crew expects. */
export function salesPeriodOf(value: unknown): SalesPeriod {
  return isSalesPeriod(value) ? value : "today";
}

/**
 * The Ethiopian calendar days a period covers, OLDEST FIRST ("2026-09-19" …
 * "2026-09-25"). A rolling period always ends with today, so "Last 7 Days" is
 * today plus the 6 days before it — never the 7 days that ended last midnight.
 */
export function salesDayKeys(period: SalesPeriod): string[] {
  const start = SALES_PERIOD_START_DAYS_AGO[period];
  const oldest = start - (SALES_PERIOD_LENGTH_DAYS[period] - 1);
  const keys: string[] = [];
  for (let daysAgo = start; daysAgo >= oldest; daysAgo--) {
    const key = etDayKeyDaysAgo(daysAgo);
    if (key) keys.push(key);
  }
  return keys;
}

/** The exact dates a period covers, printed on the screen for the crew. */
export function salesPeriodRange(period: SalesPeriod): { from: string | null; to: string | null; days: number } {
  const keys = salesDayKeys(period);
  return { from: keys[0] || null, to: keys[keys.length - 1] || null, days: keys.length };
}

/** The SQL cutoff: EAT midnight of the period's oldest day (never negative). */
export function salesPeriodCutoff(period: SalesPeriod): Date {
  return etStartOfDaysAgo(SALES_PERIOD_START_DAYS_AGO[period]);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-25" (an EAT day key) → "25 Sep 2026" for humans. */
export function formatDayKey(key?: string | null): string {
  if (!key) return "";
  const [y, m, d] = String(key).split("-").map(Number);
  if (!y || !m || !d) return String(key);
  return `${String(d).padStart(2, "0")} ${MONTHS[m - 1] || ""} ${y}`;
}

/**
 * The dates a period covers, as the crew reads them: one day is "25 Sep 2026",
 * a rolling window is "19 Sep 2026 – 25 Sep 2026". (The month name reaches the
 * screen through the staff date helper, so Amharic readers get Amharic months.)
 */
export function salesRangeText(range: { from: string | null; to: string | null }): string {
  const from = formatDayKey(range.from);
  const to = formatDayKey(range.to);
  if (!from && !to) return "";
  if (!to || from === to) return from;
  if (!from) return to;
  return `${from} – ${to}`;
}

/* ─── MODES (the accepted / done / combined tabs) ─────────────────────────── */

export type SalesMode = "accepted" | "done" | "combined";

export const SALES_MODES: SalesMode[] = ["accepted", "done", "combined"];

export const SALES_MODE_LABELS: Record<SalesMode, string> = {
  accepted: "Accepted",
  done: "Done",
  combined: "Combined",
};

/* ─── INPUT ROWS ──────────────────────────────────────────────────────────── */

type Stamp = Date | string | null | undefined;

/** One `ticket_items` row as the API route reads it (plus its bill's status). */
export interface StationSalesItemRow {
  id: number;
  ticketId: number;
  name: string;
  /** Menu category SLUG stored on the line ("hot-drinks", "foods"…). */
  category?: string | null;
  price?: number | null;
  quantity?: number | null;
  removed?: boolean | null;
  /** The bill's status, so a cancelled order never counts as sold. */
  ticketStatus?: string | null;
  stationStatus?: string | null;
  stationStatusBy?: string | null;
  stationStatusAt?: Stamp;
  stationAcceptedBy?: string | null;
  stationAcceptedAt?: Stamp;
  stationDoneBy?: string | null;
  stationDoneAt?: Stamp;
}

/** WHO tapped this line: both steps, with the pre-audit-column fallback. */
export interface LineAttribution {
  acceptedBy: string;
  acceptedAt: string | null;
  doneBy: string;
  doneAt: string | null;
}

/* ─── OUTPUT ──────────────────────────────────────────────────────────────── */

/** One menu item inside a category pile. */
export interface StationSalesItem {
  name: string;
  quantity: number;
  amount: number;
  /** Distinct bills this item appeared on. */
  bills: number;
}

/** One menu category pile with its own subtotal. */
export interface StationSalesCategory {
  category: string;
  quantity: number;
  amount: number;
  lines: number;
  bills: number;
  items: StationSalesItem[];
}

/** Everything one mode (accepted / done / combined) sold in the period. */
export interface StationSalesPile {
  /** Item UNITS sold (quantities added up). */
  quantity: number;
  /** ETB those units are worth. */
  amount: number;
  /** Order LINES counted (one line can be "2 Macchiato"). */
  lines: number;
  /** Distinct bills the lines came from. */
  bills: number;
  categories: StationSalesCategory[];
  /** The same items flat, busiest first — for a quick "top sellers" read. */
  items: StationSalesItem[];
}

export interface StationSalesReport {
  period: SalesPeriod;
  periodLabel: string;
  dayKeys: string[];
  range: { from: string | null; to: string | null; days: number };
  station: string;
  /** The person whose taps are counted; null = the whole crew of the station. */
  staff: string | null;
  generatedAt: string;
  modes: Record<SalesMode, StationSalesPile>;
}

/* ─── HELPERS ─────────────────────────────────────────────────────────────── */

const clean = (s: string | null | undefined): string => String(s ?? "").trim();

const iso = (d: Stamp): string | null => {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
};

/** Placeholder names that are not a member of the crew (see shift-report.ts). */
const NOT_A_PERSON = /^(customer\b.*|\(.*\)|admin|waiter|cashier|staff|system|guest)$/i;

/** True when the stamp is a real person's tap, not a system/placeholder name. */
export function isCrewName(name: string | null | undefined): boolean {
  const n = clean(name);
  return !!n && !NOT_A_PERSON.test(n);
}

/**
 * WHO touched this line, and WHEN.
 *
 * The permanent audit columns (`station_accepted_*` / `station_done_*`) win.
 * Lines stamped before those columns existed only know the LAST tap, so they
 * fall back to `station_status_by` / `station_status_at` — otherwise whole
 * older days would read as zero, exactly like the bug this module replaces.
 * Same rule as `buildShiftReport`, so the crew's tab and the cross-checker's
 * paper can never disagree about who handled a line.
 */
export function lineAttribution(row: StationSalesItemRow): LineAttribution {
  const status = clean(row.stationStatus).toLowerCase();
  const lastBy = clean(row.stationStatusBy);
  const acceptedBy = clean(row.stationAcceptedBy);
  const doneBy = clean(row.stationDoneBy);
  return {
    acceptedBy: acceptedBy || (!doneBy && status === "accepted" && isCrewName(lastBy) ? lastBy : ""),
    acceptedAt: iso(row.stationAcceptedAt) || (!doneBy && status === "accepted" ? iso(row.stationStatusAt) : null),
    doneBy: doneBy || (status === "done" && isCrewName(lastBy) ? lastBy : ""),
    doneAt: iso(row.stationDoneAt) || (status === "done" ? iso(row.stationStatusAt) : null),
  };
}

/** The display name of a category slug ("hot-drinks" → "Hot Drinks"). */
export function categoryLabel(
  slug: string | null | undefined,
  categoryNames?: Record<string, string> | null
): string {
  const key = clean(slug);
  if (!key) return "General";
  const named = clean(categoryNames?.[key]);
  return named || key;
}

const emptyPile = (): StationSalesPile => ({ quantity: 0, amount: 0, lines: 0, bills: 0, categories: [], items: [] });

type ItemAcc = { quantity: number; amount: number; bills: Set<number> };
type CatAcc = { quantity: number; amount: number; lines: number; bills: Set<number>; items: Map<string, ItemAcc> };

/**
 * Build the crew's "Items sold" figures for one period.
 *
 * `staff` = the person whose taps count (null/empty = everybody on that
 * station, which is what an admin sees). Every line is counted at most once
 * per mode, so Combined is the union of Accepted and Done, never their sum.
 */
export function buildStationSales(input: {
  period: SalesPeriod;
  station: string;
  staff?: string | null;
  rows: StationSalesItemRow[];
  /** Category slug → display name (the owner's wording from the Stations tab). */
  categoryNames?: Record<string, string> | null;
  /** When the figures were built (the screen shows it as "updated …"). */
  now?: Date;
}): StationSalesReport {
  const period = salesPeriodOf(input.period);
  const dayKeys = salesDayKeys(period);
  const inPeriod = new Set(dayKeys);
  const me = clean(input.staff);
  const names = input.categoryNames || null;

  const acc: Record<SalesMode, Map<string, CatAcc>> = {
    accepted: new Map(),
    done: new Map(),
    combined: new Map(),
  };
  const billSets: Record<SalesMode, Set<number>> = { accepted: new Set(), done: new Set(), combined: new Set() };

  const onDay = (at: string | null) => {
    const key = at ? etDayKey(at) : null;
    return !!key && inPeriod.has(key);
  };
  /** Whose tap counts: mine, or (admin view) any real member of the crew. */
  const counts = (by: string) => !!by && (me ? by === me : isCrewName(by));

  for (const row of input.rows || []) {
    // A line the cashier took off the bill was never made, and a cancelled
    // order was never sold — neither belongs in "items sold".
    if (row.removed) continue;
    if (clean(row.ticketStatus).toLowerCase() === "cancelled") continue;

    const quantity = Math.max(0, Math.round(Number(row.quantity) || 0));
    const price = Math.max(0, Number(row.price) || 0);
    const amount = price * quantity;
    const attr = lineAttribution(row);
    const accepted = counts(attr.acceptedBy) && onDay(attr.acceptedAt);
    const done = counts(attr.doneBy) && onDay(attr.doneAt);
    if (!accepted && !done) continue;

    const category = categoryLabel(row.category, names);
    const itemName = clean(row.name) || "Item";
    const modes: SalesMode[] = accepted && done ? ["accepted", "done", "combined"] : accepted ? ["accepted", "combined"] : ["done", "combined"];
    for (const mode of modes) {
      const cats = acc[mode];
      const cat = cats.get(category) || { quantity: 0, amount: 0, lines: 0, bills: new Set<number>(), items: new Map<string, ItemAcc>() };
      const item = cat.items.get(itemName) || { quantity: 0, amount: 0, bills: new Set<number>() };
      item.quantity += quantity;
      item.amount += amount;
      item.bills.add(row.ticketId);
      cat.items.set(itemName, item);
      cat.quantity += quantity;
      cat.amount += amount;
      cat.lines += 1;
      cat.bills.add(row.ticketId);
      cats.set(category, cat);
      billSets[mode].add(row.ticketId);
    }
  }

  const finish = (cats: Map<string, CatAcc>, bills: Set<number>): StationSalesPile => {
    const categories: StationSalesCategory[] = [...cats.entries()]
      .map(([category, cat]) => ({
        category,
        quantity: cat.quantity,
        amount: cat.amount,
        lines: cat.lines,
        bills: cat.bills.size,
        items: [...cat.items.entries()]
          .map(([name, it]) => ({ name, quantity: it.quantity, amount: it.amount, bills: it.bills.size }))
          .sort((a, b) => b.quantity - a.quantity || b.amount - a.amount || a.name.localeCompare(b.name)),
      }))
      // Busiest category first, so the crew reads its main pile at the top.
      .sort((a, b) => b.quantity - a.quantity || b.amount - a.amount || a.category.localeCompare(b.category));
    const items = categories.flatMap((c) => c.items).sort((a, b) => b.quantity - a.quantity || b.amount - a.amount || a.name.localeCompare(b.name));
    return {
      quantity: categories.reduce((n, c) => n + c.quantity, 0),
      amount: categories.reduce((n, c) => n + c.amount, 0),
      lines: categories.reduce((n, c) => n + c.lines, 0),
      bills: bills.size,
      categories,
      items,
    };
  };

  const modes = {} as Record<SalesMode, StationSalesPile>;
  for (const mode of SALES_MODES) modes[mode] = finish(acc[mode], billSets[mode]);

  return {
    period,
    periodLabel: SALES_PERIOD_LABELS[period],
    dayKeys,
    range: salesPeriodRange(period),
    station: clean(input.station),
    staff: me || null,
    generatedAt: (input.now || new Date()).toISOString(),
    modes,
  };
}

/** An empty report, so a screen that failed to load still has a valid shape. */
export function emptyStationSales(period: SalesPeriod, station: string, staff: string | null): StationSalesReport {
  return buildStationSales({ period, station, staff, rows: [] });
}
