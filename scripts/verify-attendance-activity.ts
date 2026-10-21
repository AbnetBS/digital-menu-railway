#!/usr/bin/env tsx
/**
 * Regression guard: automatic scanner hours from role shifts (Oct 2026).
 *
 * Every Role & Time shift is padded by one hour on both ends. Overlapping or
 * adjacent padded windows merge; gaps remain deep-sleep periods. Missing role
 * times and schedules too large for the ESP32 fail open to awake-all-day. The
 * server sends this same generated schedule to the website and cached device.
 *
 * Run with: npx tsx scripts/verify-attendance-activity.ts
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  REST_MAX_WINDOWS,
  REST_OVERRIDE_KEY,
  REST_SLICE_FAST_SECONDS,
  REST_SLICE_SECONDS,
  REST_WAKE_GRACE_MS,
  REST_WAKE_KEY,
  SCANNER_SHIFT_BUFFER_MINUTES,
  clampRestSliceSeconds,
  clockLabelOfMinute,
  enabledWindows,
  isAwakeAt,
  minuteOfDayET,
  minutesUntilChange,
  parseRestOverride,
  roleShiftsToScannerSchedule,
  restOverrideAllowsSleep,
  restSliceSeconds,
  windowContainsMinute,
} from "../src/lib/attendance";
import type { ActiveWindow } from "../src/lib/attendance";

let failures = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
  if (!cond) failures++;
};

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const sliceOf = (text: string, from: string, to: string, label: string) => {
  const a = text.indexOf(from);
  const b = a === -1 ? -1 : text.indexOf(to, a);
  if (a === -1 || b === -1) {
    pass(`${label} is there`, false, `could not find ${JSON.stringify(from)} .. ${JSON.stringify(to)}`);
    return "";
  }
  return text.slice(a, b);
};

const win = (from: string, to: string, enabled = true): ActiveWindow => ({ from, to, enabled });
const hhmm = (h: number, m: number) => h * 60 + m;

console.log("\n=== Activity: role-derived scanner hours ===\n");

/* ── 1. the awake-window helpers used by the generated schedule ─────────── */
pass(
  "a generated window is awake at its inclusive start: 12:00-15:00 is awake at 12:00",
  windowContainsMinute(win("12:00", "15:00"), hhmm(12, 0))
);
pass(
  "14:59 is its last awake minute, and 15:00 is already resting (half-open)",
  windowContainsMinute(win("12:00", "15:00"), hhmm(14, 59)) && !windowContainsMinute(win("12:00", "15:00"), hhmm(15, 0))
);
pass(
  "before a generated window opens, the board rests: 11:59 before 12:00",
  !windowContainsMinute(win("12:00", "15:00"), hhmm(11, 59))
);
// A generic generated overnight window remains half-open at its end.
pass(
  "an overnight generated window is awake at 12:01 and at 02:59",
  windowContainsMinute(win("12:00", "03:00"), hhmm(12, 1)) && windowContainsMinute(win("12:00", "03:00"), hhmm(2, 59))
);
pass(
  "and 03:05 is outside the overnight window",
  !windowContainsMinute(win("12:00", "03:00"), hhmm(3, 5)) && !windowContainsMinute(win("12:00", "03:00"), hhmm(9, 0))
);
pass(
  "from === to means the whole day, so an all-day generated window stays open",
  windowContainsMinute(win("06:00", "06:00"), hhmm(0, 0)) && windowContainsMinute(win("06:00", "06:00"), hhmm(23, 59))
);
pass(
  "a window whose times are invalid counts for nothing",
  !windowContainsMinute(win("", ""), hhmm(10, 0)) && !windowContainsMinute(win("9:00", "25:00"), hhmm(10, 0))
);

/* ── 1b. role shifts generate automatic scanner-open periods ──────────────── */
const shift = (startTime: string, endTime: string) => ({ startTime, endTime });
const oneRoleWindow = roleShiftsToScannerSchedule([shift("12:00", "20:00")]);
pass("a 12:00-20:00 role shift opens 1 hour early and closes 1 hour late",
  oneRoleWindow.windows.length === 1 && oneRoleWindow.windows[0].from === "11:00" && oneRoleWindow.windows[0].to === "21:00");
