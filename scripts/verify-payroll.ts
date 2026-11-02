#!/usr/bin/env tsx
/**
 * Regression guard: PAYROLL (owner, Oct 2026).
 *
 * The ask, in his words: "there is missed part how do i put the values that
 * must be putted by me ... Basic Salary, Transport Allowance, and the breakage
 * and shortage ... when i click that employee column box it must accept the
 * values there, then automatically the system calculate all column values".
 * And: "the action column isn't needed, at the end of the day it will be a
 * paid button, when the person is paid the button will be a green tick".
 * And the three formulas: holiday BasicSalary/30/8*time*2.5, free week *2,
 * shift *1.5, with the owner's 1:15 (75 minute) buffer after the shift end
 * (2026-10-28) and a one hour minimum work barrier for a holiday/free day.
 *
 * What that means in code, checked here:
 *
 *   1. The safe formula evaluator still refuses anything that is not
 *      arithmetic, and the owner's three rates are the DEFAULTS, so a fresh or
 *      old install calculates instead of printing zeros.
 *   2. The overtime measurement (recognizedOtMinutes) follows his examples:
 *      the role's Maximum Late Time / Leaving Grace keep the shift whole, the
 *      1:15 tail is not overtime, and staying two hours past the end pays the
 *      whole two hours. A holiday/free-week visit under one hour is ignored.
 *      A mistaken overtime can be marked "Don't give" without deleting it.
 *   3. The payroll API measures the three kinds from attendance, holidays and
 *      the free schedules; it never numbers the rows by database id.
 *   4. A holiday can be registered (date + name) and read back by payroll.
 *   5. Each person has one paid row and one green tick, and the salary cells
 *      are typed and confirmed before they are saved.
 *
 * Run with: npx tsx scripts/verify-payroll.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_EARLY_OUT_FORMULA,
  DEFAULT_INCOME_TAX_FORMULA,
  DEFAULT_LATENESS_FORMULA,
  DEFAULT_PAYROLL_FORMULAS,
  DEFAULT_PAYROLL_SETTINGS,
  OT_ARRIVAL_GRACE_MINUTES,
  OT_BUFFER_MINUTES,
  OT_MIN_WORK_MINUTES,
  computePayrollMoney,
  evaluatePayrollFormula,
  ethiopianDateToGregorian,
  ethiopianMonthBounds,
  gregorianDateToEthiopian,
  minutesToHours,
  recognizedOtMinutes,
  requiredPayrollSettingsMissing,
  withDefaultPayrollFormulas,
} from "../src/lib/payroll";
import { earlyOutMinutesFor, lateMinutesFor, shiftOtMinutesFor, weekdayName, workedShiftOtMinutes } from "../src/lib/attendance";

let failures = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
  if (!cond) failures++;
};
const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
// Read the files once, before any pass() can ask about them.
const clockApi = read("src/app/api/attendance/clock/route.ts");

/* ── 1. the safe evaluator and the owner's rates ─────────────────────────── */

const context = { BasicSalary: 12000, TransportAllowance: 500, HolidayOtHours: 8, FreeWeekOtHours: 8, ShiftOtHours: 2, TaxableSalary: 12500 };
assert.equal(evaluatePayrollFormula("BasicSalary / 30 / 8 * HolidayOtHours * 1.5", context), 600);
assert.equal(evaluatePayrollFormula("(BasicSalary + 100) / 2", context), 6050);
assert.throws(() => evaluatePayrollFormula("process.exit()", context), /Invalid formula|Unknown/);
assert.throws(() => evaluatePayrollFormula("BasicSalary / 0", context), /Division by zero/);
assert.equal(evaluatePayrollFormula(DEFAULT_INCOME_TAX_FORMULA, { TaxableSalary: 1800 }), 0);
assert.equal(evaluatePayrollFormula(DEFAULT_INCOME_TAX_FORMULA, { TaxableSalary: 5000 }), 500);
assert.equal(evaluatePayrollFormula(DEFAULT_INCOME_TAX_FORMULA, { TaxableSalary: 15000 }), 3200);
assert.throws(() => evaluatePayrollFormula("IF(TaxableSalary<10,0)", { TaxableSalary: 5 }), /value when false/);

