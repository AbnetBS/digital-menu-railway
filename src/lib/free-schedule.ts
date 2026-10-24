/**
 * FREE DAYS AND YE AMET EREFT (owner, Oct 2026)
 *
 * The owner's free schedule has three kinds, and they are not the same thing:
 *
 *   weekly   "every Sunday", a repeating free weekday. If the person still
 *            comes in and works it, that day is Free Week overtime (x2).
 *   dated    one named free date ("free dates", his own words).
 *   annual   "ye amet ereft": a run of days given as yearly leave, counted
 *            from a first date to a last date. It varies per person and so
 *            does the number of days, so the owner gives both ends.
 *
 * What all three share: the day is NOT an absence, and no absence money is
 * taken for it. What only annual adds: the salary is safe as if the person
 * worked, so the day is paid without being worked.
 *
 * Because of that last sentence an annual day is never ALSO free week
 * overtime: paying it twice for the same day would be paying it once for the
 * leave and once for the work that the leave already covers. Only a
 * registered holiday (which the owner pays at 2.5) still adds money on top.
 */

export const FREE_SCHEDULE_TYPES = ["weekly", "dated", "annual"] as const;
export type FreeScheduleType = (typeof FREE_SCHEDULE_TYPES)[number];

/** The longest single Ye amet ereft entry: a whole year. */
export const ANNUAL_LEAVE_MAX_DAYS = 366;

export type FreeScheduleRule = {
  scheduleType: string;
  weekday: number | null;
  freeDate: string | null;
  freeUntil: string | null;
};

const DAY_MS = 86400000;

/** YYYY-MM-DD, noon UTC, so no time zone can move the weekday. */
function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/** How many days a from-to run covers, both ends counted. 0 when it is not a run. */
export function leaveDays(from: string | null, to: string | null): number {
  if (!from || !to) return 0;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 0;
  return Math.round((end - start) / DAY_MS) + 1;
}

/** Does one rule cover this YYYY-MM-DD day? */
export function ruleCoversDay(rule: FreeScheduleRule, date: string): boolean {
  if (rule.scheduleType === "annual") {
    return Boolean(rule.freeDate && rule.freeUntil && date >= rule.freeDate && date <= rule.freeUntil);
  }
  if (rule.scheduleType === "dated") return rule.freeDate === date;
  if (rule.weekday === null || rule.weekday === undefined) return false;
  return Number(rule.weekday) === weekdayOf(date);
}

/** Is this day free in any way: repeating, a named date, or ye amet ereft? */
export function isFreeDate(rules: FreeScheduleRule[], date: string): boolean {
  return rules.some((rule) => ruleCoversDay(rule, date));
}

/** Is this day inside a ye amet ereft run? Those days are paid already. */
export function isAnnualLeaveDate(rules: FreeScheduleRule[], date: string): boolean {
  return rules.some((rule) => rule.scheduleType === "annual" && ruleCoversDay(rule, date));
}

/**
 * A free day the person still worked: the repeating weekday or the named
 * date. Ye amet ereft is left out on purpose (see the note at the top).
 */
export function isWorkedFreeDay(rules: FreeScheduleRule[], date: string): boolean {
  return rules.some((rule) => rule.scheduleType !== "annual" && ruleCoversDay(rule, date));
}
