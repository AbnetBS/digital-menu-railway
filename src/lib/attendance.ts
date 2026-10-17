/**
 * ATTENDANCE RULES - one place for the owner's numbers and colours
 * (owner, Oct 2026: "the person is considered late if he is 15 min late" -
 *  raised to 30 minutes on 2026-10-16: "change the 15 min maximum late time
 *  to 30 so if person come after 30 it will be described as late";
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

/**
 * A person is late from 30 minutes after the shift of his role starts. It was
 * 15 until the owner moved it (2026-10-16); one constant, so the door screen,
 * the admin page and the printed sheet can never disagree about who is late.
 */
export const LATE_GRACE_MINUTES = 30;

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
 * Minutes late for a clock-in: 0 up to LATE_GRACE_MINUTES (30) after the
 * shift start, then every minute past that. Morning shift 12:30 -> 13:00 is
 * still on time, 13:01 is 1 minute late.
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

/* ─── an offline scan keeps the moment of the finger ───────────────────────
 * The door device stores a scan it could not deliver and sends it again when
 * the internet is back (owner, Oct 2026: "if someone place his finger it will
 * store it and put it in list in that scanned time when the connection is
 * back"). Stored is not enough: stamped with the ARRIVAL time an on-time person
 * is written down late, and when both the IN and the OUT of one shift were
 * queued they arrive seconds apart, so the one-hour repeat lock swallows the
 * OUT and the day stays open with no hours at all.
 *
 * So the device sends `scannedAt` - the moment of the finger, from the same
 * NTP clock that drives its LCD row - and this function decides whether that
 * moment can be believed. It is deliberately strict, because it is the one
 * field a client could use to write history:
 *
 *   • nothing sensible to read            -> the arrival time (as before)
 *   • a moment in the future              -> the arrival time
 *   • a moment older than 3 days          -> the arrival time (a queue that
 *                                            survived a long outage is still
 *                                            delivered, just not back-dated
 *                                            into another week)
 *
 * Whatever happens, `arrivedAt` is kept so the log can say both times and
 * nothing is hidden from the owner.
 */

/** How far back a queued scan may reach and still be written at its own time. */
export const OFFLINE_SCAN_MAX_AGE_DAYS = 3;

/** A device clock may run slightly fast; this much ahead is still "now". */
export const OFFLINE_SCAN_FUTURE_GRACE_MINUTES = 2;

export type ScannedTimeReason =
  | "used"
  | "missing"
  | "unreadable"
  | "in_the_future"
  | "too_old";

export type ScannedTime = {
  /** The moment to write down: the device's own time when it is trusted. */
  time: Date;
  /** True when `time` came from the device rather than from the arrival. */
  trusted: boolean;
  /** Why the device's time was or was not used - for the audit note. */
  reason: ScannedTimeReason;
  /** The moment the scan reached the server. Always kept. */
  arrivedAt: Date;
};

const MS_PER_MINUTE = 60000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/** Seconds since 1970 for a date before 2001 - anything below is not a scan. */
const PLAUSIBLE_EPOCH_SECONDS = 1000000000;

/**
 * Read the moment a scan really happened. Accepts the epoch SECONDS the device
 * sends (and, tolerantly, epoch milliseconds or an ISO stamp), and falls back
 * to the arrival time whenever the value cannot be trusted.
 */
export function scannedTimeOf(raw: unknown, arrivedAt: Date = new Date()): ScannedTime {
  const fallback = (reason: ScannedTimeReason): ScannedTime => ({
    time: arrivedAt,
    trusted: false,
    reason,
    arrivedAt,
  });

  if (raw === null || raw === undefined || raw === "") return fallback("missing");

  let time: Date | null = null;
  if (raw instanceof Date) {
    time = Number.isNaN(raw.getTime()) ? null : raw;
  } else if (typeof raw === "number" && Number.isFinite(raw)) {
    // The device sends SECONDS. A number too big for seconds is taken as
    // milliseconds, so a hand-written correction is not thrown away either.
    time = new Date(raw > PLAUSIBLE_EPOCH_SECONDS * 1000 ? raw : raw * 1000);
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      time = Number.isFinite(n)
        ? new Date(n > PLAUSIBLE_EPOCH_SECONDS * 1000 ? n : n * 1000)
        : null;
    } else {
      const parsed = new Date(trimmed);
      time = Number.isNaN(parsed.getTime()) ? null : parsed;
    }
  }

  if (!time || Number.isNaN(time.getTime())) return fallback("unreadable");
  if (time.getTime() > arrivedAt.getTime() + OFFLINE_SCAN_FUTURE_GRACE_MINUTES * MS_PER_MINUTE) {
    return fallback("in_the_future");
  }
  if (time.getTime() < arrivedAt.getTime() - OFFLINE_SCAN_MAX_AGE_DAYS * MS_PER_DAY) {
    return fallback("too_old");
  }
  return { time, trusted: true, reason: "used", arrivedAt };
}

