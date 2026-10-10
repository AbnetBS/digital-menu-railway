/**
 * ATTENDANCE RULES - one place for the owner's numbers and colours
 * (owner, Oct 2026: "the person is considered late if he is 15 min late",
 * "when someone clicks more than once it says already registered but after
 * 1 hour the next scan is printed in the OUT", "maximum of 7 days",
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

/** The paper sheet prints at most one week at a time. */
export const SHEET_MAX_DAYS = 7;

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
 * SHEET_MAX_DAYS of them: a month-long range is cut back to the week that
 * still fits the printed paper. A reversed range is turned the right way up.
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
  const span = Math.min(daysBetween(start, end), SHEET_MAX_DAYS - 1);
  const out: string[] = [];
  for (let i = 0; i <= span; i++) out.push(addDays(start, i));
  return out;
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

/** How old a scan the device kept offline may be, and how far ahead its clock may run. */
export const MAX_OFFLINE_SCAN_AGE_MS = 72 * 60 * 60 * 1000;
export const MAX_DEVICE_CLOCK_AHEAD_MS = 120 * 1000;

/**
 * WHEN DID THE FINGER TOUCH? The scanner sends `scannedAt` (Unix seconds) with
 * every scan, and with the scans it saved while the WiFi was down. Recording
 * those at the moment they are finally sent would turn an 08:00 IN into a
 * 10:00 "late". A time outside the window (dead clock battery, no NTP yet) is
 * ignored and the server time is used, exactly as before.
 */
export function scanTimeFrom(scannedAt: unknown, serverNow: Date = new Date()): Date {
  const seconds = Number(scannedAt);
  if (!Number.isFinite(seconds) || seconds <= 0) return serverNow;
  const at = new Date(Math.round(seconds) * 1000);
  const diff = at.getTime() - serverNow.getTime();
  if (diff > MAX_DEVICE_CLOCK_AHEAD_MS || diff < -MAX_OFFLINE_SCAN_AGE_MS) return serverNow;
  return diff > 0 ? serverNow : at;
}
