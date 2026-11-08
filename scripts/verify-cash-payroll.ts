#!/usr/bin/env tsx
/**
 * Regression guard: THE OWNER'S 2026-11-07 CHANGES.
 *
 * In his words:
 *
 *  1. CASH PAYROLL: "on payroll i want to add cash payroll below the main
 *     payroll, that 2nd table for employees with no TIN number, so all that
 *     tax, transport ... these doesn't considered because they get paid by
 *     cash ... there will be separate print button too with approved by".
 *     The sheet he sent prints No. / Employee Name / Net pay / Signature with
 *     a TOTAL line and Prepared / Checked / Approved blanks.
 *
 *  2. THE NAMES STAY WHEN THE TABLE MOVES: "add horizontal scroll at the top
 *     of the table also when he scrolls to right the names also disappear, so
 *     ... the employee name remains, only the other columns move".
 *
 *  3. THE CLOSEST SHIFT START DECIDES: "if the role shifts start morning at
 *     12:00 and afternoon at 8:00, so if someone enters at 6 it is closer to 8
 *     so decide by that and that 2 hour is overtime". The old 30/60/120 minute
 *     windows do not decide any more.
 *
 *  4. NO AUTOMATIC OVERTIME MONEY: "i dont want the system to add overtime but
 *     the paper sheet ... the system will make it OT status which is purple
 *     just to identify that person stayed up to the next shift" and "only made
 *     the box ot color, it is given by manually".
 *
 *  5. FREE DAYS ARE NEVER RED: "i add free days for each person so when that
 *     person isn't put his finger at that time there will not be absent label
 *     which is red box ... when that person come that day the box label will be
 *     like the overtime".
 *
 * Run with: npx tsx scripts/verify-cash-payroll.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  earlyArrivalMinutesFor,
  inStatusOf,
  lateMinutesFor,
  outStatusOf,
  parseHHMM,
  pickShift,
  stayedIntoNextShift,
} from "../src/lib/attendance";
import { cashSheetTitle, cashTotal } from "../src/lib/cash-payroll";
import { AUTO_SHIFT_OT_ENABLED } from "../src/lib/attendance-overtime";

let failures = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
  if (!cond) failures++;
};
const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/* ── 3. the closest start decides the shift ───────────────────────────────── */

const morning = { label: "Morning", startTime: "12:00", endTime: "20:00", lateGraceMinutes: 30 };
const afternoon = { label: "Afternoon", startTime: "20:00", endTime: "00:00", lateGraceMinutes: 30 };
const twoShifts = [morning, afternoon];

pass(
  "the owner's own example: a 6:00 scan is 2 h from the 8:00 shift and 6 h from 12:00, so it is the 8:00 shift",
  (() => {
    const day = [
      { label: "Morning", startTime: "12:00", endTime: "20:00", lateGraceMinutes: 30 },
      { label: "Afternoon", startTime: "08:00", endTime: "16:00", lateGraceMinutes: 30 },
    ];
    const chosen = pickShift(day, parseHHMM("06:00")!);
    return chosen === day[1];
  })(),
  "pickShift did not choose the 8:00 shift"
);

pass(
  "a waiter sent in at 6:00 for an 8:00 shift is NOT late any more (the old bug)",
  lateMinutesFor(pickShift(twoShifts, parseHHMM("06:00")!), parseHHMM("06:00")!) === 0
);

{
  const owner = [
    { label: "Morning", startTime: "12:00", endTime: "20:00", lateGraceMinutes: 30 },
    { label: "Afternoon", startTime: "08:00", endTime: "16:00", lateGraceMinutes: 30 },
  ];
  pass(
    "the two hours before his own 8:00 shift are marked as early arrival (2 h > the 75 min buffer)",
    earlyArrivalMinutesFor(pickShift(owner, parseHHMM("06:00")!), parseHHMM("06:00")!) === 120
  );
}

pass(
  "arriving 40 minutes early to change clothes is inside the buffer and not marked",
  earlyArrivalMinutesFor(morning, parseHHMM("11:20")!) === 0 &&
    earlyArrivalMinutesFor(morning, parseHHMM("11:59")!) === 0
);

pass(
  "a scan at 19:10 is closest to the 20:00 start, so it is the Afternoon shift and on time",
  pickShift(twoShifts, parseHHMM("19:10")!) === afternoon &&
    lateMinutesFor(pickShift(twoShifts, parseHHMM("19:10")!), parseHHMM("19:10")!) === 0
);

