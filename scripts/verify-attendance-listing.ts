#!/usr/bin/env tsx
/**
 * Regression guard: the ATTENDANCE listing of Oct 2026.
 *
 * The owner's requests, one by one:
 *
 *   1. The attendance people are their OWN list (Attendance -> Staff Members).
 *      A cleaner, a washer or a chef clocks in with a finger and never logs in
 *      to a station, so he must not need a row in staff_users to be on the
 *      sheet.
 *   2. Role & Time owns the hours: every role has its periods (Morning
 *      entrance/out, Afternoon entrance/out, and any extra one), and the
 *      Shifts tab is gone.
 *   3. LATE = 15 minutes after the entrance time of the role. Morning 12:30 ->
 *      12:45 is on time, 12:46 is late.
 *   4. A second scan inside ONE HOUR of the IN only says "already registered";
 *      after the hour the next scan is the OUT.
 *   5. The paper sheet prints at most 7 days, takes its names from the
 *      attendance list, and colours every box: red absent, yellow late, green
 *      on time, plus its own colours for early out and overtime.
 *   6. Add Fingerprint opens a pending job the ESP32 picks up (?pending), and
 *      the page prints "Fingerprint Added ✓" when the device posts the mapping.
 *   7. The kiosk is clean: no big clock, no device chatter, no demo buttons, no
 *      wall of absent names. Name dropdown + PIN keypad on the left third, the
 *      live sheet on the right, and an Overtime button.
 *
 * The rules are imported from the real module (src/lib/attendance.ts), so a
 * change to the numbers or the colours fails here, not in the cafe.
 *
 * No network, no database. Run with: npx tsx scripts/verify-attendance-listing.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { getTableColumns } from "drizzle-orm";

import {
  attendanceBiometrics,
  attendanceEnrollJobs,
  attendanceLogs,
  attendanceMembers,
  attendanceRoleShifts,
  attendanceRoles,
} from "../src/db/schema";

import {
  LATE_GRACE_MINUTES,
  REPEAT_SCAN_LOCK_MINUTES,
  SHEET_MAX_DAYS,
  addDays,
  clockLabel,
  daysBetween,
  hoursLabel,
  inStatusOf,
  isEarlyOut,
  isAttendanceExpectedOnDate,
  lateMinutesFor,
  outStatusOf,
  parseHHMM,
  pickShift,
  rescanAction,
  sheetDates,
  toHHMM,
  scanTimeFrom,
  MAX_OFFLINE_SCAN_AGE_MS,
} from "../src/lib/attendance";

let failures = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
  if (!cond) failures++;
};

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const schema = read("src/db/schema.ts");
const migrate = read("src/db/migrate.ts");
const rolesApi = read("src/app/api/attendance/roles/route.ts");
const membersApi = read("src/app/api/attendance/members/route.ts");
const biometricsApi = read("src/app/api/attendance/biometrics/route.ts");
const mappingsApi = read("src/app/api/attendance/mappings/route.ts");
const clockApi = read("src/app/api/attendance/clock/route.ts");
const overtimeApi = read("src/app/api/attendance/overtime/route.ts");
const todayApi = read("src/app/api/attendance/today/route.ts");
const logsApi = read("src/app/api/attendance/logs/route.ts");
const adminTab = read("src/components/rms/AttendanceTab.tsx");
const kiosk = read("src/app/(internal)/attendance/page.tsx");
const firmware = read("hardware/fana_attendance_esp32/fana_attendance_esp32.ino");
const attendanceLib = read("src/lib/attendance.ts");

/* ── 1. the rules themselves (imported, not re-implemented) ──────────────── */

pass("late is decided 15 minutes after the entrance time", LATE_GRACE_MINUTES === 15);
pass("a repeated scan is only \"already registered\" for one hour", REPEAT_SCAN_LOCK_MINUTES === 60);
pass("a sheet is at most 7 days", SHEET_MAX_DAYS === 7);

const morning = { label: "Morning", startTime: "12:30", endTime: "18:00" };
const afternoon = { label: "Afternoon", startTime: "18:00", endTime: "23:00" };
const shifts = [morning, afternoon];

