import { NextResponse } from "next/server";
import { pool } from "@/db";
import { ensureTablesExist, isIntegerColumnError, repairPayrollMoneyColumns } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import {
  DEFAULT_PAYROLL_LETTERHEAD,
  OT_ARRIVAL_GRACE_MINUTES,
  OT_BUFFER_MINUTES,
  chargeableDayMinutes,
  computePayrollMoney,
  ethiopianMonthBounds,
  gregorianDateToEthiopian,
  minuteDeductionRate,
  minutesToHours,
  payrollPeriodLabel,
  recognizedOtMinutes,
  requiredPayrollSettingsMissing,
  withDefaultPayrollFormulas,
  type PayrollSettings,
} from "@/lib/payroll";
import {
  OVERTIME_TYPE_LABELS,
  OVERTIME_TYPES,
  earlyOutMinutesFor,
  etMinutes,
  lateMinutesFor,
  pickShift,
  type OvertimeType,
  type RoleShift,
} from "@/lib/attendance";
import { isFreeDate, type FreeScheduleRule } from "@/lib/free-schedule";

/**
 * PAYROLL (owner, Oct 2026).
 *
 * The page stopped being a spreadsheet where everything was typed: the owner
 * types only what only he knows (basic salary, transport, the breakage and
 * shortage of the month) and the system measures the rest:
 *
 *   • gross, pension, taxable salary, income tax and net pay from the formulas;
 *   • the three overtime kinds from the scans, the registered holiday dates and
 *     the free dates in each person's file (see recognizedOtMinutes);
 *   • absence, lateness and early departure from the attendance sheet, unless
 *     an approved exception says the reason was reasonable;
 *   • a "generate" snapshot per month for the printed payroll, one "paid" row
 *     per person (the last column is the only action now), and the sign-off
 *     names under the table.
 *
 * Every write is audited in payroll_audit. A person already paid cannot be
 * edited until the tick is taken back, which is the everyday mistake guard.
 */

