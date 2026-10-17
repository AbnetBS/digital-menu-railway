#!/usr/bin/env tsx
/**
 * Regression guard: ACTIVITY / REST WINDOWS (owner, Oct 2026).
 *
 * The ask, in his words: "on attendance page add a button Activity. inside it
 * Add time interval ... the intervals arent same so i may add many intervals.
 * in the closed time the system wont answer or stop completely ... this will
 * protect the system for over using power and less the being damaged by
 * continues power supply", and each interval gets "on/off button".
 *
 * What that means in code, checked here:
 *
 *   1. An interval is the AWAKE window, not the closed one. The owner types the
 *      hours his door is open; outside all of them the board sleeps. He named
 *      12:00-03:00 as his example: at 03:05 a person cannot scan.
 *   2. Times are clock times that repeat every day (like a shift), never dates.
 *      An interval whose end is before its start runs across midnight.
 *   3. Half-open: 12:00-15:00 is awake at 14:59 and resting at 15:00.
 *   4. from === to is the whole day, never nothing. A mistyped pair must not be
 *      able to close a door.
 *   5. No intervals, or no ENABLED interval, means awake all day. The on/off
 *      switch on a row is the owner's escape hatch when somebody is standing at
 *      a closed door: switch the row off, the board wakes, switch it back.
 *   6. The admin can also keep the device awake outright (forever, or for the
 *      minutes he types) without touching the intervals themselves.
 *   7. Resting is the device's own decision, from a schedule it caches: the
 *      website being down at 03:00 changes nothing. The same arithmetic is
 *      written twice, here and in the firmware, and it has to agree minute for
 *      minute - so the same cases are asserted on both sides.
 *   8. The tablet at /attendance (name + PIN) keeps working through a rest
 *      period: the owner's other answer for a latecomer. Only the fingerprint
 *      board sleeps.
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
  clampRestSliceSeconds,
  clockLabelOfMinute,
  enabledWindows,
  isAwakeAt,
  minuteOfDayET,
  minutesUntilChange,
  parseRestOverride,
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

console.log("\n=== Activity: the hours the scanner is awake ===\n");

/* ── 1. the window itself ─────────────────────────────────────────────────── */
pass(
  "an interval is the AWAKE window: 12:00-15:00 is awake at 12:00",
  windowContainsMinute(win("12:00", "15:00"), hhmm(12, 0))
);
pass(
  "14:59 is its last awake minute, and 15:00 is already resting (half-open)",
  windowContainsMinute(win("12:00", "15:00"), hhmm(14, 59)) && !windowContainsMinute(win("12:00", "15:00"), hhmm(15, 0))
);
pass(
  "before it opens the board rests: 11:59 in a 12:00-15:00 day",
  !windowContainsMinute(win("12:00", "15:00"), hhmm(11, 59))
);
// The owner's own example, in his words: "12:00-3:00", and somebody at 3:05.
pass(
  "the owner's example: 12:00-03:00 is awake at 12:01 and at 02:59",
  windowContainsMinute(win("12:00", "03:00"), hhmm(12, 1)) && windowContainsMinute(win("12:00", "03:00"), hhmm(2, 59))
);
pass(
  "...and a person at 03:05 cannot scan (his words: the system wont answer)",
  !windowContainsMinute(win("12:00", "03:00"), hhmm(3, 5)) && !windowContainsMinute(win("12:00", "03:00"), hhmm(9, 0))
);
pass(
  "from === to means the whole day, so a mistyped pair cannot close a door",
  windowContainsMinute(win("06:00", "06:00"), hhmm(0, 0)) && windowContainsMinute(win("06:00", "06:00"), hhmm(23, 59))
);
pass(
  "a row whose times are not times counts for nothing",
  !windowContainsMinute(win("", ""), hhmm(10, 0)) && !windowContainsMinute(win("9:00", "25:00"), hhmm(10, 0))
);