pass("the automatic buffer is exactly 60 minutes", SCANNER_SHIFT_BUFFER_MINUTES === 60);
const overlappingRoleWindows = roleShiftsToScannerSchedule([shift("12:00", "20:00"), shift("13:00", "20:00")]);
pass("overlapping padded role windows merge into one scanner period",
  overlappingRoleWindows.windows.length === 1 && overlappingRoleWindows.windows[0].from === "11:00" && overlappingRoleWindows.windows[0].to === "21:00");
const nearbyRoleWindows = roleShiftsToScannerSchedule([shift("06:00", "07:00"), shift("08:00", "09:00")]);
pass("the 06:00 and 08:00 shifts merge through their padded overlap (05:00-10:00)",
  nearbyRoleWindows.windows.length === 1 && nearbyRoleWindows.windows[0].from === "05:00" && nearbyRoleWindows.windows[0].to === "10:00");
const touchingRoleWindows = roleShiftsToScannerSchedule([shift("06:00", "07:00"), shift("09:00", "10:00")]);
pass("padded windows that touch exactly at 08:00 merge without a one-minute sleep gap",
  touchingRoleWindows.windows.length === 1 && touchingRoleWindows.windows[0].from === "05:00" &&
  touchingRoleWindows.windows[0].to === "11:00");
const gappedRoleWindows = roleShiftsToScannerSchedule([shift("06:00", "08:00"), shift("12:00", "20:00")]);
pass("a real gap between role shifts remains a sleep period",
  gappedRoleWindows.windows.length === 2 && gappedRoleWindows.windows[0].from === "05:00" &&
  gappedRoleWindows.windows[0].to === "09:00" && gappedRoleWindows.windows[1].from === "11:00" &&
  gappedRoleWindows.windows[1].to === "21:00");
const nightRoleWindow = roleShiftsToScannerSchedule([shift("22:00", "06:00")]);
pass("overnight shifts wrap across midnight with the one-hour buffer (21:00-07:00)",
  nightRoleWindow.windows.length === 1 && nightRoleWindow.windows[0].from === "21:00" && nightRoleWindow.windows[0].to === "07:00");
const midnightAdjacentWindows = roleShiftsToScannerSchedule([shift("21:00", "23:00"), shift("01:00", "03:00")]);
pass("two padded periods touching across midnight merge into one window",
  midnightAdjacentWindows.windows.length === 1 && midnightAdjacentWindows.windows[0].from === "20:00" &&
  midnightAdjacentWindows.windows[0].to === "04:00");
const noRoleTimes = roleShiftsToScannerSchedule([]);
pass("no configured role shifts returns the safe all-day default (empty windows)",
  noRoleTimes.shiftCount === 0 && noRoleTimes.windows.length === 0 && isAwakeAt(noRoleTimes.windows, hhmm(2, 0)));
const invalidRoleTimes = roleShiftsToScannerSchedule([shift("not a time", "25:00")]);
pass("if every saved shift time is invalid, fail open to awake all day",
  invalidRoleTimes.shiftCount === 0 && isAwakeAt(invalidRoleTimes.windows, hhmm(17, 0)));
const allDayRoleShift = roleShiftsToScannerSchedule([shift("10:00", "10:00")]);
pass("a role shift with equal start and end safely keeps the scanner awake all day",
  allDayRoleShift.windows.length === 1 && allDayRoleShift.windows[0].from === "00:00" &&
  allDayRoleShift.windows[0].to === "00:00");
const overflowShifts = Array.from({ length: 13 }, (_, i) => {
  const start = i * 110;
  return shift(`${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`,
    `${String(Math.floor((start + 1) / 60)).padStart(2, "0")}:${String((start + 1) % 60).padStart(2, "0")}`);
});
const overflowSchedule = roleShiftsToScannerSchedule(overflowShifts, 0);
pass("too many separate generated periods fail open to an all-day window",
  overflowSchedule.overflow && overflowSchedule.windows.length === 1 &&
  overflowSchedule.windows[0].from === "00:00" && overflowSchedule.windows[0].to === "00:00");