pass('"12:30" is 750 minutes and back again', parseHHMM("12:30") === 750 && toHHMM(750) === "12:30");
pass("a nonsense time is refused, not stored as midnight", parseHHMM("25:99") === null && parseHHMM("") === null);
pass("a scan at 12:45 belongs to the Morning shift", pickShift(shifts, parseHHMM("12:45")!) === morning);
pass("a scan at 19:10 belongs to the Afternoon shift", pickShift(shifts, parseHHMM("19:10")!) === afternoon);
pass("a scan before every start belongs to the earliest one", pickShift(shifts, parseHHMM("06:00")!) === morning);
pass("a role with no times is never late", lateMinutesFor(null, 900) === 0);

pass(
  "Morning 12:30 -> arriving 12:45 is ON TIME (the owner's own example)",
  lateMinutesFor(pickShift(shifts, parseHHMM("12:45")!), parseHHMM("12:45")!) === 0
);
pass(
  "Morning 12:30 -> arriving 12:46 is 1 minute late",
  lateMinutesFor(pickShift(shifts, parseHHMM("12:46")!), parseHHMM("12:46")!) === 1
);
pass(
  "Morning 12:30 -> arriving 13:30 is 45 minutes late",
  lateMinutesFor(pickShift(shifts, parseHHMM("13:30")!), parseHHMM("13:30")!) === 45
);

pass("leaving before the time out is an early out", isEarlyOut(morning, parseHHMM("16:00")!) === true);
pass("leaving at the time out or after is not", isEarlyOut(morning, parseHHMM("18:00")!) === false);

// A cafe night period ends after midnight, and the paper sheet must not call
// everybody who went home at 23:00 punctual (found by the end-to-end run).
const night = { label: "Night", startTime: "22:00", endTime: "02:00" };
pass("a night period 22:00 -> 02:00: leaving at 23:00 is an early out", isEarlyOut(night, parseHHMM("23:00")!) === true);
pass("leaving at 01:00 is still an early out", isEarlyOut(night, parseHHMM("01:00")!) === true);
pass("leaving at 03:00, after the time out, is not", isEarlyOut(night, parseHHMM("03:00")!) === false);

pass("total hours read as 3h 05m", hoursLabel(185) === "3h 05m" && hoursLabel(null) === null);
pass(
  "a clock time is printed on the Ethiopian wall clock, not the server's",
  clockLabel(new Date("2026-10-08T05:05:00Z")) === "08:05",
  String(clockLabel(new Date("2026-10-08T05:05:00Z")))
);

/* ── 2. the paper sheet window ───────────────────────────────────────────── */

pass("3 days asked for are 3 columns", sheetDates("2026-10-06", "2026-10-08").length === 3);
pass("7 days asked for are 7 columns", sheetDates("2026-10-02", "2026-10-08").length === 7);
pass(
  "a month asked for is cut back to 7 columns, oldest first",
  sheetDates("2026-09-01", "2026-09-30").join(",") ===
    ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"].join(",")
);
pass("a reversed range is turned the right way up", sheetDates("2026-10-08", "2026-10-06").length === 3);
pass("crossing a month end still steps one day at a time", addDays("2026-10-31", 1) === "2026-11-01");
pass("the days between two keys are counted", daysBetween("2026-10-01", "2026-10-08") === 7);
pass(
  "a member registered today is not marked absent on the three earlier sheet dates",
  !isAttendanceExpectedOnDate("2026-10-06", "2026-10-09", "2026-10-09")
);
pass(
  "the registration date itself and today are valid attendance dates",
  isAttendanceExpectedOnDate("2026-10-09", "2026-10-09", "2026-10-09") &&
    isAttendanceExpectedOnDate("2026-10-09", "2026-10-06", "2026-10-09")
);
pass(
  "future sheet dates are blank instead of absent",
  !isAttendanceExpectedOnDate("2026-10-10", "2026-10-06", "2026-10-09")
);
pass(
  "invalid or missing registration dates do not create false absences",
  !isAttendanceExpectedOnDate("2026-10-09", null, "2026-10-09") &&
    !isAttendanceExpectedOnDate("2026-10-09", "2026-02-30", "2026-10-09")
);

