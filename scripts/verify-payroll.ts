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
 * shift *1.5, with a one hour buffer after the shift end.
 *
 * What that means in code, checked here:
 *
 *   1. The safe formula evaluator still refuses anything that is not
 *      arithmetic, and the owner's three rates are the DEFAULTS, so a fresh or
 *      old install calculates instead of printing zeros.
 *   2. The overtime measurement (recognizedOtMinutes) follows his examples:
 *      a 30 minute arrival grace keeps the full shift, leaving within one hour
 *      of the shift end is not overtime, and staying two hours past the end
 *      pays two hours.
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
  DEFAULT_INCOME_TAX_FORMULA,
  DEFAULT_PAYROLL_FORMULAS,
  DEFAULT_PAYROLL_SETTINGS,
  OT_ARRIVAL_GRACE_MINUTES,
  OT_BUFFER_MINUTES,
  evaluatePayrollFormula,
  ethiopianDateToGregorian,
  ethiopianMonthBounds,
  gregorianDateToEthiopian,
  minutesToHours,
  recognizedOtMinutes,
  requiredPayrollSettingsMissing,
  withDefaultPayrollFormulas,
} from "../src/lib/payroll";
import { earlyOutMinutesFor, lateMinutesFor, shiftOtMinutesFor } from "../src/lib/attendance";

let failures = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
  if (!cond) failures++;
};
const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

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

/* ── 2. the one hour buffer and the 30 minute grace ──────────────────────── */

const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+03:00`);
const d15 = "2026-10-15";
const dayShift = { label: "Day", startTime: "08:00", endTime: "17:00" };
const freeWeekShift = { label: "12 to 8", startTime: "06:00", endTime: "14:00" };
const night = { label: "Night", startTime: "18:00", endTime: "03:00" };
const log = (inAt: Date, outAt: Date) => ({ clockIn: inAt, clockOut: outAt });

pass("the owner's buffer is one hour", OT_BUFFER_MINUTES === 60);
pass("the arrival grace is 30 minutes", OT_ARRIVAL_GRACE_MINUTES === 30);
pass("arriving 10 minutes late still earns the whole 9 hour shift", recognizedOtMinutes(dayShift, log(at(d15, "08:10"), at(d15, "17:00"))) === 540);
pass("arriving 45 minutes late loses only the 15 minutes past the grace", recognizedOtMinutes(dayShift, log(at(d15, "08:45"), at(d15, "17:00"))) === 525);
pass("leaving exactly one hour after the end is still not overtime", recognizedOtMinutes(dayShift, log(at(d15, "08:05"), at(d15, "18:00"))) === 540);
pass("one minute past the hour pays every minute past the shift end", recognizedOtMinutes(dayShift, log(at(d15, "08:05"), at(d15, "18:01"))) === 601);
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
pass("Shift OT itself still starts after one hour past the end", shiftOtMinutesFor(dayShift, at(d15, "18:00")) === 0 && shiftOtMinutesFor(dayShift, at(d15, "18:01")) === 61);
pass("late and early rules are unchanged", lateMinutesFor({ ...dayShift, lateGraceMinutes: 30 }, 8 * 60 + 40) === 10 && earlyOutMinutesFor(dayShift, 16 * 60 + 30) === 30);

/* ── 3. the API calculates, and numbers the rows 1..n ────────────────────── */

const payrollApi = read("src/app/api/payroll/route.ts");
const holidayApi = read("src/app/api/payroll/holidays/route.ts");
const payrollTab = read("src/components/rms/PayrollTab.tsx");
const attendanceTab = read("src/components/rms/AttendanceTab.tsx");
const schema = read("src/db/schema.ts");
const migrate = read("src/db/migrate.ts");

pass("the payroll reads the overtime rows the tablet and the clock already wrote", payrollApi.includes("FROM attendance_overtime"));
pass("it measures holiday and free week hours with the buffer rule", payrollApi.includes("recognizedOtMinutes(shift, log)"));
pass("it measures a normal shift past its end too", payrollApi.includes("shiftOtMinutesFor(shift, log.clock_out)"));
pass("a day is one overtime kind: a person's row wins, and the clock's own row never beats a holiday or a free day", payrollApi.includes("manualDates.has(date)") && payrollApi.includes("holidayByDate.get(date)") && payrollApi.includes("isFree(date)"));
pass("the No. column is the position in this list, never the database id", payrollApi.includes("employeeNumber: index + 1") && !payrollApi.includes("employeeNumber: memberId"));
pass("the three typed numbers are the only compensation input", payrollApi.includes("basicSalary") && payrollApi.includes("transportAllowance") && payrollApi.includes("breakageShortage"));
pass("a paid person is locked against edits", payrollApi.includes("already paid for this month"));
pass("one paid row per person per month", payrollApi.includes("INSERT INTO payroll_payments") && payrollApi.includes("DELETE FROM payroll_payments"));
pass("the holiday API stores an Ethiopian date and its name", holidayApi.includes("ethiopianDateToGregorian") && holidayApi.includes("payroll_holidays"));
pass("a holiday is one row per day", migrate.includes("CREATE UNIQUE INDEX IF NOT EXISTS payroll_holidays_date_key"));
pass("paid rows are one per person per month in the migration too", migrate.includes("CREATE UNIQUE INDEX IF NOT EXISTS payroll_payments_period_member_key"));
pass("the tables are declared in the drizzle schema", schema.includes('pgTable("payroll_holidays"') && schema.includes('pgTable("payroll_payments"'));
pass("the schema version moved so an existing database self-heals", (/SCHEMA_VERSION = "(2026-10-22-\d+)"/.exec(migrate)?.[1] ?? "") >= "2026-10-22-2");

/* ── 4. the screen ───────────────────────────────────────────────────────── */

pass("the salary, transport and breakage cells are typed", ["basicSalary", "transportAllowance", "breakageShortage"].every((f) => payrollTab.includes(`askSave(r, "${f}"`)) && payrollTab.includes("EditableMoneyCell"));
pass("Enter asks before anything is saved", payrollTab.includes("if (e.key === \"Enter\") submit();") && payrollTab.includes("Save and recalculate") && payrollTab.includes("Don't save"));
pass("the confirm shows the net pay before and after", payrollTab.includes("previewNet(") && payrollTab.includes("Net pay:"));
pass("the rows recalculate after a save", payrollTab.includes("recalculated") && payrollApi.includes("incomeTax"));
pass("the old action buttons are gone and one Paid button is in their place", !payrollTab.includes("editComp") && !payrollTab.includes("addOt(") && payrollTab.includes("> Paid"));
pass("the paid button becomes a green tick", payrollTab.includes("bg-emerald-600") && payrollTab.includes("CheckCircle2"));
pass("the holiday dates open from the payroll page", payrollTab.includes("HolidayManagerDialog") && payrollTab.includes("Holiday dates ("));
pass("the Holiday OT label itself opens the holiday dates on the Attendance page", attendanceTab.includes("HolidayManagerDialog") && attendanceTab.includes("Holiday dates"));
pass("the row's OT number opens the three kinds and the measured rows", payrollTab.includes("OvertimeDialog") && payrollTab.includes("otBreakdown"));
pass("the buffer is explained on both screens", payrollTab.includes("within one hour of his shift end") && attendanceTab.includes("within one hour after the shift end"));
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
console.log("   • owner-typed salary, transport and breakage; everything else calculated");
console.log("   • holiday dates, free week and shift OT measured with the one hour buffer");
console.log("   • 1, 2, 3 numbering and one green Paid button per person");