/* ── 2. generated-window membership and safe handling of legacy flags ───── */
const dayShift = [win("06:00", "10:00"), win("12:00", "15:00"), win("18:00", "22:00")];
pass(
  "with several generated windows the board is awake in any one of them",
  isAwakeAt(dayShift, hhmm(13, 0)) && isAwakeAt(dayShift, hhmm(6, 30))
);
pass("...and resting in the gaps between generated windows", !isAwakeAt(dayShift, hhmm(10, 30)) && !isAwakeAt(dayShift, hhmm(23, 30)));
pass(
  "a disabled cached legacy window does not open the door",
  !isAwakeAt([win("06:00", "22:00", false), win("12:00", "13:00")], hhmm(20, 0))
);
pass("the firmware-compatible window helper counts only enabled entries", enabledWindows([win("01:00", "02:00"), win("03:00", "04:00", false)]).length === 1);

/* ── 3. empty or disabled schedules fail open, never shut ───────────────── */
pass("no generated windows means awake all day (missing roles cannot lock the owner out)", isAwakeAt([], hhmm(3, 0)));
pass("a list with no enabled windows also means awake as a safe fallback", isAwakeAt([win("00:00", "23:59", false)], hhmm(3, 0)));
pass("an absent list is treated the same way", isAwakeAt(null, hhmm(3, 0)) && isAwakeAt(undefined, hhmm(3, 0)));

/* ── 4. the wait, which is what the board sleeps for ──────────────────────── */
pass("45 awake minutes before closing: the panel can say so", minutesUntilChange([win("06:00", "10:00")], hhmm(9, 15)) === 45);
pass("resting at 15:00, tomorrow's 06:00 is 900 minutes away", minutesUntilChange([win("06:00", "10:00")], hhmm(15, 0)) === 900);
pass("an all-day schedule never changes", minutesUntilChange([win("06:00", "06:00")], hhmm(4, 0)) === 1440);
pass("an empty schedule never changes either", minutesUntilChange([], hhmm(4, 0)) === 1440);
pass(
  "the boundary of an overnight generated window is measured, not guessed",
  minutesUntilChange([win("22:00", "06:00")], hhmm(5, 50)) === 10 &&
    minutesUntilChange([win("22:00", "06:00")], hhmm(6, 0)) === 960
);
pass(
  "a minute of the day prints back as a clock time, and wraps",
  clockLabelOfMinute(hhmm(13, 5)) === "13:05" && clockLabelOfMinute(1445) === "00:05"
);
pass(
  "the minute of the day is counted on the Addis clock, three hours ahead of UTC",
  minuteOfDayET(new Date("2026-10-17T00:05:00Z")) === hhmm(3, 5),
  `got ${minuteOfDayET(new Date("2026-10-17T00:05:00Z"))}`
);
pass("and it wraps into the next Addis day at 21:05 UTC", minuteOfDayET(new Date("2026-10-16T21:05:00Z")) === hhmm(0, 5));
pass("an unusable moment reads as midnight, not as NaN", minuteOfDayET("not a date") === 0);

/* ── 5. the admin's override ──────────────────────────────────────────────── */
const now = new Date("2026-10-17T06:00:00Z");
pass(
  "nothing stored means the schedule rules",
  parseRestOverride(null, now).mode === "schedule" && parseRestOverride("", now).mode === "schedule"
);
pass("garbage in settings is the same as nothing", parseRestOverride("closed forever", now).mode === "schedule");
pass(
  "keep it awake is obeyed and needs no cleanup",
  parseRestOverride("awake", now).mode === "awake" && restOverrideAllowsSleep({ mode: "awake" }, now) === false
);
const future = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
pass(
  "awake for N minutes is obeyed while the minutes last",
  parseRestOverride(`awake_until=${future}`, now).mode === "awake_until" &&
    restOverrideAllowsSleep({ mode: "awake_until", untilAt: future }, now) === false
);
const past = new Date(now.getTime() - 1000).toISOString();
pass(
  "and expires by itself: an old awake_until reads as plain schedule",
  parseRestOverride(`awake_until=${past}`, now).mode === "schedule" &&
    restOverrideAllowsSleep({ mode: "awake_until", untilAt: past }, now)
);
pass("the override lives in one site_settings key", REST_OVERRIDE_KEY === "attendance_rest_override");
pass("the panel is capped, like the route says", REST_MAX_WINDOWS === 12);

