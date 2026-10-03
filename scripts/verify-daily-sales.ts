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
 *   • keep the daily history available: today, yesterday, every receipt-backed
 *     sale day loaded from history, and every saved close record.
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
  dayCloseCutoffTime,
  dayCloseNotifyMinute,
  dayCloseNotifyTime,
  dayCloseSettingKey,
  dayKeyFromCloseSetting,
  dayKeyLabel,
  formatEtb,
  isDayCloseDue,
  isDayCloseOpen,
  isNotifyHourSettingKey,
  isNotifyTime,
  listedDayKeys,
  localLabelForHour,
  localLabelForTime,
  NOTIFY_HOUR_CHOICES,
  notifyTimeValue,
  parseClockTime,
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
  pass("the three whole hours are only QUICK PICKS now (21 / 22 / 23 EAT)",
    NOTIFY_HOUR_CHOICES.length === 3 && dayCloseNotifyHour(22) === 22 && dayCloseNotifyHour(23) === 23 &&
      dayCloseNotifyHour(19) === 19);

  // ANY TIME, TO THE MINUTE (owner, 30 Sept 2026): "make it look like i can add
  // any time like 3:03 or any other make it changable to any".
  pass("ANY minute of the evening is accepted, not only the whole hours (\"3:03\" = 21:03 EAT)",
    dayCloseNotifyTime("21:03").hour === 21 && dayCloseNotifyTime("21:03").minute === 3 &&
      dayCloseNotifyTime({ hour: 20, minute: 47 }).minute === 47 && dayCloseNotifyHour("22:15") === 22 &&
      dayCloseNotifyMinute("22:15") === 15);
  pass("the owner reads a typed 12-hour time too (9:03 PM = 21:03)",
    parseClockTime("9:03 PM")?.hour === 21 && parseClockTime("9:03 PM")?.minute === 3 &&
      parseClockTime("12:05 am")?.hour === 0 && parseClockTime("nonsense") === null);
  pass("a row written before minutes existed (\"21\") still reads as 21:00",
    dayCloseNotifyTime("21").minute === 0 && dayCloseNotifyTime(21).hour === 21 &&
      dayCloseNotifyTime("21").hour === 21);
  pass("the setting is stored as HH:MM (21:03), and reads back the same",
    notifyTimeValue({ hour: 21, minute: 3 }) === "21:03" && notifyTimeValue({ hour: 19, minute: 5 }) === "19:05" &&
      dayCloseNotifyTime(notifyTimeValue({ hour: 21, minute: 3 })).minute === 3);
  pass("only the evening window is legal: 12:00 PM .. 11:59 PM EAT (a 00:30 pick would close TOMORROW)",
    isNotifyTime(12, 0) && isNotifyTime(23, 59) && isNotifyTime(21, 3) &&
      !isNotifyTime(11, 59) && !isNotifyTime(0, 30) && !isNotifyTime(24, 0) && !isNotifyTime(21, 60) &&
      !isNotifyTime(21.5, 0));
  pass("junk or missing settings fall back to 3:00 local (a bad row can never silence the total)",
    dayCloseNotifyHour(null) === 21 && dayCloseNotifyHour(undefined) === 21 && dayCloseNotifyHour("") === 21 &&
      dayCloseNotifyHour("nonsense") === 21 && dayCloseNotifyHour(NaN) === 21 && dayCloseNotifyHour(21.5) === 21 &&
      dayCloseNotifyTime("nonsense").minute === 0 && dayCloseNotifyTime("03:03").hour === 21);

  pass("2:00 local = 20:00 EAT: the button opens ONE hour before the owner's notify time",
    DEFAULT_CUTOFF_HOUR === 20 && dayCloseCutoffHour(21) === 20 && dayCloseCutoffHour(22) === 21 &&
      dayCloseCutoffHour(23) === 22);
  pass("...and one hour before his MINUTE too (21:03 opens the button at 20:03)",
    dayCloseCutoffTime("21:03").hour === 20 && dayCloseCutoffTime("21:03").minute === 3 &&
      isDayCloseOpen(20, 20, 2, 3) === false && isDayCloseOpen(20, 20, 3, 3) === true);
  pass("19:59 is still serving time; 20:00 sharp opens the day close",
    !isDayCloseOpen(19, 20) && isDayCloseOpen(20, 20) && isDayCloseOpen(23, 20));
  pass("the button disappears at midnight (the next EAT day opens its own evening window)",
    !isDayCloseOpen(0, 20) && !isDayCloseOpen(5, 20) && isDayCloseOpen(20, 20));
  pass("the automatic send lands at the owner's hour, and never before it",
    !isDayCloseDue(20, 21) && isDayCloseDue(21, 21) && isDayCloseDue(23, 23) && !isDayCloseDue(22, 23));
  pass("junk in the due check falls back to the default hour",
    isDayCloseDue(21, NaN) && !isDayCloseDue(20, NaN));
  pass("the automatic send waits for the owner's MINUTE (21:03, not the top of the hour)",
    !isDayCloseDue(21, 21, 2, 3) && isDayCloseDue(21, 21, 3, 3) && isDayCloseDue(21, 21, 4, 3) &&
      !isDayCloseDue(20, 21, 59, 3));

  pass("the owner reads the times on his own clock (12-hour labels)",
    localLabelForHour(21) === "9:00 PM EAT" && localLabelForHour(22) === "10:00 PM EAT" &&
      localLabelForHour(23) === "11:00 PM EAT" && localLabelForHour(20) === "8:00 PM EAT");
  pass("the exact minute is printable for the screens", dayCloseMoment(20) === "20:00" && dayCloseMoment(23) === "23:00");
  pass("the owner's own minute prints too (21:03 reads as 9:03 PM on his clock)",
    dayCloseMoment(21, 3) === "21:03" && localLabelForTime(21, 3) === "9:03 PM EAT" &&
      localLabelForTime(12, 5) === "12:05 PM EAT");
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
  pass("every saved close record and every loaded receipt-backed sale day is listed",
    listed.includes("2026-09-27") && listed.includes("2026-09-20") && listed.includes("2026-09-26") && listed.length === 5);
  pass("the history is not limited to today and yesterday", listed.length > 2 && listed[0] === "2026-09-29");
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
  pass("a page load is a second safety net (the owner opening his tab also sends it), AWAITED so the page is never a moment behind",
    /await maybeAutoCloseDay\(\)\.catch\(\(\) => \{\}\)/.test(route));
  pass("the check waits for the owner's hour, and the day's own latch is the only thing that stops it",
    /isDayCloseDue\(hour, notifyTime\.hour, etMinute\(now\), notifyTime\.minute\)/.test(logic) &&
      /if \(!\(await claimAutoSendDay\(dayKey, now\)\)\) return "closed"/.test(logic) &&
      // A close record must NOT block the send any more: the cashier tapping
      // early does not end the day, so the automatic time carries the bigger
      // final number the owner reconciles against the drawer.
      !/if \(await readTodayClose\(dayKey\)\) return "closed"/.test(logic));

  pass("the automatic send is latched once a day by its OWN marker row (exactly once)",
    /onConflictDoNothing\(\{ target: siteSettings\.key \}\)/.test(logic) && /returning\(\{ key: siteSettings\.key \}\)/.test(logic) &&
      /claimAutoSendDay/.test(logic) && /dayCloseAutoSentKey/.test(logic));
  pass("the latch is claimed AFTER the bills are added up, so a hiccup retries instead of burning the day",
    /const totals = await todayTotals\(dayKey\);\s*\n\s*if \(!\(await claimAutoSendDay/.test(logic));
  pass("a send that reached no phone hands the day back, so a phone armed later still gets the total",
    /await releaseAutoSendDay\(dayKey\)/.test(logic) && /if \(push\.sent > 0\) return "sent"/.test(logic) &&
      /export async function releaseAutoSendDay/.test(logic));
  pass("the notification leaves only when its own insert won the race",
    /sendDayClosePush\(dayKey, record\.total, record\.bills\)/.test(logic));
  pass("EVERY send is awaited and reports how many phones answered (3 Oct 2026)",
    /export async function sendDayClosePush/.test(logic) && /Promise<PushSendResult>/.test(logic) &&
      /const push = await sendDayClosePush/.test(route) && /const push = await sendDayClosePush/.test(logic) &&
      /was NOT delivered to any owner phone/.test(logic));
  pass("the cashier's own tap always writes (a correction can be sent again) and always notifies",
    /onConflictDoUpdate\(\{ target: siteSettings\.key/.test(logic) && /await sendDayClosePush\(todayKey, record\.total, record\.bills\)/.test(route));
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
    /if \(!isDayCloseOpen\(hour, cutoffHour, minute, cutoff\.minute\)\)/.test(route) && /status: 409/.test(route));
  pass("the total uses receipt-attributed item quantities and excludes cancelled/unprinted work",
    /saleLinesForTicket\(/.test(logic) && /ticket_printed/.test(logic) && /item_quantity_changed/.test(logic) &&
      /row\.status === "cancelled"/.test(logic));
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
  pass("the GET also answers the notify time (hour AND minute), so both screens read one truth",
    /notifyMinute/.test(route) && /dueNow: isDayCloseDue\(/.test(route) && /readNotifyTime\(\)/.test(route) &&
      /notifyAt: dayCloseMoment\(notifyHour, notifyMinute\)/.test(route));
  pass("the worker's check reads the wall clock to the MINUTE (EAT, never the server's getters)",
    /isDayCloseDue\(hour, notifyTime\.hour, etMinute\(now\), notifyTime\.minute\)/.test(logic) &&
      /export function etMinute/.test(read("src/lib/timezone.ts")));

  pass("ONLY the owner may move the notify time (admin session, never the cashier)",
    /action === "set-notify-hour" \|\| action === "set-notify-time"/.test(route) && /status: 403/.test(route) &&
      /Only the owner can change this/.test(route));
  pass("ANY evening time is accepted, and anything outside it is refused (400)",
    /isNotifyTime\(hour, minute\)/.test(route) && /status: 400/.test(route) &&
      /between 12:00 PM and 11:59 PM EAT/.test(route) && /notifyTimeValue\(\{ hour, minute \}\)/.test(route));
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
  pass("before the hour it shows WHEN it opens, to the owner's exact minute",
    /Shift end at \{time\}/.test(button) && /state\.cutoffAt/.test(button) && /canClose/.test(button));
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
      /Send today's total sale to the owner's phone\. The system sends it by itself at \{time\} if you forget\./.test(button));
  pass("the alarm and card fire ONCE per day (a reload at 20:30 must not ring again)",
    /localStorage\.setItem\(announceKey, "1"\)/.test(button) && /localStorage\.getItem\(announceKey\)/.test(button));
  pass("the screen also runs the automatic send when the owner's hour lands (safety net beside the worker)",
    /action: "day-close", auto: true/.test(button) && /if \(dueNow\)/.test(button) &&
      /localStorage\.setItem\(autoKey, "1"\)/.test(button) &&
      // It must NOT be skipped because a close record already exists: an early
      // tap does not end the day, so the automatic time still carries the
      // final total.
      !/if \(dueNow && !closed\)/.test(button));
  pass("the card tells the cashier the tap is a snapshot, not a lock (owner's words, 3 Oct 2026)",
    /This sends the total up to now\. Orders placed after it keep counting/.test(button) &&
      /This sends the total up to now\. Orders placed after it keep counting/.test(read("src/lib/staff-dictionary.ts")));
  pass("a tap only says 'sent' when a phone actually accepted it",
    /!r\.ok \|\| data\?\.ok === false/.test(button) && /data\?\.ok === false/.test(button));
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
  pass("the page carries the two moments (button opens, system sends), to the minute",
    /Opens at \{time\}/.test(tab) && /If she forgets, the system sends it by itself at \{time\}\./.test(tab) &&
      /data\?\.notifyAt/.test(tab) && /data\?\.cutoffAt/.test(tab));
  pass("THE OWNER TYPES ANY TIME on the page: a real time field, not three fixed hours",
    /type="time"/.test(tab) && /min="12:00"/.test(tab) && /max="23:59"/.test(tab) &&
      /action: "set-notify-time"/.test(tab) && /parseClockTime\(draftValue\)/.test(tab));
  pass("the three old hours stay as QUICK PICKS that only fill the field",
    /NOTIFY_HOUR_CHOICES\.map/.test(tab) && /chooseHour\(hour\)/.test(tab) &&
      /const chooseHour = \(hour: number\) => setDraftTime/.test(tab));
  pass("SAVE sits on the RIGHT of the field and stores nothing until he presses it",
    /ml-auto shrink-0 bg-\[#C9A227\]/.test(tab) && /disabled=\{savingHour \|\| !timeChanged\}/.test(tab) &&
      /Not saved yet • press Save/.test(tab));
  pass("the moment he saves it, the page reloads the new truth",
    /✓ Your phone will ring at \{time\}/.test(tab) && /await load\(\)/.test(tab));

  pass("there is a PRINT button, with the official letterhead on the paper",
    /window\.print\(\)/.test(tab) && /PrintLetterhead/.test(tab) && /@media print/.test(tab));
  pass("the page explains the money rule (printed EFD bills, cancelled never counted)",
    /prints the bill \(the EFD receipt\)/.test(tab) && /Cancelled orders are never counted/.test(tab));
  pass("phone setup is reduced to testing the ring and turning notifications on",
    /enablePocketAlerts\(\)/.test(tab) && /Test ring sound/.test(tab) && /Turn on notifications/.test(tab) &&
      !/Arm my phone|Test ring now|Test ring in 10s/.test(tab));
  pass("turning notifications on requests browser permission when needed",
    /Notification\.requestPermission\(\)/.test(read("src/lib/push-client.ts")) && /enablePocketAlerts\(\)/.test(tab));
  pass("an open Admin page rings for the push even though its visible OS notification is silent",
    /armAudioOnFirstGesture\(\)/.test(panel) && /data\?\.type === "fana-push"/.test(panel) && /playAlarm\(\)/.test(panel) &&
      /document\.visibilityState === "visible" && document\.hasFocus\(\)/.test(panel) && /silent: true/.test(read("public/sw.js")));
  pass("the note explains shift-end and automatic timing, tap navigation, and device behavior",
    /cashier ends the shift/.test(tab) && /automatically at \{time\}/.test(tab) && /Admin → Sales/.test(tab) &&
      /Home Screen/.test(tab) && /screen off/.test(tab));
}

/* ── 10. The notification can actually reach the owner's phone ───────────── */
{
  const subscribe = read("src/app/api/push/subscribe/route.ts");
  const resubscribe = read("src/app/api/push/resubscribe/route.ts");
  const testRoute = read("src/app/api/push/test/route.ts");
  const pushServer = read("src/lib/push.ts");
  const client = read("src/lib/push-client.ts");
  const tab = read("src/components/rms/DailySalesTab.tsx");
  const route = read("src/app/api/reports/daily-sales/route.ts");

  pass("the dashboard's device can subscribe as the admin (role + name from the session)",
    /readAdminSession\(\)/.test(subscribe) && /adminSession \? "admin"/.test(subscribe) && /adminSession \? "Owner"/.test(subscribe));
  // "I allowed notifications and received nothing": one phone can hold BOTH
  // cookies, and the staff one used to win, so the owner's phone subscribed as
  // a crew member and the total (sent to role "admin") had nowhere to go.
  pass("the ADMIN session wins over a staff one, so the owner's phone is never filed as a crew device",
    /const role = adminSession \? "admin" : staffSession!\.role/.test(subscribe) &&
      /const name = adminSession \? "Owner" : staffSession!\.name/.test(subscribe));
  pass("the subscription route still refuses an anonymous caller",
    /Unauthorized/.test(subscribe) && /status: 401/.test(subscribe) && !/body\?\.role/.test(subscribe));
  // The rotated-endpoint path used to be staff-only, so the owner's phone
  // went deaf for good while the page still said "Notifications on".
  pass("a ROTATED subscription on the owner's phone is repaired, not refused with a 401",
    /readAdminSession\(\)/.test(resubscribe) && /adminSession \? "admin"/.test(resubscribe) &&
      !/requireStaff\(\)\.ok\)\s*return/.test(resubscribe));
  pass("the off-duty switch never silences the OWNER's daily total",
    /if \(s\.role === "admin"\) return true/.test(pushServer) &&
      /const staff = subs\.filter\(\(s\) => s\.role !== "admin"\)/.test(pushServer));
  pass("the send reports instead of vanishing into a silent catch",
    /export interface PushSendResult/.test(pushServer) && /result\.sent \+=/.test(pushServer) &&
      /\[push\] delivery failed/.test(pushServer) && /was NOT delivered to any owner phone/.test(read("src/lib/day-close.ts")));

  pass("the sales page RE-SYNCS this device with the server (mount, visibility, online, timer)",
    /ensurePocketAlerts\(\)/.test(tab) && /visibilitychange/.test(tab) && /"online"/.test(tab) &&
      /setInterval\(heal, 5 \* 60 \* 1000\)/.test(tab));
  pass("'Notifications on' means the SERVER has this device, not just the browser",
    /let lastSyncOk = false/.test(client) && /const registered = lastSyncOk && !lastSyncError/.test(client) &&
      /const armed = permission === "granted" && subscribed && registered/.test(client) &&
      /allowedButUnregistered/.test(tab));
  pass("the owner can demand the total on his phone right now, and is told what happened",
    /action: "send-total"/.test(tab) && /action === "send-total"/.test(route) &&
      /Nothing is registered to receive it/.test(route) && /Nothing is registered to receive it/.test(read("src/lib/staff-dictionary.ts")));
  pass("that button writes no close record and touches no latch (a test cannot bend the day's numbers)",
    /if \(action === "send-total"\)/.test(route) && !/mode: "auto"/.test(route.split('if (action === "send-total")')[1].split("if (action !==")[0]));
  pass("the page says sending the total does not close the day (owner's words, 3 Oct 2026)",
    /Sending the total does not close the day\. Sales after that moment keep counting/.test(tab) &&
      /Sending the total does not close the day\. Sales after that moment keep counting/.test(read("src/lib/staff-dictionary.ts")));
  pass("the page can show that the system already sent today's total by itself",
    /autoSentAt/.test(route) && /autoSentAt/.test(tab) && /The system already sent today's total by itself at \{time\}/.test(read("src/lib/staff-dictionary.ts")));

  pass("the owner can test his phone for real, and the test reports DELIVERY",
    /readAdminSession\(\)/.test(testRoute) && /delaySeconds/.test(testRoute) &&
      /const result = await sendPushToRoles/.test(testRoute) && /result\.sent === 0/.test(testRoute));
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
console.log("   • if she forgets, the system sends the owner's notification at 3:00 local (21:00 EAT) by default");
console.log("   • the owner picks ANY minute on the sales page (21:03) and saves it with the button on the right");
console.log("   • the button disappears at midnight (6:00 local) — the next day counts separately");
console.log("   • the owner picks the hour on the page; today's figure is live; today + yesterday + closed days");
console.log("   • tapping the notification opens /admin?tab=sales: date + total per day, print button");
