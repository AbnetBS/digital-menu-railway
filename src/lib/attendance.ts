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
 * FALLBACK only (2026-10-27): the grace that really applies is the Maximum
 * Late Time saved on each role's shift in Attendance, Role & Time, and the
 * Leaving Grace saved beside it. The door, the payroll and the printed sheet
 * all read those role values, so there is no fixed 30 minute grace in a fine.
 * This 30 is used only when a shift row has no grace value stored (an old
 * install), so an unconfigured role is not charged from its first minute.
 * It was 15 until the owner moved it on 2026-10-16.
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
  lateGraceMinutes?: number;
  earlyLeaveGraceMinutes?: number;
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
 * Pre-shift arrival window for multi-shift roles (up to 2+ shifts per role):
 * when an employee's first scan (IN) arrives near an upcoming shift's entrance
 * time (e.g. from 20-60 minutes before Shift 2 begins, such as 13:40/13:50 for
 * a 14:00 shift, or up to 120 minutes early once the earlier shift has ended),
 * recognize them on that upcoming shift instead of marking them late on Shift 1.
 */
export const SHIFT_EARLY_ARRIVAL_MINUTES = 60;
export const SHIFT_POST_PREV_ARRIVAL_MINUTES = 120;

export function pickShift(shifts: RoleShift[] | null | undefined, minutes: number): RoleShift | null {
  const list = (shifts || [])
    .map((s) => ({ shift: s, start: parseHHMM(s.startTime), end: parseHHMM(s.endTime) }))
    .filter((s): s is { shift: RoleShift; start: number; end: number | null } => s.start !== null)
    .sort((a, b) => a.start - b.start);
  if (list.length === 0) return null;
  if (list.length === 1) return list[0].shift;

  let prevIndex = -1;
  for (let i = 0; i < list.length; i++) {
    if (list[i].start <= minutes) prevIndex = i;
  }

  // Before every shift's start time today (e.g. 05:30 before an 06:00 shift):
  // assign to the earliest shift of the day.
  if (prevIndex === -1) {
    return list[0].shift;
  }

  const prev = list[prevIndex];
  const sincePrev = minutes - prev.start;
  const hasLaterToday = prevIndex + 1 < list.length;
  const next = hasLaterToday ? list[prevIndex + 1] : list[0];
  const untilNext = hasLaterToday ? next.start - minutes : next.start + 24 * 60 - minutes;

  const prevEnded = prev.end !== null && prev.end > prev.start && minutes >= prev.end;
  const earlyWindow = prevEnded ? SHIFT_POST_PREV_ARRIVAL_MINUTES : SHIFT_EARLY_ARRIVAL_MINUTES;

  if (untilNext <= earlyWindow && untilNext < sincePrev) {
    return next.shift;
  }
  return prev.shift;
}

/**
 * CHARGEABLE minutes late for a clock-in: 0 inside the role's Maximum Late
 * Time, then every minute past it. The 30 minute constant is only a fallback
 * for a shift with no grace stored. Example with a 20 minute role grace on an
 * 08:00 shift: 08:20 is still on time, 08:25 is 5 chargeable minutes.
 */
export function lateMinutesFor(shift: RoleShift | null | undefined, clockInMinutes: number): number {
  const start = parseHHMM(shift?.startTime ?? null);
  if (start === null) return 0;
  if (clockInMinutes > start && start + 24 * 60 - clockInMinutes <= SHIFT_POST_PREV_ARRIVAL_MINUTES) {
    return 0;
  }
  const grace = Math.max(0, Number(shift?.lateGraceMinutes ?? LATE_GRACE_MINUTES));
  return Math.max(0, clockInMinutes - (start + grace));
}

/**
 * CHARGEABLE minutes for leaving early: 0 inside the role's Leaving Grace,
 * then every minute before that. With a 20 minute Leaving Grace on a 17:00
 * shift, leaving at 16:40 costs nothing and 16:35 costs 5 minutes.
 *
 * A night period (22:00 -> 02:00) ends on the next calendar day, so its time out
 * is read as "02:00 tomorrow" and an OUT at 23:00 is still an early out. Without
 * that, every night-shift person who left after midnight looked punctual and
 * everybody who left before it looked late to go home.
 */
