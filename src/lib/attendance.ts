/**
 * ATTENDANCE RULES - one place for the owner's numbers and colours
 * (owner, Oct 2026: "the person is considered late if he is 15 min late",
 * "when someone clicks more than once it says already registered but after
 * 1 hour the next scan is printed in the OUT", "make it up to 30 days ...
 * if he select more than 7 days add page below ... when he click print it
 * will be printed divided like the 1st 7 days then next 7 days",
 * "we need another colour for the early out and the overtime").
 *
 * The kiosk, the admin tab and the paper sheet all import from here, so the
 * rule can never drift between the screen a person scans on and the paper the
 * owner prints.
 *
 * The attendance list is its OWN listing (Attendance -> Staff Members). It is
 * NOT the login list in Staff: cleaners, washers and chefs clock in with a
 * fingerprint but never log in to a station, so they must not be forced into
 * the staff_users table to appear on the sheet.
 */
import { etHour, etMinute } from "@/lib/timezone";

/** A person is late from 15 minutes after the shift of his role starts. */
export const LATE_GRACE_MINUTES = 15;

/**
 * A second scan inside this window after the IN is only "already registered":
 * a wet finger pressed three times must not close the day. After the hour the
 * next scan is the OUT.
 */
export const REPEAT_SCAN_LOCK_MINUTES = 60;

/**
 * One PRINTED PAGE of the paper sheet is one week wide: seven day-columns is
 * what still fits the landscape paper the owner prints on.
 */
export const SHEET_MAX_DAYS = 7;

/**
 * How far the admin may reach in one go (owner, Oct 2026: "make it up to 30
 * days"). A range wider than a page is not cut away any more - it is split
 * into pages of SHEET_MAX_DAYS days below the sheet, and the print comes out
 * divided the same way: the first 7 days, then the next 7, and so on.
 */
export const SHEET_RANGE_MAX_DAYS = 30;

/** The supervisor's door-tablet login times out after this much inactivity. */
export const SUPERVISOR_IDLE_TIMEOUT_MINUTES = 2;

/** FPC1020A templates per person we allow the admin to enroll. */
export const MAX_FINGERS_PER_MEMBER = 5;

/** A pending "place your finger" job the device may still pick up. */
export const ENROLL_JOB_TTL_MINUTES = 10;

/** One shift period of a role: "Morning" 08:00 -> 14:00. */
export type RoleShift = {
  label: string;
  startTime: string;
  endTime: string;
};

