#!/usr/bin/env tsx
/**
 * Regression guard: the ORDER HISTORY "DATE" filter (owner, Oct 2026).
 *
 * The owner's request:
 *
 *   "the current shows like this Order History (200) but i want to add other
 *    filter that makes him choose specific date like today order history,
 *    yesterday, before yesterday, last 7 days, last 1 month, name the filter
 *    'date'".
 *
 * What has to stay true:
 *
 *   1. The filter is a DROPDOWN labelled "Date" with exactly those choices,
 *      plus "All Dates" so the old list is one click away.
 *   2. The days are ETHIOPIAN CALENDAR days (midnight to midnight, UTC+3 all
 *      year), the same windows the reports use - never "N x 24 hours ago",
 *      which quietly drops the morning of the oldest day.
 *   3. A bill is counted on the day it was FINISHED (closedAt), falling back to
 *      the last time it moved and then to the day it arrived - the same stamp
 *      the history card prints, so the card and the filter cannot disagree.
 *   4. "Last 1 month" is the report's own 30-day window: today plus the 29
 *      Ethiopian days before it.
 *   5. Every label has its hand-written Amharic wording in the staff
 *      dictionary, like every other word of the admin panel.
 *   6. The report only carries the newest 200 finished bills. When a range
 *      reaches further back than that window, the tab SAYS SO instead of
 *      showing a short list as though it were the whole month.
 *   7. Nothing else about the tab moved: the search box, the status dropdown,
 *      the count in the header and the cards are all still there.
 *
 * The rules are imported from the real module (src/lib/order-date-filter.ts),
 * which is pure - no database, no React - so a change to a boundary fails here,
 * not in the cafe.
 *
 * Run with: npx tsx scripts/verify-order-date-filter.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ORDER_DATE_FILTERS,
  ORDER_DATE_FILTER_MONTH_DAYS,
  isOrderDateFilterActive,
  matchesOrderDateFilter,
  orderFilterDayCount,
  orderFilterRangeStart,
  orderFilterStartDaysAgo,
  orderHistoryDateOf,
  type OrderDateFilter,
} from "../src/lib/order-date-filter";
import { STAFF_AM } from "../src/lib/staff-dictionary";
import { etHour, etMinute, etStartOfDay, isWithinEtDays } from "../src/lib/timezone";

let failures = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
  if (!cond) failures++;
};

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const tab = read("src/components/rms/OrderHistoryTab.tsx");
const reportsApi = read("src/app/api/reports/route.ts");
const filterModule = read("src/lib/order-date-filter.ts");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/**
 * A finished bill on the given Ethiopian day back (0 = today), at this hour of
 * that day. The hour defaults to midnight: this guard runs at any hour of the
 * day, and a stamp later than "now" would be a FUTURE bill, which the rolling
 * windows leave out on purpose.
 */
const billOn = (daysAgo: number, hour = 0) => {
  const midnight = etStartOfDay(new Date()).getTime() - daysAgo * MS_PER_DAY;
  return new Date(midnight + hour * 60 * 60 * 1000);
};
const dated = (closedAt: Date | null) => ({ closedAt, updatedAt: null, createdAt: null });

/* ── 1. the dropdown itself ───────────────────────────────────────────────── */

pass(
  "the dropdown offers exactly the owner's choices, in his order",
  ORDER_DATE_FILTERS.map((f) => f.value).join(",") ===
    "all,today,yesterday,day_before,last7,last30",
  ORDER_DATE_FILTERS.map((f) => f.value).join(",")
);
pass(
  "the choices are labelled All Dates / Today / Yesterday / Day Before Yesterday / Last 7 Days / Last 30 Days",
  ORDER_DATE_FILTERS.map((f) => f.label).join(" | ") ===
    "All Dates | Today | Yesterday | Day Before Yesterday | Last 7 Days | Last 30 Days",
  ORDER_DATE_FILTERS.map((f) => f.label).join(" | ")
);
pass(
  '"last 1 month" is the report\'s own 30-day window',
  ORDER_DATE_FILTER_MONTH_DAYS === 30 && orderFilterDayCount("last30") === 30
);
pass(
  "one day is one day, a week is seven, and no filter covers nothing at all",
  orderFilterDayCount("today") === 1 &&
    orderFilterDayCount("yesterday") === 1 &&
    orderFilterDayCount("day_before") === 1 &&
    orderFilterDayCount("last7") === 7 &&
    orderFilterDayCount("all") === 0
);