/** One line for the log's `notes`, so a back-dated scan is never a secret. */
export function offlineScanNote(scan: ScannedTime): string | null {
  if (!scan.trusted) return null;
  const gapMinutes = Math.round(
    (scan.arrivedAt.getTime() - scan.time.getTime()) / MS_PER_MINUTE
  );
  if (gapMinutes < 1) return null;
  const hhmm = (d: Date) => clockLabel(d) || "";
  return `Offline scan: finger at ${hhmm(scan.time)}, reached the server ${hhmm(scan.arrivedAt)} (${gapMinutes} min later)`;
}

/** "3h 05m" for the total-hours column; null when there is no OUT yet. */
export function hoursLabel(totalMinutes: number | null | undefined): string | null {
  if (totalMinutes === null || totalMinutes === undefined) return null;
  const mins = Math.max(0, Math.round(Number(totalMinutes) || 0));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

/* ─── rest windows: when the door scanner may be awake ────────────────────
 * The owner's ask (Oct 2026): the scanner should not be imaging and answering
 * all night and all afternoon, because that is what wears an optical reader
 * out. So the admin lists the hours the door is OPEN, and outside every one of
 * them the device puts itself to sleep: the sensor stops being polled, the LCD
 * goes dark, no finger is answered. When the next listed hour starts it is
 * awake again, by itself.
 *
 *   • the intervals the admin types are ACTIVE windows, not quiet ones - that
 *     is the owner's own reading ("1st activity time is 12:00-3:00, a person
 *     at 3:05 cannot scan"), and it means a cafe that forgets to add anything
 *     keeps a working door instead of a sleeping one;
 *   • an empty list is "awake all day", never "asleep all day";
 *   • every row has its own on/off, which is the "off button beside each
 *     interval" he asked for: turn it off, the door lights up for the person
 *     standing there, turn it back on and the schedule rules again;
 *   • the name + PIN keypad on the tablet is NOT part of this. The sheet, the
 *     admin page and the PIN path keep working while the scanner rests.
 *
 * These functions are pure and the device keeps its own copy of the same
 * arithmetic, because the schedule must still be obeyed when the internet is
 * down. Morning 12:30 -> 15:00 is awake at 14:59 and resting at 15:00.
 */

export const REST_MAX_WINDOWS = 12;

/** The site_settings key that holds the "keep it awake anyway" override. */
export const REST_OVERRIDE_KEY = "attendance_rest_override";

export type ActiveWindow = {
  id?: number;
  /** "HH:MM" on the Addis clock. */
  from: string;
  /** "HH:MM". A time before `from` means the window runs across midnight. */
  to: string;
  label?: string | null;
  enabled?: boolean | null;
};

/** Only the enabled rows count. */
export function enabledWindows(windows: ActiveWindow[] | null | undefined): ActiveWindow[] {
  return (Array.isArray(windows) ? windows : []).filter((w) => w && w.enabled !== false);
}

/**
 * Is this minute inside this window? Half-open [from, to), so the last minute
 * of an open hour is the minute BEFORE it closes. `from === to` is the whole
 * day and not nothing: "open 06:00 to 06:00" can only mean always open, and an
 * admin must never be able to close his own door by accident.
 */
export function windowContainsMinute(window: ActiveWindow, minuteOfDay: number): boolean {
  const from = parseHHMM(window?.from ?? null);
  const to = parseHHMM(window?.to ?? null);
  if (from === null || to === null) return false;
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(Number(minuteOfDay) || 0)));
  if (from === to) return true;
  return from < to ? m >= from && m < to : m >= from || m < to;
}

/** Should the scanner be awake at this minute of the day? */
export function isAwakeAt(windows: ActiveWindow[] | null | undefined, minuteOfDay: number): boolean {
  const open = enabledWindows(windows);
  if (open.length === 0) return true;
  return open.some((w) => windowContainsMinute(w, minuteOfDay));
}

/**
 * How long until the answer changes, in minutes: from awake to resting, or
 * from resting to awake. Walking the clock a minute at a time is deliberate -
 * 1440 cheap steps, no boundary arithmetic to get wrong, and a window that
 * wraps midnight needs no special case. 1440 means "it never changes" (no
 * windows at all, or one that covers the whole day).
 */
export function minutesUntilChange(windows: ActiveWindow[] | null | undefined, minuteOfDay: number): number {
  const now = Math.max(0, Math.min(24 * 60 - 1, Math.round(Number(minuteOfDay) || 0)));
  const awake = isAwakeAt(windows, now);
  for (let step = 1; step <= 24 * 60; step++) {
    if (isAwakeAt(windows, (now + step) % (24 * 60)) !== awake) return step;
  }
  return 24 * 60;
}