/* ── 2. many intervals, each with its own switch ──────────────────────────── */
const dayShift = [win("06:00", "10:00"), win("12:00", "15:00"), win("18:00", "22:00")];
pass(
  "with several intervals the board is awake in any of them",
  isAwakeAt(dayShift, hhmm(13, 0)) && isAwakeAt(dayShift, hhmm(6, 30))
);
pass("...and resting in the gaps between them", !isAwakeAt(dayShift, hhmm(10, 30)) && !isAwakeAt(dayShift, hhmm(23, 30)));
pass(
  "a switched-off interval stops opening the door",
  !isAwakeAt([win("06:00", "22:00", false), win("12:00", "13:00")], hhmm(20, 0))
);
pass("only the enabled rows are counted", enabledWindows([win("01:00", "02:00"), win("03:00", "04:00", false)]).length === 1);

/* ── 3. an empty schedule is OPEN, never shut ─────────────────────────────── */
pass("no intervals at all means awake all day (a new panel cannot lock the owner out)", isAwakeAt([], hhmm(3, 0)));
pass("and a panel whose every row is switched off also means awake", isAwakeAt([win("00:00", "23:59", false)], hhmm(3, 0)));
pass("an absent list is treated the same way", isAwakeAt(null, hhmm(3, 0)) && isAwakeAt(undefined, hhmm(3, 0)));

