#!/usr/bin/env tsx
/**
 * Regression guard: THE OWNER'S DAILY SALES + THE CASHIER'S DAY CLOSE
 * (owner's decisions, 29 Sept 2026 — round 4 timings).
 *
 * What the owner asked for, in his order:
 *   • "the today's shift end button will appear at 2 local time or 8:00 pm" —
 *     the cashier's button opens at 20:00 EAT, and her screen plays the alarm
 *     and shows a card at that moment;
 *   • "if she forgets to click that button the system will automatically send
 *     that notification after 1 hour which is 3 local time or 9:00 pm" — a
 *     server-side check sends the owner's notification (background worker plus
 *     a safety net in the page load; no screen has to stay open);
 *   • "that button will disappear at midnight or 6 local time ... because
 *     after that counted as next day" — the window closes at the EAT midnight
 *     roll-over;
 *   • "in that tab add choose time to notify button ... as default I choose 3
 *     lt but he can choose it there" — 21:00 / 22:00 / 23:00 EAT, and the
 *     button opens one hour before the chosen time;
 *   • "whenever the owner opens that page it shows him the total price that got
 *     printed up to that time" — live totals, never cached;
 *   • "for now only todays and yesterday total sale ... but starting from
 *     tomorrow it started listed" — today + yesterday + the days closed since
 *     the feature started.
 *
 * Run with: npx tsx scripts/verify-daily-sales.ts   (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AUTO_CLOSE_BY,
  DEFAULT_CUTOFF_HOUR,
  DEFAULT_NOTIFY_HOUR,
  DAY_CLOSE_KEY_PREFIX,
  DAY_CLOSE_NOTIFY_KEY,
  dayCloseCutoffHour,
  dayCloseMoment,
  dayCloseNotifyHour,
  dayClosePush,
  dayCloseSettingKey,
  dayKeyFromCloseSetting,
  dayKeyLabel,
  formatEtb,
  isDayCloseDue,
  isDayCloseOpen,
  isNotifyHourSettingKey,
  listedDayKeys,
  localLabelForHour,
  NOTIFY_HOUR_CHOICES,
  parseDayCloseValue,
  recentDayKeys,
  yesterdayKey,
} from "../src/lib/daily-sales";
import { bucketByDay } from "../src/lib/day-close";
import { etDayKey, etDayKeyDaysAgo } from "../src/lib/timezone";

let failures = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
  if (!cond) failures++;
};

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

/* ── 1. WHEN the button opens and WHEN the system sends ──────────────────── */
{
  pass("the default notify hour is 3:00 local (21:00 EAT) — the owner's own default",
    DEFAULT_NOTIFY_HOUR === 21 && dayCloseNotifyHour(21) === 21 && NOTIFY_HOUR_CHOICES.includes(21));
  pass("the owner may move it to 4:00 or 5:00 local (22:00 / 23:00 EAT), nothing else",
    NOTIFY_HOUR_CHOICES.length === 3 && dayCloseNotifyHour(22) === 22 && dayCloseNotifyHour(23) === 23 &&
      dayCloseNotifyHour(19) === 21);
  pass("junk or missing settings fall back to 3:00 local (a bad row can never silence the total)",
    dayCloseNotifyHour(null) === 21 && dayCloseNotifyHour(undefined) === 21 && dayCloseNotifyHour("") === 21 &&
      dayCloseNotifyHour("nonsense") === 21 && dayCloseNotifyHour(NaN) === 21 && dayCloseNotifyHour(21.5) === 21);

  pass("2:00 local = 20:00 EAT: the button opens ONE hour before the owner's notify time",
    DEFAULT_CUTOFF_HOUR === 20 && dayCloseCutoffHour(21) === 20 && dayCloseCutoffHour(22) === 21 &&
      dayCloseCutoffHour(23) === 22);
  pass("19:59 is still serving time; 20:00 sharp opens the day close",
    !isDayCloseOpen(19, 20) && isDayCloseOpen(20, 20) && isDayCloseOpen(23, 20));
  pass("the button disappears at midnight (the next EAT day opens its own evening window)",
    !isDayCloseOpen(0, 20) && !isDayCloseOpen(5, 20) && isDayCloseOpen(20, 20));
  pass("the automatic send lands at the owner's hour, and never before it",
    !isDayCloseDue(20, 21) && isDayCloseDue(21, 21) && isDayCloseDue(23, 23) && !isDayCloseDue(22, 23));
  pass("junk in the due check falls back to the default hour",
    isDayCloseDue(21, NaN) && !isDayCloseDue(20, NaN));

  pass("the owner reads the times on his own clock (12-hour labels)",
    localLabelForHour(21) === "9:00 PM EAT" && localLabelForHour(22) === "10:00 PM EAT" &&
      localLabelForHour(23) === "11:00 PM EAT" && localLabelForHour(20) === "8:00 PM EAT");
  pass("the exact minute is printable for the screens", dayCloseMoment(20) === "20:00" && dayCloseMoment(23) === "23:00");
}

