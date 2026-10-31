#!/usr/bin/env tsx
/**
 * Regression guard: THE OWNER'S PER-MINUTE DEDUCTION RULE (2026-10-27).
 *
 * His words: "assume an employee earns a net salary of 6,000 ETB per month"
 *   6,000 / 30 days = 200 ETB a day; / 8 hours = 25 ETB an hour;
 *   / 60 = 0.4167 ETB a minute. Ignore the first 20 minutes and charge only
 *   the minutes past it: 25 late -> 5 minutes -> 2.08 ETB.
 * The salary is the Basic Salary box he already types per employee (the same
 * base the three overtime rates use). NetSalary stays available as an option.
 *
 * And his change: "it was 30 min grace time but i am thinking to make it based
 * on the time of Maximum Late Time (min) and Leaving Grace (min) i enter ...
 * if someone max early time leaving is 20 and he left before 25 he will be
 * fined that 5 min". So the formula has NO fixed 20 or 30 in it: the attendance
 * measurement removes the grace of each person's OWN role, and the payroll
 * receives chargeable minutes only. Early leaving costs exactly the same.
 *
 * Run with: npx tsx scripts/verify-minute-deductions.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_EARLY_OUT_FORMULA,
  DEFAULT_LATENESS_FORMULA,
  DEFAULT_PAYROLL_SETTINGS,
  MAX_CHARGEABLE_MINUTES_PER_DAY,
  PAYROLL_MINUTES_PER_MONTH,
  PAYROLL_VARIABLES,
  chargeableDayMinutes,
  evaluatePayrollFormula,
  minuteDeductionRate,
  netSalaryForMinuteRule,
  withDefaultPayrollFormulas,
} from "../src/lib/payroll";
import { earlyOutMinutesFor, lateMinutesFor, type RoleShift } from "../src/lib/attendance";

let failures = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
  if (!cond) failures++;
};
const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/* ── 1. the rate itself, straight from his arithmetic ────────────────────── */

const NET = 6000;
const dayShift: RoleShift = { label: "Day", startTime: "08:00", endTime: "17:00" };
const startMinutes = 8 * 60;
const endMinutes = 17 * 60;

pass("a payroll month is 30 days of 8 hours of 60 minutes", PAYROLL_MINUTES_PER_MONTH === 14400);
pass("200 ETB a day, 25 ETB an hour, 0.4167 ETB a minute", minuteDeductionRate(NET) === 6000 / 14400 && Number(minuteDeductionRate(NET).toFixed(4)) === 0.4167);
pass("one chargeable minute costs 0.42 ETB once rounded to money", evaluatePayrollFormula(DEFAULT_LATENESS_FORMULA, { BasicSalary: NET, LateMinutes: 1 }) === 0.42);
pass("the exact fraction is used, never a pre-rounded 0.42 ETB/min", evaluatePayrollFormula(DEFAULT_LATENESS_FORMULA, { BasicSalary: NET, LateMinutes: 40 }) === 16.67);
pass(
  "the shipped rules divide by BasicSalary, the one salary the owner types",
  DEFAULT_LATENESS_FORMULA.startsWith("BasicSalary / 30 / 8 / 60") &&
    DEFAULT_EARLY_OUT_FORMULA.startsWith("BasicSalary / 30 / 8 / 60")
);
pass(
  "one missed hour costs the same 25 ETB the overtime formulas pay for one hour",
  evaluatePayrollFormula(DEFAULT_LATENESS_FORMULA, { BasicSalary: NET, LateMinutes: 60 }) ===
    evaluatePayrollFormula("BasicSalary / 30 / 8", { BasicSalary: NET })
);
pass(
  "changing one word to NetSalary still works, for a take-home-based rate",
  evaluatePayrollFormula("NetSalary / 30 / 8 / 60 * MAX(0, LateMinutes)", { NetSalary: NET, LateMinutes: 5 }) === 2.08
);

/* ── 2. his worked table, with a 20 minute grace in the ROLE ─────────────── */

const role20: RoleShift = { ...dayShift, lateGraceMinutes: 20, earlyLeaveGraceMinutes: 20 };
const table: Array<[number, number, number]> = [
  [10, 0, 0],
  [20, 0, 0],
  [25, 5, 2.08],
  [30, 10, 4.17],
  [45, 25, 10.42],
  [60, 40, 16.67],
];
for (const [actual, chargeable, deduction] of table) {
  const measured = lateMinutesFor(role20, startMinutes + actual);
  const money = evaluatePayrollFormula(DEFAULT_LATENESS_FORMULA, { BasicSalary: NET, LateMinutes: measured });
  pass(
    `${actual} minutes late with a 20 minute Maximum Late Time -> ${chargeable} chargeable minutes -> ${deduction} ETB`,
    measured === chargeable && money === deduction,
    `measured ${measured} min and ${money} ETB`
  );
}

/* ── 3. the grace is the ROLE's, not the fixed 20 or 30 of the draft ─────── */