/* ── 4. the wait, which is what the board sleeps for ──────────────────────── */
pass("45 awake minutes before closing: the panel can say so", minutesUntilChange([win("06:00", "10:00")], hhmm(9, 15)) === 45);
pass("resting at 15:00, tomorrow's 06:00 is 900 minutes away", minutesUntilChange([win("06:00", "10:00")], hhmm(15, 0)) === 900);
pass("an all-day schedule never changes", minutesUntilChange([win("06:00", "06:00")], hhmm(4, 0)) === 1440);
pass("an empty schedule never changes either", minutesUntilChange([], hhmm(4, 0)) === 1440);
pass(
  "the boundary of a row that wraps midnight is measured, not guessed",
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

/* ── 6. the table, created by the app's own migration ─────────────────────── */
const schema = read("src/db/schema.ts");
const schemaSlice = sliceOf(schema, "export const attendanceActiveWindows = pgTable(", "\n});", "the schedule table");
pass(
  "one row per interval, with its own on/off switch and an order",
  schemaSlice.includes('pgTable("attendance_active_windows"') &&
    schemaSlice.includes("fromTime") &&
    schemaSlice.includes("toTime") &&
    schemaSlice.includes("enabled") &&
    schemaSlice.includes("sortOrder")
);
const migrate = read("src/db/migrate.ts");
pass("the app creates it on boot, like the other attendance tables", migrate.includes("attendance_active_windows"));
pass(
  "a row keeps its label and its times as text the device can read without a parser",
  schemaSlice.includes("label") && schemaSlice.includes("updatedAt")
);

/* ── 7. the API: the page writes it, the device reads it ──────────────────── */
const routePath = "src/app/api/attendance/activity/route.ts";
pass("the endpoint exists", existsSync(path.join(ROOT, routePath)));
const route = read(routePath);
const getSlice = sliceOf(route, "export async function GET(", "export async function POST(", "the GET handler");
const postSlice = sliceOf(route, "export async function POST(", "\n}\n", "the POST handler");
pass("a device may read the schedule with its own token, no admin session", getSlice.includes("deviceAllowed(request)"));
pass("a device may not write it: the POST is admin only", !postSlice.includes("deviceAllowed"));
pass("the answer carries both views: the panel's and the device's", getSlice.includes("device:") && getSlice.includes("nextChangeLabel"));
pass("the device view is numbers-only, because the ESP32 has no date parser", getSlice.includes("wakeUntilEpoch") && getSlice.includes("keptAwake"));
pass("it also says what the board would do right now", getSlice.includes("awakeNow") && getSlice.includes("changeInMinutes"));
pass("every change is pushed to the awake devices at once", route.includes("publish(") && route.includes("CHANNELS.device"));
pass("the five edits the panel makes are the only ones", ["add", "update", "toggle", "remove", "override"].every((a) => route.includes(`"${a}"`)));
pass("the cap is enforced in the route, not only in the form", route.includes("REST_MAX_WINDOWS"));
pass(
  "the override modes the library understands are the ones the route writes",
  route.includes('"awake"') && route.includes("awake_until=") && route.includes("writeOverride")
);
pass("a toggle flips the row and rewrites nothing else", postSlice.includes('"toggle"') && postSlice.includes("enabled"));
pass("an interval is added with its name, trimmed to what the column holds", postSlice.includes('"add"') && postSlice.includes("slice(0, 40)"));
pass("the same pair of times twice is refused instead of doubling the row", postSlice.includes("is already listed"));
pass("and the panel's cap is the answer, in words the owner can act on", postSlice.includes("Remove one first"));
pass("a half-typed interval is refused, not stored", postSlice.includes("Both times are needed"));
pass("changing and deleting a row that is gone says so instead of pretending", postSlice.includes("That interval is gone already"));

/* ── 8. the admin panel: the button, the form, the switches ───────────────── */
const panel = read("src/components/rms/AttendanceTab.tsx");
pass(
  "Activity sits on the Attendance page, beside Leaderboard and Overtime",
  panel.includes('{ key: "activity", label: "Activity"') &&
    panel.includes('{ key: "overtime", label: "Overtime"') &&
    panel.includes('{ key: "leaderboard", label: "Leaderboard"')
);
pass(
  "it loads its own data when it is opened, without polling the server",
  panel.includes('if (v.key === "activity") void loadActivity();') && !panel.includes("setInterval(loadActivity")
);
pass("the panel offers Add time interval, in his words", panel.includes("Add time interval"));
pass("a new interval is picked with two clock inputs and a name", panel.includes("actFrom") && panel.includes("actTo") && panel.includes("actLabel"));
pass("every row carries its own on/off button", panel.includes('postActivity({ action: "toggle", id: w.id })'));
pass("a row can be deleted as well as switched", panel.includes('postActivity({ action: "remove", id: w.id })'));
const viewSlice = sliceOf(panel, 'activeView === "activity"', "STAFF FINGERPRINTS", "the activity view");
pass(
  "the panel shows the schedule's own verdict, not a guess",
  viewSlice.includes("awakeNow") && viewSlice.includes("changeInMinutes") && viewSlice.includes("nextChangeLabel")
);
pass(
  "the panel says what resting means at the door, so it is not mistaken for a breakdown",
  viewSlice.includes("dark screen, no scan") &&
    viewSlice.includes("The name + PIN keypad on the tablet") &&
    viewSlice.includes("working the whole time")
);
pass(
  "a switched-off row says the scanner stays awake, not that the door is shut",
  viewSlice.includes('w.enabled ? "on" : "off, scanner awake outside its hours too"')
);
pass(
  "the three buttons the admin has are the three the route writes",
  viewSlice.includes('mode: "awake"') && viewSlice.includes('mode: "minutes"') && viewSlice.includes('mode: "schedule"')
);
pass("the form's own rule about midnight is on the page, in words", viewSlice.includes("runs across midnight, like 22:00 to 06:00"));
pass("the escape hatch for a locked-out person is next to the intervals", viewSlice.includes("actWakeMinutes"));
pass("the interval list says plainly what an empty panel means", panel.includes("so the scanner stays awake all day and rests never"));
pass("the cap the page was given is the cap in the library", panel.includes("maxWindows"));

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
pass("a sleep is sliced, so an admin switch is obeyed without hardware", fw.includes("#define REST_SLICE_MAX_MS") && fw.includes("if (ms > REST_SLICE_MAX_MS) ms = REST_SLICE_MAX_MS;"));
pass("a wait too short to pay for a reboot is not slept at all", fw.includes("if (waitMs < REST_MIN_SLEEP_MS) return false;"));
pass("the board reads the schedule at boot", fw.includes("loadRestScheduleFromServer();") && loopSlice.length > 0);
pass("and again the moment an admin changes it", sliceOf(fw, "void pumpEventStream()", "\n}", "the real-time pump").includes("loadRestScheduleFromServer();"));
pass("the escape hatch without the website: rest off on the Serial monitor", fw.includes("restCommand(cmd.substring(4));") && fw.includes("Rest is OFF"));
pass("the status page reports what the board believes", fw.includes("restAwake") && fw.includes("restKeptAwake"));
const hostTest = read("hardware/fana_attendance_esp32/test/enroll_host_test.cpp");
pass(
  "the whole decision is driven in the host suite, not only on hardware",
  hostTest.includes("restShouldSleep") && hostTest.includes("maybeRest()") && hostTest.includes("parseRestPayload")
);
pass(
  "the suite asserts the owner's example and the safety rules too",
  hostTest.includes("3:05 example") &&
    hostTest.includes("cannot lock his own door") &&
    hostTest.includes("with no clock it stays awake") &&
    hostTest.includes("switching his only interval off wakes the board")
);
pass("and the sleep is stubbed so a test can read the decision", existsSync(path.join(ROOT, "hardware/fana_attendance_esp32/test/stub/esp_sleep.h")));

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


/* ── 11. a change at the panel reaches the door in about a minute ─────────
 * The owner's follow-up (2026-10-17): "i want the system to start working if he
 * changes the time for that particular person to register" and "i want the
 * intervals to be workable". A sleeping board cannot hear a push, so the way to
 * be instant without new hardware is to make the board itself look again soon:
 * the website leaves a stamp, the stamp shortens the next sleep to about 45 s,
 * and the intervals can be edited in place instead of deleted and retyped.
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
pass("every edit of the hours marks it, before any branch can return early",
  getSlice.includes("readRestWakeHint") && route.includes("markRestWakeRequested()") &&
    route.indexOf("markRestWakeRequested()") < route.indexOf('action === "add"'));
pass("the device is told the number in the block it caches", getSlice.includes("sliceSeconds,"));
const bio = read("src/app/api/attendance/biometrics/route.ts");
const enrollSlice = sliceOf(bio, 'if (action === "enroll") {', "\n    }", "the enroll branch");
pass("opening an Add Fingerprint job is the same signal, so a registration does not wait for morning",
  enrollSlice.includes("markRestWakeRequested()"));

pass("the panel says how soon the device will hear it, instead of leaving the admin to guess",
  viewSlice.includes("checking these hours every") && viewSlice.includes("starts answering within about a minute"));
pass("and it says so differently while a finger job is waiting", viewSlice.includes("fingerprint registration is waiting"));
pass("the intervals are editable in place, which is what workable means here",
  panel.includes("actEditingId") && panel.includes("editActivityWindow") && panel.includes('"Save changes"'));
pass("the form doubles as the editor and can be backed out of",
  panel.includes('"Cancel"') && panel.includes("setActEditingId(null)"));
pass("each row carries the pencil beside its switch", panel.includes("<Pencil"));
pass("the edit goes through the same route the add uses",
  panel.includes('action: "update"') && postSlice.includes('"update"'));

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
  hostTest.includes("restSliceMs() == 45000UL") && hostTest.includes("never under the floor") &&
    hostTest.includes("a cap under the wait is obeyed"));
pass("and it says out loud that a hurried sleep still promises the real opening hour",
  hostTest.includes("the real opening hour is still what the board promises"));
const readme = read("hardware/fana_attendance_esp32/README.md");
pass("the notes promise about a minute, not ten", readme.includes("45 seconds while"));
pass("the notes warn about the one thing that kills a battery setup: the bank cutting out",
  readme.includes("Auto-shutoff"));
pass("and the notes do the arithmetic in Wh, not in mAh on the label",
  readme.includes("37 Wh") && readme.includes("6000 mAh"));

console.log(`\n${failures ? "GUARD FAILED" : "GUARD PASSED"} (${failures} failed)\n`);
process.exit(failures ? 1 : 0);
