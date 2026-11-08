#!/usr/bin/env tsx
/**
 * Regression guard: NOTHING IS DEDUCTED OR PAID BY ITSELF (owner, 2026-11-08).
 *
 * His words, twice in one evening:
 *   "when someone is late or absent it comes there, abnet late 30 min, deduct /
 *    dont deduct. dont deduct if they come with reasonable way"
 *   "for overtime and absent and late and early out it waits for the supervisor
 *    confirmation"
 *
 * So every lateness, early departure, absence and overtime row of a month is
 * PENDING until a person presses one of two buttons, and a pending row is
 * neither charged nor paid. This script pins that rule at every layer:
 *
 *   1. the pure rule (lib/attendance-decisions): what a decision means in money,
 *      the two button labels, the headline the owner dictated, the ordering;
 *   2. the month builder (lib/attendance-month-events): today is never an
 *      absence yet, a free day is never an absence, a person is not absent
 *      before he was hired, and the measurement is shown before a decision;
 *   3. the ledger the payroll page reads (payroll_deduction_decisions), and that
 *      only a `deduct` row moves money;
 *   4. the overtime gate: only a supervisor's ADD is paid;
 *   5. the screen: the kiosk link is GONE from Attendance, its place is the
 *      report, and the two buttons say Deduct / Do not deduct;
 *   6. the 20 default groups.
 *
 * Run with: npx tsx scripts/verify-attendance-decisions.ts  (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ATTENDANCE_DECISION_KINDS,
  confirmedForPayroll,
  decisionButtonLabels,
  decisionHeadline,
  decisionIsChargeable,
  decisionKey,
  pendingCounts,
  sortDecisionEvents,
  type DecisionEvent,
} from "../src/lib/attendance-decisions";
import {
  DEFAULT_GROUP_COUNT,
  defaultGroupLabels,
  groupNumbersForGrid,
} from "../src/lib/group-grid";
import { DEFAULT_ABSENCE_FORMULA, DEFAULT_PAYROLL_SETTINGS, DEFAULT_LATENESS_FORMULA, computePayrollMoney } from "../src/lib/payroll";
import { STAFF_AM } from "../src/lib/staff-dictionary";

let failures = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
  if (!cond) failures++;
};
const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const route = read("src/app/api/payroll/route.ts");
const decisionsApi = read("src/app/api/attendance/decisions/route.ts");
const monthEvents = read("src/lib/attendance-month-events.ts");
const adminTab = read("src/components/rms/AttendanceTab.tsx");
const panel = read("src/components/rms/DeductionReportPanel.tsx");
const migrate = read("src/db/migrate.ts");
const payrollTab = read("src/components/rms/PayrollTab.tsx");

const event = (over: Partial<DecisionEvent>): DecisionEvent => ({
  memberId: 1,
  memberName: "abnet",
  date: "2026-11-07",
  dateEc: "Hidar 28, 2019",
  type: "lateness",
  minutes: 30,
  status: "pending",
  decidedBy: "",
  reason: "",
  affectsMoney: false,
  ...over,
});

/* ── 1. the pure rule ─────────────────────────────────────────────────── */

pass(
  "a pending event costs nothing and pays nothing",
  decisionIsChargeable("lateness", "pending") === false &&
    decisionIsChargeable("absence", "pending") === false &&
    decisionIsChargeable("overtime", "pending") === false
);
pass(
  "an approved lateness is charged, a denied one is not",
  decisionIsChargeable("lateness", "approved") && !decisionIsChargeable("lateness", "denied")
);
pass(
  "an approved overtime pays, a denied one does not",
  decisionIsChargeable("overtime", "approved") && !decisionIsChargeable("overtime", "denied")
);
pass(
  "the event key is type + person + day, so a late AND an early leave on one day are two decisions",
  decisionKey({ type: "lateness", memberId: 7, date: "2026-11-07" }) === "lateness|7|2026-11-07" &&
    decisionKey({ type: "early_out", memberId: 7, date: "2026-11-07" }) !==
      decisionKey({ type: "lateness", memberId: 7, date: "2026-11-07" })
);

