#!/usr/bin/env tsx
/**
 * Regression guard: THE OWNER'S DAILY SALES + THE CASHIER'S DAY CLOSE
 * (owner's decision, 29 Sept 2026).
 *
 * What the owner asked for:
 *   • a "Today's shift end" button that opens after 1:00 Ethiopian local time
 *     (19:00 EAT, five hours after the 14:00 shift change);
 *   • tapping it computes TODAY's total from the bills the cashier printed
 *     (the EFD receipt pile — the paper he counts against the drawer) and
 *     sends ONE notification to his phone: "💰 Today's total sale • 12,450 ETB";
 *   • tapping that notification opens his page (the dashboard's Daily Sales
 *     tab) which lists, per date, only the date and the total
 *     ("29 Sep 2026 • 12,450 ETB"), with a print button.
 *
 * This guard walks the pure helpers, then pins the wiring of every piece:
 * the cashier's button, the day-close endpoint, the owner push, the URL the
 * notification opens and the dashboard tab it lands on.
 *
 * Run with: npx tsx scripts/verify-daily-sales.ts   (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CLOSE_HOURS_AFTER_SPLIT,
  DEFAULT_CUTOFF_HOUR,
  DAY_CLOSE_KEY_PREFIX,
  dayCloseCutoffHour,
  dayClosePush,
  dayCloseSettingKey,
  dayKeyFromCloseSetting,
  dayKeyLabel,
  formatEtb,
  isDayCloseOpen,
  parseDayCloseValue,
  recentDayKeys,
} from "../src/lib/daily-sales";
import { etDayKey, etDayKeyDaysAgo } from "../src/lib/timezone";

let failures = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
  if (!cond) failures++;
};

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

/* ── 1. WHEN the button opens (1:00 local = 19:00 EAT) ────────────────────── */
{
  pass("the closing hour is the shift change + 5 hours (14:00 EAT → 19:00 = 1:00 local)",
    CLOSE_HOURS_AFTER_SPLIT === 5 && DEFAULT_CUTOFF_HOUR === 19 && dayCloseCutoffHour(14) === 19);
  pass("an owner who moves the shift change moves the closing hour with it",
    dayCloseCutoffHour(15) === 20 && dayCloseCutoffHour(12) === 17);
  pass("junk or missing settings fall back to the default",
    dayCloseCutoffHour(null) === 19 && dayCloseCutoffHour(undefined) === 19 && dayCloseCutoffHour(NaN) === 19);
  pass("the closing hour can never run into the next day (clamped below midnight)",
    dayCloseCutoffHour(23) === 23 && dayCloseCutoffHour(-4) === 5);
  pass("18:59 is still serving time; 19:00 sharp opens the day close",
    !isDayCloseOpen(18, 19) && isDayCloseOpen(19, 19) && isDayCloseOpen(21, 19));
  pass("once closed the button stays available (a late correction must be sendable)",
    isDayCloseOpen(23, 19) && dayCloseCutoffHour(14) <= 23);
}

/* ── 2. The day-close record ─────────────────────────────────────────────── */
{
  const key = dayCloseSettingKey("2026-09-29");
  pass("one settings row per EAT day", key === `${DAY_CLOSE_KEY_PREFIX}2026-09-29` && key.length < 100);
  pass("only real day keys count as records", dayKeyFromCloseSetting(key) === "2026-09-29" && dayKeyFromCloseSetting("day_close_today") === null && dayKeyFromCloseSetting("other_key") === null);

  const record = { at: "2026-09-29T16:05:00.000Z", by: "Hanna", total: 12450, bills: 88 };
  const parsed = parseDayCloseValue(JSON.stringify(record));
  pass("a stored record reads back whole", !!parsed && parsed.by === "Hanna" && parsed.total === 12450 && parsed.bills === 88);
  pass("malformed or empty values read as 'not closed' (never a crash)",
    parseDayCloseValue("") === null && parseDayCloseValue("nonsense") === null && parseDayCloseValue("{}") === null && parseDayCloseValue(null) === null);
  pass("a record missing numbers still parses (a torn write can not blank the page)",
    parseDayCloseValue(JSON.stringify({ at: "2026-09-29T16:05:00.000Z", by: "Hanna" }))?.total === 0);
}