const money = (n: unknown) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
const asNumber = (n: unknown) => (n === undefined || n === null || n === "" ? null : Math.max(0, money(String(n).replace(/,/g, ""))));
const positive = (n: unknown) => asNumber(n) ?? 0;
const validPeriod = (v: unknown) => /^\d{4}-(0[1-9]|1[0-3])$/.test(String(v || ""));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateRange = (from: string, to: string) => {
  const out: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

/**
 * A whole-number column does not always refuse a decimal: when Postgres is
 * told to put numeric 3080.13 into an `integer` column it quietly rounds it to
 * 3080. This error is raised when a write comes back changed, so the same
 * repair-and-retry path runs instead of losing the cents.
 */
class RoundedMoneyColumnError extends Error {}

/** Does a value we asked to store differ from the one the database kept? */
function valuesDiffer(stored: unknown, wanted: number | null): boolean {
  if (wanted === null) return false; // an empty box keeps the old value
  if (stored === null || stored === undefined) return false;
  return Math.abs(Number(stored) - wanted) > 0.004;
}

/**
 * THE MONEY COLUMNS, CHECKED ONCE PER SERVER PROCESS.
 *
 * A database made by an earlier build keeps `integer` salary columns, and
 * Postgres then either refuses 3080.13 ("invalid input syntax for type
 * integer") or silently rounds it to 3080. The migration converts them on the
 * first request after a deploy; this makes the payroll page itself do the same
 * check on its first visit, so a site that was never redeployed still accepts
 * cents. The result is remembered, so it costs one small query per process.
 */
let moneyColumnsChecked = false;
async function ensureMoneyColumns(): Promise<void> {
  if (moneyColumnsChecked) return;
  const problems = await repairPayrollMoneyColumns();
  if (problems.length === 0) moneyColumnsChecked = true;
  else console.warn("[payroll] could not convert the money columns yet:", problems);
}

async function loadSettings(): Promise<PayrollSettings> {
  const q = await pool.query("SELECT settings,approved FROM payroll_settings WHERE id=1");
  const row = q.rows[0];
  // A formula the owner never filled in falls back to his own default, so an
  // old install calculates from the first day instead of printing zeros.
  const settings = withDefaultPayrollFormulas(row?.settings || {});
  settings.settingsApproved = Boolean(row?.approved || !row);
  return settings;
}

type OtRow = {
  id: number;
  member_id: number;
  date: string;
  type: OvertimeType;
  minutes: number;
  shift_label: string | null;
  source: string;
  entered_by: string | null;
  note: string | null;
};

function shiftOfLog(log: any, shifts: RoleShift[]): RoleShift | null {
  if (!log?.clock_in) return shifts[0] ?? null;
  return pickShift(shifts, etMinutes(log.clock_in)) ?? shifts[0] ?? null;
}

async function buildRows(periodKey: string) {
  const [year, month] = periodKey.split("-").map(Number);
  const bounds = ethiopianMonthBounds(year, month);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Addis_Ababa" });
  const effectiveTo = bounds.to < today ? bounds.to : today;

  const [membersQ, logsQ, compQ, inputQ, otEntriesQ, periodQ, savedQ, exceptionsQ, historyQ, freeQ, rolesQ, holidaysQ, otRowsQ, paymentsQ, headerQ, excludedQ, breakageQ] =
    await Promise.all([
      pool.query(
        "SELECT m.id,m.name,m.role_id,m.active,m.employment_started_at,m.terminated_at,m.created_at,(SELECT min(l.date) FROM attendance_logs l WHERE l.member_id=m.id) AS first_attendance_date FROM attendance_members m ORDER BY m.name"
      ),
      pool.query(
        "SELECT member_id,date,clock_in,clock_out,total_minutes,late_minutes,early_out,early_out_minutes,is_overtime,status FROM attendance_logs WHERE date BETWEEN $1 AND $2 AND member_id IS NOT NULL",
        [bounds.from, bounds.to]
      ),
      pool.query("SELECT * FROM payroll_compensation"),
      pool.query("SELECT * FROM payroll_monthly_inputs WHERE period_key=$1", [periodKey]),
      pool.query("SELECT * FROM payroll_overtime_entries WHERE period_key=$1 ORDER BY created_at", [periodKey]),
      pool.query("SELECT * FROM payroll_periods WHERE period_key=$1", [periodKey]),
      pool.query("SELECT member_id,snapshot FROM payroll_rows WHERE period_key=$1", [periodKey]),
      pool.query("SELECT * FROM payroll_exceptions WHERE period_key=$1 ORDER BY created_at DESC", [periodKey]),
      pool.query("SELECT period_key,status,approved_at,paid_at,prepared_by,checked_by,approved_by FROM payroll_periods ORDER BY period_key DESC LIMIT 36"),
      pool.query("SELECT * FROM attendance_free_schedules"),
      pool.query(
        "SELECT role_id,label,start_time,end_time,late_grace_minutes,early_leave_grace_minutes FROM attendance_role_shifts ORDER BY role_id,sort_order,id"
      ),
      pool.query("SELECT * FROM payroll_holidays WHERE holiday_date BETWEEN $1 AND $2 ORDER BY holiday_date", [bounds.from, bounds.to]),
      pool.query(
        "SELECT id,member_id,date,type,minutes,shift_label,source,entered_by,note FROM attendance_overtime WHERE date BETWEEN $1 AND $2 ORDER BY date,id",
        [bounds.from, bounds.to]
      ),
      pool.query("SELECT member_id,paid_at,method,snapshot FROM payroll_payments WHERE period_key=$1", [periodKey]),
      // The printed government sheet's company name and TIN. Editable from
      // Payroll -> Formula Settings; a fresh install uses the Excel values.
      pool.query("SELECT key,value FROM site_settings WHERE key IN ('payroll_company_name','payroll_tin')"),
      // "Don't give": overtime kept in the history but not added to the salary.
      pool.query("SELECT id,member_id,date,type,authorized_by,reason FROM attendance_ot_exclusions WHERE date BETWEEN $1 AND $2", [bounds.from, bounds.to]),
      pool.query("SELECT member_id, COALESCE(sum(amount),0) AS amount FROM payroll_breakages WHERE period_key=$1 AND voided_at IS NULL GROUP BY member_id", [periodKey]),
    ]);

  const settings = await loadSettings();
  const headerValues = new Map(headerQ.rows.map((r) => [String(r.key), String(r.value ?? "")]));
  const letterhead = {
    companyName: headerValues.get("payroll_company_name") || DEFAULT_PAYROLL_LETTERHEAD.companyName,
    tin: headerValues.get("payroll_tin") || DEFAULT_PAYROLL_LETTERHEAD.tin,
  };
  const comp = new Map(compQ.rows.map((r) => [Number(r.member_id), r]));
  void inputQ; // retained for existing installations; manual breakage is now read-only
  const saved = new Map(savedQ.rows.map((r) => [Number(r.member_id), r.snapshot]));
  const payments = new Map(paymentsQ.rows.map((r) => [Number(r.member_id), r]));
  const holidays = holidaysQ.rows.map((h) => ({
    id: Number(h.id),
    date: String(h.holiday_date),
    name: String(h.name),
    dateEc: gregorianDateToEthiopian(String(h.holiday_date)),
  }));
  const holidayByDate = new Map(holidays.map((h) => [h.date, h]));
  const shiftsByRole = new Map<number, RoleShift[]>();
  for (const r of rolesQ.rows) {
    const roleId = Number(r.role_id);
    const list = shiftsByRole.get(roleId) || [];
    list.push({
      label: String(r.label || "Shift"),
      startTime: String(r.start_time),
      endTime: String(r.end_time),
      lateGraceMinutes: Number(r.late_grace_minutes ?? 30),
      earlyLeaveGraceMinutes: Number(r.early_leave_grace_minutes ?? 0),
    });
    shiftsByRole.set(roleId, list);
  }
  const otByMember = new Map<number, OtRow[]>();
  for (const r of otRowsQ.rows as OtRow[]) {
    const id = Number(r.member_id);
    const list = otByMember.get(id) || [];
    list.push({ ...r, member_id: id, minutes: Number(r.minutes) });
    otByMember.set(id, list);
  }

  const allDates = effectiveTo >= bounds.from ? dateRange(bounds.from, effectiveTo) : [];
  const periodDates = dateRange(bounds.from, bounds.to);
  const typeLabels: Record<string, string> = OVERTIME_TYPE_LABELS;

  const rows = membersQ.rows.map((member, index) => {
    const memberId = Number(member.id);
    const memberLogs = logsQ.rows.filter((l) => Number(l.member_id) === memberId);
    const logByDate = new Map(memberLogs.map((l) => [String(l.date), l]));
    const c = comp.get(memberId) || {};
    const exceptions = exceptionsQ.rows.filter((e) => Number(e.member_id) === memberId);
    const payment = payments.get(memberId);
    const roleShifts = shiftsByRole.get(Number(member.role_id)) || [];
    const otRows = otByMember.get(memberId) || [];
    const excludedOt = new Set(
      (excludedQ.rows as Array<{ member_id: number; date: string; type: string }>)
        .filter((e) => Number(e.member_id) === memberId)
        .map((e) => `${String(e.date)}|${String(e.type)}`)
    );
    const allowedOtRow = (r: OtRow) => !excludedOt.has(`${String(r.date)}|${String(r.type)}`);
    const manualOtRows = otRows.filter((r) => r.source !== "auto" && allowedOtRow(r));
    const manualHolidayDates = new Set(
      otRows.filter((r) => r.source !== "auto" && r.type === "holiday").map((r) => r.date)
    );
    const legacyOt = otEntriesQ.rows.filter((o) => Number(o.member_id) === memberId);

    const startedRaw = member.employment_started_at;
    const created = member.first_attendance_date || (startedRaw ? new Date(startedRaw).toISOString().slice(0, 10) : bounds.from);
    const terminated = member.terminated_at ? new Date(member.terminated_at).toISOString().slice(0, 10) : null;
    // Three kinds of free day: a repeating weekday, one named date, and a
    // ye amet ereft run of paid days (from free_date to free_until).
    const freeSchedules: FreeScheduleRule[] = freeQ.rows
      .filter((f) => Number(f.member_id) === memberId)
      .map((f) => ({
        scheduleType: String(f.schedule_type || ""),
        weekday: f.weekday === null || f.weekday === undefined ? null : Number(f.weekday),
        freeDate: f.free_date ? String(f.free_date) : null,
        freeUntil: f.free_until ? String(f.free_until) : null,
      }));
    // A free day is never an absence, and a late arrival on one is not lateness.
    const isFree = (date: string) => isFreeDate(freeSchedules, date);
    const presentDates = new Set(memberLogs.filter((l) => l.date).map((l) => String(l.date)));
    const expectedDates = allDates.filter((d) => d >= created && (!terminated || d < terminated || presentDates.has(d)) && !isFree(d));
    // An absence now costs a whole day's wage. TODAY is not finished yet, so
    // nobody may lose a day's salary just because payroll was opened before
    // their shift ended. Yesterday and older are decided; a finished month
    // (bounds.to < today) counts every day as before.
    const absenceDates = expectedDates.filter((d) => d < today && !presentDates.has(d));
    const excusedAbsence = new Set(exceptions.filter((e) => e.exception_type === "absence").map((e) => e.attendance_date));
    const excusedLate = new Set(exceptions.filter((e) => e.exception_type === "lateness").map((e) => e.attendance_date));
    const excusedEarly = new Set(exceptions.filter((e) => e.exception_type === "early_out").map((e) => e.attendance_date));
    /* ── chargeable minutes: the role's OWN grace, not a fixed 20 or 30 ────
     * The owner (2026-10-27): "i am thinking to make it based on the time of
     * Maximum Late Time (min) and Leaving Grace (min) i enter ... if someone
     * max early time leaving is 20 and he left before 25 he will be fined that
     * 5 min". So the `max(0, late - grace)` of his formula happens HERE, once
     * per day, with the grace of the person's own role:
     *   • lateMinutesFor    -> minutes past Maximum Late Time
     *   • earlyOutMinutesFor-> minutes past Leaving Grace
     * The scans are re-measured on every payroll read (instead of trusting the
     * numbers stored at scan time), so editing a role's grace in Attendance,
     * Role & Time really changes what the month costs. Stored minutes are the
     * fallback for old rows with no clock time or no role times.
     */
    const measured = memberLogs.map((l) => {
      const shift = shiftOfLog(l, roleShifts);
      const storedLate = Math.max(0, Math.round(Number(l.late_minutes || 0)));
      const storedEarly = Math.max(0, Math.round(Number(l.early_out_minutes || 0)));
      const rawLate = shift && l.clock_in ? lateMinutesFor(shift, etMinutes(l.clock_in)) : storedLate;
      const rawEarly = shift && l.clock_out
        ? earlyOutMinutesFor(shift, etMinutes(l.clock_out))
        : l.early_out
          ? storedEarly
          : 0;
      const { late, early } = chargeableDayMinutes(rawLate, rawEarly);
      return { date: String(l.date), late, early, isFree: isFree(String(l.date)) };
    });
    const lateLogs = measured.filter((l) => l.late > 0);
    const deductibleLate = lateLogs.filter((l) => !excusedLate.has(l.date) && !l.isFree);
    const earlyLogs = measured.filter((l) => l.early > 0);
    const deductibleEarly = earlyLogs.filter((l) => !excusedEarly.has(l.date) && !l.isFree);

    /* ── automatic overtime ONLY on registered holiday dates ──────────────
     * Only registered holiday fingerprint scans earn overtime automatically.
     * Free week OT, Shift OT, and Night shift OT are added manually through
     * the Overtime form and merged from manualOtRows / legacyOt below.
     */
    let autoHolidayMinutes = 0;
    const autoDays: Array<{ date: string; type: OvertimeType; hours: number; why: string; excluded: boolean }> = [];
    for (const date of allDates) {
      const log = logByDate.get(date);
      const holiday = holidayByDate.get(date);
      if (!log || !holiday || manualHolidayDates.has(date)) continue;
      const shift = shiftOfLog(log, roleShifts);
      const excluded = excludedOt.has(`${date}|holiday`);
      const minutes = recognizedOtMinutes(shift, log);
      if (minutes > 0) {
        if (!excluded) autoHolidayMinutes += minutes;
        autoDays.push({ date, type: "holiday", hours: minutesToHours(minutes), why: holiday.name, excluded });
      }
    }

    const manualMinutes = (type: OtRow["type"]) =>
      manualOtRows.filter((r) => r.type === type).reduce((s, r) => s + Number(r.minutes || 0), 0);
    const legacyHours = (type: OtRow["type"]) =>
      money(legacyOt.filter((o) => o.overtime_type === type).reduce((s, o) => s + Number(o.hours), 0));

    const holidayOtHours = money(minutesToHours(autoHolidayMinutes + manualMinutes("holiday")) + legacyHours("holiday"));
    const freeWeekOtHours = money(minutesToHours(manualMinutes("free_week")) + legacyHours("free_week"));
    const shiftOtHours = money(minutesToHours(manualMinutes("shift")) + legacyHours("shift"));
    const nightShiftOtHours = money(minutesToHours(manualMinutes("night_shift")) + legacyHours("night_shift"));

    const attendance = {
      scheduledDays: expectedDates.length,
      scheduledHours: money(memberLogs.reduce((s, l) => s + Number(l.total_minutes || 0), 0) / 60),
      daysPresent: presentDates.size,
      approvedAbsences: absenceDates.filter((d) => excusedAbsence.has(d)).length,
      unapprovedAbsences: absenceDates.filter((d) => !excusedAbsence.has(d)).length,
      lateCount: deductibleLate.length,
      lateMinutes: deductibleLate.reduce((s, l) => s + l.late, 0),
      earlyOutCount: deductibleEarly.length,
      earlyOutMinutes: deductibleEarly.reduce((s, l) => s + l.early, 0),
      holidayOtHours,
      freeWeekOtHours,
      shiftOtHours,
      nightShiftOtHours,
      autoHolidayHours: minutesToHours(autoHolidayMinutes),
      autoFreeWeekHours: 0,
      autoShiftHours: 0,
      holidayDays:
        autoDays.filter((d) => d.type === "holiday" && !d.excluded).length +
        manualOtRows.filter((r) => r.type === "holiday").length,
      freeWeekDays: manualOtRows.filter((r) => r.type === "free_week").length,
      shiftDays: manualOtRows.filter((r) => r.type === "shift").length,
      nightShiftDays: manualOtRows.filter((r) => r.type === "night_shift").length,
    };

    const basic = positive(c.basic_salary);
    const transport = positive(c.transport_allowance);
    const breakage = positive(breakageQ.rows.find((r) => Number(r.member_id) === memberId)?.amount);
    const employmentDays = periodDates.filter((d) => d >= created && (!terminated || d < terminated || presentDates.has(d))).length;
    const prorationFactor = periodDates.length ? Math.min(1, employmentDays / periodDates.length) : 1;
    // ONE money chain, with Excel's full precision behind the two displayed
    // decimals. The server row and the live screen preview both call this, so
    // the paper, the screen and the payment snapshot can never disagree.
    const pay = computePayrollMoney({
      basicSalary: basic,
      transportAllowance: transport,
      breakageShortage: breakage,
      settings,
      attendance: {
        HolidayOtHours: holidayOtHours,
        FreeWeekOtHours: freeWeekOtHours,
        ShiftOtHours: shiftOtHours,
        NightShiftOtHours: nightShiftOtHours,
        ScheduledDays: attendance.scheduledDays,
        ScheduledHours: attendance.scheduledHours,
        DaysPresent: attendance.daysPresent,
        ApprovedAbsences: attendance.approvedAbsences,
        UnapprovedAbsences: attendance.unapprovedAbsences,
        LateCount: attendance.lateCount,
        LateMinutes: attendance.lateMinutes,
        EarlyOutCount: attendance.earlyOutCount,
        EarlyOutMinutes: attendance.earlyOutMinutes,
      },
      prorationFactor,
    }).display;

    const attendanceEvents = [
      ...absenceDates.map((date) => ({ date, dateEc: gregorianDateToEthiopian(date), type: "absence", minutes: 0, excused: excusedAbsence.has(date) })),
      ...lateLogs.map((l) => ({ date: l.date, dateEc: gregorianDateToEthiopian(l.date), type: "lateness", minutes: l.late, excused: excusedLate.has(l.date) })),
      ...earlyLogs.map((l) => ({ date: l.date, dateEc: gregorianDateToEthiopian(l.date), type: "early_out", minutes: l.early, excused: excusedEarly.has(l.date) })),
    ].sort((a, b) => b.date.localeCompare(a.date));

    // A "Don't give" typed row stays in the history with its flag; only
    // manualOtRows (above) feeds the money. This is the audit trail: the
    // owner sees that a mistaken overtime existed and who silenced it.
    const writtenEntries = otRows.filter((r) => r.source !== "auto").map((r) => ({
      id: r.id,
      date: r.date,
      dateEc: gregorianDateToEthiopian(r.date),
      type: r.type,
      typeLabel: typeLabels[r.type] || r.type,
      hours: minutesToHours(Number(r.minutes)),
      source: r.source,
      enteredBy: r.entered_by,
      note: r.note,
      holidayName: holidayByDate.get(r.date)?.name || null,
      automatic: false,
      excluded: excludedOt.has(`${String(r.date)}|${String(r.type)}`),
    }));
    const automaticEntries = autoDays.map((d) => ({
      id: null,
      date: d.date,
      dateEc: gregorianDateToEthiopian(d.date),
      type: d.type,
      typeLabel: typeLabels[d.type] || d.type,
      hours: d.hours,
      source: "auto",
      enteredBy: null,
      note: d.why,
      holidayName: holidayByDate.get(d.date)?.name || null,
      automatic: true,
      excluded: d.excluded,
    }));

    const computed = {
      // The No. column is 1, 2, 3... of THIS list, never the database id: the
      // owner saw 39 and 40 after deleting the people before them.
      memberId,
      employeeNumber: index + 1,
      employeeName: member.name,
      employeeActive: member.active !== false,
      roleId: member.role_id,
      attendance,
      attendanceEvents,
      exceptions,
      overtimeEntries: [...writtenEntries, ...automaticEntries].sort((a, b) => b.date.localeCompare(a.date)),
      otBreakdown: {
        holiday: { hours: holidayOtHours, pay: pay.holidayOtPay, days: attendance.holidayDays },
        freeWeek: { hours: freeWeekOtHours, pay: pay.freeWeekOtPay, days: attendance.freeWeekDays },
        shift: { hours: shiftOtHours, pay: pay.shiftOtPay, days: attendance.shiftDays },
        nightShift: { hours: nightShiftOtHours, pay: pay.nightShiftOtPay, days: attendance.nightShiftDays },
        bufferMinutes: OT_BUFFER_MINUTES,
        arrivalGraceMinutes: OT_ARRIVAL_GRACE_MINUTES,
      },
      basicSalary: basic,
      employerPension: pay.employerPension,
      transportAllowance: transport,
      overtimePay: pay.overtimePay,
      holidayOtPay: pay.holidayOtPay,
      freeWeekOtPay: pay.freeWeekOtPay,
      shiftOtPay: pay.shiftOtPay,
      nightShiftOtPay: pay.nightShiftOtPay,
      grossSalary: pay.grossSalary,
      taxableSalary: pay.taxableSalary,
      // The numbers behind the Lateness and Early Departure columns, so the
      // printed row can be checked with a calculator: 6,000 -> 0.4167/min.
      netSalary: pay.netSalary,
      minuteRate: Math.round(minuteDeductionRate(basic) * 10000) / 10000,
      chargeableMinutes: attendance.lateMinutes + attendance.earlyOutMinutes,
      incomeTax: pay.incomeTax,
      employeePension: pay.employeePension,
      totalPension: pay.totalPension,
      breakageShortage: breakage,
      absenceDeduction: pay.absenceDeduction,
      latenessDeduction: pay.latenessDeduction,
      earlyOutDeduction: pay.earlyOutDeduction,
      totalDeduction: pay.totalDeduction,
      fullMonthNetPay: pay.fullMonthNetPay,
      prorationDays: employmentDays,
      periodDays: periodDates.length,
      prorationFactor,
      netPay: pay.netPay,
      paid: Boolean(payment),
      paidAt: payment?.paid_at || null,
      paymentMethod: payment?.method || null,
      savedSnapshot: saved.get(memberId) || null,
    };
    // WHAT WAS PAID STAYS WHAT WAS PAID. A ticked row shows the numbers frozen
    // at the moment the tick was pressed (the overtime list included), so a
    // scan corrected or a holiday added later cannot rewrite a month that is
    // already in the employees' hands. Taking the tick back returns it to the
    // live calculation.
    const frozen = payment?.snapshot;
    if (!frozen || typeof frozen !== "object") return computed;
    return {
      ...computed,
      ...frozen,
      memberId,
      employeeNumber: index + 1,
      employeeName: member.name,
      employeeActive: member.active !== false,
      roleId: member.role_id,
      paid: true,
      paidAt: payment.paid_at || null,
      paymentMethod: payment.method || null,
    };
  });

  const period = periodQ.rows[0] || {};
  return {
    periodKey,
    bounds,
    // The printed government sheet's header: company, month and TIN. His
    // Excel writes "For The Month of JuLY 2018 E.C": the Gregorian month in
    // which the Ethiopian month starts, with the Ethiopian year. The exact
    // Ethiopian month and the Gregorian date range go on the small line.
    letterhead: {
      ...letterhead,
      monthLabel: `${new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(`${bounds.from}T12:00:00Z`))} ${periodKey.split("-")[0]} E.C`,
      periodLabel: payrollPeriodLabel(periodKey),
      gregorianRange: `${bounds.from} to ${bounds.to}`,
      // Formal sheets carry a date. It comes from the selected payroll month,
      // never from the day somebody happens to click Print, so a re-print of
      // an old month keeps its own date.
      dateEc: gregorianDateToEthiopian(bounds.to),
      dateLabel: new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${bounds.to}T12:00:00Z`)),
    },
    status: period.status || "draft",
    paidAt: period.paid_at || null,
    preparedBy: period.prepared_by || "",
    checkedBy: period.checked_by || "",
    approvedBy: period.approved_by || "",
    settings,
    missingSettings: requiredPayrollSettingsMissing(settings),
    holidays,
    exceptions: exceptionsQ.rows,
    // "Don't give" decisions of this month, so the Overtime dialog can show
    // them beside the row and put the hours back with one click.
    otExclusions: excludedQ.rows,
    history: historyQ.rows,
    paidCount: rows.filter((r) => r.paid).length,
    rows,
  };
}

export async function GET(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  const period = new URL(request.url).searchParams.get("period");
  if (!validPeriod(period)) return NextResponse.json({ error: "Valid Ethiopian period YYYY-MM required" }, { status: 400 });
  await ensureMoneyColumns();
  try {
    return NextResponse.json(await buildRows(period!));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** A person marked paid is closed for the month until the tick is taken back. */
async function isPaid(period: string, memberId: number): Promise<boolean> {
  if (!memberId) return false;
  const q = await pool.query("SELECT 1 FROM payroll_payments WHERE period_key=$1 AND member_id=$2", [period, memberId]);
  return q.rows.length > 0;
}

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  const body = await request.json().catch(() => ({}));
  const period = String(body.period || "");
  const action = String(body.action || "");
  if (!validPeriod(period)) return NextResponse.json({ error: "Valid Ethiopian period required" }, { status: 400 });
  await ensureMoneyColumns();

  const locked = await pool.query("SELECT status FROM payroll_periods WHERE period_key=$1", [period]);
  const status = locked.rows[0]?.status || "draft";
  const paying = action === "mark_paid" || action === "mark_member_paid";
  if (["approved", "paid"].includes(status) && !paying)
    return NextResponse.json({ error: "Approved or paid payroll is locked." }, { status: 409 });

  try {
    if (action === "save_compensation") {
      // The three numbers the owner types with his own hand. Everything else
      // on the row is the system's answer to them.
      const id = Number(body.memberId);
      if (!id) throw new Error("Employee required");
      if (await isPaid(period, id)) throw new Error("This person is already paid for this month. Take the paid tick back first.");
      // A missing box keeps the number that is already stored: an older screen
      // or a partial request must never wipe a salary to zero.
      const basicSalary = asNumber(body.basicSalary);
      const transportAllowance = asNumber(body.transportAllowance);
      if (body.breakageShortage !== undefined) throw new Error("Breakage is recorded in Store, not entered manually in Payroll.");
      const writeCompensation = async () => {
        // $2 and $3 are cast to numeric ON PURPOSE. Inside COALESCE($2,0) the
        // untyped parameter takes the type of the literal 0, which is integer,
        // and Postgres then parses "3080.13" as a whole number and refuses it
        // with "invalid input syntax for type integer" even on a numeric
        // column. The cast is what lets a salary with cents through.
        const saved = await pool.query<{ basic_salary: string; transport_allowance: string }>(
          `INSERT INTO payroll_compensation(member_id,basic_salary,transport_allowance,updated_at)
           VALUES($1,COALESCE($2::numeric,0),COALESCE($3::numeric,0),now())
           ON CONFLICT(member_id) DO UPDATE SET
             basic_salary=COALESCE($2::numeric,payroll_compensation.basic_salary),
             transport_allowance=COALESCE($3::numeric,payroll_compensation.transport_allowance),
             updated_at=now()
           RETURNING basic_salary,transport_allowance`,
          [id, basicSalary, transportAllowance]
        );
        if (valuesDiffer(saved.rows[0]?.basic_salary, basicSalary) || valuesDiffer(saved.rows[0]?.transport_allowance, transportAllowance)) {
          throw new RoundedMoneyColumnError(
            `This database still stores payroll money as whole numbers (${saved.rows[0]?.basic_salary} instead of ${basicSalary}).`
          );
        }
        await pool.query("INSERT INTO payroll_audit(period_key,member_id,action,detail) VALUES($1,$2,'compensation_saved',$3::jsonb)", [
          period,
          id,
          JSON.stringify({ basicSalary, transportAllowance }),
        ]);
      };
      try {
        await writeCompensation();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // The live database still holds the whole-number columns an earlier
        // build made ("invalid input syntax for type integer: 3080.13"). Heal
        // them right here and save again, so the owner never has to wait for a
        // deploy to type a salary with cents.
        if (!(e instanceof RoundedMoneyColumnError) && !isIntegerColumnError(message)) throw e;
        await repairPayrollMoneyColumns();
        try {
          await writeCompensation();
        } catch (retry) {
          throw new Error(
            `This database still stores payroll money as whole numbers, so ${basicSalary} could not be saved. ` +
              `Open the Payroll page once more (the repair runs on the first request after a deploy). Details: ${
                retry instanceof Error ? retry.message : String(retry)
              }`
          );
        }
      }
    } else if (action === "add_overtime") {
      const id = Number(body.memberId);
      const type = String(body.overtimeType);
      const hours = positive(body.hours);
      if (!id || !(OVERTIME_TYPES as readonly string[]).includes(type) || hours <= 0)
        throw new Error("Employee, overtime type and positive hours required");
      if (await isPaid(period, id)) throw new Error("This person is already paid for this month. Take the paid tick back first.");
      const writeOvertime = async () => {
        const row = await pool.query<{ hours: string }>(
          "INSERT INTO payroll_overtime_entries(member_id,period_key,overtime_type,hours,note) VALUES($1,$2,$3,$4::numeric,$5) RETURNING hours",
          [id, period, type, hours, String(body.note || "")]
        );
        // 1.5 h must stay 1.5 h; a whole-number column would round it to 2.
        if (valuesDiffer(row.rows[0]?.hours, hours))
          throw new RoundedMoneyColumnError(`This database still stores overtime hours as whole numbers (${row.rows[0]?.hours} instead of ${hours}).`);
      };
      try {
        await writeOvertime();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!(e instanceof RoundedMoneyColumnError) && !isIntegerColumnError(message)) throw e;
        // Same whole-number column, this time on the overtime hours (1.5 h).
        await repairPayrollMoneyColumns();
        await writeOvertime();
      }
      await pool.query("INSERT INTO payroll_audit(period_key,member_id,action,detail) VALUES($1,$2,'overtime_added',$3::jsonb)", [
        period,
        id,
        JSON.stringify({ type, hours, note: body.note }),
      ]);
    } else if (action === "delete_overtime") {
      // Only the manual rows live here; measured rows are removed on the
      // Attendance page (they are the paper sheet's own record).
      const id = Number(body.id);
      if (!id) throw new Error("Overtime row required");
      await pool.query("DELETE FROM payroll_overtime_entries WHERE id=$1 AND period_key=$2", [id, period]);
      await pool.query("INSERT INTO payroll_audit(period_key,action,detail) VALUES($1,'overtime_removed',$2::jsonb)", [period, JSON.stringify({ id })]);
    } else if (action === "add_exception") {
      const id = Number(body.memberId);
      const date = String(body.date || "");
      const type = String(body.exceptionType || "");
      const by = String(body.authorizedBy || "").trim();
      const reason = String(body.reason || "").trim();
      if (!id || !DATE_RE.test(date) || !["absence", "lateness", "early_out"].includes(type) || !by || !reason)
        throw new Error("Employee, attendance event, authorizer name and reason are required");
      await pool.query(
        `INSERT INTO payroll_exceptions(period_key,member_id,attendance_date,exception_type,authorized_by,reason) VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(period_key,member_id,attendance_date,exception_type) DO UPDATE SET authorized_by=$5,reason=$6,created_at=now()`,
        [period, id, date, type, by, reason]
      );
      await pool.query("INSERT INTO payroll_audit(period_key,member_id,action,detail) VALUES($1,$2,'deduction_exception_approved',$3::jsonb)", [
        period,
        id,
        JSON.stringify({ date, type, by, reason }),
      ]);
    } else if (action === "remove_exception") {
      const id = Number(body.id);
      if (!id) throw new Error("Exception required");
      await pool.query("DELETE FROM payroll_exceptions WHERE id=$1 AND period_key=$2", [id, period]);
      await pool.query("INSERT INTO payroll_audit(period_key,action,detail) VALUES($1,'deduction_exception_removed',$2::jsonb)", [period, JSON.stringify({ id })]);
    } else if (action === "save_signatures") {
      const prepared = String(body.preparedBy || "").trim();
      const checked = String(body.checkedBy || "").trim();
      const approved = String(body.approvedBy || "").trim();
      await pool.query(
        `INSERT INTO payroll_periods(period_key,status,prepared_by,checked_by,approved_by,updated_at) VALUES($1,'draft',$2,$3,$4,now())
         ON CONFLICT(period_key) DO UPDATE SET prepared_by=$2,checked_by=$3,approved_by=$4,updated_at=now()`,
        [period, prepared, checked, approved]
      );
    } else if (action === "generate") {
      const data = await buildRows(period);
      await pool.query("INSERT INTO payroll_periods(period_key,status,updated_at) VALUES($1,'draft',now()) ON CONFLICT(period_key) DO UPDATE SET updated_at=now()", [period]);
      for (const row of data.rows) {
        await pool.query(`INSERT INTO payroll_rows(period_key,member_id,snapshot,updated_at) VALUES($1,$2,$3::jsonb,now()) ON CONFLICT(period_key,member_id) DO UPDATE SET snapshot=$3::jsonb,updated_at=now()`, [
          period,
          row.memberId,
          JSON.stringify(row),
        ]);
      }
      await pool.query("INSERT INTO payroll_audit(period_key,action,detail) VALUES($1,'payroll_generated',$2::jsonb)", [period, JSON.stringify({ employees: data.rows.length })]);
    } else if (action === "approve") {
      const data = await buildRows(period);
      if (data.missingSettings.length) return NextResponse.json({ error: `Cannot approve: ${data.missingSettings.join(", ")}` }, { status: 400 });
      if (!data.preparedBy || !data.checkedBy || !data.approvedBy)
        return NextResponse.json({ error: "Prepared by, Checked by and Approved by names are required" }, { status: 400 });
      if (!data.rows.length || data.rows.some((r) => !r.savedSnapshot)) return NextResponse.json({ error: "Generate payroll before approval" }, { status: 400 });
      await pool.query("UPDATE payroll_periods SET status='approved',approved_at=now(),updated_at=now() WHERE period_key=$1", [period]);
      await pool.query("INSERT INTO payroll_audit(period_key,action) VALUES($1,'payroll_approved')", [period]);
    } else if (action === "mark_member_paid") {
      // The one button at the end of the row. `paid:false` takes the green tick
      // back (a wrong tap), and the change is audited either way.
      const id = Number(body.memberId);
      if (!id) throw new Error("Employee required");
      const paid = body.paid === undefined ? true : Boolean(body.paid);
      if (paid) {
        const data = await buildRows(period);
        const row = data.rows.find((r) => r.memberId === id);
        if (!row) throw new Error("Employee not found in this payroll");
        // Freeze the row with the tick: the amount and the overtime that were
        // on the screen when the owner said this person is paid.
        const { savedSnapshot: _saved, paid: _paid, paidAt: _paidAt, paymentMethod: _method, ...frozen } = row as any;
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("INSERT INTO payroll_periods(period_key,status,updated_at) VALUES($1,'draft',now()) ON CONFLICT(period_key) DO NOTHING", [period]);
          await client.query("SELECT status FROM payroll_periods WHERE period_key=$1 FOR UPDATE", [period]);
          const current = await client.query("SELECT COALESCE(sum(amount),0) AS amount FROM payroll_breakages WHERE period_key=$1 AND member_id=$2 AND voided_at IS NULL", [period,id]);
          if (Math.abs(Number(current.rows[0].amount) - Number(row.breakageShortage)) > 0.001) throw new Error("Breakage changed while paying. Refresh payroll and confirm again.");
          await client.query(
            `INSERT INTO payroll_payments(period_key,member_id,paid_at,method,note,snapshot) VALUES($1,$2,now(),$3,$4,$5::jsonb)
             ON CONFLICT(period_key,member_id) DO UPDATE SET paid_at=now(),method=$3,note=$4,snapshot=$5::jsonb`,
            [period, id, String(body.method || "Cash"), String(body.note || "") || null, JSON.stringify(frozen)]
          );
          await client.query("COMMIT");
        } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
        await pool.query("INSERT INTO payroll_audit(period_key,member_id,action,detail) VALUES($1,$2,'person_paid',$3::jsonb)", [
          period,
          id,
          JSON.stringify({ netPay: row.netPay, method: body.method || "Cash" }),
        ]);
      } else {
        await pool.query("DELETE FROM payroll_payments WHERE period_key=$1 AND member_id=$2", [period, id]);
        await pool.query("INSERT INTO payroll_audit(period_key,member_id,action,detail) VALUES($1,$2,'payment_reversed',$3::jsonb)", [
          period,
          id,
          JSON.stringify({}),
        ]);
      }
      // The month's own status stays the owner's decision: paying everybody
      // with the row buttons does not lock the month by itself, the bottom
      // "Mark paid" does.
    } else if (action === "mark_paid") {
      if (status !== "approved") return NextResponse.json({ error: "Only approved payroll can be marked paid" }, { status: 400 });
      const data = await buildRows(period);
      for (const row of data.rows) {
        await pool.query(
          `INSERT INTO payroll_payments(period_key,member_id,paid_at,method) VALUES($1,$2,now(),'Bank')
           ON CONFLICT(period_key,member_id) DO UPDATE SET paid_at=now(),method='Bank'`,
          [period, row.memberId]
        );
      }
      await pool.query("UPDATE payroll_periods SET status='paid',paid_at=now(),payment_method='Bank',updated_at=now() WHERE period_key=$1", [period]);
      await pool.query("INSERT INTO payroll_audit(period_key,action,detail) VALUES($1,'payroll_paid',$2::jsonb)", [
        period,
        JSON.stringify({ paymentMethod: "Bank", people: data.rows.length }),
      ]);
    } else throw new Error("Unknown payroll action");
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
