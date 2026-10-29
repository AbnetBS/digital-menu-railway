#!/usr/bin/env tsx
/**
 * Regression guard: OVERTIME (owner, Oct 2026).
 *
 * The ask, in his words: "on the admin attendance page beside leaderboard put
 * a button overtime, when i click it three button Holiday OT, Free week OT,
 * Shift OT, then i choose the employee and date and shift, then that person
 * date and shift is overtime ... with other info below in a table employee
 * name, date, type of overtime, total hour".
 *
 * What that means in code, checked here:
 *
 *   1. Three kinds, and only three: holiday, free_week, shift. A row is one
 *      kind for one person on one day (plus the shift it belongs to, when one
 *      was picked). There is no fourth "generic overtime".
 *   2. It arrives from three directions and every row says which:
 *        admin      the tab on the Attendance page
 *        self       the person's own tap at the door tablet
 *        supervisor the door tablet while the supervisor's keypad is open
 *        auto       the clock-out scan of a person who stayed past his shift
 *   3. The automatic rule (owner, 2026-10-28: "all overtime must have 1:15
 *      buffer for transfer and changing clothes"): still present more than 75
 *      minutes after the end of the shift, and the overtime is the WHOLE time
 *      past that end. A second shift measures the worked time beyond the
 *      person's own shift length, from IN to OUT.
 *   4. No approval step. The row IS the record, it lists immediately, it turns
 *      that day's box on the paper sheet violet, and the Leaderboard counts the
 *      day as an overtime day.
 *   5. A double tap cannot count the same hours twice: the row of the same
 *      person + day + kind + shift is updated instead of added, and an auto row
 *      never overwrites a number a person typed.
 *   6. The admin table has the four columns he named, in his order, plus the
 *      weekday beside the date, the category filter ("who got which OT") and
 *      the "Don't give" / "Give again" decision that keeps the row in history.
 *   7. A mistaken overtime is excluded from pay, never deleted.
 *
 * The rules are imported from the real modules, so a change to the numbers
 * fails here and not in the cafe. No network, no database.
 *
 * Run with: npx tsx scripts/verify-attendance-overtime.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  OVERTIME_SOURCES,
  OVERTIME_TYPE_HINTS,
  OVERTIME_TYPE_LABELS,
  OVERTIME_TYPES,
  SHIFT_OT_GRACE_MINUTES,
  isOvertimeSource,
  isOvertimeType,
  overtimeHoursLabel,
  overtimeMinutesFromLog,
  shiftOtMinutesFor,
  weekdayName,
  workedShiftOtMinutes,
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
const overtimeApi = read("src/app/api/attendance/overtime/route.ts");
const clockApi = read("src/app/api/attendance/clock/route.ts");
const store = read("src/lib/attendance-overtime.ts");
const adminTab = read("src/components/rms/AttendanceTab.tsx");
const kiosk = read("src/app/(internal)/attendance/page.tsx");

/* ── 1. the three kinds ──────────────────────────────────────────────────── */

pass("the three kinds the owner named, in his order", OVERTIME_TYPES.join(",") === "holiday,free_week,shift");
pass(
  "each button reads the way he asked",
  OVERTIME_TYPES.map((t) => OVERTIME_TYPE_LABELS[t]).join(" | ") === "Holiday OT | Free week OT | Shift OT"
);
pass(
  "each kind explains itself in one line on the button",
  OVERTIME_TYPES.every((t) => (OVERTIME_TYPE_HINTS[t] || "").length > 20)
);
pass("a kind nobody asked for is refused", !isOvertimeType("sick_day") && !isOvertimeType("") && isOvertimeType("shift"));
pass("the four sources of a row are named", OVERTIME_SOURCES.join(",") === "admin,supervisor,self,auto");
pass("and an unknown source is refused too", !isOvertimeSource("manager") && isOvertimeSource("auto"));

/* ── 2. the automatic Shift OT rule (1:15 buffer) ───────────────────────── */