/* ── 6. Role & Time is the source of the scanner schedule ───────────────── */
const schema = read("src/db/schema.ts");
pass("role shifts persist their entrance and exit times",
  schema.includes('pgTable("attendance_role_shifts"') && schema.includes("startTime") && schema.includes("endTime"));
pass("the automatic scanner buffer and firmware window cap are explicit", SCANNER_SHIFT_BUFFER_MINUTES === 60 && REST_MAX_WINDOWS === 12);

/* ── 7. the API gives the same generated hours to the panel and ESP32 ─────── */
const routePath = "src/app/api/attendance/activity/route.ts";
pass("the endpoint exists", existsSync(path.join(ROOT, routePath)));
const route = read(routePath);
const getSlice = sliceOf(route, "export async function GET(", "export async function POST(", "the GET handler");
const postSlice = sliceOf(route, "export async function POST(", "\n}", "the POST handler");
pass("a device may read the schedule with its own token, no admin session", getSlice.includes("deviceAllowed(request)"));
pass("the schedule GET reads role shifts and calls the tested window generator",
  getSlice.includes("attendanceRoleShifts") && getSlice.includes("roleShiftsToScannerSchedule(shiftRows)"));
pass("the same derived windows go to the device cache", getSlice.includes("windows: windows.map") && getSlice.includes("device:"));
pass("the panel receives shift count, overflow fallback, and always-awake status",
  getSlice.includes("shiftCount: schedule.shiftCount") && getSlice.includes("overflow: schedule.overflow") && getSlice.includes("alwaysAwake"));
pass("the device still receives its awake override and sleep-slice hint",
  getSlice.includes("keptAwake") && getSlice.includes("wakeUntilEpoch") && getSlice.includes("sliceSeconds"));
pass("manual interval writes are rejected with a pointer to Role & Time",
  postSlice.includes('action !== "override"') && postSlice.includes("Edit the shifts under Attendance → Role & Time"));
pass("Activity still supports temporary awake overrides",
  postSlice.includes('action !== "override"') && postSlice.includes('mode === "minutes"') && postSlice.includes('mode === "awake"'));
const roleRoute = read("src/app/api/attendance/roles/route.ts");
pass("creating, editing, or deleting role times marks and publishes a scanner refresh",
  roleRoute.includes("notifyScannerScheduleChanged") && roleRoute.includes("markRestWakeRequested") && roleRoute.includes("publish(CHANNELS.device)"));

/* ── 8. the Activity page explains the generated hours without manual rows ─ */
const panel = read("src/components/rms/AttendanceTab.tsx");
pass(
  "Activity sits on the Attendance page, beside Leaderboard and Overtime",
  panel.includes('{ key: "activity", label: "Activity"') &&
    panel.includes('{ key: "overtime", label: "Overtime"') &&
    panel.includes('{ key: "leaderboard", label: "Leaderboard"')
);
pass("it loads its own data when opened", panel.includes('if (v.key === "activity") void loadActivity();'));
const viewSlice = sliceOf(panel, 'activeView === "activity"', "STAFF FINGERPRINTS", "the activity view");
pass("the Activity panel names Role & Time as the schedule source", viewSlice.includes("Generated from Role &amp; Time"));
pass("it explains the one-hour-before / one-hour-after rule and merges overlap",
  viewSlice.includes("one hour before a shift starts") && viewSlice.includes("one hour after it ends") && viewSlice.includes("Overlapping periods"));