const missingAmharic = ORDER_DATE_FILTERS.filter((f) => {
  const am = (STAFF_AM as Record<string, string>)[f.label];
  return !am || !/[\u1200-\u137F]/.test(am);
}).map((f) => f.label);
pass(
  "every choice has its hand-written Amharic wording",
  missingAmharic.length === 0,
  `missing: ${missingAmharic.join(", ")}`
);

/* ── 2. the day a bill belongs to ─────────────────────────────────────────── */

pass(
  "a bill counts on the day it was finished",
  orderHistoryDateOf({
    closedAt: "2026-10-14T09:00:00Z",
    updatedAt: "2026-10-15T09:00:00Z",
    createdAt: "2026-10-13T09:00:00Z",
  })?.toISOString() === "2026-10-14T09:00:00.000Z"
);
pass(
  "a bill that never got a closing stamp counts on the last day it moved",
  orderHistoryDateOf({ closedAt: null, updatedAt: "2026-10-15T09:00:00Z", createdAt: "2026-10-13T09:00:00Z" })?.toISOString() ===
    "2026-10-15T09:00:00.000Z"
);
pass(
  "and failing that, on the day it arrived",
  orderHistoryDateOf({ closedAt: null, updatedAt: null, createdAt: "2026-10-13T09:00:00Z" })?.toISOString() ===
    "2026-10-13T09:00:00.000Z"
);
pass(
  "a broken stamp falls through instead of throwing the list away",
  orderHistoryDateOf({ closedAt: "not a date", updatedAt: "2026-10-15T09:00:00Z", createdAt: null })?.toISOString() ===
    "2026-10-15T09:00:00.000Z" &&
    orderHistoryDateOf(null) === null &&
    matchesOrderDateFilter(null, "today") === false
);
pass(
  "a bill with no readable stamp at all is in no range, so it cannot sit in every one",
  matchesOrderDateFilter(dated(null), "all") === false &&
    matchesOrderDateFilter(dated(null), "today") === false &&
    matchesOrderDateFilter(dated(null), "last30") === false
);

/* ── 3. the boundaries, on Ethiopian calendar days ────────────────────────── */