pass(
  "a scan at 12:45 stays with the 12:00 shift",
  pickShift(twoShifts, parseHHMM("12:45")!) === morning
);

pass(
  "a late arrival on his own shift is still late (the closest rule does not excuse it)",
  lateMinutesFor(pickShift(twoShifts, parseHHMM("12:40")!), parseHHMM("12:40")!) === 10
);

{
  const night = { label: "Night", startTime: "22:00", endTime: "06:00", lateGraceMinutes: 30 };
  const day = { label: "Day", startTime: "12:00", endTime: "20:00", lateGraceMinutes: 30 };
  pass(
    "across midnight the dial is used: a 02:00 scan is 4 h from 22:00 and 10 h from 12:00, so Night wins",
    pickShift([day, night], parseHHMM("02:00")!) === night
  );
}

/* ── 4. stayed to the next shift: a mark, not money ───────────────────────── */

const shiftA = { label: "Morning", startTime: "12:00", endTime: "18:00", lateGraceMinutes: 30, earlyLeaveGraceMinutes: 0 };
const shiftB = { label: "Afternoon", startTime: "18:00", endTime: "23:00", lateGraceMinutes: 30, earlyLeaveGraceMinutes: 0 };
const backToBack = [shiftA, shiftB];

const stay = stayedIntoNextShift(backToBack, shiftA, parseHHMM("21:30")!);
pass(
  "an OUT at 21:30 (own end 18:00, next end 23:00) is a 'stayed next shift' mark",
  stay !== null && stay.shift === shiftB && stay.extraMinutes === 210,
  JSON.stringify(stay)
);

pass(
  "an OUT at 18:30 is close to his own end, so it is not the next shift",
  stayedIntoNextShift(backToBack, shiftA, parseHHMM("18:30")!) === null
);

pass(
  "the automatic Shift OT money is OFF (AUTO_SHIFT_OT_ENABLED === false)",
  AUTO_SHIFT_OT_ENABLED === false
);

const overtimeModule = read("src/lib/attendance-overtime.ts");
pass(
  "the clock-out path itself returns 0 before it can write a paid overtime row",
  /if \(!AUTO_SHIFT_OT_ENABLED\) return 0;/.test(overtimeModule)
);

/* ── 5. free days are never the red absent box ────────────────────────────── */

pass(
  "a free day with no scan is 'free', not 'absent'",
  inStatusOf(null, { freeDay: true }) === "free"
);
pass(
  "coming in on a free day is 'free_worked' (blue Worked), not overtime by itself",
  inStatusOf({ clockIn: "2026-11-07T06:00:00Z" }, { freeDay: true }) === "free_worked" &&
    outStatusOf({ clockIn: "2026-11-07T06:00:00Z", clockOut: "2026-11-07T15:00:00Z" }, { freeDay: true }) === "free_worked"
);
pass(
  "a normal day with no scan is still the red 'absent'",
  inStatusOf(null) === "absent"
);
pass(
  "the violet marks: sent in early, stayed for the next shift, and a pressed overtime button",
  inStatusOf({ clockIn: "2026-11-07T06:00:00Z" }, { earlyArrival: true }) === "overtime" &&
    outStatusOf({ clockIn: "2026-11-07T06:00:00Z", clockOut: "2026-11-07T18:30:00Z" }, { stayedNextShift: true }) === "next_shift" &&
    outStatusOf({ clockIn: "2026-11-07T06:00:00Z", clockOut: "2026-11-07T18:30:00Z", isOvertime: true }) === "overtime"
);
pass(
  "a late arrival outranks the early mark (late is the stronger fact)",
  inStatusOf({ clockIn: "2026-11-07T06:00:00Z", lateMinutes: 12 }, { earlyArrival: true }) === "late"
);

/* ── 1. the cash payroll ──────────────────────────────────────────────────── */

pass(
  "the cash sheet title is the one in his Excel",
  cashSheetTitle("Meskerem 2019 E.C") === "CASH ON HAND FOR THE MONTH OF MESKEREM 2019 E.C",
  cashSheetTitle("Meskerem 2019 E.C")
);
pass("the cash total adds the rows to the cent", cashTotal([{ netPay: 3000 }, { netPay: 7000 }, { netPay: 4133.33 }]) === 14133.33);