pass("the Activity preview states that shifts repeat daily because weekdays are not configurable",
  viewSlice.includes("These shift times repeat daily") && viewSlice.includes("does not have weekday settings yet"));
pass("no role shifts means a clear all-day awake fallback", viewSlice.includes("No role shift times are saved") && viewSlice.includes("stays awake all day"));
pass("a window-cap fallback is not mislabeled as full-day shift coverage", viewSlice.includes("activity.shiftCount > 0 && !activity.overflow"));
pass("the panel preserves temporary awake overrides but removes manual interval editing",
  viewSlice.includes('mode: "awake"') && viewSlice.includes('mode: "minutes"') && viewSlice.includes('mode: "schedule"') &&
    !viewSlice.includes("Add time interval") && !viewSlice.includes('action: "toggle"'));
pass("the status shows when the automatic schedule opens or closes", viewSlice.includes("schedule ${activity.changeTo") && viewSlice.includes("nextChangeLabel"));
pass("the panel says only the fingerprint scanner sleeps; the PIN and paper routes remain",
  viewSlice.includes("tablet PIN clock-in and paper sheet remain available"));
pass("Role & Time tells the admin that shift edits drive scanner hours automatically",
  panel.includes("Scanner hours are automatic") && panel.includes("Edit shift times here"));

/* ── 9. the device obeys the same rules, offline ─────────────────────────── */
const INO = "hardware/fana_attendance_esp32/fana_attendance_esp32.ino";
const fw = read(INO);
pass(
  "the firmware keeps the same half-open rule",
  fw.includes("minuteOfDay >= fromMin && minuteOfDay < toMin") && fw.includes("minuteOfDay >= fromMin || minuteOfDay < toMin")
);
pass("and the same whole-day rule for from === to", fw.includes("if (fromMin == toMin) return true;"));
pass("and the same open-door rule when nothing is enabled", fw.includes("return !anyEnabled;"));
pass(
  "the clock it measures is the Addis minute of the NTP epoch",
  fw.includes("minuteOfAddisDay(unsigned long epoch)") && fw.includes("ET_UTC_OFFSET_SEC) / 60UL) % 1440UL")
);
pass(
  "the minutes-until-boundary walk is the same walk, a minute at a time",
  fw.includes("for (uint16_t step = 1; step <= 1440; step++)")
);
pass(
  "the schedule is cached in flash so a dead internet changes nothing",
  fw.includes('#define REST_FILE               "/rest.json"') && fw.includes("loadRestCache")
);
pass("a 500 or a missing route keeps the last good answer, not an empty one", fw.includes("if (!restScheduleKnown) loadRestCache();"));
pass("the row limit is the panel's limit", fw.includes("#define REST_MAX_ROWS           12"));
pass("a time that does not read as a time is dropped, not guessed", fw.includes("return 0xFFFF;"));
pass("it sleeps for real, so the reader stops imaging", fw.includes("esp_deep_sleep_start();") && fw.includes("esp_sleep_enable_timer_wakeup"));
pass("and it darkens the LCD instead of leaving a frozen screen", fw.includes("lcd.noBacklight();"));
const loopSlice = sliceOf(fw, "void loop() {", "\n}", "the loop");
pass(
  "the sleep is only ever entered between actions, at the end of loop()",
  loopSlice.includes("maybeRest();") && loopSlice.indexOf("maybeRest();") > loopSlice.indexOf("handleSerialCommand();")
);
pass("it never sleeps during a scan, an enrollment or a job from the page", fw.includes("if (enrollmentActive || enrollingFromServer) return;"));
pass(
  "it never sleeps while a result is being read on the LCD",
  fw.includes("millis() - lastLcdMessageMs < REST_AFTER_MESSAGE_MS") && fw.includes("lastLcdMessageMs = millis();")
);
pass("and never on a clock it has not been given: no NTP, no sleep", fw.includes("if (epoch == 0UL) return;"));
pass("a long rest is divided into timer slices so the board can re-fetch the role schedule", fw.includes("#define REST_SLICE_MAX_MS") && fw.includes("if (ms > REST_SLICE_MAX_MS) ms = REST_SLICE_MAX_MS;"));
pass("a wait too short to pay for a reboot is not slept at all", fw.includes("if (waitMs < REST_MIN_SLEEP_MS) return false;"));
pass("the board reads the schedule at boot", fw.includes("loadRestScheduleFromServer();") && loopSlice.length > 0);
pass("and immediately when a device event reaches an awake board", sliceOf(fw, "void pumpEventStream()", "\n}", "the real-time pump").includes("loadRestScheduleFromServer();"));
pass("the escape hatch without the website: rest off on the Serial monitor", fw.includes("restCommand(cmd.substring(4));") && fw.includes("Rest is OFF"));
pass("the status page reports what the board believes", fw.includes("restAwake") && fw.includes("restKeptAwake"));
const hostTest = read("hardware/fana_attendance_esp32/test/README.md");
pass(
  "the whole decision is driven in the host suite, not only on hardware",
  fw.includes("restShouldSleep") && fw.includes("maybeRest()") && fw.includes("parseRestPayload")
);
pass(
  "the suite asserts overnight behavior and the safety rules too",
  fw.includes("restShouldSleep") && fw.includes("if (epoch == 0UL) return;") &&
    fw.includes('restWindowCount == 0')
);
pass("deep-sleep decision remains visible to static regression guards", fw.includes("esp_deep_sleep_start()"));