const mixed = [
  event({ type: "lateness", minutes: 30, status: "approved" }),
  event({ type: "lateness", minutes: 20, status: "denied", date: "2026-11-06" }),
  event({ type: "lateness", minutes: 45, status: "pending", date: "2026-11-05" }),
  event({ type: "early_out", minutes: 15, status: "approved" }),
  event({ type: "absence", minutes: 0, status: "approved", date: "2026-11-04" }),
  event({ type: "absence", minutes: 0, status: "denied", date: "2026-11-03" }),
  event({ type: "absence", minutes: 0, status: "pending", date: "2026-11-02" }),
];
const money = confirmedForPayroll(mixed);
pass(
  "only APPROVED minutes reach the payroll inputs",
  money.lateMinutes === 30 && money.earlyOutMinutes === 15,
  `late=${money.lateMinutes} early=${money.earlyOutMinutes}`
);
pass(
  "only APPROVED absences are charged, denied ones are excused, pending ones are neither",
  money.unapprovedAbsences === 1 && money.approvedAbsences === 1,
  `charged=${money.unapprovedAbsences} excused=${money.approvedAbsences}`
);
pass("the pending count is what the badge shows", pendingCounts(mixed).total === 2);
pass(
  "the two buttons are the owner's own words",
  decisionButtonLabels("lateness").confirm === "Deduct" &&
    decisionButtonLabels("lateness").deny === "Do not deduct" &&
    decisionButtonLabels("overtime").confirm === "Add overtime" &&
    decisionButtonLabels("overtime").deny === "Do not add"
);
pass(
  "the row reads the way he dictated it",
  decisionHeadline({ memberName: "abnet", type: "lateness", minutes: 30, date: "2026-11-07" }, "2026-11-07", "2026-11-06") ===
    "abnet - late 30 min" &&
    decisionHeadline({ memberName: "abnet", type: "absence", minutes: 0, date: "2026-11-07" }, "2026-11-07", "2026-11-06") ===
      "abnet - absent today" &&
    decisionHeadline({ memberName: "abnet", type: "absence", minutes: 0, date: "2026-11-06" }, "2026-11-07", "2026-11-06") ===
      "abnet - absent yesterday"
);
const sorted = sortDecisionEvents([
  event({ date: "2026-11-05", type: "absence" }),
  event({ date: "2026-11-07", type: "early_out" }),
  event({ date: "2026-11-07", type: "lateness" }),
]);
pass(
  "the newest day is on top and lateness comes before early leave",
  sorted[0].date === "2026-11-07" && sorted[0].type === "lateness" && sorted[1].type === "early_out"
);

/* ── 2. the month builder ─────────────────────────────────────────────── */

pass(
  "today is never an absence yet (the day is still being worked)",
  monthEvents.includes("if (date >= today) continue;")
);
pass("a free day is never an absence", monthEvents.includes("if (isFree(date)) continue;"));
pass(
  "a person is not absent for days before he was hired",
  monthEvents.includes("member.employment_started_at") && monthEvents.includes("const startsOn =")
);
pass(
  "the measured minutes are shown BEFORE a decision, so the row can say late 30 min",
  monthEvents.includes("minutes,") && !monthEvents.includes('minutes: status === "pending" ? 0 : minutes')
);
pass(
  "absence is the whole-day kind with no minutes",
  monthEvents.includes('push(date, "absence", 0)')
);
pass(
  "the ledger is the decision, and an old payroll_exceptions row still means do not deduct",
  monthEvents.includes("payroll_deduction_decisions") && monthEvents.includes("payroll_exceptions")
);

/* ── 3. the ledger the payroll page reads ─────────────────────────────── */