const cashLib = read("src/lib/cash-payroll.ts");
pass(
  "the cash table carries no tax, pension or transport column",
  !/pension|incomeTax|transport/i.test(cashLib.replace(/\/\*[\s\S]*?\*\//g, ""))
);

const cashRoute = read("src/app/api/payroll/cash/route.ts");
pass(
  "adding an attendance member and typing a new name are both supported",
  cashRoute.includes('action === "add_member"') && cashRoute.includes('action === "add_name"')
);
pass(
  "renaming a member row also renames the attendance staff member",
  cashRoute.includes('action === "rename"') && cashRoute.includes("UPDATE attendance_members SET name=$1")
);
pass("a row can be deleted at the end of the line", cashRoute.includes('action === "remove"'));
pass("the money is typed per person", cashRoute.includes('action === "set_net_pay"'));
pass(
  "the cash sheet has its own prepared / checked / approved names",
  cashRoute.includes("cash_payroll_signoff") && cashRoute.includes("save_signatures")
);

const payrollRoute = read("src/app/api/payroll/route.ts");
pass(
  "a cash person is left OFF the TIN sheet of the same month",
  payrollRoute.includes("cashMemberIds") && payrollRoute.includes("cash_payroll_entries c")
);

const panel = read("src/components/rms/CashPayrollPanel.tsx");
pass(
  "the screen table is No. / Employee Name / Net pay / Signature, as his sheet",
  panel.includes(">S No<") && panel.includes(">Employee Name<") && panel.includes(">Net pay<") && panel.includes(">Signature<")
);
pass(
  "the cash print button prints the cash sheet only (its own print mode)",
  panel.includes("Print cash sheet") && panel.includes("cash-print-mode")
);
pass("the cash table can be printed on its own with Approved by", panel.includes("Approved by"));

/* ── 2. the scroll: top bar, frozen name ──────────────────────────────────── */

const scroll = read("src/components/rms/TableScroll.tsx");
pass(
  "a second horizontal scrollbar sits ABOVE the table and drags the table's own",
  scroll.includes("topRef") && scroll.includes("sync(topRef.current, bodyRef.current)") && scroll.includes("mb-1")
);
pass(
  "the first column is pinned with position: sticky so the name stays",
  scroll.includes(".fana-freeze-cell { position: sticky; left: 0")
);

const payrollTab = read("src/components/rms/PayrollTab.tsx");
pass(
  "the payroll table uses the frozen name column and the top scrollbar",
  payrollTab.includes("<TableScroll label=\"Monthly payroll table\"") &&
    payrollTab.includes('h === "Employee Name" ? "fana-freeze-cell fana-freeze-head"')
);

const attendanceTab = read("src/components/rms/AttendanceTab.tsx");
pass(
  "the attendance paper sheet keeps the employee name pinned too",
  attendanceTab.includes('label="Attendance paper sheet"') &&
    attendanceTab.includes("fana-freeze-cell p-2 border border-black font-black")
);

/* ── the paper-sheet API reads the free schedules ─────────────────────────── */

const logsRoute = read("src/app/api/attendance/logs/route.ts");
pass(
  "the sheet API reads each person's free schedule and marks the box",
  logsRoute.includes("attendanceFreeSchedules") && logsRoute.includes("isFreeDate(freeRules, d)")
);
pass(
  "the sheet API measures the stayed-next-shift mark",
  logsRoute.includes("stayedIntoNextShift(shifts, shift, etMinutes(log.clockOut))")
);

/* ── user-visible text rules ──────────────────────────────────────────────── */

pass(
  "no user-visible string in the new files carries an em dash",
  ![read("src/lib/cash-payroll.ts"), panel, scroll].some((text) =>
    /(["'`])[^"'`]*\u2014[^"'`]*\1/.test(text.replace(/\/\*[\s\S]*?\*\//g, ""))
  )
);

console.log(
  failures === 0
    ? "\n✅ Cash payroll and the 2026-11-07 attendance rules PASSED\n   • a second cash table with its own print and sign-off\n   • top scrollbar and a pinned employee name\n   • the closest shift start decides, and the extra hours are marked violet\n   • free days are never red, worked free days are blue\n"
    : `\n❌ ${failures} check(s) failed\n`
);
process.exit(failures === 0 ? 0 : 1);