/* ── 2. The day-close record (one row per EAT day) ───────────────────────── */
{
  const key = dayCloseSettingKey("2026-09-29");
  pass("one settings row per EAT day", key === `${DAY_CLOSE_KEY_PREFIX}2026-09-29` && key.length < 100);
  pass("the notify hour has its own settings key, kept out of the day records",
    DAY_CLOSE_NOTIFY_KEY === "day_close_notify_hour" && isNotifyHourSettingKey(DAY_CLOSE_NOTIFY_KEY) &&
      !dayKeyFromCloseSetting(DAY_CLOSE_NOTIFY_KEY));
  pass("only real day keys count as records",
    dayKeyFromCloseSetting(key) === "2026-09-29" && dayKeyFromCloseSetting("day_close_today") === null &&
      dayKeyFromCloseSetting("other_key") === null);

  const record = { at: "2026-09-29T18:05:00.000Z", by: "Hanna", total: 12450, bills: 88 };
  const parsed = parseDayCloseValue(JSON.stringify(record));
  pass("a stored record reads back whole", !!parsed && parsed.by === "Hanna" && parsed.total === 12450 && parsed.bills === 88);
  pass("malformed or empty values read as 'not closed' (never a crash)",
    parseDayCloseValue("") === null && parseDayCloseValue("nonsense") === null && parseDayCloseValue("{}") === null &&
      parseDayCloseValue(null) === null);
  pass("a record missing numbers still parses (a torn write can not blank the page)",
    parseDayCloseValue(JSON.stringify({ at: "2026-09-29T18:05:00.000Z", by: "Hanna" }))?.total === 0);
  pass("the automatic send has its own name in the record (the owner sees who closed it)",
    AUTO_CLOSE_BY === "auto (system)");
}

/* ── 3. WHAT COUNTS: printed bills, bucketed on the EAT calendar day ─────── */
{
  const rows = [
    { printedAt: new Date("2026-09-29T06:00:00Z"), totalAmount: 100, status: "paid" }, // 09:00 EAT 29th
    { printedAt: new Date("2026-09-29T18:00:00Z"), totalAmount: 250, status: "completed" }, // 21:00 EAT 29th
    { printedAt: new Date("2026-09-29T21:30:00Z"), totalAmount: 400, status: "paid" }, // 00:30 EAT 30th
    { printedAt: new Date("2026-09-29T19:00:00Z"), totalAmount: 999, status: "cancelled" }, // never counted
    { printedAt: null, totalAmount: 500, status: "paid" }, // never printed
    { printedAt: new Date("2026-09-29T20:00:00Z"), totalAmount: null, status: "paid" }, // no amount stored
  ];
  const byDay = bucketByDay(rows);
  pass("a bill counts on the EAT day the cashier printed it (not the next day)",
    byDay.get("2026-09-29")?.total === 350 && byDay.get("2026-09-29")?.bills === 3);
  pass("after midnight the print belongs to the NEXT day (\"after that counted as next day\")",
    byDay.get("2026-09-30")?.total === 400 && byDay.get("2026-09-30")?.bills === 1);
  pass("a cancelled bill is never counted", ![...byDay.values()].some((v) => v.total >= 999));
  pass("a bill that was never printed, or has no amount, cannot invent money",
    byDay.size === 2 && (byDay.get("2026-09-29")?.total ?? 0) === 350);
}

