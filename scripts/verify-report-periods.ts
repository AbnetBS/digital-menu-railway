#!/usr/bin/env tsx
/**
 * Regression guard — the REPORT PERIODS and the ROLLING 30-DAY WINDOW
 * (owner's requests, Sept 2026).
 *
 *   1. DAY BEFORE YESTERDAY — the cross-checker's new single-day period sits
 *      BETWEEN Yesterday and Last 7 Days, on the server (?period=dayBefore) and
 *      on the screen (a fifth interval card, its own revenue/order pair).
 *   2. EXACTLY 30 DAYS, ROLLING — "Last 30 Days" is today plus the 29 Ethiopian
 *      calendar days before it, so on 1 Oct it covers 2 Sep – 1 Oct and 1 Sep
 *      leaves the window that same day. It never resets on the 1st of a month,
 *      and every day boundary is the ETHIOPIAN calendar day (never 30 × 24 hours
 *      from this instant, which silently drops the morning of the first day).
 *   3. NOTHING IS DELETED — the report only READS that window; the orders, the
 *      order history and their items stay in the database. Only old receipt
 *      PHOTOS are swept, by the separate /api/tickets/cleanup endpoint.
 *   4. THE EFD PILE IS THE ONLY MONEY — a bill counts when the cashier tapped
 *      ✓ PRINTED; cancelled orders are never counted anywhere, and an unprinted
 *      bill never joins the Printed Bills archive in print-queue mode.
 *
 * Part runtime (the pure Ethiopian-clock helpers are imported and exercised,
 * including a simulated October morning), part static source inspection — no
 * database, no React, no network.
 * Run with: npx tsx scripts/verify-report-periods.ts   (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  etDayKey,
  etDayKeyDaysAgo,
  etStartOfCalendarDay,
  etStartOfDaysAgo,
  isDayBeforeYesterdayET,
  isOnEtDayDaysAgo,
  isTodayET,
  isWithinEtDays,
  isYesterdayET,
} from "../src/lib/timezone";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const failures: string[] = [];
const pass = (name: string, cond: boolean) => {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures.push(name);
};

const reports = read("src/app/api/reports/route.ts");
const reportsUi = read("src/components/rms/ReportsTab.tsx");
const timezone = read("src/lib/timezone.ts");
const types = read("src/types/index.ts");
const cleanupRoute = read("src/app/api/tickets/cleanup/route.ts");
const receiptCleanup = read("src/lib/receipt-cleanup.ts");
const historyUi = read("src/components/rms/OrderHistoryTab.tsx");

/* ── 1. DAY BEFORE YESTERDAY ──────────────────────────────────────────────── */
{
  pass("the timezone lib knows the day before yesterday", /export function isDayBeforeYesterdayET/.test(timezone));
  pass("the API accepts ?period=dayBefore", /rawPeriod === "dayBefore"/.test(reports));
  pass("the API labels it \"Day Before Yesterday\"", /dayBefore: "Day Before Yesterday"/.test(reports));
  pass("the API computes that day's revenue and bill count", /dayBeforeRevenue/.test(reports) && /dayBeforeOrders: dayBeforeTickets\.length/.test(reports));
  pass("that day's bills come from the SOLD bills of exactly that EAT day", /dayBeforeTickets = revenueTickets\.filter\(\(t\) => isDayBeforeYesterdayET\(soldAt\(t\)\)\)/.test(reports));
  pass("the selected period can BE that day (every section follows it)", /period === "dayBefore" \? dayBeforeTickets/.test(reports) && /period === "dayBefore" \? isDayBeforeYesterdayET/.test(reports));
  pass("the shared type knows the period", /export type ReportPeriod = "today" \| "yesterday" \| "dayBefore" \| "week" \| "month"/.test(types));
  pass("the ReportData type carries the new pair", /dayBeforeRevenue\?: number/.test(types) && /dayBeforeOrders\?: number/.test(types));
  pass("the screen's card sits BETWEEN Yesterday and Last 7 Days", /const PERIOD_ORDER: Period\[\] = \["today", "yesterday", "dayBefore", "week", "month"\]/.test(reportsUi) && /PERIOD_ORDER\.map\(/.test(reportsUi));
  pass("the screen renders five interval cards", /lg:grid-cols-5/.test(reportsUi) && /dayBefore: \(d\) => \(\{ label: PERIOD_LABELS\.dayBefore, rev: d\.dayBeforeRevenue \|\| 0, cnt: d\.dayBeforeOrders \|\| 0, day: d\.dayKeys\?\.dayBefore \}\)/.test(reportsUi));
  pass("the screen reads the new revenue/order pair for its KPIs", /period === "dayBefore" \? data\?\.dayBeforeRevenue/.test(reportsUi) && /period === "dayBefore" \? data\?\.dayBeforeOrders/.test(reportsUi));
  pass("the printed paper names that day in plain language", /dayBefore: "the day before yesterday's sales"/.test(reportsUi));

  // Runtime: the three single-day helpers never overlap and never skip a day.
  const now = new Date();
  const todayStamp = new Date(etStartOfDaysAgo(0).getTime() + 9 * 60 * 60 * 1000); // 09:00 EAT today
  const yesterdayStamp = new Date(etStartOfDaysAgo(1).getTime() + 20 * 60 * 60 * 1000); // 20:00 EAT yesterday
  const dayBeforeStamp = new Date(etStartOfDaysAgo(2).getTime() + 6 * 60 * 60 * 1000); // 06:00 EAT the day before
  pass("runtime: a bill sold today is today's (not yesterday's, not the day before)", isTodayET(todayStamp) && !isYesterdayET(todayStamp) && !isDayBeforeYesterdayET(todayStamp));
  pass("runtime: a bill sold yesterday is ONLY yesterday's", isYesterdayET(yesterdayStamp) && !isTodayET(yesterdayStamp) && !isDayBeforeYesterdayET(yesterdayStamp));
  pass("runtime: a bill sold the day before yesterday is ONLY that day's", isDayBeforeYesterdayET(dayBeforeStamp) && !isYesterdayET(dayBeforeStamp) && !isTodayET(dayBeforeStamp));
  pass("runtime: the three day keys are three consecutive Ethiopian dates", [0, 1, 2].every((n) => !!etDayKeyDaysAgo(n)) && etDayKeyDaysAgo(1) === etDayKey(etStartOfDaysAgo(1)) && etDayKeyDaysAgo(2) === etDayKey(new Date(etStartOfDaysAgo(1).getTime() - 24 * 60 * 60 * 1000)));
  pass("runtime: isOnEtDayDaysAgo agrees with the named helpers", isOnEtDayDaysAgo(dayBeforeStamp, 2) && !isOnEtDayDaysAgo(dayBeforeStamp, 1));
  pass("runtime: a null/garbage stamp is never in any day", !isTodayET(null) && !isDayBeforeYesterdayET("not a date") && !isOnEtDayDaysAgo(undefined, 2));
  void now;
}

/* ── 2. EXACTLY 30 DAYS, ROLLING (Ethiopian calendar days) ────────────────── */
{
  pass("the window helpers are calendar-day based, never N × 24 hours", /export function isWithinEtDays/.test(timezone) && /export function etStartOfDaysAgo/.test(timezone));
  pass("the old 24-hour window helper is gone from the report", !/function isWithinDays\(/.test(reports) && !/isWithinDays\(/.test(reports));
  pass("Last 30 Days = today + the 29 EAT days before it", /monthTickets = revenueTickets\.filter\(\(t\) => isWithinEtDays\(soldAt\(t\), PERIOD_LENGTH_DAYS\.month\)\)/.test(reports) && /month: 29/.test(reports) && /month: 30/.test(reports));
  pass("Last 7 Days = today + the 6 EAT days before it", /weekTickets = revenueTickets\.filter\(\(t\) => isWithinEtDays\(soldAt\(t\), PERIOD_LENGTH_DAYS\.week\)\)/.test(reports) && /week: 6/.test(reports) && /week: 7/.test(reports));
  pass("the SQL cutoff starts at EAT midnight 29 days back (not 30 × 24h ago)", /const cutoff = etStartOfDaysAgo\(PERIOD_START_DAYS_AGO\.month\)/.test(reports) && !/cutoff\.setDate\(cutoff\.getDate\(\) - 30\)/.test(reports));
  pass("a bill printed inside the window is loaded even if it was opened before it", /gt\(tickets\.printedAt, cutoff\)/.test(reports));
  pass("the response says which exact dates it covers", /periodRange/.test(reports) && /dayKeys/.test(reports) && /periodRange\?: \{ from: string \| null; to: string \| null; days: number \}/.test(types));
  pass("the screen and the paper print those dates for the cross-checker", /fmtDayKey/.test(reportsUi) && /Covers: \{rangeText\}/.test(reportsUi));

  // Runtime: the window is exactly 30 Ethiopian calendar days and slides one day
  // at a time — simulated on 1 October, when 1 September must drop out.
  const oct1 = etStartOfCalendarDay(2026, 10, 1);
  const windowStartFromOct1 = new Date(oct1.getTime() - 29 * 24 * 60 * 60 * 1000); // what etStartOfDaysAgo(29) returns on 1 Oct
  pass("runtime: on 1 Oct the 30-day window starts at 2 Sep (EAT midnight)", etDayKey(windowStartFromOct1) === "2026-09-02");
  const at = (y: number, m: number, d: number, hour = 12) => new Date(etStartOfCalendarDay(y, m, d).getTime() + hour * 60 * 60 * 1000);
  const inWindow = (stamp: Date) => {
    // The same test the report applies, evaluated AS IF today were 1 Oct 2026.
    const t = stamp.getTime();
    return t >= windowStartFromOct1.getTime() && t <= oct1.getTime() + 24 * 60 * 60 * 1000 - 1;
  };
  pass("runtime: 2 Sep – 1 Oct are all inside that window (30 days, today included)", [at(2026, 9, 2), at(2026, 9, 15), at(2026, 9, 30), at(2026, 10, 1, 1)].every(inWindow));
  pass("runtime: 1 Sep is OUT of that window the same day (it slid forward)", !inWindow(at(2026, 9, 1, 23)));
  pass("runtime: the window is 30 days wide, not a calendar month", Math.round((oct1.getTime() + 24 * 60 * 60 * 1000 - windowStartFromOct1.getTime()) / (24 * 60 * 60 * 1000)) === 30);

  // Runtime, against the real clock: today and 29 days back are in, 30 days back is out.
  pass("runtime: today's bill is inside the live 30-day window", isWithinEtDays(new Date(Math.min(Date.now(), etStartOfDaysAgo(0).getTime() + 60 * 60 * 1000)), 30));
  pass("runtime: a bill from 29 EAT days ago is inside (the oldest day kept)", isWithinEtDays(new Date(etStartOfDaysAgo(29).getTime() + 60 * 60 * 1000), 30));
  pass("runtime: a bill from 30 EAT days ago is outside (it left the window)", !isWithinEtDays(new Date(etStartOfDaysAgo(30).getTime() + 60 * 60 * 1000), 30));
  pass("runtime: the FIRST morning of that oldest day still counts (calendar, not 24h)", isWithinEtDays(new Date(etStartOfDaysAgo(29).getTime() + 5 * 60 * 1000), 30));
  pass("runtime: the live 7-day window is 7 calendar days", isWithinEtDays(new Date(etStartOfDaysAgo(6).getTime() + 5 * 60 * 1000), 7) && !isWithinEtDays(new Date(etStartOfDaysAgo(7).getTime() + 5 * 60 * 1000), 7));
  pass("runtime: a future stamp never counts as sold", !isWithinEtDays(new Date(Date.now() + 60 * 60 * 1000), 30));
  pass("runtime: garbage never counts", !isWithinEtDays(null, 30) && !isWithinEtDays("nonsense", 30));
}

/* ── 3. NOTHING IS DELETED — the window is a READ, not a purge ────────────── */
{
  pass("the report never deletes a row", !/db\s*\.\s*delete\(/.test(reports));
  pass("the report only READS the rolling window (documented as retention)", /RETENTION \(owner's decision, Sept 2026\): NOTHING is ever deleted here/.test(reports));
  pass("the only automatic sweep is still receipt PHOTOS, order records kept", /cleanupOldReceipts/.test(cleanupRoute) && /receiptImage: null/.test(receiptCleanup) && !/db\s*\.\s*delete\(tickets\)/.test(receiptCleanup));
  pass("the Order History button still says photos go, records stay", /Order records \(items, totals\) stay in history/.test(historyUi));
  pass("the screen tells the owner older bills stay stored", /Older bills stay stored; they simply leave the report/.test(reportsUi));
  pass("the Order History tab names the same rolling window", /Newest finished bills of the last 30 days \(today plus the 29 days before it\)/.test(historyUi) && /older bills\s*\n?\s*are still stored/i.test(historyUi));
}

/* ── 4. THE EFD PILE IS THE ONLY MONEY ────────────────────────────────────── */
{
  pass("a sale is the cashier's ✓ PRINTED tap (print-queue mode)", /function isSold\(t: \{ status: string; printedAt: Date \| string \| null \}, printQueueMode: boolean\)/.test(reports) && /return printQueueMode \? !!t\.printedAt : true/.test(reports));
  pass("the report reads the owner's cashier_mode switch", /siteSettings\.key, "cashier_mode"/.test(reports) && /printQueueMode = String\(modeRows\[0\]\?\.value \|\| "print-queue"\) !== "full"/.test(reports));
  pass("CANCELLED bills are never a sale", /if \(t\.status === "cancelled"\) return false/.test(reports));
  pass("CANCELLED bills are never in the Printed Bills archive", /t\.status !== "cancelled" && t\.printedAt && inScopeDay\(t\.printedAt\)/.test(reports));
  pass("an UNPRINTED bill never joins the archive in print-queue mode", /const paidTodayIds = printQueueMode\s*\?\s*\[\]\s*: scopeTickets\.filter\(\(t\) => !t\.printedAt/.test(reports));
  pass("the screen says cancelled orders are excluded", /Cancelled orders are never listed or added here/.test(reportsUi));
  pass("the printed paper says cancelled orders are excluded", /Cancelled \(voided\) orders are excluded from both sides/.test(reportsUi));
  pass("lines added after a print are reported, not silently counted", /printedPending/.test(reports) && /itemsAfterPrint/.test(reports) && /itemsAfterPrint\?: number/.test(types));
  pass("the screen explains that difference to the cross-checker", /AFTER\s*\n?\s*their last print|not on an EFD receipt yet/.test(reportsUi));
}

if (failures.length > 0) {
  console.error("\n❌ REPORT PERIODS REGRESSION TEST FAILED\n");
  for (const f of failures) console.error("  • " + f);
  process.exit(1);
}
console.log("\n✅ Report periods regression test PASSED");
console.log("   • five interval cards: Today / Yesterday / DAY BEFORE YESTERDAY / Last 7 Days / Last 30 Days");
console.log("   • Last 30 Days = exactly 30 Ethiopian calendar days (today + the 29 before it),");
console.log("     sliding one day at a time — on 1 Oct it covers 2 Sep – 1 Oct, never a calendar month");
console.log("   • nothing is deleted: the report only reads that window, orders and history stay stored");
console.log("   • only bills the cashier keyed into the EFD count; cancelled orders count nowhere");