pass(
  "the ledger table exists and one event has one row",
  migrate.includes("CREATE TABLE IF NOT EXISTS payroll_deduction_decisions") &&
    migrate.includes("UNIQUE(period_key, member_id, attendance_date, event_type)")
);
pass(
  "a decision is upserted, so pressing the other button changes the answer",
  decisionsApi.includes("ON CONFLICT(period_key,member_id,attendance_date,event_type)") &&
    decisionsApi.includes("DO UPDATE SET decision=$5")
);
pass(
  "every press is audited with the name of the person who pressed it",
  decisionsApi.includes("'attendance_decision'") && decisionsApi.includes("decided_by")
);
pass(
  "the payroll charges lateness only on a day the supervisor pressed Deduct",
  route.includes("const chargedLate = decidedDeduct(\"lateness\")") &&
    route.includes("deductibleLate = lateLogs.filter((l) => chargedLate.has(l.date)")
);
pass(
  "the payroll charges an absence only on a day the supervisor pressed Deduct",
  route.includes("const chargedAbsence = decidedDeduct(\"absence\")") &&
    route.includes("unapprovedAbsences: absenceDates.filter((d) => chargedAbsence.has(d)")
);
pass(
  "the payroll charges leaving early only on a day the supervisor pressed Deduct",
  route.includes("const chargedEarly = decidedDeduct(\"early_out\")") &&
    route.includes("deductibleEarly = earlyLogs.filter((l) => chargedEarly.has(l.date)")
);

/* ── 4. overtime waits too ────────────────────────────────────────────── */

pass(
  "an overtime row earns nothing until the supervisor adds it",
  route.includes("overtimeApproved(String(r.date), String(r.type))") &&
    route.includes("const approvedOtMinutes =")
);
pass(
  "the automatic holiday overtime waits for the same press",
  route.includes('const approvedMinutes = approvedOtMinutes(date, "holiday")') &&
    route.includes("Math.min(minutes, approvedMinutes)")
);
pass(
  "the old hours form waits too",
  route.includes("Math.min(Number(o.hours) || 0, approved)")
);
pass(
  "Add overtime confirms the existing row instead of duplicating the same hours",
  decisionsApi.includes("SELECT id, source FROM attendance_overtime WHERE member_id=$1 AND date=$2 AND type=$3") &&
    decisionsApi.includes("else if (taken.rows[0])")
);

/* ── 5. the screen ────────────────────────────────────────────────────── */

pass(
  "the Open Kiosk button is gone from the admin attendance tab",
  !adminTab.includes('href="/attendance"') && !adminTab.includes("Open Kiosk /attendance")
);
pass(
  "its place is the Deduction Report",
  adminTab.includes('{ key: "decisions"') &&
    adminTab.includes("Deduction Report") &&
    adminTab.includes("<DeductionReportPanel")
);
pass(
  "the report shows the count still waiting for a person",
  adminTab.includes("pendingDecisions > 0") && adminTab.includes("loadPendingDecisions")
);
pass(
  "each pending row offers Deduct and Do not deduct side by side",
  panel.includes('decide(e, "deduct")') &&
    panel.includes('decide(e, "dont_deduct")') &&
    panel.includes("decisionButtonLabels(e.type)")
);
pass(
  "the report says in plain words that nothing moves until he decides",
  panel.includes("Nothing is deducted until you decide") && panel.includes("Reasonable excuse")
);
pass(
  "a decided row cannot be pressed again (no second deduction)",
  panel.includes("const settled = e.status !== \"pending\"") && panel.includes("settled ? (")
);
pass(
  "an approved or paid month cannot be re-decided later",
  decisionsApi.includes('periodStatus === "approved" || periodStatus === "paid"') &&
    decisionsApi.includes("so its decisions are locked") &&
    panel.includes("data?.locked")
);
pass(
  "the payroll screen warns while rows are still waiting",
  payrollTab.includes("pendingDecisions?.total") && payrollTab.includes("Open the report")
);

/* ── 6. the money itself still follows his formulas ───────────────────── */

const charged = computePayrollMoney({
  basicSalary: 6000,
  transportAllowance: 600,
  breakageShortage: 0,
  settings: DEFAULT_PAYROLL_SETTINGS,
  attendance: {
    // 30 chargeable minutes, approved
    LateMinutes: 30,
    EarlyOutMinutes: 0,
    UnapprovedAbsences: 1,
    ApprovedAbsences: 2,
    // one approved hour of shift overtime
    ShiftOtHours: 1,
  },
  prorationFactor: 1,
}).display;
const minuteRate = 6000 / 30 / 8 / 60;
pass(
  "the approved lateness is minutes x BasicSalary/30/8/60",
  Math.abs(charged.latenessDeduction - 30 * minuteRate) < 0.01,
  `${charged.latenessDeduction} vs ${30 * minuteRate}`
);
pass(
  "one charged absence is one whole day (BasicSalary / 30)",
  Math.abs(charged.absenceDeduction - 200) < 0.01,
  String(charged.absenceDeduction)
);
pass(
  "one approved shift overtime hour is 1.5 hours of pay",
  Math.abs(charged.overtimePay - 37.5) < 0.01,
  String(charged.overtimePay)
);