/** "08:45" -> 525 minutes after midnight. Null when it is not a time. */
export function parseHHMM(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 525 -> "08:45". */
export function toHHMM(totalMinutes: number): string {
  const safe = Math.max(0, Math.round(Number(totalMinutes) || 0)) % (24 * 60);
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Minutes after midnight on the Ethiopian wall clock. */
export function etMinutes(d: Date | string): number {
  const dt = d instanceof Date ? d : new Date(d);
  return etHour(dt) * 60 + etMinute(dt);
}

/** "08:05" on the Ethiopian wall clock - what the sheet and the kiosk print. */
export function clockLabel(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return toHHMM(etMinutes(dt));
}

/**
 * The shift of the role a clock-in belongs to: the period whose start has
 * already passed and is the closest to the scan. A scan before every start
 * (a 05:00 baker on an 06:00 morning shift) belongs to the earliest period.
 */
export function pickShift(shifts: RoleShift[] | null | undefined, minutes: number): RoleShift | null {
  const list = (shifts || [])
    .map((s) => ({ shift: s, start: parseHHMM(s.startTime) }))
    .filter((s): s is { shift: RoleShift; start: number } => s.start !== null)
    .sort((a, b) => a.start - b.start);
  if (list.length === 0) return null;

  let best = list[0];
  for (const item of list) {
    if (item.start <= minutes && item.start >= best.start) best = item;
  }
  return best.shift;
}

/**
 * Minutes late for a clock-in: 0 up to 15 minutes after the shift start, then
 * every minute past that. Morning shift 12:30 -> 12:45 is still on time,
 * 12:46 is 1 minute late.
 */
export function lateMinutesFor(shift: RoleShift | null | undefined, clockInMinutes: number): number {
  const start = parseHHMM(shift?.startTime ?? null);
  if (start === null) return 0;
  return Math.max(0, clockInMinutes - (start + LATE_GRACE_MINUTES));
}

/**
 * True when the person left before the time out of the shift he clocked in for.
 *
 * A night period (22:00 -> 02:00) ends on the next calendar day, so its time out
 * is read as "02:00 tomorrow" and an OUT at 23:00 is still an early out. Without
 * that, every night-shift person who left after midnight looked punctual and
 * everybody who left before it looked late to go home.
 */
export function isEarlyOut(shift: RoleShift | null | undefined, clockOutMinutes: number): boolean {
  const start = parseHHMM(shift?.startTime ?? null);
  const end = parseHHMM(shift?.endTime ?? null);
  if (end === null) return false;
  const crossesMidnight = start !== null && end <= start;
  const endMinutes = crossesMidnight ? end + 24 * 60 : end;
  const outMinutes = crossesMidnight && clockOutMinutes < (start ?? 0) ? clockOutMinutes + 24 * 60 : clockOutMinutes;
  return outMinutes < endMinutes;
}

/**
 * What a SECOND scan of the same person means. Inside one hour of the IN it is
 * only "already registered" (a wet finger pressed three times must not close
 * the day); from the hour on, the next scan is the OUT.
 */
export function rescanAction(
  clockIn: Date | string | null | undefined,
  now: Date | string = new Date()
): "already_registered" | "clock_out" {
  const inAt = clockIn instanceof Date ? clockIn : new Date(clockIn as string);
  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(inAt.getTime()) || Number.isNaN(at.getTime())) return "clock_out";
  const minutes = (at.getTime() - inAt.getTime()) / 60000;
  return minutes < REPEAT_SCAN_LOCK_MINUTES ? "already_registered" : "clock_out";
}

/** "3h 05m" for the total-hours column; null when there is no OUT yet. */
export function hoursLabel(totalMinutes: number | null | undefined): string | null {
  if (totalMinutes === null || totalMinutes === undefined) return null;
  const mins = Math.max(0, Math.round(Number(totalMinutes) || 0));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

/* ─── the paper sheet window ─────────────────────────────────────────────── */

/**
 * Whether an attendance absence is meaningful for this member on this sheet
 * date. The keys are Ethiopian calendar dates in YYYY-MM-DD form: before the
 * member registered and after today should remain blank, not red/absent.
 */
export function isAttendanceExpectedOnDate(
  dateKey: string,
  registeredOn: string | null | undefined,
  today: string | null | undefined
): boolean {
  const isDateKey = (key: string | null | undefined): key is string => {
    if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
    const parsed = new Date(`${key}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === key;
  };
  if (!isDateKey(dateKey) || !isDateKey(registeredOn) || !isDateKey(today)) return false;
  return dateKey >= registeredOn && dateKey <= today;
}

/** Shift a "YYYY-MM-DD" key by whole days (plain date maths, no timezone). */
export function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  if (!y || !m || !d) return dateKey;
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Days between two "YYYY-MM-DD" keys (b - a), 0 for the same day. */
export function daysBetween(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
  return Math.round((tb - ta) / 86400000);
}

/**
 * Every "YYYY-MM-DD" column of the sheet, oldest first, and never more than
 * SHEET_RANGE_MAX_DAYS (30) of them. A reversed range is turned the right way
 * up, and a range longer than a month is cut back to the first 30 days so one
 * request can never pull the whole history.
 *
 * The week limit moved to the PAGE (owner, Oct 2026): 30 days are shown and
 * printed as pages of SHEET_MAX_DAYS days - see sheetPages().
 */
export function sheetDates(from: string | null | undefined, to: string | null | undefined): string[] {
  if (!from || !to) return [];
  let start = from;
  let end = to;
  if (daysBetween(start, end) < 0) {
    const swap = start;
    start = end;
    end = swap;
  }
  const span = Math.min(daysBetween(start, end), SHEET_RANGE_MAX_DAYS - 1);
  const out: string[] = [];
  for (let i = 0; i <= span; i++) out.push(addDays(start, i));
  return out;
}

/**
 * The printed pages of a sheet: SHEET_MAX_DAYS (7) day-columns each, so a
 * 30-day range comes out as 7 + 7 + 7 + 7 + 2. The admin sees one page at a
 * time (the page numbers appear below the sheet only when there is more than
 * one), and printing emits every page in order, each on its own paper.
 */
export function sheetPages(dates: string[]): string[][] {
  const list = Array.isArray(dates) ? dates : [];
  const width = Math.max(1, SHEET_MAX_DAYS);
  const pages: string[][] = [];
  for (let i = 0; i < list.length; i += width) pages.push(list.slice(i, i + width));
  return pages;
}

/** Which page (0-based) a date column belongs to, or -1 when it is not there. */
export function pageIndexOfDate(dates: string[], date: string | null | undefined): number {
  if (!date) return -1;
  const at = (Array.isArray(dates) ? dates : []).indexOf(date);
  return at < 0 ? -1 : Math.floor(at / Math.max(1, SHEET_MAX_DAYS));
}

/* ─── the colours of one box on the paper sheet ──────────────────────────── */

/** The IN box: nobody came (red), he came late (yellow), on time (green). */
export type InStatus = "absent" | "late" | "on_time";

/** The OUT box: still inside, done, left early, or overtime. */
export type OutStatus = "none" | "still_in" | "completed" | "early_out" | "overtime";

type SheetLog = {
  clockIn?: Date | string | null;
  clockOut?: Date | string | null;
  lateMinutes?: number | null;
  isOvertime?: boolean | null;
  earlyOut?: boolean | null;
  status?: string | null;
};

/** Colour of the IN box for one person on one day. */
export function inStatusOf(log: SheetLog | null | undefined): InStatus {
  if (!log || !log.clockIn) return "absent";
  return (log.lateMinutes || 0) > 0 || log.status === "late" ? "late" : "on_time";
}

/**
 * Colour of the OUT box for one person on one day. Overtime wins over an
 * early out: the person himself pressed the overtime button, so that is the
 * stronger statement about the day.
 */
export function outStatusOf(log: SheetLog | null | undefined): OutStatus {
  if (!log || !log.clockIn) return "none";
  if (!log.clockOut) return "still_in";
  if (log.isOvertime) return "overtime";
  if (log.earlyOut || log.status === "early_out") return "early_out";
  return "completed";
}

/* ─── the leaderboard: who spent the most time at work ───────────────────── */

/**
 * ADMIN -> ATTENDANCE -> LEADERBOARD (owner, Oct 2026: "add 1 category that
 * says leaderboard that shows highest time that is spent in work ... category
 * by role then the name with rank").
 *
 * One card per role, the people of that role ranked by the hours they really
 * spent inside the range. A day that is still open counts too (the time since
 * the IN, marked "still in"), so the board is honest at 4 pm and does not wait
 * for everybody to scan out before it says anything.
 */

export type LeaderLog = {
  memberId?: number | null;
  clockIn?: Date | string | null;
  clockOut?: Date | string | null;
  totalMinutes?: number | null;
  isOvertime?: boolean | null;
};

export type LeaderMember = {
  id: number;
  name: string;
  roleId?: number | null;
  roleName?: string | null;
};

export type LeaderRow = {
  rank: number;
  memberId: number;
  name: string;
  /** Closed days: the total the OUT scan wrote down. */
  workedMinutes: number;
  /** The day that is open right now: minutes since the IN, if there is one. */
  openMinutes: number;
  totalMinutes: number;
  /** "40h 05m" - the same label the sheet and Today Live use. */
  totalHours: string;
  days: number;
  overtimeDays: number;
  stillIn: boolean;
};

export type LeaderGroup = {
  roleId: number | null;
  roleName: string;
  rows: LeaderRow[];
  totalMinutes: number;
  /** Active people of this role with no scan at all inside the range. */
  notSeen: number;
};

const asTime = (d: Date | string | null | undefined): number | null => {
  if (!d) return null;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isNaN(t) ? null : t;
};

/**
 * The minutes one log line adds to the board: the OUT total when the day is
 * closed, otherwise the time since the IN (never negative, never in the
 * future).
 */
export function leaderMinutesOf(
  log: LeaderLog | null | undefined,
  now: Date | string = new Date()
): { workedMinutes: number; openMinutes: number } {
  const at = asTime(now) ?? Date.now();
  const inAt = asTime(log?.clockIn);
  const outAt = asTime(log?.clockOut);
  if (inAt === null) return { workedMinutes: 0, openMinutes: 0 };
  if (outAt !== null) {
    const stored = Math.max(0, Math.round(Number(log?.totalMinutes) || 0));
    // A row without its total (an old import, a manual fix) still counts: the
    // two stamps are right there.
    return { workedMinutes: stored || Math.max(0, Math.round((outAt - inAt) / 60000)), openMinutes: 0 };
  }
  return { workedMinutes: 0, openMinutes: Math.max(0, Math.round((at - inAt) / 60000)) };
}

/**
 * Rank the people of every role by the hours they spent at work inside the
 * range. Roles are listed alphabetically ("No role" last) so the cards do not
 * jump around when one day is busier than the next; inside a card the rank is
 * by hours, and two equal hours are ordered by name.
 */
export function buildLeaderboard(
  logs: LeaderLog[] | null | undefined,
  members: LeaderMember[] | null | undefined,
  now: Date | string = new Date()
): LeaderGroup[] {
  const people = (members || []).filter((m) => m && Number.isFinite(m.id));
  const totals = new Map<
    number,
    { workedMinutes: number; openMinutes: number; days: number; overtimeDays: number; stillIn: boolean }
  >();

  for (const log of logs || []) {
    const id = Number(log?.memberId);
    if (!Number.isFinite(id) || id <= 0) continue;
    const { workedMinutes, openMinutes } = leaderMinutesOf(log, now);
    if (workedMinutes <= 0 && openMinutes <= 0 && !log?.clockIn) continue;
    const row = totals.get(id) ?? { workedMinutes: 0, openMinutes: 0, days: 0, overtimeDays: 0, stillIn: false };
    row.workedMinutes += workedMinutes;
    row.openMinutes += openMinutes;
    if (log?.clockIn) row.days += 1;
    if (log?.isOvertime) row.overtimeDays += 1;
    if (openMinutes > 0) row.stillIn = true;
    totals.set(id, row);
  }

  const byRole = new Map<string, LeaderGroup>();
  for (const person of people) {
    const roleId = Number.isFinite(Number(person.roleId)) && person.roleId ? Number(person.roleId) : null;
    const roleName = String(person.roleName || (roleId ? "No role" : "No role")).trim() || "No role";
    const key = `${roleId ?? "none"}|${roleName}`;
    if (!byRole.has(key)) byRole.set(key, { roleId, roleName, rows: [], totalMinutes: 0, notSeen: 0 });
    const group = byRole.get(key)!;
    const t = totals.get(person.id);
    if (!t || (t.workedMinutes <= 0 && t.openMinutes <= 0 && t.days <= 0)) {
      group.notSeen += 1;
      continue;
    }
    const totalMinutes = t.workedMinutes + t.openMinutes;
    group.rows.push({
      rank: 0,
      memberId: person.id,
      name: person.name,
      workedMinutes: t.workedMinutes,
      openMinutes: t.openMinutes,
      totalMinutes,
      totalHours: hoursLabel(totalMinutes) || "0h 00m",
      days: t.days,
      overtimeDays: t.overtimeDays,
      stillIn: t.stillIn,
    });
    group.totalMinutes += totalMinutes;
  }

  return [...byRole.values()]
    .map((group) => {
      const rows = group.rows
        .sort((a, b) => b.totalMinutes - a.totalMinutes || a.name.localeCompare(b.name))
        .map((row, i) => ({ ...row, rank: i + 1 }));
      return { ...group, rows };
    })
    .sort((a, b) => {
      const aNone = a.roleName === "No role" ? 1 : 0;
      const bNone = b.roleName === "No role" ? 1 : 0;
      return aNone - bNone || a.roleName.localeCompare(b.roleName);
    });
}

/** "40h 05m" as the plain hours the owner reads on the board ("40 hours"). */
export function wholeHoursOf(totalMinutes: number | null | undefined): number {
  return Math.floor(Math.max(0, Math.round(Number(totalMinutes) || 0)) / 60);
}

/* ─── the supervisor countdown on the door tablet ────────────────────────── */

/**
 * The door tablet locks the backup PIN again after two minutes with no
 * activity (owner, Oct 2026). This is the clock the tablet shows while it is
 * unlocked: 120000 -> "2:00", 75000 -> "1:15", 0 -> "0:00". Never negative.
 */
export function countdownLabel(msLeft: number | null | undefined): string {
  const total = Math.max(0, Math.round(Number(msLeft) || 0));
  const seconds = Math.ceil(total / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** True when the idle time has run out and the tablet must ask again. */
export function supervisorIdleExpired(
  lastActivityAt: Date | number | null | undefined,
  now: Date | number = Date.now(),
  timeoutMinutes: number = SUPERVISOR_IDLE_TIMEOUT_MINUTES
): boolean {
  const last = lastActivityAt instanceof Date ? lastActivityAt.getTime() : Number(lastActivityAt);
  const at = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(last) || !Number.isFinite(at)) return true;
  return at - last >= Math.max(0, timeoutMinutes) * 60000;
}