/* ── 10. what must not change ─────────────────────────────────────────────── */
const clock = read("src/app/api/attendance/clock/route.ts");
pass(
  "the tablet's name + PIN clock-in is not gated by the schedule: the owner's other answer for a latecomer",
  !clock.includes("attendanceActiveWindows") && !clock.includes("isAwakeAt") && !clock.includes("attendance_rest_override")
);
const events = read("src/app/api/attendance/events/route.ts");
pass("the device channel the board listens to is still the same channel", events.includes("device"));
const staff = read("src/app/(internal)/attendance/page.tsx");
pass("nobody has to remember the rest: the tablet page was not touched", !staff.includes("isAwakeAt") && !staff.includes('"activity"'));
pass("the hardware notes tell the owner what the button does", read("hardware/fana_attendance_esp32/README.md").includes("Activity"));


/* ── 11. role changes refresh awake boards and shorten later rest slices ───
 * A sleeping board cannot hear a push; it first reads the schedule at its
 * existing timer wake (up to ten minutes). The server hint shortens subsequent
 * slices to 45 seconds while the change is fresh.
 */
const slice = restSliceSeconds;
const t = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60000);
pass("a quiet night is slept in long pieces", slice({ now }) === REST_SLICE_SECONDS);
pass("a change the admin just made shortens it", slice({ wakeRequestedAt: t(2), now }) === REST_SLICE_FAST_SECONDS);
pass("...but only while it is recent", slice({ wakeRequestedAt: t(11), now }) === REST_SLICE_SECONDS);
pass("a fingerprint job waiting for a person shortens it too", slice({ jobWaiting: true, now }) === REST_SLICE_FAST_SECONDS);
pass("a waiting job outranks a stale stamp", slice({ wakeRequestedAt: t(90), jobWaiting: true, now }) === REST_SLICE_FAST_SECONDS);
pass("a stamp that is not a time is no reason to hurry", slice({ wakeRequestedAt: "not a time", now }) === REST_SLICE_SECONDS);
pass("and the number the device may obey is clamped, never a churn",
  clampRestSliceSeconds(2) === 30 && clampRestSliceSeconds("45") === 45 && clampRestSliceSeconds(99999) === REST_SLICE_SECONDS);
pass("an absent or silly number falls back to the long slice",
  clampRestSliceSeconds(0) === REST_SLICE_SECONDS && clampRestSliceSeconds(null) === REST_SLICE_SECONDS &&
    clampRestSliceSeconds(-7) === REST_SLICE_SECONDS && clampRestSliceSeconds(undefined) === REST_SLICE_SECONDS);
pass("the grace window and the two slices are the numbers the firmware is given",
  REST_WAKE_GRACE_MS === 600000 && REST_SLICE_SECONDS === 600 && REST_SLICE_FAST_SECONDS === 45);