pass(
  '"All Dates" keeps every bill, whatever its day',
  [0, 1, 2, 7, 29, 31, 400].every((daysAgo) => matchesOrderDateFilter(dated(billOn(daysAgo)), "all"))
);
pass(
  "Today is today only, from its first minute to the last minute of yesterday",
  matchesOrderDateFilter(dated(billOn(0)), "today") &&
    !matchesOrderDateFilter(dated(billOn(1)), "today") &&
    !matchesOrderDateFilter(dated(billOn(1, 23)), "today")
);
pass(
  '"Yesterday" and "Day Before Yesterday" are single days, not rolling ones',
  matchesOrderDateFilter(dated(billOn(1)), "yesterday") &&
    !matchesOrderDateFilter(dated(billOn(0)), "yesterday") &&
    !matchesOrderDateFilter(dated(billOn(2)), "yesterday") &&
    matchesOrderDateFilter(dated(billOn(2)), "day_before") &&
    !matchesOrderDateFilter(dated(billOn(1)), "day_before") &&
    !matchesOrderDateFilter(dated(billOn(3)), "day_before")
);
pass(
  '"Last 7 Days" is today plus the 6 Ethiopian days before it',
  [0, 1, 2, 3, 4, 5, 6].every((daysAgo) => matchesOrderDateFilter(dated(billOn(daysAgo)), "last7")) &&
    !matchesOrderDateFilter(dated(billOn(7)), "last7")
);
pass(
  '"Last 30 Days" is today plus the 29 Ethiopian days before it',
  [0, 1, 15, 28, 29].every((daysAgo) => matchesOrderDateFilter(dated(billOn(daysAgo)), "last30")) &&
    !matchesOrderDateFilter(dated(billOn(30)), "last30")
);
pass(
  "the last millisecond of an Ethiopian day still belongs to that day",
  matchesOrderDateFilter(dated(billOn(1, 23)), "yesterday") &&
    matchesOrderDateFilter(dated(new Date(etStartOfDay(new Date()).getTime() - 1)), "yesterday") &&
    !matchesOrderDateFilter(dated(new Date(etStartOfDay(new Date()).getTime() - 1)), "today")
);
pass(
  "a bill stamped in the future is in no range but the unfiltered list",
  matchesOrderDateFilter(dated(new Date(Date.now() + MS_PER_DAY)), "all") &&
    !matchesOrderDateFilter(dated(new Date(Date.now() + MS_PER_DAY)), "today") &&
    !matchesOrderDateFilter(dated(new Date(Date.now() + MS_PER_DAY)), "last30")
);
pass(
  "an unknown filter word keeps the whole list instead of emptying the screen",
  matchesOrderDateFilter(dated(billOn(0)), "nonsense") &&
    matchesOrderDateFilter(dated(billOn(400)), "nonsense") &&
    matchesOrderDateFilter(dated(billOn(0)), null) &&
    matchesOrderDateFilter(dated(billOn(0)), undefined)
);
pass(
  "the tab can tell a filter is on, so the count can say what it counted",
  isOrderDateFilterActive("today") &&
    isOrderDateFilterActive("last30") &&
    !isOrderDateFilterActive("all") &&
    !isOrderDateFilterActive(null) &&
    !isOrderDateFilterActive("")
);

/* ── 4. the start of a range agrees with the matcher ──────────────────────── */

pass(
  "each range starts at Ethiopian midnight of its first day",
  (["today", "yesterday", "day_before", "last7", "last30"] as OrderDateFilter[]).every((f) => {
    const start = orderFilterRangeStart(f);
    return (
      start !== null &&
      etHour(start) === 0 &&
      etMinute(start) === 0 &&
      orderFilterStartDaysAgo(f) !== null &&
      Math.round((etStartOfDay(new Date()).getTime() - start.getTime()) / MS_PER_DAY) ===
        (orderFilterStartDaysAgo(f) as number)
    );
  })
);
pass(
  '"All Dates" has no start at all',
  orderFilterRangeStart("all") === null && orderFilterStartDaysAgo("all") === null
);
pass(
  "the start answers to an injected clock, so the guard is not at the mercy of midnight",
  (() => {
    const now = new Date("2026-10-15T21:30:00Z"); // 2026-10-16 00:30 in Ethiopia
    const start = orderFilterRangeStart("last7", now);
    return (
      start !== null &&
      etHour(start) === 0 &&
      etMinute(start) === 0 &&
      Math.round((etStartOfDay(now).getTime() - start.getTime()) / MS_PER_DAY) === 6
    );
  })()
);
const boundary = (["today", "yesterday", "day_before", "last7", "last30"] as OrderDateFilter[]).map((f) => {
  const start = orderFilterRangeStart(f);
  if (!start) return `${f}: no start`;
  const before = new Date(start.getTime() - 1);
  const wrong = [
    matchesOrderDateFilter(dated(start), f) ? "" : "the first instant is not in its own range",
    matchesOrderDateFilter(dated(before), f) ? "one millisecond before is still in the range" : "",
  ];
  /* Only the two rolling ranges have a "last N days" window to agree with -
   * a single day (yesterday, the day before) is not a rolling window. */
  if (f === "last7" || f === "last30") {
    const days = orderFilterDayCount(f);
    wrong.push(
      isWithinEtDays(start, days) ? "" : "the report's rolling window disagrees with the range start",
      isWithinEtDays(before, days) ? "the report's rolling window reaches one millisecond too far" : ""
    );
  }
  return wrong.filter(Boolean).length ? `${f}: ${wrong.filter(Boolean).join("; ")}` : "";
});
pass(
  "a bill on the first instant of a range is in it, and one millisecond before is not",
  boundary.every((note) => note === ""),
  boundary.filter(Boolean).join(" | ")
);