export function earlyOutMinutesFor(shift: RoleShift | null | undefined, clockOutMinutes: number): number {
  const start = parseHHMM(shift?.startTime ?? null);
  const end = parseHHMM(shift?.endTime ?? null);
  if (end === null) return 0;
  const crossesMidnight = start !== null && end <= start;
  const endMinutes = (crossesMidnight ? end + 24 * 60 : end) - Math.max(0, Number(shift?.earlyLeaveGraceMinutes ?? 0));
  const outMinutes = crossesMidnight && clockOutMinutes < (start ?? 0) ? clockOutMinutes + 24 * 60 : clockOutMinutes;
  return Math.max(0, endMinutes - outMinutes);
}

export function isEarlyOut(shift: RoleShift | null | undefined, clockOutMinutes: number): boolean {
  return earlyOutMinutesFor(shift, clockOutMinutes) > 0;
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
 * The device sends `scannedAt` from its clock. This parser reports whether a
 * time is usable; its legacy fallback is arrival, but the clock route MUST
 * reject an invalid/missing timestamp on queued scans rather than using that
 * fallback. `allowOlder` enables valid dates beyond three days; the route also
 * requires a configured, verified device token for those older scans.
 * `arrivedAt` remains available for the audit note.
 */

/** Older scans require an explicitly configured device token at the route. */
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
 * sends (and, tolerantly, epoch milliseconds or an ISO stamp). For legacy
 * callers it returns arrival with `trusted: false` when validation fails;
 * callers requiring recorded time must reject that result.
 */
export function scannedTimeOf(
  raw: unknown,
  arrivedAt: Date = new Date(),
  options: { allowOlder?: boolean } = {}
): ScannedTime {
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
  // The ESP32 refuses to consider its clock synchronized before 2020. Even an
  // authenticated device must not turn a boot-relative number into a date.
  if (options.allowOlder && time.getTime() < Date.UTC(2020, 0, 1)) return fallback("unreadable");
  if (time.getTime() > arrivedAt.getTime() + OFFLINE_SCAN_FUTURE_GRACE_MINUTES * MS_PER_MINUTE) {
    return fallback("in_the_future");
  }
  if (!options.allowOlder && time.getTime() < arrivedAt.getTime() - OFFLINE_SCAN_MAX_AGE_DAYS * MS_PER_DAY) {
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

/* ─── automatic scanner hours: role shifts plus a one-hour buffer ──────────
 * Every configured role shift is extended by one hour before its start and one
 * hour after its end. Overlapping or touching windows are merged; any gaps
 * remain rest periods. These are recurring Addis Ababa clock times, matching
 * the role-shift form and the ESP32's local clock.
 *
 * An empty role-shift list is deliberately fail-open: the scanner stays awake
 * all day rather than risk closing the door because the schedule is missing.
 * If the schedule would exceed the ESP32's supported window count, it also
 * fails open to all-day awake rather than silently omitting a worker's shift.
 * The keypad, paper sheet and admin page work independently of scanner sleep.
 */

export const REST_MAX_WINDOWS = 12;
export const SCANNER_SHIFT_BUFFER_MINUTES = 60;

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

export type RoleScannerSchedule = {
  windows: ActiveWindow[];
  /** Number of valid configured role shifts used to build this schedule. */
  shiftCount: number;
  /** True only when the safe all-day fallback is used due to too many windows. */
  overflow: boolean;
};

/**
 * Convert every role's recurring shift into scanner-awake windows. For example,
 * 12:00-20:00 becomes 11:00-21:00. Windows that overlap or touch are merged,
 * including across midnight. The output is limited to the ESP32's fixed
 * capacity; overflow fails open to all-day awake so no shift is silently lost.
 */
export function roleShiftsToScannerSchedule(
  shifts: Array<Pick<RoleShift, "startTime" | "endTime"> | null | undefined>,
  paddingMinutes = SCANNER_SHIFT_BUFFER_MINUTES
): RoleScannerSchedule {
  const padding = Number.isFinite(Number(paddingMinutes)) ? Math.max(0, Math.floor(Number(paddingMinutes))) : SCANNER_SHIFT_BUFFER_MINUTES;
  const valid = (Array.isArray(shifts) ? shifts : [])
    .map((shift) => ({ start: parseHHMM(shift?.startTime), end: parseHHMM(shift?.endTime) }))
    .filter((shift): shift is { start: number; end: number } => shift.start !== null && shift.end !== null);
  const shiftCount = valid.length;
  const allDay = (label: string, overflow = false): RoleScannerSchedule => ({
    windows: [{ from: "00:00", to: "00:00", label, enabled: true }],
    shiftCount,
    overflow,
  });

  if (shiftCount === 0) return { windows: [], shiftCount: 0, overflow: false };

  const open = new Uint8Array(24 * 60);
  for (const shift of valid) {
    let end = shift.end;
    // As elsewhere in attendance, an end at/before the start belongs to the
    // following day; equal times therefore mean a full-day shift.
    if (end <= shift.start) end += 24 * 60;
    const intervalStart = shift.start - padding;
    const intervalEnd = end + padding;
    if (intervalEnd - intervalStart >= 24 * 60) return allDay("Role shifts cover all day");
    for (let minute = intervalStart; minute < intervalEnd; minute++) {
      const normalized = ((minute % (24 * 60)) + 24 * 60) % (24 * 60);
      open[normalized] = 1;
    }
  }

  const activeMinutes = open.reduce((sum, minute) => sum + minute, 0);
  if (activeMinutes === 24 * 60) return allDay("Role shifts cover all day");

  const windows: ActiveWindow[] = [];
  for (let start = 0; start < open.length; start++) {
    const previous = (start + open.length - 1) % open.length;
    if (!open[start] || open[previous]) continue;
    let length = 0;
    while (length < open.length && open[(start + length) % open.length]) length++;
    windows.push({
      from: toHHMM(start),
      to: toHHMM((start + length) % open.length),
      label: "Automatic from role shifts",
      enabled: true,
    });
  }

  if (windows.length > REST_MAX_WINDOWS) {
    return allDay("Safety fallback: too many separate role periods", true);
  }
  return { windows, shiftCount, overflow: false };
}

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
 * A sleeping ESP32 cannot hear a click, so a Role & Time edit is picked up at
 * the end of its next sleep slice. The sleep is sliced, and the slice is short
 * while something is expected. Two of the three reasons to hurry are things
 * only the server knows, so the server says how long the next sleep may be:
 *
 *   • an admin has just changed a role shift or pressed Keep scanner awake (10 min grace)
 *   • a "place your finger" job is waiting for somebody to register
 *   • the board handles a nearby generated-window boundary itself, sleeping
 *     only until that boundary when it is nearer than the slice cap
 *
 * An awake scanner refreshes immediately through the device event channel. A
 * scanner already in deep sleep cannot be interrupted remotely: it first reads
 * the change on its next timer wake (up to the normal ten-minute slice), then
 * uses the short slice during the grace period. Quiet rest otherwise stays in
 * ten-minute pieces.
 */
export const REST_SLICE_SECONDS = 600;
export const REST_SLICE_FAST_SECONDS = 45;
/** The board is never asked to wake faster than this: a reboot costs seconds. */
export const REST_SLICE_FLOOR_SECONDS = 30;
/** How long an admin edit counts as "just now". */
export const REST_WAKE_GRACE_MS = 10 * 60000;
/** The site_settings key holding the moment a scanner refresh was requested. */
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
 *     more than ONE HOUR after his shift ends has worked overtime, and the
 *     overtime is exactly the time past the end of the shift (out at 10:00 for
 *     a shift ending 8:00 is two hours). That row is written by the clock-out
 *     scan itself (source "auto").
 *
 * There is no approval step - the owner wants the row to "list immediately".
 * A row IS the decision, and the day's box on the paper sheet turns violet
 * beside it so the two views can never disagree about that day.
 */

export const OVERTIME_TYPES = ["free_week", "holiday", "shift", "night_shift"] as const;
export type OvertimeType = (typeof OVERTIME_TYPES)[number];

/** The four overtime types offered in the dropdown and payroll settings. */
export const OVERTIME_TYPE_LABELS: Record<OvertimeType, string> = {
  free_week: "Free week OT",
  holiday: "Holiday OT",
  shift: "Shift OT",
  night_shift: "Night shift OT",
};

/** Short descriptions for each overtime kind. */
export const OVERTIME_TYPE_HINTS: Record<OvertimeType, string> = {
  free_week: "A scheduled free day worked.",
  holiday: "A registered holiday worked.",
  shift: "Extra hours worked on a shift.",
  night_shift: "Extra hours worked on a night shift.",
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

/**
 * How far past the end of a shift a person must still be present before the
 * time starts counting as Shift OT. On 2026-10-28 the owner raised it from
 * ONE HOUR to ONE HOUR FIFTEEN: "they will stay doing transferring, change
 * cloth and other and sometimes they stay maximum of 1:15 hour ... if that
 * person scan his finger in 9:00 he will get undeserved 1:15 hour". The whole
 * time past the end is then paid, not only the part above the buffer (his
 * 2026-10-22 example: shift ends 8:00, out 10:00 -> 2 hours).
 *
 * The same 75 minutes apply to holiday, free-week and shift overtime; on a
 * worked holiday or free day the shift itself is overtime from the first
 * minute, and only the clothing/transfer tail is ignored.
 */
export const SHIFT_OT_GRACE_MINUTES = 75;

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
 * "THE TIME MORE THAN 8 HOUR IS AUTOMATICALLY CONSIDERED SHIFT OT"
 * (owner, 2026-10-28). A person who covers a second shift (the afternoon
 * worker who came in for the sick morning worker) has one IN and one OUT on
 * that day. The extra shift is the time worked BEYOND the length of his own
 * shift, not the minutes past a nominal end that a late arrival already ate.
 *
 *     shift 12:00-8:00, IN 12:30, OUT 11:30  -> 11 h worked, 8 h shift
 *                                            -> 3 h Shift OT
 *
 * The 1:15 buffer still guards the tail: a person who merely changed clothes
 * and left 60 minutes after the end has 60 minutes beyond the shift, which is
 * inside the buffer and pays nothing. Past the buffer the WHOLE excess is paid.
 *
 * Without a clock-in (an old row) this falls back to the end-of-shift
 * measurement, which is all that row can prove.
 */
export function workedShiftOtMinutes(
  shift: RoleShift | null | undefined,
  clockInAt: Date | string | null | undefined,
  clockOutAt: Date | string | null | undefined
): number {
  if (!clockInAt) return shiftOtMinutesFor(shift, clockOutAt);
  const start = parseHHMM(shift?.startTime ?? null);
  const endRaw = parseHHMM(shift?.endTime ?? null);
  if (start === null || endRaw === null || !clockOutAt) return 0;
  const inAt = clockInAt instanceof Date ? clockInAt : new Date(clockInAt);
  const outAt = clockOutAt instanceof Date ? clockOutAt : new Date(clockOutAt);
  if (Number.isNaN(inAt.getTime()) || Number.isNaN(outAt.getTime())) return 0;
  const inM = etMinutes(inAt);
  const outM = etMinutes(outAt);
  const crossesMidnight = endRaw <= start;
  const end = crossesMidnight ? endRaw + 24 * 60 : endRaw;
  const inShifted = crossesMidnight && inM < start ? inM + 24 * 60 : inM;
  const outShifted = crossesMidnight && outM < start ? outM + 24 * 60 : outM;
  if (outShifted <= inShifted) return 0;
  const shiftLength = Math.max(0, end - start);
  const beyond = Math.max(0, outShifted - inShifted - shiftLength);
  return beyond > SHIFT_OT_GRACE_MINUTES ? Math.min(24 * 60, Math.round(beyond)) : 0;
}

/** "2026-10-24" -> "Saturday". Noon UTC: no time zone can move the weekday.
 *  The owner asked for the weekday beside every overtime date in the history. */
export function weekdayName(date: string): string {
  const d = new Date(`${String(date || "").slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(d);
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
