/**
 * DAILY SALES + THE DAY CLOSE (owner's decisions, 29 Sept 2026).
 *
 * THE OWNER'S FLOW, in his words:
 *   • "the today's shift end button will appear at 2 local time or 8:00 pm" —
 *     the cashier's button opens at 20:00 EAT and, at that moment, her screen
 *     plays the alarm and shows a card so she knows it is available;
 *   • "if she forgets to click that button the system will automatically send
 *     that notification after 1 hour which is 3 local time or 9:00 pm" — the
 *     automatic send is the owner's chosen NOTIFY hour (default 21:00 EAT);
 *   • "that button will disappear at midnight or 6 local time ... because after
 *     that counted as next day" — the window closes when the EAT day rolls
 *     over, and the next day starts its own window at 20:00;
 *   • "in that tab add choose time to notify button ... as default I choose 3
 *     lt but he can choose it there" — the notify time is a setting he picks in
 *     the Daily Sales tab, and since 30 Sept 2026 it is ANY minute of the
 *     evening, not just the three whole hours: "can you make the time change
 *     button on the sales cathagory customizable not only 3 hours 3,4,5 make it
 *     look like i can add any time like 3:03 or any other make it changable to
 *     any then add save button on the right after i change it".
 *
 * So there are exactly two times, and the button opens one hour before the
 * owner's notify time — to the minute:
 *
 *   cutoffTime (button opens, alarm + card)  = notifyTime - 1h   (20:00 default)
 *   notifyTime (auto-send if she forgot)     = 21:00 default, owner-chosen
 *
 * WHAT COUNTS AS A SALE: exactly what the reports count. The money moment is
 * the cashier's ✓ PRINTED tap (tickets.printed_at) — the EFD receipt in her
 * hand. Cancelled bills never count.
 *
 * ─── "SENDING THE TOTAL DOES NOT CLOSE THE DAY" (owner, 3 Oct 2026) ────────
 * The owner's own correction of a misunderstanding that made the feature look
 * broken: "when the cashier click end shift doesnt mean after that time no
 * sale will be place but to send notification to the owners".
 *
 * So the tap is a SNAPSHOT, not a lock. The bills printed up to that moment
 * are added up and sent; the cafe keeps selling; anything printed afterwards
 * keeps counting towards today's live total, and the same button sends the
 * bigger number whenever it is pressed again. Nothing in the system ever
 * refuses a sale because the day was "closed".
 *
 * The automatic send follows the same rule and now means "the day's FINAL
 * number": it goes out at the owner's chosen time even when the cashier
 * already tapped the button hours earlier, because that later total is the
 * one he actually reconciles against the drawer. It is latched once a day by
 * its own marker (DAY_CLOSE_AUTO_KEY_PREFIX), so it never becomes a stream
 * of notifications.
 *
 * This module is deliberately PURE: no database, no Next.js, no React. The API
 * route and the background worker feed data in; scripts/verify-daily-sales.ts
 * feeds fixtures in.
 */
import { etDayKey, etDayKeyDaysAgo, etHour, etStartOfDay } from "@/lib/timezone";

/* ─── WHEN (the button, the alarm and the automatic send) ─────────────────── */

/** The owner's default notify hour: 3:00 local = 21:00 EAT. */
export const DEFAULT_NOTIFY_HOUR = 21;

/** ...and its default minute: on the hour, until he types one himself. */
export const DEFAULT_NOTIFY_MINUTE = 0;

/**
 * The QUICK PICKS on the owner's page (EAT hours). They are only a shortcut:
 * since 30 Sept 2026 he may choose ANY minute of the evening — "make the time
 * change button on the sales category customizable not only 3 hours 3,4,5 make
 * it look like i can add any time like 3:03 or any other" — and the three chips
 * simply fill the same time field the typed value goes into.
 */
export const NOTIFY_HOUR_CHOICES = [21, 22, 23];

/**
 * The window the owner may pick inside, in EAT minutes since midnight.
 *
 * The day close is an EVENING action and the whole feature assumes it: the
 * cashier's button opens one hour earlier and disappears at the EAT midnight
 * roll-over ("after that counted as next day"). A notify time of 00:30 would
 * therefore close TOMORROW, a day with no sales in it yet — so the earliest
 * legal pick is 6:00 PM local (12:00 EAT) and the latest 11:59 PM local.
 */
export const NOTIFY_MIN_MINUTES = 12 * 60;
export const NOTIFY_MAX_MINUTES = 23 * 60 + 59;