/* ── 4. The list the owner reads ─────────────────────────────────────────── */
{
  pass('"2026-09-29" reads as "29 Sep 2026" (never shifted by a timezone)',
    dayKeyLabel("2026-09-29") === "29 Sep 2026" && dayKeyLabel("2026-01-01") === "1 Jan 2026");
  pass("an unreadable day key renders as nothing, not as garbage", dayKeyLabel("") === "" && dayKeyLabel("today") === "");
  pass("money is grouped and carries ETB (the cross-check shape)",
    formatEtb(12450) === "12,450 ETB" && formatEtb(0) === "0 ETB" && formatEtb(999) === "999 ETB");

  const listed = listedDayKeys({
    todayKey: "2026-09-29",
    yesterdayKey: "2026-09-28",
    closedKeys: ["2026-09-29", "2026-09-27", "2026-09-20"],
    salesKeys: ["2026-09-26"],
  });
  pass("today and yesterday are ALWAYS listed, newest first",
    listed[0] === "2026-09-29" && listed[1] === "2026-09-28");
  pass("every day closed since the feature started is kept (the history grows one day at a time)",
    listed.includes("2026-09-27") && listed.includes("2026-09-20") && listed.length === 4);
  pass("a day before the feature (sales but never closed) is NOT listed — the rule the owner gave",
    !listed.includes("2026-09-26"));
  pass("junk day keys can never enter the list",
    listedDayKeys({ todayKey: "2026-09-29", yesterdayKey: null, closedKeys: ["garbage", ""] }).length === 1);
  pass("yesterday is computed from the EAT calendar, not the local clock",
    yesterdayKey(new Date("2026-09-29T21:30:00Z")) === etDayKeyDaysAgo(1));

  const keys = recentDayKeys(3);
  pass("the rolling list is a true EAT calendar list (built from the shared helpers, never local getters)",
    keys.length === 3 && keys[0] === etDayKey(new Date()) && keys[1] === etDayKeyDaysAgo(1) &&
      keys[2] === etDayKeyDaysAgo(2) && keys.every((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)));
}