pass(
  "a role with 30 minutes of Maximum Late Time owes nothing at 25 minutes",
  evaluatePayrollFormula(DEFAULT_LATENESS_FORMULA, {
    BasicSalary: NET,
    LateMinutes: lateMinutesFor({ ...dayShift, lateGraceMinutes: 30 }, startMinutes + 25),
  }) === 0
);
pass(
  "a role with 0 minutes of Maximum Late Time is charged all 25 minutes",
  evaluatePayrollFormula(DEFAULT_LATENESS_FORMULA, {
    BasicSalary: NET,
    LateMinutes: lateMinutesFor({ ...dayShift, lateGraceMinutes: 0 }, startMinutes + 25),
  }) === 10.42
);
pass(
  "the shipped formulas subtract no hard-coded grace at all",
  !/-\s*\d+/.test(DEFAULT_LATENESS_FORMULA + DEFAULT_EARLY_OUT_FORMULA) &&
    !DEFAULT_LATENESS_FORMULA.includes("LateMinutes - ") &&
    !DEFAULT_EARLY_OUT_FORMULA.includes("EarlyOutMinutes - ")
);

/* ── 4. early leaving: his own example, 20 min grace, left 25 min early ──── */

const leftEarlyBy = (minutes: number) => earlyOutMinutesFor(role20, endMinutes - minutes);
pass("leaving 20 minutes early inside the Leaving Grace costs nothing", leftEarlyBy(20) === 0);
pass("leaving 25 minutes early with a 20 minute Leaving Grace charges 5 minutes", leftEarlyBy(25) === 5);
pass("those 5 minutes cost 2.08 ETB, the same as 5 late minutes", evaluatePayrollFormula(DEFAULT_EARLY_OUT_FORMULA, { BasicSalary: NET, EarlyOutMinutes: leftEarlyBy(25) }) === 2.08);
pass("leaving 60 minutes early costs 16.67 ETB", evaluatePayrollFormula(DEFAULT_EARLY_OUT_FORMULA, { BasicSalary: NET, EarlyOutMinutes: leftEarlyBy(60) }) === 16.67);
pass(
  "lateness and early departure are the SAME rate",
  DEFAULT_LATENESS_FORMULA.replace("LateMinutes", "X") === DEFAULT_EARLY_OUT_FORMULA.replace("EarlyOutMinutes", "X")
);

/* ── 5. proportional to the person's own salary ─────────────────────────── */

pass("double the basic salary costs double the money for the same 5 minutes", evaluatePayrollFormula(DEFAULT_LATENESS_FORMULA, { BasicSalary: 12000, LateMinutes: 5 }) === 4.17);
pass("a person with no salary entered is charged nothing", evaluatePayrollFormula(DEFAULT_LATENESS_FORMULA, { BasicSalary: 0, LateMinutes: 40 }) === 0);
pass("NetSalary is gross minus income tax and the employee pension", netSalaryForMinuteRule(7120, 700, 420) === 6000);
pass("NetSalary can never be negative", netSalaryForMinuteRule(100, 200, 0) === 0);
pass("NetSalary is an approved formula field", (PAYROLL_VARIABLES as readonly string[]).includes("NetSalary"));

/* ── 6. MAX() / MIN(), and the safety of the evaluator ───────────────────── */

pass("his literal draft formula evaluates too", evaluatePayrollFormula("NetSalary / (30 * 8 * 60) * MAX(0, LateMinutes - 20)", { NetSalary: NET, LateMinutes: 25 }) === 2.08);
pass("MAX clamps a negative to zero", evaluatePayrollFormula("MAX(0, 5 - 20)", {}) === 0);
pass("MIN and nested calls work", evaluatePayrollFormula("MAX(0, MIN(40, 100))", {}) === 40);
assert.throws(() => evaluatePayrollFormula("MAX()", {}), /Incomplete formula|Invalid formula/);
assert.throws(() => evaluatePayrollFormula("ROUND(1.2)", {}), /Unknown field/);
assert.throws(() => evaluatePayrollFormula("process.exit()", {}), /Invalid formula|Unknown/);
pass("an unknown function is still refused, so no code can run", true);

/* ── 7. one bad day may not cost more than one day's wage ────────────────── */

pass("an ordinary day is untouched by the cap", JSON.stringify(chargeableDayMinutes(5, 10)) === JSON.stringify({ late: 5, early: 10 }));
pass("a 10 hour lateness is capped at the 8 hours the rate assumes", chargeableDayMinutes(600, 0).late === MAX_CHARGEABLE_MINUTES_PER_DAY);
pass("late AND early on one day still cost at most one day", JSON.stringify(chargeableDayMinutes(600, 600)) === JSON.stringify({ late: 480, early: 0 }));
pass("no negative minutes are charged", JSON.stringify(chargeableDayMinutes(-5, -9)) === JSON.stringify({ late: 0, early: 0 }));
pass("480 chargeable minutes cost exactly 200 ETB, not more", evaluatePayrollFormula(DEFAULT_LATENESS_FORMULA, { BasicSalary: NET, LateMinutes: 480 }) === 200);