/** An exact clock time the owner can choose. */
export interface NotifyTime {
  hour: number;
  minute: number;
}

/** Minutes since midnight — the only sane way to compare two clock times. */
export function minutesOfDay(hour: number, minute = 0): number {
  const h = Math.floor(Number(hour));
  const m = Math.floor(Number(minute));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
}

/** Is this an exact time the owner is allowed to ring at? */
export function isNotifyTime(hour: number, minute: number): boolean {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return false;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return false;
  const mins = minutesOfDay(hour, minute);
  return mins >= NOTIFY_MIN_MINUTES && mins <= NOTIFY_MAX_MINUTES;
}

/**
 * The owner's chosen notify TIME. The setting row holds either a bare hour
 * ("21", written before minutes existed) or "HH:MM" ("21:03"); anything
 * missing, malformed or outside the evening window falls back to the default,
 * so a bad settings row can never silence the daily total.
 */
export function dayCloseNotifyTime(value: unknown): NotifyTime {
  const fallback = { hour: DEFAULT_NOTIFY_HOUR, minute: DEFAULT_NOTIFY_MINUTE };
  if (value === null || value === undefined) return fallback;

  // An object from a caller that already split the two ({ hour, minute }).
  if (typeof value === "object") {
    const raw = value as { hour?: unknown; minute?: unknown };
    const hour = Math.floor(Number(raw.hour));
    const minute = Math.floor(Number(raw.minute ?? 0));
    return isNotifyTime(hour, minute) ? { hour, minute } : fallback;
  }

  const text = String(value).trim();
  if (!text) return fallback;

  // "21:03" / "9:03 pm" / "21.03" — a typed clock time.
  const clock = parseClockTime(text);
  if (clock) return isNotifyTime(clock.hour, clock.minute) ? clock : fallback;

  // A bare hour ("21" or 21): the shape the setting had before minutes existed.
  const n = Number(text);
  if (!Number.isFinite(n)) return fallback;
  const hour = Math.floor(n);
  return isNotifyTime(hour, DEFAULT_NOTIFY_MINUTE) ? { hour, minute: DEFAULT_NOTIFY_MINUTE } : fallback;
}