/* ── 3. the colour of a box ──────────────────────────────────────────────── */

pass("no line at all is ABSENT (red)", inStatusOf(null) === "absent");
pass("a line without an IN is still ABSENT", inStatusOf({ clockOut: new Date() }) === "absent");
pass("an IN with no lateness is ON TIME (green)", inStatusOf({ clockIn: new Date(), lateMinutes: 0 }) === "on_time");
pass("an IN 20 minutes late is LATE (yellow)", inStatusOf({ clockIn: new Date(), lateMinutes: 20 }) === "late");
pass("no IN means the OUT box is empty too", outStatusOf(null) === "none");
pass("inside and not out yet is STILL IN", outStatusOf({ clockIn: new Date() }) === "still_in");
pass("out at the end of the shift is COMPLETED", outStatusOf({ clockIn: new Date(), clockOut: new Date() }) === "completed");
pass(
  "an early out keeps its own colour",
  outStatusOf({ clockIn: new Date(), clockOut: new Date(), earlyOut: true }) === "early_out"
);
pass(
  "overtime wins over an early out (the person pressed the button himself)",
  outStatusOf({ clockIn: new Date(), clockOut: new Date(), earlyOut: true, isOvertime: true }) === "overtime"
);
pass("overtime before the OUT still shows", outStatusOf({ clockIn: new Date(), isOvertime: true }) === "still_in");

/* ── 4. the attendance list is its own list ──────────────────────────────── */

pass(
  "the schema stores the attendance roles, their periods, the members, their fingers and the enroll jobs",
  ["attendance_roles", "attendance_role_shifts", "attendance_members", "attendance_biometrics", "attendance_enroll_jobs"].every(
    (t) => schema.includes(`pgTable("${t}"`)
  )
);
pass(
  "the migration creates every one of those tables",
  ["attendance_roles", "attendance_role_shifts", "attendance_members", "attendance_biometrics", "attendance_enroll_jobs"].every(
    (t) => migrate.includes(`CREATE TABLE IF NOT EXISTS ${t}`)
  )
);
pass(
  "a log points at a member of the attendance list, and can carry overtime and an early out",
  schema.includes('memberId: integer("member_id")') &&
    schema.includes('isOvertime: boolean("is_overtime")') &&
    schema.includes('earlyOut: boolean("early_out")')
);
// The column block of attendance_logs, exactly as the migration lists it.
const logsColumns = /attendance_logs: \{([\s\S]*?)\n  \},/.exec(migrate)?.[1] ?? "";
pass(
  "the migration adds those columns to the existing attendance_logs table",
  ["member_id", "role_id", "is_overtime", "early_out"].every((c) => logsColumns.includes(c)),
  logsColumns.slice(0, 120)
);
pass(
  "the schema version was bumped so a deployed database migrates itself",
  (/SCHEMA_VERSION = "(\d{4}-\d{2}-\d{2}-\d+)"/.exec(migrate)?.[1] ?? "") >= "2026-10-08-1"
);

pass(
  "the members route never reads the station logins",
  !membersApi.includes("staffUsers") && membersApi.includes("attendanceMembers")
);
pass(
  "the door tablet gets names and roles only, never a PIN",
  membersApi.includes('pub === "1"') && !/pub === "1"[\s\S]{0,400}\bpin:/.test(membersApi)
);
pass("the backup PIN is stored hashed", membersApi.includes("hashSecret"));
pass("the admin list only says whether a PIN is set", membersApi.includes("pinSet: Boolean(m.pin)"));