/* ── 8. every rule is editable, and absence is the owner's one-day rule ──── */

pass("the two minute boxes and the one-day absence box ship with the owner's rules", DEFAULT_PAYROLL_SETTINGS.latenessFormula === DEFAULT_LATENESS_FORMULA && DEFAULT_PAYROLL_SETTINGS.earlyOutFormula === DEFAULT_EARLY_OUT_FORMULA && DEFAULT_PAYROLL_SETTINGS.absenceFormula === "BasicSalary / 30 * UnapprovedAbsences");
pass("a fresh install gets the rule without a settings row", withDefaultPayrollFormulas({}).latenessFormula === DEFAULT_LATENESS_FORMULA);
pass("emptying a box switches the deduction off, permanently", withDefaultPayrollFormulas({ latenessFormula: "" }).latenessFormula === "" && withDefaultPayrollFormulas({ earlyOutFormula: "  " }).earlyOutFormula === "");
pass("a formula the owner typed is kept", withDefaultPayrollFormulas({ latenessFormula: "BasicSalary / 30 / 8 / 60 * LateMinutes" }).latenessFormula === "BasicSalary / 30 / 8 / 60 * LateMinutes");
pass("an empty formula deducts zero", evaluatePayrollFormula("0", {}) === 0);

/* ── 9. the whole path, from the role screen to the payslip ──────────────── */

const payrollApi = read("src/app/api/payroll/route.ts");
const settingsApi = read("src/app/api/payroll/settings/route.ts");
const payrollTab = read("src/components/rms/PayrollTab.tsx");
const attendanceTab = read("src/components/rms/AttendanceTab.tsx");
const clockApi = read("src/app/api/attendance/clock/route.ts");
const migrate = read("src/db/migrate.ts");

pass("the role screen has both grace fields the owner enters", attendanceTab.includes('Maximum Late Time (min)') && attendanceTab.includes("Leaving Grace (min)"));
pass("the door reads each role's own grace values", clockApi.includes("lateGraceMinutes: Number(r.lateGraceMinutes") && clockApi.includes("earlyLeaveGraceMinutes: Number(r.earlyLeaveGraceMinutes"));
pass("payroll reads the role shifts with their grace columns", payrollApi.includes("late_grace_minutes,early_leave_grace_minutes"));
pass("payroll re-measures the scans with the role's grace and caps the day", payrollApi.includes("chargeableDayMinutes(rawLate, rawEarly)"));
pass("free days and approved exceptions are still never charged", payrollApi.includes("!excusedLate.has(l.date) && !l.isFree") && payrollApi.includes("!excusedEarly.has(l.date) && !l.isFree"));
pass("the API row uses the Excel-precision money chain", payrollApi.includes("computePayrollMoney({") && payrollApi.includes("pay.incomeTax"));
pass("the live preview uses the very same money chain", payrollTab.includes("computePayrollMoney({") && payrollTab.includes("pay.display.netPay"));
pass("settings validates MAX(), MIN() and NetSalary with a sample row", settingsApi.includes("PAYROLL_VARIABLES.map") && settingsApi.includes("evaluatePayrollFormula(formula, example)"));
pass("Formula Settings keeps the per-minute formulas editable with clean titles", payrollTab.includes("BasicSalary / 30 / 8 / 60 * MAX(0, LateMinutes)") && payrollTab.includes("Payroll formula settings") && !payrollTab.includes("The per-minute rule."));
pass(
  "old databases are seeded with the BasicSalary rules exactly once",
  migrate.includes("payroll_minute_rule_2026_10_27") &&
    migrate.includes('const latenessRule = "BasicSalary / 30 / 8 / 60 * MAX(0, LateMinutes)"') &&
    migrate.includes('const earlyOutRule = "BasicSalary / 30 / 8 / 60 * MAX(0, EarlyOutMinutes)"') &&
    migrate.includes("jsonb_strip_nulls")
);
pass("the interim NetSalary defaults are upgraded to the final rules", migrate.includes("minute rule base upgrade") && migrate.includes("NetSalary / 30 / 8 / 60 * MAX(0, LateMinutes)"));
pass("an absent day is charged once, and never for today before it is finished", DEFAULT_PAYROLL_SETTINGS.absenceFormula === "BasicSalary / 30 * UnapprovedAbsences" && payrollApi.includes("d < today && !presentDates.has(d)"));

console.log("");
if (failures > 0) {
  console.error(`\n❌ MINUTE DEDUCTION GUARD FAILED (${failures})\n`);
  process.exit(1);
}
console.log("✅ Minute deduction guard PASSED");
console.log("   • BasicSalary / 30 / 8 / 60 = 0.4167 ETB/min for 6,000 ETB typed in Basic Salary");
console.log("   • the grace is each role's Maximum Late Time / Leaving Grace, never a fixed 20 or 30");
console.log("   • early leaving costs the same, one day is capped at one day's wage, absence costs one day");