/* ── 5. The owner's notification ─────────────────────────────────────────── */
{
  const push = dayClosePush("2026-09-29", 12450, 88);
  pass("the title says what it is: today's total sale", /Today's total sale/i.test(push.title));
  pass("the body carries the date, the amount in ETB and the bill count",
    push.body.includes("29 Sep 2026") && push.body.includes("12,450 ETB") && push.body.includes("88 bill(s)"));
  pass("one notification per day (same tag replaces, never piles up)",
    push.tag === "fana-day-close-2026-09-29" && dayClosePush("2026-09-28", 1, 1).tag !== push.tag);
  pass("tapping it opens the owner's sales page", push.url === "/admin?tab=sales");

  const pushLib = read("src/lib/push.ts");
  const sender = read("src/lib/day-close.ts");
  pass("it is sent as a NORMAL notification (owner's wording), not the old urgent staff alert",
    /urgent: false/.test(sender) && /repeat: 0/.test(sender));
  pass("the owner's phone is the ONE push this feature sends (role admin)",
    /sendPushToRoles\(\["admin"\]/.test(sender) && /role === "admin"\) return "\/admin\?tab=sales"/.test(pushLib));
}

/* ── 6. The automatic send: server-side, exactly once ────────────────────── */
{
  const logic = read("src/lib/day-close.ts");
  const route = read("src/app/api/reports/daily-sales/route.ts");
  const instr = read("src/instrumentation.ts");

  pass("the automatic send does not depend on any screen: a server worker runs it",
    /export function startDayCloseWorker/.test(logic) && /setInterval\(\(\) => void tick\(\), POLL_MS\)/.test(logic) &&
      /const POLL_MS = 60_000/.test(logic));
  pass("the worker starts with the server (same startup hook as the waiter send queue)",
    /startDayCloseWorker\(\)/.test(instr) && /startDeferredTicketWorker\(\)/.test(instr));
  pass("a page load is a second safety net (the owner opening his tab also sends it)",
    /void maybeAutoCloseDay\(\)\.catch\(\(\) => \{\}\)/.test(route));
  pass("the check waits for the owner's hour and stops once the day is closed",
    /isDayCloseDue\(hour, notifyHour\)/.test(logic) && /if \(await readTodayClose\(dayKey\)\) return "closed"/.test(logic));

  pass("the automatic send writes the day record ONLY if it is missing (exactly once)",
    /onConflictDoNothing\(\{ target: siteSettings\.key \}\)/.test(logic) && /returning\(\{ key: siteSettings\.key \}\)/.test(logic));
  pass("the notification leaves only when its own insert won the race",
    /if \(!written\) return "raced"/.test(logic) && /sendDayClosePush\(dayKey, record\.total, record\.bills\)/.test(logic));
  pass("the cashier's own tap always writes (a correction can be sent again) and always notifies",
    /onConflictDoUpdate\(\{ target: siteSettings\.key/.test(logic) && /sendDayClosePush\(todayKey, record\.total, record\.bills\)/.test(route));
  pass("the record says whether it was the automatic send or the cashier",
    /by: input\.mode === "auto" \? AUTO_CLOSE_BY : input\.by/.test(logic));
}

/* ── 7. The day-close endpoint ───────────────────────────────────────────── */
{
  const route = read("src/app/api/reports/daily-sales/route.ts");
  const logic = read("src/lib/day-close.ts");
  pass("the mutation is guarded (cashier, or the owner acting for her)",
    /requireStaffOrAdmin\(\)/.test(route) && /staff\.role !== "cashier"/.test(route));
  pass("before the closing hour the tap is REFUSED, so no total leaves early",
    /if \(!isDayCloseOpen\(hour, cutoffHour\)\)/.test(route) && /status: 409/.test(route));
  pass("the total is today's PRINTED bills only (the EFD pile never counts a voided bill)",
    /isNotNull\(tickets\.printedAt\)/.test(logic) && /row\.status === "cancelled"/.test(logic));
  pass("days are bucketed on the EAT wall clock with the shared helper",
    /etDayKey\(/.test(logic) && !/AT TIME ZONE/.test(logic));
  pass("the close is recorded in settings under the EAT day key",
    /dayCloseSettingKey\(input\.dayKey\)/.test(logic) && /onConflictDoUpdate/.test(logic));
  pass("the record names WHO closed it and WHEN",
    /by: staff\?\.name \|\| "admin"/.test(route) && /at: at\.toISOString\(\)/.test(logic));
  pass("the page data is never cached (the owner must read today's truth)",
    /"Cache-Control": "no-store"/.test(route));
  pass("the GET answers the closing-hour state the cashier's button needs",
    /canClose: isDayCloseOpen\(/.test(route) && /cutoffHour/.test(route) && /currentHour/.test(route));
  pass("the GET also answers the notify hour, so both screens read one truth",
    /notifyHour/.test(route) && /dueNow: isDayCloseDue\(/.test(route) && /readNotifyHour\(\)/.test(route));

  pass("ONLY the owner may move the notify hour (admin session, never the cashier)",
    /action === "set-notify-hour"/.test(route) && /status: 403/.test(route) && /Only the owner can change this/.test(route));
  pass("only the three offered hours are accepted (anything else is refused)",
    /dayCloseNotifyHour\(body\?\.hour\)/.test(route) && /status: 400/.test(route) &&
      /Choose 21:00, 22:00 or 23:00/.test(route));
  pass("the POST exposes the auto action the system uses",
    /body\?\.auto === true/.test(route) && /await maybeAutoCloseDay\(now\)/.test(route));
}

/* ── 8. The cashier's button: alarm + card at 20:00, auto at 21:00 ───────── */
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
  pass("it re-checks the clock on its own every minute (the closing moment arrives while she works)",
    /setInterval\(\(\) => void load\(\), 60 \* 1000\)/.test(button));

  pass("THE ALARM: the moment the button opens, this screen rings",
    /playAlarm\(\)/.test(button));
  pass("THE CARD: the same moment shows a card that says the button is available",
    /setCardOpen\(true\)/.test(button) && /Today's shift end is open/.test(button) &&
      /Send today's total sale to the owner's phone\. The system sends it by itself at \{hour\}:00 if you forget\./.test(button));
  pass("the alarm and card fire ONCE per day (a reload at 20:30 must not ring again)",
    /localStorage\.setItem\(announceKey, "1"\)/.test(button) && /localStorage\.getItem\(announceKey\)/.test(button));
  pass("the screen also runs the automatic send when the owner's hour lands (safety net beside the worker)",
    /action: "day-close", auto: true/.test(button) && /if \(dueNow && !closed\) void autoSend\(\)/.test(button));
  pass("the card carries one-action button and a way to postpone it",
    /✓ Send to the owner now/.test(button) && /Later/.test(button));
}

/* ── 9. The owner's page (Daily Sales tab) ───────────────────────────────── */
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
    /closed \{clock\} by \{name\}/.test(tab) && /d\.closed/.test(tab));
  pass("REAL TIME: the page reloads itself every minute and asks for no cached copy",
    /setInterval\(\(\) => void loadRef\.current\(\), 60 \* 1000\)/.test(tab) && /cache: "no-store"/.test(tab));
  pass("the page carries the two moments (button opens, system sends)",
    /Opens at \{hour\}:00/.test(tab) && /If she forgets, the system sends it by itself at \{hour\}:00\./.test(tab));
  pass("THE OWNER CHOOSES HIS HOUR on the page (three offered times, his saved one marked)",
    /action: "set-notify-hour"/.test(tab) && /NOTIFY_HOUR_CHOICES\.map/.test(tab) && /data\?\.notifyHour === hour/.test(tab));
  pass("the moment he changes it, the page reloads the new truth",
    /✓ Your phone will ring at \{time\}/.test(tab) && /await load\(\)/.test(tab));

  pass("there is a PRINT button, with the official letterhead on the paper",
    /window\.print\(\)/.test(tab) && /PrintLetterhead/.test(tab) && /@media print/.test(tab));
  pass("the page explains the money rule (printed EFD bills, cancelled never counted)",
    /prints the bill \(the EFD receipt\)/.test(tab) && /Cancelled orders are never counted/.test(tab));
  pass("the owner arms HIS phone from this page (the only device that still rings)",
    /enablePocketAlerts\(\)/.test(tab) && /Arm my phone/.test(tab) && /Test ring now/.test(tab) && /Test ring in 10s/.test(tab));
  pass("the iPhone rule is spelled out for him (Android rings with the screen off)",
    /Home Screen/.test(tab) && /screen off/.test(tab));
}

/* ── 10. The notification can actually reach the owner's phone ───────────── */
{
  const subscribe = read("src/app/api/push/subscribe/route.ts");
  const testRoute = read("src/app/api/push/test/route.ts");
  pass("the dashboard's device can subscribe as the admin (role + name from the session)",
    /readAdminSession\(\)/.test(subscribe) && /role = "admin"/.test(subscribe) && /name = "Owner"/.test(subscribe));
  pass("the subscription route still refuses an anonymous caller",
    /Unauthorized/.test(subscribe) && /status: 401/.test(subscribe) && !/body\?\.role/.test(subscribe));
  pass("the owner can test his phone for real (the button on the sales page)",
    /readAdminSession\(\)/.test(testRoute) && /delaySeconds/.test(testRoute));
}

/* ── 11. The owner's words are the comments the next reader will trust ───── */
{
  const logic = read("src/lib/daily-sales.ts");
  pass("the timings are written down where a future reader will find them (local ⇄ EAT, the owner's quotes)",
    /2 local time or 8:00 pm/.test(logic) && /3 local time or 9:00 pm/.test(logic) &&
      /midnight or 6 local time/.test(logic) && /counted as next day/.test(logic));
}

if (failures > 0) {
  console.error("\n❌ DAILY SALES / DAY-CLOSE TEST FAILED\n");
  process.exit(1);
}
console.log("\n✅ Daily sales + the cashier's day close: all guards green");
console.log("   • the button opens at 2:00 local (20:00 EAT) with the alarm + card");
console.log("   • if she forgets, the system sends the owner's notification at 3:00 local (21:00 EAT)");
console.log("   • the button disappears at midnight (6:00 local) — the next day counts separately");
console.log("   • the owner picks the hour on the page; today's figure is live; today + yesterday + closed days");
console.log("   • tapping the notification opens /admin?tab=sales: date + total per day, print button");