const morning = { label: "Morning", startTime: "08:00", endTime: "17:00" };
const night = { label: "Night", startTime: "18:00", endTime: "03:00" };
/** Addis Ababa is UTC+3 with no DST, so an explicit offset is the honest way. */
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+03:00`);
const d15 = "2026-10-15";
const d16 = "2026-10-16";

pass("the grace is 1 hour 15 minutes (owner, 2026-10-28)", SHIFT_OT_GRACE_MINUTES === 75);
pass("leaving at the end of the shift is not overtime", shiftOtMinutesFor(morning, at(d15, "17:00")) === 0);
pass("leaving early is not overtime", shiftOtMinutesFor(morning, at(d15, "15:20")) === 0);
pass("the owner's example: shift ends 8:00, OUT 9:00, no undeserved overtime", shiftOtMinutesFor({ label: "12 to 8", startTime: "12:00", endTime: "20:00" }, at(d15, "21:00")) === 0);
pass("75 minutes past the end is still inside the buffer", shiftOtMinutesFor(morning, at(d15, "18:15")) === 0);
pass("one minute past 1:15 pays the WHOLE time past the end", shiftOtMinutesFor(morning, at(d15, "18:16")) === 76);
pass("a whole evening is measured, not capped at the grace", shiftOtMinutesFor(morning, at(d15, "21:00")) === 240);
pass("a shift across midnight wraps like the early-out rule", shiftOtMinutesFor(night, at(d16, "05:00")) === 120);
pass("and an out before that midnight end is an early leave, not 22 hours", shiftOtMinutesFor(night, at(d16, "02:00")) === 0);
pass("no shift set for the person means nothing can be measured", shiftOtMinutesFor(null, at(d15, "23:00")) === 0);
pass("no clock-out is no overtime", shiftOtMinutesFor(morning, null) === 0);
pass("a broken time is ignored instead of throwing", shiftOtMinutesFor(morning, "not a date" as unknown as Date) === 0);

const double = { label: "12 to 8", startTime: "12:00", endTime: "20:00" };
pass("covering a second shift measures worked time beyond the shift's own length", workedShiftOtMinutes(double, at(d15, "12:30"), at(d15, "23:30")) === 180);
pass("a late IN inside the role grace does not steal the extra shift", workedShiftOtMinutes(double, at(d15, "12:30"), at(d15, "22:00")) === 90);
pass("one hour of changing clothes is not a second shift", workedShiftOtMinutes(double, at(d15, "12:00"), at(d15, "21:00")) === 0);
pass("without an IN it falls back to the old end-of-shift measurement", workedShiftOtMinutes(morning, null, at(d15, "21:00")) === 240);
pass("overtime dates carry their weekday name (Monday, Tuesday...)", weekdayName("2026-10-26") === "Monday" && weekdayName("2026-10-27") === "Tuesday");

/* ── 3. the hours a day already implies ─────────────────────────────────── */

pass("an empty hours box means the day's own worked hours", overtimeMinutesFromLog({ totalMinutes: 500 }) === 500);
pass("or, when the day was never totalled, IN to OUT", overtimeMinutesFromLog({ clockIn: at(d15, "08:00"), clockOut: at(d15, "19:30") }) === 690);
pass("an open day (no OUT) has no default yet", overtimeMinutesFromLog({ clockIn: at(d15, "08:00"), clockOut: null }) === 0);
pass("no scan at all is 0, so the caller must ask for a number", overtimeMinutesFromLog(null) === 0);
pass("and a day is never longer than a day", overtimeMinutesFromLog({ totalMinutes: 10_000 }) === 24 * 60);
pass("overtime is spoken in hours and minutes", overtimeHoursLabel(91) === "1h 31m" && overtimeHoursLabel(0) === "0h 00m");

/* ── 4. the table ───────────────────────────────────────────────────────── */

pass("there is a real overtime table (not a flag on the log)", schema.includes('pgTable("attendance_overtime"'));
// The whole declaration, not up to the first `})` (a varchar's own `{ length }`
// would cut it off after two columns).
const otTableAt = schema.indexOf("export const attendanceOvertime = pgTable(");
const otTableBlock =
  otTableAt >= 0 ? schema.slice(otTableAt, schema.indexOf("\n});", otTableAt) + 1) : "";
pass("the table is declared once, in the schema", otTableAt >= 0);
pass(
  "with the columns the three kinds and the three sources need",
  ["memberId", "date", "type", "minutes", "shiftLabel", "logId", "source", "enteredBy", "note"].every((col) =>
    otTableBlock.includes(`${col}:`)
  )
);
pass("and the day it belongs to is the sheet's own date key",
  otTableBlock.includes('date: varchar("date", { length: 10 })'));
pass("the migration creates it when it is missing", migrate.includes("CREATE TABLE IF NOT EXISTS attendance_overtime ("));
// It has to be in the list of serial tables whose sequence is repaired; it does
// not have to be the last one (Attendance -> Activity added one after it), so the
// assertion stops at the name instead of at the closing bracket.
pass("its id sequence is repaired like every other table here",
  /serialTables = \[[\s\S]*?"attendance_overtime",/.test(migrate));
pass(
  "one person, one day, one kind, one shift: the unique key that stops a double count",
  migrate.includes("attendance_overtime_member_day_type_key ON attendance_overtime (member_id, date, type, COALESCE(shift_label, ''))")
);
pass("and a list by range is indexed", migrate.includes("CREATE INDEX IF NOT EXISTS attendance_overtime_date_idx ON attendance_overtime (date)"));
pass("an already-migrated database gets the table too: the version gate moved",
  (/SCHEMA_VERSION = "(\d{4}-\d{2}-\d{2}-\d+)"/.exec(migrate)?.[1] ?? "") >= "2026-10-28-1");

/* ── 5. the writer every door and page shares ───────────────────────────── */

pass("one module writes the rows, so the three ways in cannot disagree",
  store.includes("export async function saveOvertimeRow") && store.includes("export async function recordShiftOvertimeAtClockOut"));
pass("a row of the same person + day + kind + shift is updated, not added",
  store.includes("return { row, replaced: true };") && store.includes(".update(attendanceOvertime)"));
pass("a re-scan restates the auto row instead of adding a second one",
  store.includes(`const mine = existing.find((r) => r.source === "auto"`));
pass("a number a person typed is never overwritten by the stopwatch",
  store.includes("const typed = existing.find((r) => r.source !== \"auto\"") && store.includes("if (typed) return 0;"));
pass("the API writes through that same module", overtimeApi.includes("saveOvertimeRow({"));

/* ── 6. the API ─────────────────────────────────────────────────────────── */

pass("GET lists a range with the other info beside the hours",
  /export async function GET/.test(overtimeApi) &&
    overtimeApi.includes("clockInLabel") &&
    overtimeApi.includes("workedLabel"));
pass("POST accepts the three kinds and refuses anything else",
  overtimeApi.includes("isOvertimeType(type)") && overtimeApi.includes("Pick the person first"));
pass("the hours may be left to the day's own scan",
  overtimeApi.includes("asked ?? overtimeMinutesFromLog(log)"));
pass("and 0 hours is refused instead of writing a blank row",
  overtimeApi.includes('"Type how many hours.'));
pass("a date that is not YYYY-MM-DD is refused", overtimeApi.includes("DAY_RE.test(date)"));
pass("the tablet's hours land as its own claim, not as an admin's",
  overtimeApi.includes('const source: OvertimeSource = !isAdmin') && overtimeApi.includes('"self"'));
pass("saving overtime also marks the day, so the sheet stays violet",
  overtimeApi.includes("isOvertime: true"));
pass("removing a row is admin only (a tap at the door cannot take hours back off pay)",
  /export async function DELETE/.test(overtimeApi) &&
    /export async function DELETE\([\s\S]{0,200}requireAdmin\(\)/.test(overtimeApi));
pass("the old plain switch still works for the device",
  overtimeApi.includes("No scan for today yet. Scan the fingerprint first, then press Overtime."));
pass("a day with no overtime left loses its violet mark too",
  /export async function DELETE[\s\S]*isOvertime: false/.test(overtimeApi));

/* ── 7. the clock-out scan writes the automatic row ─────────────────────── */

pass("the OUT of a shift measures the overtime on the same tap",
  clockApi.includes("recordShiftOvertimeAtClockOut({"));
pass("the OUT measures IN to OUT beyond the shift length, not only the tail",
  clockApi.includes("workedShiftOtMinutes(inShift, existing.clockIn, now)") &&
    clockApi.includes("clockInAt: existing.clockIn,"));
pass("the shared writer uses the same worked-time rule",
  store.includes("workedShiftOtMinutes(args.shift, args.clockInAt, args.clockOutAt)"));
pass("and the day is marked overtime by the same rule, not only by a button",
  /isOvertime: Boolean\(existing\.isOvertime\) \|\| shiftOtMinutes > 0/.test(clockApi));
pass("the device is told the hours so its screen can show them",
  clockApi.includes("overtimeLabel: otLabel || null") && clockApi.includes("OT ${otLabel}"));
pass("a database hiccup rolls back clock-out and overtime together so the queued scan can retry",
  clockApi.includes("db.transaction(async (tx)") && /recordShiftOvertimeAtClockOut\(\{[\s\S]*?\}, tx\)/.test(clockApi) && store.includes('client: OvertimeDb = db'));

/* ── 8. the admin tab: the button beside the Leaderboard and his table ──── */

// One bounded slice: from where the overtime view starts to where the next
// view starts. Every claim below is about that block, so a string living in
// another tab can never make it pass by accident.
const otStart = adminTab.indexOf('{activeView === "overtime" && (');
const activityStart = adminTab.indexOf('{activeView === "activity" && (', otStart);
const printsStart = adminTab.indexOf('{activeView === "prints" && (', otStart);
const otEnd = activityStart >= 0 ? activityStart : printsStart;
const otView = otStart >= 0 && otEnd > otStart ? adminTab.slice(otStart, otEnd) : "";

pass("the Overtime view exists as its own block", otStart >= 0);
pass("the Overtime view sits beside the Leaderboard in the switcher",
  /{ key: "leaderboard", label: "Leaderboard"[\s\S]{0,200}{ key: "overtime", label: "Overtime"/.test(adminTab));
pass("the three type buttons are the first thing the tab offers",
  otView.indexOf("Object.keys(OVERTIME_TYPE_LABELS)") < otView.indexOf("<select"));
pass("the form picks the employee, the date, the shift and the hours",
  ["Employee", "Date", "Shift", "Total hours"].every((label) => otView.includes(`>${label}</label>`)));
pass("the table has his four columns in his order",
  [">Employee Name</th>", ">Date</th>", ">Type of overtime</th>", ">Total Hour</th>"].every(
    (h, i, all) => otView.includes(h) && (i === 0 || otView.indexOf(all[i - 1]) < otView.indexOf(h))
  ));
pass("the other info is below, in the row: the times, the worked hours, who wrote it",
  otView.includes("worked ${row.workedLabel}") && otView.includes("from his clock-out scan"));
pass("the shift of the picked person comes from his own role's times",
  adminTab.includes("const otShifts = otRole?.shifts ?? [];"));
pass("the hours box defaults to the day's worked hours and says so",
  otView.includes('placeholder={otWorkedNow ? otWorkedNow.label : "e.g. 2"}') &&
    adminTab.includes("worked ${otWorkedNow.label} on"));
pass("a row is saved with a named type, and the list is reloaded after",
  /body: JSON\.stringify\(\{\s*memberId: Number\(otMemberId\),\s*date: otDate,\s*type: otType/.test(adminTab) &&
    adminTab.includes("await loadOvertime();"));
pass("there is no approval language in the overtime tab",
  !/approve|pending approval|reject/i.test(otView));
pass("a mistaken row is NOT deleted: 'Don't give' keeps it in the history",
  otView.includes("toggleOvertimeDecision(row)") && otView.includes("Don't give") && !otView.includes("removeOvertime(row.id)"));
pass("and 'Give again' puts the hours back on pay",
  /action: excluded \? "give_again" : "dont_give"/.test(adminTab) && otView.includes("Give again"));
pass("the category buttons filter the history: who got which OT, with name, type, date",
  otView.includes("otVisibleRows") && otView.includes("Who got ") && otView.includes("weekdayName(row.date)"));
pass("clicking a person prefills the manual form so a missing OT can be given",
  adminTab.includes("const giveOvertimeTo =") && otView.includes("giveOvertimeTo(m.id"));
pass("the API keeps the exclusion in its own table and never erases the overtime row",
  overtimeApi.includes('decision === "dont_give" || decision === "give_again"') &&
    overtimeApi.includes("Only an admin can decide not to give overtime") &&
    schema.includes('pgTable("attendance_ot_exclusions"') &&
    migrate.includes("CREATE TABLE IF NOT EXISTS attendance_ot_exclusions"));

/* ── 9. the door tablet: the person's own tap ───────────────────────────── */

pass("the Overtime button opens the three kinds instead of flipping a flag",
  /onClick={openOvertime}/.test(kiosk) && kiosk.includes("Which kind of overtime?"));
pass("the tablet offers all three",
  /otOpen && \([\s\S]*Object\.keys\(OVERTIME_TYPE_LABELS\)/.test(kiosk));
pass("the hours may stay empty and then come from the scan",
  kiosk.includes('placeholder="auto"') && kiosk.includes("hours: otHours === \"\" ? undefined : hours"));
pass("the tablet names who typed it, so the admin table can say so",
  kiosk.includes("enteredBy: supervisorName ?? undefined"));
pass("the panel can be backed out of without saving",
  kiosk.includes("Cancel") && kiosk.includes("setOtOpen(false)"));

/* ── 10. the words on the screen ─────────────────────────────────────────── */

const otPanel = kiosk.slice(kiosk.indexOf("const openOvertime"), kiosk.indexOf("const lastScan"));
// Amharic on the door tablet is what must not happen: the whole cafe reads it,
// and the words are only written down in English (owner's standing rule).
pass("the tablet's overtime copy is English (it is a public door)",
  otPanel.length > 200 && !/[\u1200-\u137F]/.test(otPanel));
pass("no user-visible overtime string carries an em dash",
  !/[—‒–]/.test(otPanel + overtimeApi + otView));

console.log("");
if (failures > 0) {
  console.error(`\n❌ OVERTIME GUARD FAILED (${failures})\n`);
  process.exit(1);
}
console.log("✅ Overtime guard PASSED");
console.log("   • three kinds, four sources, one row per person + day + kind + shift");
console.log("   • a person still here 1:15 past his shift gets the whole time measured for him");
console.log("   • 'Don't give' keeps the record but excludes it from pay; 'Give again' restores it");
console.log("   • the admin tab beside the Leaderboard, the tablet at the door, and no approval queue");