/** "06:00" for a minute of the day, for the panel's "wakes at" line. */
export function clockLabelOfMinute(minuteOfDay: number): string {
  const m = ((Math.round(Number(minuteOfDay) || 0) % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** The minute of the day (0..1439) of a moment, on the Addis clock. */
export function minuteOfDayET(at: Date | string | number = new Date()): number {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return 0;
  return etHour(d) * 60 + etMinute(d);
}

/**
 * THE OVERRIDE. "Keep it awake" is what the admin taps when somebody stands at
 * a closed door: the schedule stays exactly as it is and simply does not sleep
 * the device until the owner says so (or until the minutes he typed run out).
 * It is stored as one setting value, so there is nothing to clean up: an
 * expired "awake until" reads as plain "schedule" from the moment it passes.
 */
export type RestOverride =
  | { mode: "schedule" }
  | { mode: "awake" }
  | { mode: "awake_until"; untilAt: string };

export function parseRestOverride(value: string | null | undefined, now: Date = new Date()): RestOverride {
  const v = String(value ?? "").trim();
  if (v === "awake") return { mode: "awake" };
  if (v.startsWith("awake_until=")) {
    const untilAt = v.slice("awake_until=".length);
    const until = new Date(untilAt);
    if (!Number.isNaN(until.getTime()) && until.getTime() > now.getTime()) {
      return { mode: "awake_until", untilAt };
    }
  }
  return { mode: "schedule" };
}

/* ── how fast a change reaches a board that is resting ────────────────────
 * A sleeping ESP32 cannot hear a click, so an edit on the Activity panel is
 * carried by the board itself at the end of its next sleep slice. The trick
 * that keeps the power saving AND keeps the panel feeling alive: the sleep is
 * sliced, and the slice is SHORT while something is expected. Two of the three
 * reasons to be eager are things only the server knows, so the server says how
 * long the next sleep may be:
 *
 *   • an admin has just changed the hours, or pressed Keep it awake   (10 min grace)
 *   • a "place your finger" job is waiting for somebody to register
 *   • (the third one the board handles alone: an interval opening soon is
 *     slept exactly to that boundary whenever it is nearer than the cap)
 *
 * So changing a person's time to register makes the system start answering
 * within about 45 seconds, with no new wire and no second channel, and a quiet
 * night is still slept in ten minute pieces.
 */
export const REST_SLICE_SECONDS = 600;
export const REST_SLICE_FAST_SECONDS = 45;
/** The board is never asked to wake faster than this: a reboot costs seconds. */
export const REST_SLICE_FLOOR_SECONDS = 30;
/** How long an admin edit counts as "just now". */
export const REST_WAKE_GRACE_MS = 10 * 60000;
/** The site_settings key holding the moment the hours were last changed. */
export const REST_WAKE_KEY = "attendance_rest_wake_at";

/** How long a resting device may sleep in one go, right now, in seconds. */
export function restSliceSeconds(input: {
  wakeRequestedAt?: Date | string | number | null;
  jobWaiting?: boolean | null;
  now?: Date;
}): number {
  if (input.jobWaiting) return REST_SLICE_FAST_SECONDS;
  const raw = input.wakeRequestedAt;
  if (raw === null || raw === undefined || raw === "") return REST_SLICE_SECONDS;
  const at = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(at.getTime())) return REST_SLICE_SECONDS;
  const now = input.now ?? new Date();
  return now.getTime() - at.getTime() < REST_WAKE_GRACE_MS ? REST_SLICE_FAST_SECONDS : REST_SLICE_SECONDS;
}

/** What a device is allowed to obey: a whole number of seconds, never churn. */
export function clampRestSliceSeconds(value: unknown): number {
  const n = Math.round(Number(value) || 0);
  if (!Number.isFinite(n) || n <= 0) return REST_SLICE_SECONDS;
  return Math.max(REST_SLICE_FLOOR_SECONDS, Math.min(REST_SLICE_SECONDS, n));
}

/** Does the override let the device put itself to sleep right now? */
export function restOverrideAllowsSleep(override: RestOverride, now: Date = new Date()): boolean {
  if (override.mode === "awake") return false;
  if (override.mode === "awake_until") return new Date(override.untilAt).getTime() <= now.getTime();
  return true;
}

/* ─── overtime: three kinds, three ways in ────────────────────────────────
 * Overtime is not one flag here, it is a kind of work (owner, Oct 2026), and
 * it can arrive from three directions:
 *
 *   • an admin writes it on the Overtime tab of the Attendance page
 *     (source "admin");
 *   • a person taps Overtime on the door tablet and picks the kind himself
 *     ("self"), or the supervisor does it for him ("supervisor");
 *   • nobody has to remember for Shift OT: whoever is still in the building
 *     more than an hour and a half after his shift ends has worked overtime,
 *     and the overtime is exactly the time past the end of the shift. That row
 *     is written by the clock-out scan itself (source "auto").
 *
 * There is no approval step - the owner wants the row to "list immediately".
 * A row IS the decision, and the day's box on the paper sheet turns violet
 * beside it so the two views can never disagree about that day.
 */

export const OVERTIME_TYPES = ["holiday", "free_week", "shift"] as const;
export type OvertimeType = (typeof OVERTIME_TYPES)[number];

/** The three buttons the owner asked for, in the order they are offered. */
export const OVERTIME_TYPE_LABELS: Record<OvertimeType, string> = {
  holiday: "Holiday OT",
  free_week: "Free week OT",
  shift: "Shift OT",
};

/** What each kind means, for the small print under the buttons. */
export const OVERTIME_TYPE_HINTS: Record<OvertimeType, string> = {
  holiday: "A public holiday or a rest day that was worked.",
  free_week: "The person's own free week that was given up.",
  shift: "Hours past the end of the shift, on a normal working day.",
};

export const OVERTIME_SOURCES = ["admin", "supervisor", "self", "auto"] as const;
export type OvertimeSource = (typeof OVERTIME_SOURCES)[number];

/** Who wrote the row. The table shows it, because the owner reads this page
 *  to find out who put hours on somebody's day. */
export const OVERTIME_SOURCE_LABELS: Record<OvertimeSource, string> = {
  admin: "admin",
  supervisor: "supervisor",
  self: "the person",
  auto: "clock-out",
};

/** How far past the end of a shift a person must still be present before the
 *  time starts counting as Shift OT (owner, Oct 2026: an hour and a half). */
export const SHIFT_OT_GRACE_MINUTES = 90;

export function isOvertimeType(value: unknown): value is OvertimeType {
  return typeof value === "string" && (OVERTIME_TYPES as readonly string[]).includes(value);
}

export function isOvertimeSource(value: unknown): value is OvertimeSource {
  return typeof value === "string" && (OVERTIME_SOURCES as readonly string[]).includes(value);
}

/**
 * The Shift OT of one clock-out: the minutes between the end of the shift and
 * the OUT scan, and only when the person stayed more than SHIFT_OT_GRACE_MINUTES
 * past it. A shift that runs across midnight (18:00-03:00) wraps exactly the
 * way the early-out rule wraps it, so an out at 02:00 is an hour EARLY and
 * nothing is written, while an out at 05:00 is two hours past the end. A shift
 * that ends before midnight is never wrapped upwards: the clock route closes a
 * day only inside that day's own date, so an out that reads earlier than the
 * start of the shift is a mistake, not a night of overtime, and it is ignored.
 *
 * Returns 0 when there is nothing to record, which is also the answer for "no
 * shift is set for this person" - the rule can only measure against a time.
 */
export function shiftOtMinutesFor(
  shift: RoleShift | null | undefined,
  clockOutAt: Date | string | null | undefined
): number {
  const start = parseHHMM(shift?.startTime ?? null);
  const end = parseHHMM(shift?.endTime ?? null);
  if (end === null || !clockOutAt) return 0;
  const out = clockOutAt instanceof Date ? clockOutAt : new Date(clockOutAt);
  if (Number.isNaN(out.getTime())) return 0;
  const crossesMidnight = start !== null && end <= start;
  const endMinutes = crossesMidnight ? end + 24 * 60 : end;
  const raw = etMinutes(out);
  const outMinutes = crossesMidnight && start !== null && raw < start ? raw + 24 * 60 : raw;
  const past = outMinutes - endMinutes;
  return past > SHIFT_OT_GRACE_MINUTES ? past : 0;
}

/**
 * What a day's own scans say about overtime, used when nobody typed a number:
 * the hours actually worked that day. A day with no line has none (0), and the
 * caller then asks for the hours instead of inventing them.
 */
export function overtimeMinutesFromLog(
  log:
    | {
        totalMinutes?: number | null;
        clockIn?: Date | string | null;
        clockOut?: Date | string | null;
      }
    | null
    | undefined
): number {
  if (!log) return 0;
  const cap = 24 * 60;
  const stored = Math.round(Number(log.totalMinutes) || 0);
  if (stored > 0) return Math.min(stored, cap);
  const inAt = log.clockIn ? new Date(log.clockIn).getTime() : NaN;
  const outAt = log.clockOut ? new Date(log.clockOut).getTime() : NaN;
  if (!Number.isFinite(inAt) || !Number.isFinite(outAt)) return 0;
  return Math.max(0, Math.min(Math.round((outAt - inAt) / 60000), cap));
}

/** "2h 30m" for the table. Overtime is always spoken in hours and minutes. */
export function overtimeHoursLabel(minutes: number | null | undefined): string {
  return hoursLabel(minutes) ?? "0h 00m";
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