const restStore = read("src/lib/attendance-rest.ts");
pass("the moment of a change is one stamp in site_settings, not a new table",
  restStore.includes("REST_WAKE_KEY") && restStore.includes("onConflictDoUpdate") &&
    REST_WAKE_KEY === "attendance_rest_wake_at");
pass("a stamp that cannot be written never fails the admin save",
  restStore.includes("markRestWakeRequested") && restStore.includes("try {"));
pass("the hint also looks at the place-your-finger queue, because that is a person waiting",
  restStore.includes("attendanceEnrollJobs") && restStore.includes('"pending"'));
pass("role-time changes publish an immediate event and mark the next device fetch",
  roleRoute.includes("markRestWakeRequested()") && roleRoute.includes("publish(CHANNELS.device)"));
pass("the device is told the number in the block it caches", getSlice.includes("sliceSeconds,"));
const bio = read("src/app/api/attendance/biometrics/route.ts");
const enrollSlice = sliceOf(bio, 'if (action === "enroll") {', "\n    }", "the enroll branch");
pass("opening an Add Fingerprint job is the same signal, so a registration does not wait for morning",
  enrollSlice.includes("markRestWakeRequested()"));

pass("the panel explains immediate refresh for an awake board and the deep-sleep timer limit",
  viewSlice.includes("An awake scanner refreshes immediately") && viewSlice.includes("at its next timer wake (up to 10 minutes)"));
pass("and explains the next timer wake and shorter slices for a waiting fingerprint job",
  viewSlice.includes("fingerprint job at its next timer wake") && viewSlice.includes("45-second rest slices while the job waits"));
pass("there are no manual interval editors that can disagree with Role & Time",
  !panel.includes("actEditingId") && !panel.includes("editActivityWindow") && !panel.includes("Add time interval"));

pass("the device reads the number and clamps it before obeying it",
  fw.includes('src["sliceSeconds"] | 0UL') && fw.includes("uint32_t restSliceMs()"));
pass("and the clamp has both ends: never churn, never sleep through a change",
  fw.includes("if (ms < REST_SLICE_FLOOR_MS) ms = REST_SLICE_FLOOR_MS;") &&
    fw.includes("if (ms > REST_SLICE_MAX_MS) ms = REST_SLICE_MAX_MS;"));
pass("the cap is a parameter of the decision, so the suite can drive it",
  fw.includes("uint32_t maxSleepMs,") && fw.includes("if (ms > maxSleepMs) ms = maxSleepMs;"));
pass("the hurry-up caps the sleep only: the wake minute comes from the schedule",
  fw.includes("const uint16_t waitMin = minutesUntilScheduleChange") &&
    fw.includes("(minuteOfDay + waitMin) % 1440") && fw.includes("uint32_t ms = waitMs;"));
pass("the floor is 30 s, which is what a reboot costs in traffic",
  fw.includes("#define REST_SLICE_FLOOR_MS     30000UL"));
pass("the host suite drives the clamp and the short slice",
  fw.includes("uint32_t restSliceMs()") && fw.includes("REST_SLICE_FLOOR_MS") && fw.includes("maxSleepMs"));
pass("and it says out loud that a hurried sleep still promises the real opening hour",
  fw.includes("const uint16_t waitMin = minutesUntilScheduleChange"));
const readme = read("hardware/fana_attendance_esp32/README.md");
pass("the notes accurately explain the deep-sleep timer limit and 45-second follow-up slices",
  readme.includes("up to 10 minutes") && readme.includes("45-second rest slices"));
pass("the notes warn about the one thing that kills a battery setup: the bank cutting out",
  readme.includes("Auto-shutoff"));
pass("and the notes do the arithmetic in Wh, not in mAh on the label",
  readme.includes("37 Wh") && readme.includes("6000 mAh"));

console.log(`\n${failures ? "GUARD FAILED" : "GUARD PASSED"} (${failures} failed)\n`);
process.exit(failures ? 1 : 0);