/* ── 5. the tab the admin reads ───────────────────────────────────────────── */

pass(
  'the filter is a dropdown and it is labelled "Date"',
  tab.includes('id="order-history-date"') &&
    tab.includes('htmlFor="order-history-date"') &&
    tab.includes('{L("Date")}') &&
    tab.includes("<select") &&
    tab.includes("ORDER_DATE_FILTERS.map((f) =>")
);
pass(
  "the dropdown starts on All Dates, so the old list is what the admin sees first",
  tab.includes('useState<OrderDateFilter>("all")') &&
    tab.includes("setDateFilter(e.target.value as OrderDateFilter)")
);
pass(
  "the day-range is applied together with the search and the status, never instead of them",
  tab.includes("matchesOrderDateFilter(o, dateFilter)") &&
    tab.includes("const matchQ = !q || searchText.includes(q.toLowerCase());") &&
    tab.includes('const matchS = statusFilter === "all" || historyStatusOf(o) === statusFilter;') &&
    tab.includes("return matchQ && matchS && matchD;") &&
    tab.includes("[orders, q, statusFilter, dateFilter]")
);
pass(
  "the header still counts what is on the screen",
  tab.includes('L("Order History ({length})", { length: filtered.length })')
);
pass(
  "the three filters sit side by side on a wide screen",
  tab.includes("grid grid-cols-1 sm:grid-cols-3 gap-3")
);
pass(
  "the cards, the receipt photos and the audit trail did not move",
  tab.includes("filtered.map((o) =>") &&
    tab.includes("displayItems") &&
    tab.includes("auditTrail") &&
    tab.includes("No orders match your search.")
);

/* ── 6. the honest warning about the 200-bill window ──────────────────────── */

pass(
  "the report still sends the newest 200 finished bills, and the tab says when that cuts a range short",
  reportsApi.includes(".slice(0, 200);") &&
    tab.includes("orderFilterRangeStart(dateFilter)") &&
    tab.includes("orders.length < 200") &&
    tab.includes("windowTooShort &&") &&
    tab.includes('L("The list holds the newest 200 bills, so this range may be missing older ones.")')
);
pass(
  "the warning is measured against the oldest bill in the window, not guessed",
  tab.includes("orderHistoryDateOf(o)") && tab.includes("oldest > rangeStart.getTime()")
);
pass(
  "the warning has its Amharic wording too",
  /[\u1200-\u137F]/.test(
    (STAFF_AM as Record<string, string>)[
      "The list holds the newest 200 bills, so this range may be missing older ones."
    ] || ""
  )
);
pass(
  "the module stays pure: no database, no React, no clock of its own beyond the timezone helper",
  !filterModule.includes("drizzle") &&
    !filterModule.includes("from \"react\"") &&
    !filterModule.includes("fetch(") &&
    filterModule.includes('import type { StaffPhrase } from "@/lib/staff-i18n";')
);

if (failures > 0) {
  console.error(`\n❌ ORDER DATE FILTER GUARD FAILED (${failures})\n`);
  process.exit(1);
}
console.log("\n✅ Order date filter guard PASSED");
console.log("   • a Date dropdown: All Dates, Today, Yesterday, Day Before Yesterday, Last 7 Days, Last 30 Days");
console.log("   • Ethiopian calendar days, counted on the day the bill was finished");
console.log("   • search, status, count and cards untouched, every label in Amharic too");
console.log("   • a range the 200-bill window cannot cover says so out loud");
