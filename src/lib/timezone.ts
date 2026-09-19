/**
 * THE ETHIOPIAN WALL CLOCK (owner, Sept 2026).
 *
 * The server runs on Railway (UTC), but the cafe runs on Ethiopian time
 * (EAT, UTC+3 — no daylight saving, ever). Every "today", "yesterday" and
 * "which hour sold most" in the reports must follow the clock on the office
 * PC, not the server's: at 1am in Addis the server still thinks it is
 * yesterday, and a 6pm rush would print as 3pm. All day/hour math goes
 * through these helpers — never through the Date's local getters.
 */
export const ETHIOPIA_TIME_ZONE = "Africa/Addis_Ababa";

/** EAT is a fixed UTC+3 all year (Ethiopia never observes DST). */
const ET_OFFSET_MS = 3 * 60 * 60 * 1000;

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: ETHIOPIA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const hourFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: ETHIOPIA_TIME_ZONE,
  hour: "numeric",
  hour12: false,
});

const asDate = (d: Date | string | null | undefined): Date | null => {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt;
};

/** "2026-09-09" — the EAT calendar day an instant falls on. */
export function etDayKey(d: Date | string | null | undefined): string | null {
  const dt = asDate(d);
  if (!dt) return null;
  const [m, day, y] = partsFmt.format(dt).split("/"); // en-US order is MM/DD/YYYY
  return `${y}-${m}-${day}`;
}

/** True when the instant falls on today's EAT calendar day. */
export function isTodayET(d: Date | string | null | undefined): boolean {
  return isOnEtDayDaysAgo(d, 0);
}

/** True when the instant falls on yesterday's EAT calendar day. */
export function isYesterdayET(d: Date | string | null | undefined): boolean {
  return isOnEtDayDaysAgo(d, 1);
}

/** True when the instant falls on the EAT calendar day BEFORE yesterday. */
export function isDayBeforeYesterdayET(d: Date | string | null | undefined): boolean {
  return isOnEtDayDaysAgo(d, 2);
}

/* ─── ROLLING DAY WINDOWS (owner, Sept 2026) ────────────────────────────────
 * "Yesterday", "the day before yesterday" and "Last 30 Days" on the report are
 * CALENDAR windows on the Ethiopian clock, never "N × 24 hours from this
 * instant". The difference is visible every morning: at 09:00 a 24-hour window
 * starts at 09:00 thirty days ago and quietly drops that whole morning, while
 * the calendar window always starts at midnight. So on 1 October the report
 * covers 2 September – 1 October (exactly 30 Ethiopian days, today included)
 * and 1 September leaves the window that same day — the paper is always a true
 * 30-day window that slides forward one day at a time.
 *
 * EAT is UTC+3 with no daylight saving, so a whole day is ALWAYS 86 400 000 ms:
 * stepping back in whole days from EAT midnight never lands off midnight.
 */

/** The UTC instant of EAT midnight `daysAgo` EAT calendar days before today. */
export function etStartOfDaysAgo(daysAgo: number): Date {
  const days = Math.max(0, Math.round(Number(daysAgo) || 0));
  return new Date(etStartOfToday().getTime() - days * 24 * 60 * 60 * 1000);
}

/** "2026-09-17" — the EAT date key of the day `daysAgo` days before today. */
export function etDayKeyDaysAgo(daysAgo: number): string | null {
  return etDayKey(etStartOfDaysAgo(daysAgo));
}

/**
 * True when the instant falls exactly on the EAT calendar day `daysAgo` days
 * before today (0 = today, 1 = yesterday, 2 = the day before yesterday).
 */
export function isOnEtDayDaysAgo(d: Date | string | null | undefined, daysAgo: number): boolean {
  const k = etDayKey(d);
  if (k === null) return false;
  // EAT midnight today minus whole days, keyed back in EAT: a true calendar
  // day even around midnight (unlike "24 hours ago").
  return k === etDayKeyDaysAgo(daysAgo);
}

/**
 * True when the instant is inside the last `days` EAT calendar days INCLUDING
 * today — the report's "Last 7 Days" (days = 7 → today + the 6 days before it)
 * and "Last 30 Days" (days = 30 → today + the 29 days before it). Future stamps
 * are excluded, like the old 24-hour maths did.
 */
export function isWithinEtDays(d: Date | string | null | undefined, days: number): boolean {
  const dt = asDate(d);
  if (!dt) return false;
  const t = dt.getTime();
  if (t > Date.now()) return false;
  return t >= etStartOfDaysAgo(Math.max(1, Math.round(Number(days) || 1)) - 1).getTime();
}

/**
 * The UTC instant of EAT midnight today — the `printedAt >=` cutoff for
 * "printed today" queries. Built from the EAT calendar date, so it is right
 * whatever timezone the server runs in.
 */
export function etStartOfToday(): Date {
  return etStartOfDay(new Date());
}

/** The UTC instant of EAT midnight on the EAT calendar day `d` falls on. */
export function etStartOfDay(d: Date | string): Date {
  const dt = d instanceof Date ? d : new Date(d);
  const [y, m, day] = (etDayKey(dt) || "1970-01-01").split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day, 0, 0, 0) - ET_OFFSET_MS);
}

/** The UTC instant of EAT midnight on an explicit EAT calendar date. */
export function etStartOfCalendarDay(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - ET_OFFSET_MS);
}

/** Hour of day (0-23) on the Ethiopian wall clock. */
export function etHour(d: Date | string): number {
  const dt = d instanceof Date ? d : new Date(d);
  // hour12:false renders midnight as "24" on some ICU builds — normalize it.
  return Number(hourFmt.format(dt)) % 24;
}