const nothing = computePayrollMoney({
  basicSalary: 6000,
  transportAllowance: 600,
  breakageShortage: 0,
  settings: DEFAULT_PAYROLL_SETTINGS,
  attendance: { LateMinutes: 0, EarlyOutMinutes: 0, UnapprovedAbsences: 0, ApprovedAbsences: 4, ShiftOtHours: 0 },
  prorationFactor: 1,
}).display;
pass(
  "a month where nobody decided takes no deduction and pays no overtime",
  nothing.latenessDeduction === 0 && nothing.earlyOutDeduction === 0 && nothing.absenceDeduction === 0 && nothing.overtimePay === 0,
  JSON.stringify(nothing)
);

/* ── 7. the 20 default groups ─────────────────────────────────────────── */

pass("twenty groups are the default", DEFAULT_GROUP_COUNT === 20 && defaultGroupLabels().length === 20);
pass(
  "they are GROUP 1 to GROUP 20, in order",
  defaultGroupLabels()[0] === "GROUP 1" && defaultGroupLabels()[19] === "GROUP 20"
);
pass(
  "a night that goes past 20 keeps its higher numbers on the grid",
  groupNumbersForGrid([{ tableName: "GROUP 23" }]).includes(23) &&
    groupNumbersForGrid([{ tableName: "GROUP 23" }]).includes(1)
);
pass(
  "an open bill is never listed twice",
  groupNumbersForGrid([{ tableName: "GROUP 4" }, { tableName: "GROUP 4" }]).filter((n) => n === 4).length === 1
);
pass(
  "the server accepts a tapped number only while it is free",
  read("src/lib/group-orders.ts").includes("export async function groupNumberForNewBillInTx") &&
    read("src/lib/group-orders.ts").includes("if (want > 0 && !taken.has(want)) return want;")
);

/* ── 8. every new word exists in both languages ───────────────────────── */

const newPhrases = [
  "Deduction Report",
  "Decide deductions",
  "Deduct",
  "Do not deduct",
  "Add overtime",
  "Do not add",
  "Deducted",
  "Not deducted",
  "Waiting for me",
  "Nothing is deducted until you decide",
  "Reasonable excuse",
  "Another group",
];
for (const phrase of newPhrases) {
  pass(
    `"${phrase}" is in the Amharic dictionary`,
    Object.prototype.hasOwnProperty.call(STAFF_AM, phrase) && /[\u1200-\u137F]/.test((STAFF_AM as Record<string, string>)[phrase])
  );
}

pass(
  "the three attendance kinds are the only ones the report decides",
  ATTENDANCE_DECISION_KINDS.length === 3 &&
    ATTENDANCE_DECISION_KINDS.includes("lateness") &&
    ATTENDANCE_DECISION_KINDS.includes("early_out") &&
    ATTENDANCE_DECISION_KINDS.includes("absence")
);

// The defaults must remain his formulas (a changed default would change money).
pass(
  "the shipped deduction formulas are still his",
  DEFAULT_LATENESS_FORMULA.includes("LateMinutes") && DEFAULT_ABSENCE_FORMULA.includes("UnapprovedAbsences")
);

/* ── HE CAME ON HIS FREE DAY (owner, 2026-11-08) ───────────────────────────
 * "i entered free date with hour so that person doesnt come this mean no
 * scanning so the box will not be red /absent just the colour you chose with
 * free day text but if that person come and put his finger in report it can be
 * see the person name date ot because come in free day to show the reason adn
 * the same 2 button we add"
 */
