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
 *     lt but he can choose it there" — the notify hour is a setting he picks in
 *     the Daily Sales tab (21:00, 22:00 or 23:00 EAT).
 *
 * So there are exactly two times, and the button opens one hour before the
 * owner's notify time:
 *
 *   cutoffHour (button opens, alarm + card)  = notifyHour - 1   (20:00 default)
 *   notifyHour (auto-send if she forgot)     = 21:00 default, owner-chosen
 *
 * WHAT COUNTS AS A SALE: exactly what the reports count. The money moment is
 * the cashier's ✓ PRINTED tap (tickets.printed_at) — the EFD receipt in her
 * hand. Cancelled bills never count.
 *
 * This module is deliberately PURE: no database, no Next.js, no React. The API
 * route and the background worker feed data in; scripts/verify-daily-sales.ts
 * feeds fixtures in.
 */
import { etDayKey, etDayKeyDaysAgo, etHour, etStartOfDay } from "@/lib/timezone";

/* ─── WHEN (the button, the alarm and the automatic send) ─────────────────── */

/** The owner's default notify hour: 3:00 local = 21:00 EAT. */
export const DEFAULT_NOTIFY_HOUR = 21;

/**
 * The hours the owner can choose for his notification (EAT). All three sit
 * AFTER the button appears (20:00) and BEFORE midnight, because after midnight
 * the day belongs to tomorrow ("after that counted as next day").
 */
export const NOTIFY_HOUR_CHOICES = [21, 22, 23];

/** The local-clock equivalents the owner reads: 21:00 EAT = 3:00 local. */
export function localLabelForHour(hour: number): string {
  const h = ((Number(hour) || 0) + 12) % 12 || 12;
  const ampm = Number(hour) < 12 ? "AM" : "PM";
  return `${h}:00 ${ampm} EAT`;
}

/** The hour the button opens: ONE HOUR before the owner's notify time. */
export function dayCloseCutoffHour(notifyHour: number | null | undefined): number {
  const notify = dayCloseNotifyHour(notifyHour);
  return Math.min(23, Math.max(0, notify - 1));
}

/** The default cutoff (20:00 EAT = 2:00 local) — where the button appears. */
export const DEFAULT_CUTOFF_HOUR = dayCloseCutoffHour(DEFAULT_NOTIFY_HOUR);

/**
 * The owner's chosen notify hour. Only the three offered hours are accepted;
 * anything else (missing setting, junk, an old value) falls back to the
 * default, so a bad settings row can never silence the daily total.
 */
export function dayCloseNotifyHour(value: number | string | null | undefined): number {
  const missing = value === null || value === undefined || String(value).trim() === "";
  const n = missing ? NaN : Number(value);
  return Number.isInteger(n) && NOTIFY_HOUR_CHOICES.includes(n) ? n : DEFAULT_NOTIFY_HOUR;
}

/**
 * Is the cashier's button visible? It opens at the cutoff hour and stays
 * visible until midnight — after midnight the EAT day has rolled over, so the
 * new day's window opens again in the evening and today can no longer be
 * closed ("after that counted as next day").
 */
export function isDayCloseOpen(hour: number, cutoffHour: number): boolean {
  return hour >= cutoffHour;
}

/** Has the owner's notify time arrived? (the automatic send if she forgot) */
export function isDayCloseDue(hour: number, notifyHour: number): boolean {
  return hour >= dayCloseNotifyHour(notifyHour);
}

/** The exact minute the auto-send lands / the alarm rings (for the screens). */
export function dayCloseMoment(hour: number): string {
  return `${String(Math.max(0, Math.min(23, hour))).padStart(2, "0")}:00`;
}

/* ─── THE STORED RECORDS ──────────────────────────────────────────────────── */

/** The site_settings key holding one day's close record. */
export const DAY_CLOSE_KEY_PREFIX = "day_close_";

/** The site_settings key holding the owner's chosen notify hour. */
export const DAY_CLOSE_NOTIFY_KEY = "day_close_notify_hour";

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
 * "for now only todays and yesterday total sale because before that it isnt
 * full report but starting from tomorrow it started listed" (owner, 29 Sept
 * 2026): TODAY and YESTERDAY are always listed, and from today onward every day
 * that was ever closed is kept in the list — so the daily history grows one day
 * at a time, while the years before this feature (whose figures were never
 * complete) never appear.
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
  // A day with sales is only listed when it is today or yesterday (the rule
  // above already added those); older sales-only days stay out on purpose.
  const yesterday = input.yesterdayKey;
  for (const key of input.salesKeys ?? []) {
    if (key === input.todayKey || key === yesterday) out.add(key);
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