pass(
  "a scan is resolved through the attendance fingerprints, not the staff ones",
  clockApi.includes("attendanceBiometrics") && !clockApi.includes("staffUsers") && clockApi.includes("attendanceMembers")
);
pass(
  "the today board lists the attendance people",
  todayApi.includes("attendanceMembers") && !todayApi.includes("staffUsers")
);
pass(
  "the paper sheet takes its rows from the attendance people",
  logsApi.includes("attendanceMembers") && !logsApi.includes("staffUsers") && logsApi.includes("sheetDates")
);
pass(
  "the paper-sheet API provides Ethiopian registration dates and today's date",
  logsApi.includes("registeredOn: etDayKey(m.createdAt)") && logsApi.includes("today,")
);
pass(
  "pre-registration and future sheet cells stay blank, while eligible no-shows remain absent",
  adminTab.includes("isAttendanceExpectedOnDate(d, s.registeredOn, sheetData.today)") &&
    adminTab.includes("? IN_STYLE.absent") &&
    adminTab.includes("? OUT_STYLE.none") &&
    adminTab.includes("Dates before registration and after today stay blank.")
);

/* ── 4b. the drizzle schema and the migration DDL agree ──────────────────── */

// The migration is what an already deployed database runs, and it is written by
// hand next to the schema. A column that exists in one and not in the other is
// exactly the "column does not exist" crash the header of migrate.ts warns
// about, so the guard compares the two column by column.
const ddlOf = (table: string): string =>
  new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n    \\)`).exec(migrate)?.[1] ?? "";
const alterBlockOf = (table: string): string =>
  new RegExp(`\\n  ${table}: \\{([\\s\\S]*?)\\n  \\},`).exec(migrate)?.[1] ?? "";

for (const [label, table, drizzleTable] of [
  ["attendance_roles", "attendance_roles", attendanceRoles],
  ["attendance_role_shifts", "attendance_role_shifts", attendanceRoleShifts],
  ["attendance_members", "attendance_members", attendanceMembers],
  ["attendance_biometrics", "attendance_biometrics", attendanceBiometrics],
  ["attendance_enroll_jobs", "attendance_enroll_jobs", attendanceEnrollJobs],
  ["attendance_logs", "attendance_logs", attendanceLogs],
] as const) {
  const columns = Object.values(getTableColumns(drizzleTable) as Record<string, { name: string }>).map((c) => c.name);
  const known = `${ddlOf(table)}\n${alterBlockOf(table)}`;
  const missing = columns.filter((c) => !new RegExp(`(^|[\\s(])${c}[\\s,:)]`).test(known));
  pass(
    `every column of ${label} exists in the migration too`,
    missing.length === 0,
    `missing: ${missing.join(", ") || "-"}`
  );
}

/* ── 5. Role & Time replaces the Shifts tab ──────────────────────────────── */

pass(
  "the roles route stores one period per row with an entrance and an exit time",
  rolesApi.includes("attendanceRoleShifts") && rolesApi.includes("startTime") && rolesApi.includes("endTime")
);
pass("a half-filled period is refused instead of stored", rolesApi.includes("parseHHMM(startTime) === null"));
pass("the Shifts tab is gone from the admin", !/key: "shifts"/.test(adminTab) && !adminTab.includes("api/attendance/shifts"));
pass(
  "the role form asks for the name, the shift, the time of entrance and the time out",
  ["Role Name", "Time of Entrance", "Time Out", "Add another shift"].every((t) => adminTab.includes(t))
);
pass("the role form starts with a Morning and an Afternoon period", adminTab.includes('"Morning"') && adminTab.includes('"Afternoon"'));
pass("late and early out are explained on the role form", adminTab.includes("15 minutes after the time of entrance"));

/* ── 6. the members form and the fingerprint flow ────────────────────────── */

pass(
  "the member form has a name, a role dropdown and a backup PIN",
  ["Add Member", "Backup PIN", "Select role", "Add Fingerprint"].every((t) => adminTab.includes(t))
);
pass(
  "Add Fingerprint asks the server for a pending enroll job",
  adminTab.includes('action: "enroll"') && biometricsApi.includes('action === "enroll"')
);
pass(
  "the server picks the next free fingerprint ID when the admin does not type one",
  biometricsApi.includes("nextFreeId")
);
pass(
  "the device asks who is waiting with ?pending (device token or admin)",
  biometricsApi.includes('pending !== "1" || !deviceAllowed(request)') && biometricsApi.includes("requireAdmin()")
);
pass("the pending answer carries the OLED lines for the device", biometricsApi.includes("Place finger"));
pass(
  "the admin page polls the job and prints Fingerprint Added ✓",
  adminTab.includes("biometrics?job=") && adminTab.includes("Fingerprint Added ✓")
);
pass(
  "the device reports the finger it stored to /mappings and that closes the job it worked on",
  mappingsApi.includes("export async function POST") &&
    mappingsApi.includes("attendanceEnrollJobs") &&
    mappingsApi.includes("body.jobId") &&
    mappingsApi.includes('inArray(attendanceEnrollJobs.status, ["pending", "failed"])')
);
pass(
  "a job the device could not finish becomes failed with its reason, and the admin sees it",
  biometricsApi.includes('action === "device_failed"') &&
    biometricsApi.includes('status: "failed"') &&
    biometricsApi.includes("failReason") &&
    adminTab.includes('job?.status === "failed"') &&
    adminTab.includes("Fingerprint not added")
);
pass(
  "the firmware listens in real time (SSE, fallback poll) and posts the mapping back with the job",
  firmware.includes("checkPendingJob()") &&
    firmware.includes("/api/attendance/biometrics?pending=1") &&
    firmware.includes('path = "/api/attendance/mappings"') &&
    firmware.includes('doc["jobId"] = r.jobId') &&
    firmware.includes('doc["action"] = "device_failed"') &&
    firmware.includes("/api/attendance/events?channel=device") &&
    firmware.includes("pumpEventStream()") &&
    firmware.includes("PENDING_POLL_FALLBACK_MS") &&
    biometricsApi.includes("publish(CHANNELS.device)")
);
pass(
  "firmware follows the six-capture sequence (1, 2, 2, 2, 2, 3) and shows Step x of 6",
  /static const uint8_t steps\[ENROLL_CAPTURES\] = \{1, 2, 2, 2, 2, 3\}/.test(firmware) &&
    firmware.includes("#define ENROLL_CAPTURES 6") &&
    firmware.includes("Step ")
);
pass(
  "enrollment reads the real status codes: 6 = ID occupied, 7 = finger saved elsewhere, 8 = no finger yet",
  firmware.includes("#define FP_ACK_ID_OCCUPIED   0x06") &&
    firmware.includes("#define FP_ACK_FINGER_EXISTS 0x07") &&
    firmware.includes("#define FP_ACK_TIMEOUT       0x08") &&
    firmware.includes("if (st == FP_ACK_TIMEOUT) { noReply = 0; continue; }") &&
    !firmware.includes("BIOVO_ACK_IMAGEMESS")
);
pass(
  "four wires only: no touch-sense pin, nothing waits for GPIO25",
  !firmware.includes("FINGER_TOUCH_PIN") && !firmware.includes("waitForFingerPlacement") && !firmware.includes("digitalRead(25")
);
pass(
  "the sensor's capture window is set, and the scan never posts or waits on the network",
  firmware.includes("#define FP_CMD_CAPTURE_WINDOW 0x2E") &&
    firmware.includes("configureCaptureWindow()") &&
    firmware.includes("xTaskCreatePinnedToCore(") &&
    firmware.includes("showVerified(")
);
pass(
  "manual Serial enrollment tells the owner how to map its stored ID",
  firmware.includes("Stored as ID ") &&
    firmware.includes("Map it: admin → Attendance → Staff Fingerprints")
);
{
  const serverNow = new Date("2026-10-10T07:00:00Z");
  const sec = (d: Date) => Math.floor(d.getTime() / 1000);
  const twoHoursAgo = new Date(serverNow.getTime() - 2 * 60 * 60 * 1000);
  pass("an offline scan 2 hours old keeps its own time", scanTimeFrom(sec(twoHoursAgo), serverNow).getTime() === twoHoursAgo.getTime());
  pass("no scannedAt means the server time", scanTimeFrom(undefined, serverNow) === serverNow);
  pass(
    "a scan older than the offline window falls back to the server time",
    scanTimeFrom(sec(serverNow) - MAX_OFFLINE_SCAN_AGE_MS / 1000 - 60, serverNow) === serverNow
  );
  pass("a device clock far in the future is ignored", scanTimeFrom(sec(serverNow) + 3600, serverNow) === serverNow);
  pass("a device clock a few seconds ahead is clamped to now", scanTimeFrom(sec(serverNow) + 30, serverNow) === serverNow);
  pass("garbage scannedAt is ignored", scanTimeFrom("abc", serverNow) === serverNow);
}
pass(
  "the clock takes the real scan time (offline scans are not marked late) and the device token",
  clockApi.includes("scanTimeFrom(scannedAt)") &&
    clockApi.includes("deviceAllowed(request)") &&
    attendanceLib.includes("MAX_OFFLINE_SCAN_AGE_MS")
);
pass(
  "the kiosk board refreshes in real time (EventSource) instead of polling",
  kiosk.includes("new EventSource") && kiosk.includes("channel=attendance") && kiosk.includes("fetchToday()")
);
pass(
  "a person keeps at most 5 fingers",
  biometricsApi.includes("MAX_FINGERS_PER_MEMBER") && mappingsApi.includes("MAX_FINGERS_PER_MEMBER")
);

/* ── 7. the clock rules ──────────────────────────────────────────────────── */

pass("the clock uses the shared 15 minute rule", clockApi.includes("lateMinutesFor"));
pass("the clock uses the shared one hour rule", clockApi.includes("REPEAT_SCAN_LOCK_MINUTES"));
pass("a repeated scan answers \"already registered\" and writes nothing", clockApi.includes('action: "already_registered"'));
pass("an early out is written on the line", clockApi.includes("earlyOut: early") && clockApi.includes("isEarlyOut"));
pass("the clock asks the shared rule what a second scan means", clockApi.includes("rescanAction(existing.clockIn, now)"));

const inAt = new Date("2026-10-08T05:00:00Z");
const minsLater = (m: number) => new Date(inAt.getTime() + m * 60000);
pass("a second scan 1 minute later only says already registered", rescanAction(inAt, minsLater(1)) === "already_registered");
pass("a second scan at 59 minutes is still already registered", rescanAction(inAt, minsLater(59)) === "already_registered");
pass("from the hour on, the next scan is the OUT", rescanAction(inAt, minsLater(60)) === "clock_out");
pass("a scan 3 hours later is the OUT", rescanAction(inAt, minsLater(180)) === "clock_out");
pass("the PIN is the second way in and a wrong PIN says so", clockApi.includes('method === "pin"') && clockApi.includes("Incorrect PIN"));
pass("the Overtime button has an endpoint of its own", overtimeApi.includes("isOvertime: !clear"));
pass("the today feed tells the tablet who is standing at the door", todayApi.includes("lastScan"));

/* ── 8. the admin tab: order, and what was removed ───────────────────────── */

pass(
  "the buttons are ordered Today Live first and Open Kiosk last",
  adminTab.indexOf('"today"') < adminTab.indexOf('"roles"') &&
    adminTab.indexOf('"roles"') < adminTab.indexOf('"members"') &&
    adminTab.indexOf('"members"') < adminTab.indexOf('"sheet"') &&
    adminTab.indexOf('"sheet"') < adminTab.indexOf('"prints"') &&
    adminTab.lastIndexOf("/attendance") > adminTab.indexOf('"prints"')
);
pass(
  "the FPC1020A + ESP32 WROOM subtitle is gone from the admin header",
  !adminTab.includes("FPC1020A + ESP32 WROOM")
);
pass("the wall of absent names is gone from the admin", !adminTab.includes("Absent Today"));
pass(
  "the sheet keeps From Date, To Date, Load Sheet and Print Hard Copy",
  ["From Date", "To Date", "Load Sheet", "Print Hard Copy"].every((t) => adminTab.includes(t))
);
pass(
  "the sheet is bigger and bolder than it was",
  adminTab.includes("text-[15px]") && adminTab.includes("font-black text-[14px]")
);
pass(
  "the sheet colours a box red, yellow or green, and has its own colours for early out and overtime",
  ["bg-emerald-200", "bg-amber-200", "bg-rose-200", "bg-sky-200", "bg-violet-200"].every((c) => adminTab.includes(c))
);
pass("the sheet says how many days it prints at most", adminTab.includes("SHEET_MAX_DAYS"));
pass("a too-long range is cut in the date pickers too", adminTab.includes("setFromCapped") && adminTab.includes("setToCapped"));
pass("the Staff Fingerprints tab is still there", adminTab.includes("Staff Fingerprints"));

const printsView = adminTab.split('{activeView === "prints" && (')[1]?.split("{/* Print styles")[0] ?? "";
pass(
  "Staff Fingerprints refreshes the member list when opened and reports load errors",
  adminTab.includes('if (activeView === "prints") loadMembers()') &&
    adminTab.includes('fetch("/api/attendance/members", { cache: "no-store" })') &&
    adminTab.includes("membersError")
);
pass(
  "Staff Fingerprints lists each member, their fingerprint IDs and per-finger delete buttons",
  printsView.includes("members.map((m)") &&
    printsView.includes("m.fingers.map((f)") &&
    printsView.includes("ID {f.fingerprintId}") &&
    printsView.includes("deleteFinger(f.id)")
);
pass(
  "the manual form selects a member, takes a 1-1000 ID and a finger name",
  printsView.includes("Select person") &&
    printsView.includes("min={1}") &&
    printsView.includes("max={1000}") &&
    printsView.includes("value={manualFingerName}") &&
    printsView.includes("onClick={enrollManual}")
);
pass(
  "manual mapping POSTs memberId, fingerprintId and fingerName to the default map action",
  adminTab.includes('fetch("/api/attendance/biometrics"') &&
    adminTab.includes("memberId: selectedMember.id") &&
    adminTab.includes("fingerprintId,") &&
    adminTab.includes("fingerName: manualFingerName") &&
    biometricsApi.includes('body.action ?? "map"')
);
pass(
  "both automatic and manual enrollment instructions are plain words on the tab",
  printsView.includes("Attendance → Staff Members") &&
    printsView.includes("ADD FINGERPRINT") &&
    printsView.includes("Serial Monitor at 115200 baud") &&
    printsView.includes("enroll 7") &&
    printsView.includes("Staff Fingerprints")
);
pass(
  "a successful manual mapping confirms the staff member and reloads the finger list",
  adminTab.includes("Fingerprint Added for ${d.memberName || selectedMember.name}") &&
    adminTab.includes("await loadMembers()")
);

/* ── 9. the kiosk ────────────────────────────────────────────────────────── */

pass("the big clock and its timezone line are gone", !kiosk.includes("Africa/Addis_Ababa") && !kiosk.includes("toLocaleTimeString"));
pass("the device chatter is gone", !kiosk.includes("Place finger on FPC1020A") && !kiosk.includes("Device will beep"));
pass("the demo buttons are gone", !kiosk.includes("Test without hardware") && !kiosk.includes("handleManualFingerprint"));
pass("the wall of absent names and the counters are gone", !kiosk.includes("Absent Today") && !kiosk.includes("stats.present"));
pass("the left third has the name dropdown", kiosk.includes("Select your name") && kiosk.includes("/api/attendance/members?public=1"));
pass("the PIN keypad is a phone pad", kiosk.includes('const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "ok"]'));
pass("the PIN goes in with Submit", kiosk.includes("Submit") && kiosk.includes('method: "pin"'));
pass("the Overtime button is there and names the person it marks", kiosk.includes("Overtime") && kiosk.includes("/api/attendance/overtime"));
pass(
  "the live board keeps the paper header and its five columns",
  ["FANA CAFÉ & RESTAURANT", "Employee Name", "IN (Time & Sgn.)", "OUT (Time & Sgn.)", "Total Hours", "Status"].every((t) =>
    kiosk.includes(t)
  )
);
pass("the fingerprint is still called the main way and the PIN the backup", kiosk.includes("Fingerprint on the scanner is the main way"));

if (failures > 0) {
  console.error(`\n❌ ATTENDANCE LISTING GUARD FAILED (${failures})\n`);
  process.exit(1);
}
console.log("\n✅ Attendance listing guard PASSED");
console.log("   • roles own the times, the members are their own list, the sheet is coloured and 7 days at most");