/** "21:03", "9:03 PM", "9:03pm" → { hour: 21, minute: 3 } (null if unreadable). */
export function parseClockTime(text: string): NotifyTime | null {
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(String(text || "").trim());
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const suffix = (m[3] || "").toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (suffix === "pm" && hour < 12) hour += 12;
  if (suffix === "am" && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** The owner's chosen notify hour (the hour half of his exact time). */
export function dayCloseNotifyHour(value: unknown): number {
  return dayCloseNotifyTime(value).hour;
}

/** The minute half of the owner's exact time (0 when he never typed one). */
export function dayCloseNotifyMinute(value: unknown): number {
  return dayCloseNotifyTime(value).minute;
}

/** The owner's notify time as minutes since midnight (EAT). */
export function notifyMinutesOfDay(value: unknown): number {
  const t = dayCloseNotifyTime(value);
  return minutesOfDay(t.hour, t.minute);
}

/** "21:03" — the shape `<input type="time">` and the settings row both use. */
export function notifyTimeValue(time: NotifyTime | null | undefined): string {
  const t = dayCloseNotifyTime(time);
  return `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
}

/** The local-clock equivalents the owner reads: 21:03 EAT = 9:03 PM. */
export function localLabelForTime(hour: number, minute = 0): string {
  const t = dayCloseNotifyTime({ hour, minute });
  const h = (t.hour + 12) % 12 || 12;
  const ampm = t.hour < 12 ? "AM" : "PM";
  return `${h}:${String(t.minute).padStart(2, "0")} ${ampm} EAT`;
}

/** The whole-hour label (kept for the three quick picks). */
export function localLabelForHour(hour: number): string {
  return localLabelForTime(hour, DEFAULT_NOTIFY_MINUTE);
}

/** The hour the button opens: ONE HOUR before the owner's notify time. */
export function dayCloseCutoffHour(notifyTime: unknown): number {
  return dayCloseCutoffTime(notifyTime).hour;
}

/** The minute the button opens: one hour before the owner's exact time. */
export function dayCloseCutoffTime(notifyTime: unknown): NotifyTime {
  const mins = Math.max(0, notifyMinutesOfDay(notifyTime) - 60);
  return { hour: Math.floor(mins / 60), minute: mins % 60 };
}

/** The default cutoff (20:00 EAT = 2:00 local) — where the button appears. */
export const DEFAULT_CUTOFF_HOUR = dayCloseCutoffHour(DEFAULT_NOTIFY_HOUR);

/**
 * Is the cashier's button visible? It opens at the cutoff time and stays
 * visible until midnight — after midnight the EAT day has rolled over, so the
 * new day's window opens again in the evening and today can no longer be
 * closed ("after that counted as next day").
 */
export function isDayCloseOpen(hour: number, cutoffHour: number, minute = 0, cutoffMinute = 0): boolean {
  const now = minutesOfDay(hour, minute);
  const cutoff = minutesOfDay(cutoffHour, cutoffMinute);
  if (!Number.isFinite(now)) return false;
  return now >= (Number.isFinite(cutoff) ? cutoff : 0);
}

/** Has the owner's notify time arrived? (the automatic send if she forgot) */
export function isDayCloseDue(
  hour: number,
  notifyHour: number,
  minute = 0,
  notifyMinute: number = DEFAULT_NOTIFY_MINUTE,
): boolean {
  const now = minutesOfDay(hour, minute);
  if (!Number.isFinite(now)) return false;
  return now >= notifyMinutesOfDay({ hour: notifyHour, minute: notifyMinute });
}

/** The exact minute the auto-send lands / the alarm rings (for the screens). */
export function dayCloseMoment(hour: number, minute = 0): string {
  const h = Math.max(0, Math.min(23, Math.floor(Number(hour)) || 0));
  const m = Math.max(0, Math.min(59, Math.floor(Number(minute)) || 0));
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/* ─── THE STORED RECORDS ──────────────────────────────────────────────────── */

/** The site_settings key holding one day's close record. */
export const DAY_CLOSE_KEY_PREFIX = "day_close_";

/**
 * The site_settings key that records "the system's own send already went out
 * for this day" (owner's rule, 3 Oct 2026).
 *
 * WHY IT IS NOT THE CLOSE RECORD: the close record answers "what did the day
 * add up to when it was closed", and it is rewritten on every tap. The
 * automatic send is a different question - "has the system already told the
 * owner the final number today?" - and it must keep its own once-a-day latch,
 * because the automatic send now happens even when the cashier closed the day
 * earlier (see the note at the top of this file). Sharing one row would let a
 * later manual tap re-open the automatic send, and the owner would get a
 * second, larger number he never asked for.
 */
export const DAY_CLOSE_AUTO_KEY_PREFIX = "day_close_auto_";

/** The marker key for one EAT day. */
export function dayCloseAutoSentKey(dayKey: string): string {
  return `${DAY_CLOSE_AUTO_KEY_PREFIX}${String(dayKey || "").trim()}`;
}

/** True when this value is the automatic-send marker key for one EAT day. */
export function isAutoSentSettingKey(key: string): boolean {
  return String(key || "").startsWith(DAY_CLOSE_AUTO_KEY_PREFIX);
}

/** The site_settings key holding the owner's chosen notify hour. */
export const DAY_CLOSE_NOTIFY_KEY = "day_close_notify_hour";

/**
 * What that key holds: "HH:MM" EAT ("21:03") since minutes became choosable.
 * Rows written before then hold a bare hour ("21") and still read correctly —
 * see dayCloseNotifyTime.
 */
export function isNotifyTimeSettingValue(value: unknown): boolean {
  return /^\d{1,2}:\d{2}$/.test(String(value ?? "").trim());
}

export function dayCloseSettingKey(dayKey: string): string {
  return `${DAY_CLOSE_KEY_PREFIX}${String(dayKey || "").trim()}`;
}

/** What was stored when the day was closed (JSON in site_settings.value). */
export interface DayCloseRecord {
  /** ISO instant of the tap (or of the automatic send). */
  at: string;
  /** WHO closed it: the cashier's name, "admin", or the automatic send. */
  by: string;
  /** The total that was sent to the owner at that moment. */
  total: number;
  /** How many printed bills made that total. */
  bills: number;
}

/** The name the automatic send is recorded under. */
export const AUTO_CLOSE_BY = "auto (system)";

/** Read a stored close record; anything malformed reads as "not closed". */
export function parseDayCloseValue(value: string | null | undefined): DayCloseRecord | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(String(value)) as Partial<DayCloseRecord>;
    if (!raw || typeof raw !== "object" || !raw.at) return null;
    const total = Number(raw.total);
    const bills = Number(raw.bills);
    return {
      at: String(raw.at),
      by: String(raw.by || ""),
      total: Number.isFinite(total) ? total : 0,
      bills: Number.isFinite(bills) ? bills : 0,
    };
  } catch {
    return null;
  }
}

/** True when this value is a day-close record key for one EAT day. */
export function dayKeyFromCloseSetting(key: string): string | null {
  const k = String(key || "");
  if (!k.startsWith(DAY_CLOSE_KEY_PREFIX)) return null;
  const day = k.slice(DAY_CLOSE_KEY_PREFIX.length).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** True when this value is the notify-hour setting key. */
export function isNotifyHourSettingKey(key: string): boolean {
  return String(key || "") === DAY_CLOSE_NOTIFY_KEY;
}

/* ─── WHICH DAYS THE OWNER'S PAGE LISTS ───────────────────────────────────── */

/**
 * The days the owner reads, NEWEST FIRST.
 *
 * TODAY and YESTERDAY are always listed. Every day with a receipt-backed sale
 * in the loaded history window and every day with a saved close record is also
 * retained, so the owner can review the prior week and older completed days.
 */
export function listedDayKeys(input: {
  todayKey: string;
  yesterdayKey: string | null;
  /** Days that have a close record (the feature's own history). */
  closedKeys: Iterable<string>;
  /** Days with printed bills, used to include yesterday even before a close. */
  salesKeys?: Iterable<string>;
}): string[] {
  const out = new Set<string>();
  if (input.todayKey) out.add(input.todayKey);
  if (input.yesterdayKey) out.add(input.yesterdayKey);
  for (const key of input.closedKeys) if (/^\d{4}-\d{2}-\d{2}$/.test(key)) out.add(key);
  // Every receipt-backed day in the loaded history is available, not just
  // today/yesterday. Closed keys remain available indefinitely via settings.
  for (const key of input.salesKeys ?? []) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) out.add(key);
  }
  return [...out].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/* ─── THE OWNER'S PAGE: one line per date ────────────────────────────────── */

/** "12,450 ETB" — the shape the owner reads against the EFD paper. */
export function formatEtb(n: number | null | undefined): string {
  const v = Number(n || 0);
  return `${(Number.isFinite(v) ? v : 0).toLocaleString("en-US")} ETB`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-29" → "29 Sep 2026" (an EAT calendar date, never shifted). */
export function dayKeyLabel(dayKey: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || "").trim());
  if (!m) return "";
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return "";
  return `${Number(m[3])} ${MONTHS[monthIndex]} ${m[1]}`;
}

/**
 * The EAT day keys a rolling window shows, NEWEST FIRST — today, yesterday and
 * so on. Built from the canonical EAT helpers, so the list is a true calendar
 * list even around midnight.
 */
export function recentDayKeys(count: number, now: Date = new Date()): string[] {
  const n = Math.max(1, Math.min(400, Math.round(Number(count) || 1)));
  const today = etDayKey(now) || etDayKey(etStartOfDay(now));
  const keys: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const key = i === 0 ? today : etDayKeyDaysAgo(i);
    if (key) keys.push(key);
  }
  return keys;
}

/** Yesterday's EAT day key (null if the clock is unreadable). */
export function yesterdayKey(now: Date = new Date()): string | null {
  return etDayKeyDaysAgo(1) || etDayKey(new Date(etStartOfDay(now).getTime() - 86_400_000));
}

/** The current EAT hour (0-23), for the closing-hour gate. */
export function currentEtHour(now: Date = new Date()): number {
  return etHour(now);
}

/* ─── THE OWNER'S NOTIFICATION ────────────────────────────────────────────── */

/** The payload the owner's phone notification carries. */
export interface DayClosePush {
  title: string;
  body: string;
  tag: string;
  url: string;
}

/**
 * A NORMAL notification (owner, 29 Sept 2026): it behaves like any other
 * phone notification — it rings once, shows the date and the total, and can be
 * swiped away. It is deliberately NOT one of the old "urgent, stays on the
 * lock screen until tapped" staff alerts.
 */
export function dayClosePush(dayKey: string, total: number, bills: number): DayClosePush {
  return {
    title: "💰 Today's total sale",
    body: `${dayKeyLabel(dayKey)} • ${formatEtb(total)} • ${bills} bill(s) • tap to open the sales page`,
    tag: `fana-day-close-${dayKey}`,
    url: "/admin?tab=sales",
  };
}