pass("the holiday formula pays 2.5x the owner's day rate", evaluatePayrollFormula(DEFAULT_PAYROLL_FORMULAS.holidayOtFormula, { ...context, HolidayOtHours: 8 }) === 1000);
pass("the free week formula pays 2x", evaluatePayrollFormula(DEFAULT_PAYROLL_FORMULAS.freeWeekOtFormula, { ...context, FreeWeekOtHours: 8 }) === 800);
pass("the shift formula pays 1.5x", evaluatePayrollFormula(DEFAULT_PAYROLL_FORMULAS.shiftOtFormula, { ...context, ShiftOtHours: 2 }) === 150);
pass("every required formula has an owner's default, so nothing blocks the first month", requiredPayrollSettingsMissing(DEFAULT_PAYROLL_SETTINGS).length === 0);
pass("a saved empty formula falls back to the default instead of zeroing a column", withDefaultPayrollFormulas({ holidayOtFormula: "", shiftOtFormula: "  " }).holidayOtFormula === DEFAULT_PAYROLL_FORMULAS.holidayOtFormula);
pass("and a typed formula is kept as it is", withDefaultPayrollFormulas({ holidayOtFormula: "BasicSalary / 30 / 8 * HolidayOtHours * 3" }).holidayOtFormula.endsWith("* 3"));
pass("the settings page no longer needs a manager approval to calculate", requiredPayrollSettingsMissing({ ...DEFAULT_PAYROLL_SETTINGS, settingsApproved: false }).length === 0);

/* ── 2. the 1:15 buffer, the 1 hour barrier and the role's own grace ────── */