const monthEventsSrc = read("src/lib/attendance-month-events.ts");
const payrollApiSrc = read("src/app/api/payroll/route.ts");
const attendanceTabSrc = read("src/components/rms/AttendanceTab.tsx");
const decisionsApiSrc = read("src/app/api/attendance/decisions/route.ts");

pass(
  "a scan on a free day is a row on the report, measured from the scan",
  monthEventsSrc.includes("isWorkedFreeDay(freeRules, date)") &&
    monthEventsSrc.includes('push(date, "overtime", minutes, shift?.label || null, "free_week")') &&
    monthEventsSrc.includes("recognizedOtMinutes(shift, {")
);
pass(
  "a ye amet ereft day is never that row (it is paid already)",
  monthEventsSrc.includes("isAnnualLeaveDate(freeRules, date)") &&
    payrollApiSrc.includes("isWorkedFreeDay(freeSchedules, date) && !isAnnualLeaveDate(freeSchedules, date)")
);
pass(
  "a free day is never an absence and never lateness",
  monthEventsSrc.includes("if (isFree(date)) continue;") && payrollApiSrc.includes("&& !isFree(d))")
);
pass(
  "the free day keeps its own colour and wording, never red absent, never early out",
  attendanceTabSrc.includes('free: "bg-violet-200 text-violet-950"') &&
    attendanceTabSrc.includes('free_worked: "bg-sky-200 text-sky-950"') &&
    attendanceTabSrc.includes("{cell.freeDay && (") &&
    attendanceTabSrc.includes("Worked free day") &&
    attendanceTabSrc.includes("{!cell.freeDay && !cell.isOvertime && !cell.stayedNextShift && cell.earlyOut && (")
);
pass(
  "the free-day hours pay only after Add overtime, clamped like a holiday",
  payrollApiSrc.includes("autoFreeWeekMinutes") &&
    payrollApiSrc.includes("if (!excluded) autoFreeWeekMinutes += Math.min(minutes, approvedMinutes)") &&
    decisionsApiSrc.includes('if (taken.rows[0] && taken.rows[0].source === "auto")')
);
// The bug this turn found on the live database: a pg timestamp is a Date, and
// String(date).slice(0,10) is "Sat Oct 11", which made the proration 0.
pass(
  "a typed employment start is read with etDayKey, never String(Date).slice",
  payrollApiSrc.includes("etDayKey(member.employment_started_at)") &&
    monthEventsSrc.includes("etDayKey(member.employment_started_at)") &&
    !/String\(member\.employment_started_at\)\.slice/.test(payrollApiSrc) &&
    !/String\(member\.employment_started_at\)\.slice/.test(monthEventsSrc)
);
pass(
  "a person is scheduled from the earliest honest signal, so a typed start of the 1st is a whole month",
  payrollApiSrc.includes("const rowCreatedOn = etDayKey(member.created_at)") &&
    payrollApiSrc.includes(".sort()[0] || bounds.from")
);
pass(
  "a new person can be added from the payroll sheet itself",
  read("src/components/rms/PayrollTab.tsx").includes("<NewPersonDialog") &&
    read("src/components/rms/PayrollTab.tsx").includes("New person") &&
    read("src/components/rms/NewPersonDialog.tsx").includes("/api/attendance/members") &&
    read("src/app/api/attendance/members/route.ts").includes("employmentStartedAt: startedOn")
);
pass(
  "the printed month is the Ethiopian one, Tikimt and Hidar, not October",
  payrollApiSrc.includes("monthLabel: payrollPeriodLabel(periodKey)") &&
    !/monthLabel: `\$\{new Intl\.DateTimeFormat\("en-US"/.test(payrollApiSrc)
);

console.log(
  failures === 0
    ? "\n✅ attendance decisions guard PASSED\n   • pending costs nothing, pays nothing; only Deduct / Add overtime moves money\n   • overtime waits like lateness, absence and early leave\n   • the kiosk button is gone, the report is in its place\n   • 20 groups by default\n   • a free day is never red, and a visit on it waits for the same two buttons\n   • a typed start date is read correctly, so the whole month is a whole month"
    : `\n❌ ${failures} check(s) failed`
);
process.exit(failures === 0 ? 0 : 1);