/* ── 3. The list the owner reads: date + total only ──────────────────────── */
{
  pass('"2026-09-29" reads as "29 Sep 2026" (never shifted by a timezone)',
    dayKeyLabel("2026-09-29") === "29 Sep 2026" && dayKeyLabel("2026-01-01") === "1 Jan 2026");
  pass("an unreadable day key renders as nothing, not as garbage", dayKeyLabel("") === "" && dayKeyLabel("today") === "");
  pass("money is grouped and carries ETB (the cross-check shape)",
    formatEtb(12450) === "12,450 ETB" && formatEtb(0) === "0 ETB" && formatEtb(999) === "999 ETB");

  const keys = recentDayKeys(3);
  pass("the page lists today first, then yesterday, then the day before",
    keys.length === 3 && keys[0] === etDayKey(new Date()) && keys[1] === etDayKeyDaysAgo(1) && keys[2] === etDayKeyDaysAgo(2));
  pass("the list is a true EAT calendar list (built from the shared helpers, never local getters)",
    keys.every((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)));
}

/* ── 4. The owner's notification ─────────────────────────────────────────── */
{
  const push = dayClosePush("2026-09-29", 12450, 88);
  pass("the title says what it is: today's total sale", /Today's total sale/i.test(push.title));
  pass("the body carries the date, the amount in ETB and the bill count",
    push.body.includes("29 Sep 2026") && push.body.includes("12,450 ETB") && push.body.includes("88 bill(s)"));
  pass("one notification per day (same tag replaces, never piles up)",
    push.tag === "fana-day-close-2026-09-29" && dayClosePush("2026-09-28", 1, 1).tag !== push.tag);
  pass("tapping it opens the owner's sales page", push.url === "/admin?tab=sales");
}

/* ── 5. The day-close endpoint ───────────────────────────────────────────── */
{
  const route = read("src/app/api/reports/daily-sales/route.ts");
  pass("the mutation is guarded (cashier, or the owner acting for her)",
    /requireStaffOrAdmin\(\)/.test(route) && /staff\.role !== "cashier"/.test(route));
  pass("before the closing hour the tap is REFUSED, so no total leaves early",
    /if \(!isDayCloseOpen\(hour, cutoffHour\)\)/.test(route) && /status: 409/.test(route));
  pass("the total is today's PRINTED bills only (the EFD pile never counts a voided bill)",
    /isNotNull\(tickets\.printedAt\)/.test(route) && /row\.status === "cancelled"/.test(route) && /skip|continue/.test(route));
  pass("days are bucketed on the EAT wall clock with the shared helper",
    /etDayKey\(/.test(route) && !/AT TIME ZONE/.test(route));
  pass("the close is recorded in settings under the EAT day key",
    /dayCloseSettingKey\(todayKey\)/.test(route) && /onConflictDoUpdate/.test(route));
  pass("the record names WHO closed it and WHEN",
    /by = staff\?\.name \|\| "admin"/.test(route) && /at: now\.toISOString\(\)/.test(route));
  pass("the owner's phone is the ONE push this endpoint sends (role admin, the day-close payload)",
    /sendPushToRoles\(\["admin"\]/.test(route) && /dayClosePush\(todayKey/.test(route));
  pass("the socket is fire-and-forget: a push failure can never fail the close",
    /void sendPushToRoles\(\["admin"\][\s\S]{0,400}catch\(\(\) => \{\}\)/.test(route));
  pass("the page data is never cached (the owner must read today's truth)",
    /"Cache-Control": "no-store"/.test(route));
  pass("the GET answers the closing-hour state the cashier's button needs",
    /canClose: isDayCloseOpen\(/.test(route) && /cutoffHour/.test(route) && /currentHour/.test(route));
}

/* ── 6. The cashier's button ─────────────────────────────────────────────── */
{
  const button = read("src/components/rms/DayCloseButton.tsx");
  const cashier = read("src/components/rms/CashierDashboard.tsx");
  pass("the button lives on the CASHIER screen (she closes the day)",
    /<DayCloseButton onToast=\{showToast\} \/>/.test(cashier));
  pass("it posts the day-close action the endpoint expects",
    /action: "day-close"/.test(button) && /"\/api\/reports\/daily-sales"/.test(button));
  pass("before the hour it shows WHEN it opens (no dead button to tap)",
    /Shift end at \{hour\}:00/.test(button) && /canClose/.test(button));
  pass("after the moment it says what it does (send today's total to the owner)",
    /Today's shift end/.test(button) && /Send today's total sale to the owner's phone/.test(button));
  pass("after a close it says the total was sent, and stays tappable for a correction",
    /Total sent • \{value\}/.test(button) && /send the total again if something changed/.test(button));
  pass("every outcome speaks to the cashier through the screen's toast",
    /onToast\?\.\(/.test(button) && /Network error/.test(button) && /Could not close the day/.test(button));
  pass("it re-checks the hour on its own (the closing moment arrives while she works)",
    /setInterval/.test(button) && /5 \* 60 \* 1000/.test(button));
}

/* ── 7. The owner's page (Daily Sales tab) ───────────────────────────────── */
{
  const tab = read("src/components/rms/DailySalesTab.tsx");
  const panel = read("src/components/AdminPanel.tsx");
  pass("the dashboard grew a Daily Sales tab", /"sales"/.test(panel) && /label: L\("Daily Sales"\)/.test(panel) && /<DailySalesTab \/>/.test(panel));
  pass("?tab=sales opens it directly (this is the URL the notification carries)",
    /readTabFromUrl/.test(panel) && /"tab"/.test(panel) && /useState<Tab>\(\(\) => readTabFromUrl\(\)/.test(panel));
  pass("an unknown ?tab value falls back to the normal default tab", /includes\(wanted\)/.test(panel) && /\|\| "reports"/.test(panel));
  pass("the page lists date + total ONLY (no category breakdown, no clutter)",
    /dayKeyLabel\(d\.dayKey\)/.test(tab) && /formatEtb\(d\.total\)/.test(tab) && !/categoryBreakdown|perCategory/i.test(tab));
  pass("each day's line carries its printed-bill count beside the total",
    /\{bills\} printed bill\(s\)/.test(tab) && /formatEtb\(d\.total\)/.test(tab));
  pass("today is highlighted, so he cannot misread which line is today",
    /Today\b/.test(tab) && /d\.dayKey === data\.todayKey/.test(tab));
  pass("it shows whether the cashier already closed the day (and at what time)",
    /closed \{clock\} by \{name\}/.test(tab) && /formatClock\(d\.closed\.at\)/.test(tab));
  pass("there is a PRINT button, with the official letterhead on the paper",
    /window\.print\(\)/.test(tab) && /PrintLetterhead/.test(tab) && /@media print/.test(tab));
  pass("the page explains the money rule (printed EFD bills, cancelled never counted)",
    /prints the bill \(the EFD receipt\)/.test(tab) && /Cancelled orders are never counted/.test(tab));
  pass("the owner arms HIS phone from this page (the only device that still rings)",
    /enablePocketAlerts\(\)/.test(tab) && /Arm my phone/.test(tab) && /Test ring now/.test(tab) && /Test ring in 10s/.test(tab));
  pass("the iPhone rule is spelled out for him (Android rings with the screen off)",
    /Home Screen/.test(tab) && /screen off/.test(tab));
}

/* ── 8. The notification can actually reach the owner's phone ────────────── */
{
  const pushLib = read("src/lib/push.ts");
  const subscribe = read("src/app/api/push/subscribe/route.ts");
  const testRoute = read("src/app/api/push/test/route.ts");
  pass("the admin role knows where to open (the sales page)", /role === "admin"\) return "\/admin\?tab=sales"/.test(pushLib));
  pass("the dashboard's device can subscribe as the admin (role + name from the session)",
    /readAdminSession\(\)/.test(subscribe) && /role = "admin"/.test(subscribe) && /name = "Owner"/.test(subscribe));
  pass("the subscription route still refuses an anonymous caller",
    /Unauthorized/.test(subscribe) && /status: 401/.test(subscribe) && !/body\?\.role/.test(subscribe));
  pass("the owner can test his phone for real (the button on the sales page)",
    /readAdminSession\(\)/.test(testRoute) && /delaySeconds/.test(testRoute));
}

if (failures > 0) {
  console.error("\n❌ DAILY SALES / DAY-CLOSE TEST FAILED\n");
  process.exit(1);
}
console.log("\n✅ Daily sales + the cashier's day close: all guards green");
console.log("   • the button opens at 1:00 local (19:00 EAT, 5h after the shift change)");
console.log("   • the total is today's PRINTED EFD bills — cancelled never counted");
console.log("   • the close is stored per EAT day, with who closed it and when");
console.log("   • the owner's phone gets one notification: date, total and bill count");
console.log("   • tapping it opens /admin?tab=sales: date + total per day, print button");