const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+03:00`);
const d15 = "2026-10-15";
const dayShift = { label: "Day", startTime: "08:00", endTime: "17:00" };
const freeWeekShift = { label: "12 to 8", startTime: "06:00", endTime: "14:00" };
const night = { label: "Night", startTime: "18:00", endTime: "03:00" };
const log = (inAt: Date, outAt: Date) => ({ clockIn: inAt, clockOut: outAt });

pass("the owner's buffer is 1 hour 15 minutes", OT_BUFFER_MINUTES === 75);
pass("a holiday/free-week visit must be longer than one hour", OT_MIN_WORK_MINUTES === 60);
pass("the 30 minute arrival grace is only a fallback now", OT_ARRIVAL_GRACE_MINUTES === 30);
pass("arriving 10 minutes late still earns the whole 9 hour shift", recognizedOtMinutes(dayShift, log(at(d15, "08:10"), at(d15, "17:00"))) === 540);
pass("arriving 45 minutes late loses only the 15 minutes past the grace", recognizedOtMinutes(dayShift, log(at(d15, "08:45"), at(d15, "17:00"))) === 525);
pass("the owner's 20 min grace example: 30 min late earns 7:50, not 7:30", recognizedOtMinutes({ ...freeWeekShift, lateGraceMinutes: 20 }, log(at(d15, "06:30"), at(d15, "14:00"))) === 470);
pass("leaving one hour after the end is still not overtime", recognizedOtMinutes(dayShift, log(at(d15, "08:05"), at(d15, "18:00"))) === 540);
pass("leaving at 9:00 after an 8:00 end is inside the 1:15 buffer: no undeserved OT", recognizedOtMinutes(freeWeekShift, log(at(d15, "06:00"), at(d15, "15:00"))) === 480);
pass("exactly 1:15 past the end still earns no extra", recognizedOtMinutes(dayShift, log(at(d15, "08:05"), at(d15, "18:15"))) === 540);
pass("one minute past 1:15 pays every minute past the shift end", recognizedOtMinutes(dayShift, log(at(d15, "08:05"), at(d15, "18:16"))) === 616);
pass("a holiday visit of 45 minutes is not overtime at all", recognizedOtMinutes(dayShift, log(at(d15, "09:00"), at(d15, "09:45"))) === 0);
pass("the owner's example: shift ends 17:00, out at 19:00, two hours past the end", recognizedOtMinutes(dayShift, log(at(d15, "08:00"), at(d15, "19:00"))) === 660);
pass(
  "his free week example: 12:30 to 9:00 is still the full 8 hours",
  minutesToHours(recognizedOtMinutes(freeWeekShift, log(at(d15, "06:30"), at(d15, "15:00")))) === 8
);
pass("a free week arrival after the grace loses only the extra lateness", recognizedOtMinutes(freeWeekShift, log(at(d15, "07:00"), at(d15, "14:00"))) === 450);
pass("a shift across midnight measures the same way", recognizedOtMinutes(night, log(at(d15, "18:00"), at("2026-10-16", "05:00"))) === 660);
pass("half a day with no OUT has no measured hours", recognizedOtMinutes(dayShift, { clockIn: at(d15, "08:00"), clockOut: null }) === 0);
pass("a stored total is still honoured when the two scans were never stored", recognizedOtMinutes(dayShift, { totalMinutes: 480 }) === 480);
pass("no role times fall back to the clocked time", recognizedOtMinutes(null, log(at(d15, "08:00"), at(d15, "16:00"))) === 480);
pass("Shift OT itself still starts after 1:15 past the end", shiftOtMinutesFor(dayShift, at(d15, "18:15")) === 0 && shiftOtMinutesFor(dayShift, at(d15, "18:16")) === 76);
pass("a second shift is measured by the time worked beyond the shift's own length", workedShiftOtMinutes({ label: "12 to 8", startTime: "12:00", endTime: "20:00" }, at(d15, "12:30"), at(d15, "23:30")) === 180);
pass("and a person who only stayed 60 minutes past the end gets no Shift OT", workedShiftOtMinutes({ label: "12 to 8", startTime: "12:00", endTime: "20:00" }, at(d15, "12:00"), at(d15, "21:00")) === 0);
pass("overtime dates carry their weekday name", weekdayName("2026-10-28") === "Wednesday" && weekdayName("2026-10-24") === "Saturday" && weekdayName("") === "");
/* ── 2b. the deduction starts only after the grace (owner, Oct 2026) ────── */

pass("coming in inside the Maximum Late Time costs nothing", lateMinutesFor({ ...dayShift, lateGraceMinutes: 30 }, 8 * 60 + 30) === 0);
pass("coming in past it deducts only the minutes above the grace", lateMinutesFor({ ...dayShift, lateGraceMinutes: 30 }, 8 * 60 + 40) === 10);
pass("leaving inside the Leaving Grace costs nothing", earlyOutMinutesFor({ ...dayShift, earlyLeaveGraceMinutes: 30 }, 16 * 60 + 45) === 0);
pass("leaving past it deducts only the minutes above the grace", earlyOutMinutesFor({ ...dayShift, earlyLeaveGraceMinutes: 30 }, 16 * 60 + 30) === 0 && earlyOutMinutesFor({ ...dayShift, earlyLeaveGraceMinutes: 30 }, 16 * 60 + 20) === 10);
pass("an early departure is measured in minutes for the pay slip", earlyOutMinutesFor({ ...dayShift, earlyLeaveGraceMinutes: 0 }, 16 * 60 + 30) === 30);
pass("the door reads each role's own Maximum Late Time and Leaving Grace", clockApi.includes("lateGraceMinutes: Number(r.lateGraceMinutes") && clockApi.includes("earlyLeaveGraceMinutes: Number(r.earlyLeaveGraceMinutes"));
pass("the clock-out scan now stores those minutes, not only a flag", clockApi.includes("earlyOutMinutes: earlyMinutes") && clockApi.includes("earlyOutMinutesFor(inShift, nowMinutes)"));

/* ── 3. the API calculates, and numbers the rows 1..n ────────────────────── */

const payrollApi = read("src/app/api/payroll/route.ts");
const settingsApi = read("src/app/api/payroll/settings/route.ts");
const holidayApi = read("src/app/api/payroll/holidays/route.ts");
const payrollTab = read("src/components/rms/PayrollTab.tsx");
const attendanceTab = read("src/components/rms/AttendanceTab.tsx");
const schema = read("src/db/schema.ts");
const migrate = read("src/db/migrate.ts");
const payrollLib = read("src/lib/payroll.ts");

/* ── 1b. the three deductions: two minute rules and the one-day absence rule */

pass(
  "lateness and early departure ship with the owner's per-minute rule",
  DEFAULT_PAYROLL_SETTINGS.latenessFormula === DEFAULT_LATENESS_FORMULA &&
    DEFAULT_PAYROLL_SETTINGS.earlyOutFormula === DEFAULT_EARLY_OUT_FORMULA
);
pass(
  "absence ships with the owner's one-day rule: BasicSalary / 30 per absent day",
  DEFAULT_PAYROLL_SETTINGS.absenceFormula === "BasicSalary / 30 * UnapprovedAbsences"
);
pass(
  "a database whose formula keys were never written gets the shipped minute rules",
  withDefaultPayrollFormulas({}).latenessFormula === DEFAULT_LATENESS_FORMULA &&
    withDefaultPayrollFormulas({}).earlyOutFormula === DEFAULT_EARLY_OUT_FORMULA &&
    withDefaultPayrollFormulas(null).absenceFormula === "BasicSalary / 30 * UnapprovedAbsences"
);
pass(
  "an empty deduction box stays empty instead of being filled with a made-up formula",
  withDefaultPayrollFormulas({ absenceFormula: "", latenessFormula: "   ", earlyOutFormula: "" }).absenceFormula === "" &&
    withDefaultPayrollFormulas({ latenessFormula: "" }).latenessFormula === "" &&
    withDefaultPayrollFormulas({ earlyOutFormula: "" }).earlyOutFormula === ""
);
pass(
  "an empty formula deducts nothing in the payroll row",
  payrollApi.includes("computePayrollMoney({") && payrollLib.includes("f?Math.max(0,evaluatePayrollFormulaExact(f,context)):0")
);
pass(
  "the three deductions are not required settings, so a first month is never blocked by them",
  !requiredPayrollSettingsMissing(DEFAULT_PAYROLL_SETTINGS).some((m) => /absence|lateness|early/i.test(m))
);
pass(
  "saving an empty deduction box stores it empty, it does not fall back to a default",
  settingsApi.includes("if (!formula && (DEDUCTION_FORMULA_KEYS as readonly string[]).includes(key))") &&
    settingsApi.includes('settings[key] = ""')
);
pass(
  "the migration clears only the shipped deduction formulas an earlier build had stored",
  migrate.includes("BasicSalary / 30 * UnapprovedAbsences") &&
    migrate.includes("BasicSalary / 30 / 8 / 60 * LateMinutes") &&
    migrate.includes("BasicSalary / 30 / 8 / 60 * EarlyOutMinutes") &&
    migrate.includes("jsonb_set(settings, '{${key}}'")
);
pass(
  "the migration seeds the two shipped minute rules once into old databases",
  migrate.includes("payroll_minute_rule_2026_10_27") &&
    migrate.includes('const latenessRule = "BasicSalary / 30 / 8 / 60 * MAX(0, LateMinutes)"') &&
    migrate.includes('const earlyOutRule = "BasicSalary / 30 / 8 / 60 * MAX(0, EarlyOutMinutes)"') &&
    migrate.includes("minute rule base upgrade") &&
    migrate.includes("jsonb_strip_nulls") &&
    (/SCHEMA_VERSION = "(\d{4}-\d{2}-\d{2}-\d+)"/.exec(migrate)?.[1] ?? "") >= "2026-10-27-2"
);
pass(
  "the migration seeds the absence rule once, without clearing his decision",
  migrate.includes("payroll_absence_rule_2026_10_27") &&
    migrate.includes('const absenceRule = "BasicSalary / 30 * UnapprovedAbsences"') &&
    !migrate.includes('["absenceFormula", "BasicSalary / 30 * UnapprovedAbsences"]')
);
pass(
  "Formula Settings includes all 4 overtime formulas (including Night shift) and deduction formulas without verbose prose walls",
  payrollTab.includes("nightShiftOtFormula") &&
    payrollTab.includes("BasicSalary / 30 / 8 * NightShiftOtHours * 1.75") &&
    payrollTab.includes("BasicSalary / 30 / 8 / 60 * MAX(0, LateMinutes)") &&
    payrollTab.includes("BasicSalary / 30 * UnapprovedAbsences") &&
    !payrollTab.includes("The per-minute rule.")
);
{
  const nightMoney = computePayrollMoney({
    basicSalary: 6000,
    transportAllowance: 0,
    breakageShortage: 0,
    settings: DEFAULT_PAYROLL_SETTINGS,
    attendance: { NightShiftOtHours: 4 },
  }).display;
  // 6000 / 30 / 8 = 25 ETB/hr * 4 hr * 1.75 = 175.00 ETB
  pass("Night shift OT formula calculates 25 * 4 * 1.75 = 175.00 ETB and is editable", nightMoney.nightShiftOtPay === 175 && nightMoney.overtimePay === 175);
}


pass("payroll measures lateness and early departure from the role's own times", payrollApi.includes("lateMinutesFor(shift, etMinutes(l.clock_in))") && payrollApi.includes("earlyOutMinutesFor(shift, etMinutes(l.clock_out))"));
pass("the scans are re-measured so a changed role grace really changes the month", payrollApi.includes("chargeableDayMinutes(rawLate, rawEarly)"));
pass("an older row with a flag but no clock time keeps its stored minutes", payrollApi.includes("l.early_out"));
pass(
  "the API row and the live preview use the same Excel-precision money chain including NightShiftOtHours",
  payrollApi.includes("computePayrollMoney({") && payrollTab.includes("computePayrollMoney({") &&
    payrollApi.includes("NightShiftOtHours: nightShiftOtHours") && payrollTab.includes("NightShiftOtHours: a.nightShiftOtHours || 0") &&
    payrollLib.includes("evaluatePayrollFormulaExact") && payrollLib.includes("const money2=roundMoney")
);

pass("the payroll reads the overtime rows from attendance_overtime", payrollApi.includes("FROM attendance_overtime"));
pass("automatic overtime in payroll is granted ONLY for registered holiday dates",
  payrollApi.includes("recognizedOtMinutes(shift, log)") &&
    payrollApi.includes("const holiday = holidayByDate.get(date)") &&
    !payrollApi.includes("workedShiftOtMinutes") &&
    !payrollApi.includes("isWorkedFree"));
pass("all four manual overtime kinds (holiday, free_week, shift, night_shift) feed payroll",
  payrollApi.includes('manualMinutes("night_shift")') && payrollApi.includes("nightShiftOtPay: pay.nightShiftOtPay"));
pass("a 'Don't give' decision is read for the month and filters manual and holiday OT",
  payrollApi.includes("FROM attendance_ot_exclusions") &&
    payrollApi.includes("excludedOt.has(`${date}|holiday`)") &&
    payrollApi.includes("allowedOtRow"));
pass("excluded rows stay in the overtime history, marked as not given", payrollApi.includes("excluded: excludedOt.has(") && payrollApi.includes("otExclusions: excludedQ.rows") && payrollApi.includes("const writtenEntries = otRows.filter((r) => r.source !== \"auto\")") && payrollApi.includes("excluded: d.excluded"));
pass("and their hours are never added to pay, nor counted as paid OT days", payrollApi.includes("if (!excluded) autoHolidayMinutes += minutes") && payrollApi.includes('autoDays.filter((d) => d.type === "holiday" && !d.excluded)'));
pass("manual holiday OT overrides auto holiday scan on the same day, and free days are never absences", payrollApi.includes("manualHolidayDates.has(date)") && payrollApi.includes("holidayByDate.get(date)") && payrollApi.includes("!isFree(d)"));
pass("the No. column is the position in this list, never the database id", payrollApi.includes("employeeNumber: index + 1") && !payrollApi.includes("employeeNumber: memberId"));
pass("breakage comes from Store records while salary and transport are typed", payrollApi.includes("payroll_breakages") && payrollApi.includes("Breakage is recorded in Store"));
pass("a paid person is locked against edits", payrollApi.includes("already paid for this month"));
pass("one paid row per person per month", payrollApi.includes("INSERT INTO payroll_payments") && payrollApi.includes("DELETE FROM payroll_payments"));
pass("the holiday API stores an Ethiopian date and its name", holidayApi.includes("ethiopianDateToGregorian") && holidayApi.includes("payroll_holidays"));
pass("a holiday is one row per day", migrate.includes("CREATE UNIQUE INDEX IF NOT EXISTS payroll_holidays_date_key"));
pass("paid rows are one per person per month in the migration too", migrate.includes("CREATE UNIQUE INDEX IF NOT EXISTS payroll_payments_period_member_key"));
pass("a paid row freezes what was actually handed over", payrollApi.includes("snapshot") && migrate.includes("ALTER TABLE payroll_payments ADD COLUMN IF NOT EXISTS snapshot jsonb"));
pass("the tables are declared in the drizzle schema", schema.includes('pgTable("payroll_holidays"') && schema.includes('pgTable("payroll_payments"'));
pass("the schema version moved so an existing database self-heals", (/SCHEMA_VERSION = "(\d{4}-\d{2}-\d{2}-\d+)"/.exec(migrate)?.[1] ?? "") >= "2026-10-22-3");

/* ── 3b. the salary cells take cents ─────────────────────────────────────── */

pass(
  "a salary with cents reaches the database as a decimal, not a whole number",
  payrollApi.includes("COALESCE($2::numeric,0)") && payrollApi.includes("COALESCE($3::numeric,0)")
);
pass(
  "the parameter is cast because a bare COALESCE($2,0) is typed as integer by Postgres",
  payrollApi.includes("$2::numeric") && payrollApi.includes("COALESCE($3::numeric,payroll_compensation.transport_allowance)")
);
pass(
  "a column that still rounds the cents away is caught and the save is retried",
  payrollApi.includes("RoundedMoneyColumnError") && payrollApi.includes("RETURNING basic_salary,transport_allowance")
);
pass(
  "overtime hours keep their half hour too",
  payrollApi.includes("$4::numeric") && payrollApi.includes("RETURNING hours")
);
pass(
  "the five whole-number columns from the old build are converted in place",
  ["payroll_compensation", "payroll_monthly_inputs", "payroll_overtime_entries"].every((t) => migrate.includes(`["${t}"`)) &&
    migrate.includes('["payroll_compensation", "basic_salary"]') &&
    migrate.includes('["payroll_compensation", "transport_allowance"]') &&
    migrate.includes('["payroll_overtime_entries", "hours"]') &&
    migrate.includes("ALTER COLUMN ${column} TYPE numeric(14,2)")
);
pass(
  "only a column that is still wrong is rewritten, so a healthy database is not touched",
  migrate.includes("numeric_scale") && migrate.includes('live.data_type === "numeric"')
);
pass(
  "the payroll page repairs on its own first visit, without waiting for a deploy",
  payrollApi.includes("ensureMoneyColumns()") && payrollApi.includes("moneyColumnsChecked")
);
pass(
  "the schema version moved so an existing database self-heals",
  (/SCHEMA_VERSION = "(\d{4}-\d{2}-\d{2}-\d+)"/.exec(migrate)?.[1] ?? "") >= "2026-10-23-1"
);

/* ── 4. the screen ───────────────────────────────────────────────────────── */

pass("salary and transport are typed; breakage comes only from Store", ["basicSalary", "transportAllowance"].every((f) => payrollTab.includes(`askSave(r, "${f}"`)) && !payrollTab.includes('askSave(r, "breakageShortage"') && payrollTab.includes("Recorded in Store"));
pass("Enter asks before anything is saved", payrollTab.includes("if (e.key === \"Enter\") submit();") && payrollTab.includes("Save and recalculate") && payrollTab.includes("Don't save"));
pass("the confirm shows the net pay before and after", payrollTab.includes("previewNet(") && payrollTab.includes("Net pay:"));
pass("the rows recalculate after a save", payrollTab.includes("recalculated") && payrollApi.includes("incomeTax"));
pass("the old action buttons are gone and one Paid button is in their place", !payrollTab.includes("editComp") && !payrollTab.includes("addOt(") && payrollTab.includes("> Paid"));
pass("the paid button becomes a green tick", payrollTab.includes("bg-emerald-600") && payrollTab.includes("CheckCircle2"));
pass("the holiday dates open from the payroll page", payrollTab.includes("HolidayManagerDialog") && payrollTab.includes("Holiday dates ("));
pass("the Holiday OT label itself opens the holiday dates on the Attendance page", attendanceTab.includes("HolidayManagerDialog") && attendanceTab.includes("Holiday dates"));
pass("the row's OT number opens all four kinds and the overtime history", payrollTab.includes("OvertimeDialog") && payrollTab.includes("otBreakdown") && payrollTab.includes("Night shift OT"));
pass("the printed sheet's date and month come from the selected payroll month", payrollApi.includes("dateEc: gregorianDateToEthiopian(bounds.to)") && payrollTab.includes("data?.letterhead?.monthLabel") && payrollTab.includes("data?.letterhead?.dateEc"));
pass("'Don't give' keeps the row in the history and can be given again", payrollTab.includes('action: entry.excluded ? "give_again" : "dont_give"') && attendanceTab.includes('action: excluded ? "give_again" : "dont_give"') && payrollTab.includes("Give again") && attendanceTab.includes("Don't give"));
pass("Attendance Overtime view shows Overtime history with type filter and weekday", attendanceTab.includes("otVisibleRows") && attendanceTab.includes("Overtime history") && attendanceTab.includes("weekdayName(row.date)"));
const overtimeApi = read("src/app/api/attendance/overtime/route.ts");
pass("the overtime API refuses a non-admin 'Don't give' decision", overtimeApi.includes('decision === "dont_give" || decision === "give_again"') && overtimeApi.includes('if (!isAdmin) return NextResponse.json({ error: "Only an admin can decide not to give overtime" }, { status: 403 })'));
pass("the decision is one row per person + day + kind, in its own table", schema.includes('pgTable("attendance_ot_exclusions"') && migrate.includes("CREATE TABLE IF NOT EXISTS attendance_ot_exclusions") && overtimeApi.includes("onConflictDoNothing()"));
pass("the overtime tab still has no approval language", !/approve|pending approval|reject/i.test(payrollTab.slice(payrollTab.indexOf("function OvertimeDialog"), payrollTab.indexOf("function ExceptionPanel"))));
pass("no user-visible payroll string carries an em dash", !/[—‒–]/.test(payrollTab + holidayApi + payrollApi));

/* ── 5. Ethiopian calendar helpers are untouched ─────────────────────────── */

const meskerem = ethiopianMonthBounds(2019, 1);
assert.match(meskerem.from, /^2026-09-/);
assert.match(meskerem.to, /^2026-10-/);
const pagumen = ethiopianMonthBounds(2018, 13);
assert.ok(Date.parse(pagumen.to) >= Date.parse(pagumen.from));
assert.equal(gregorianDateToEthiopian(ethiopianDateToGregorian("2019-02-15")), "2019-02-15");
assert.throws(() => ethiopianDateToGregorian("2018-13-06"), /has 5 days/);

console.log("");
if (failures > 0) {
  console.error(`\n❌ PAYROLL GUARD FAILED (${failures})\n`);
  process.exit(1);
}
console.log("✅ Payroll guard PASSED");
console.log("   • owner-typed salary and transport; Store breakage and other deductions calculated");
console.log("   • holiday dates, free week and extra-shift OT measured with the 1:15 buffer");
console.log("   • a mistaken OT stays in history: 'Don't give' excludes it from pay, 'Give again' restores it");
console.log("   • 1, 2, 3 numbering and one green Paid button per person");
console.log("   • salaries, transport, breakage and overtime hours stored with cents");
