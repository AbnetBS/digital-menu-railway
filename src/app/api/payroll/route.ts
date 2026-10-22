import { NextResponse } from "next/server";
import { pool } from "@/db";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import {
  OT_ARRIVAL_GRACE_MINUTES,
  OT_BUFFER_MINUTES,
  ethiopianMonthBounds,
  evaluatePayrollFormula,
  gregorianDateToEthiopian,
  minutesToHours,
  recognizedOtMinutes,
  requiredPayrollSettingsMissing,
  withDefaultPayrollFormulas,
  type PayrollSettings,
} from "@/lib/payroll";
import {
  earlyOutMinutesFor,
  etMinutes,
  lateMinutesFor,
  pickShift,
  shiftOtMinutesFor,
  type RoleShift,
} from "@/lib/attendance";

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
  type: "holiday" | "free_week" | "shift";
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

  const [membersQ, logsQ, compQ, inputQ, otEntriesQ, periodQ, savedQ, exceptionsQ, historyQ, freeQ, rolesQ, holidaysQ, otRowsQ, paymentsQ] =
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
    ]);

  const settings = await loadSettings();
  const comp = new Map(compQ.rows.map((r) => [Number(r.member_id), r]));
  const inputs = new Map(inputQ.rows.map((r) => [Number(r.member_id), r]));
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
  const typeLabels: Record<string, string> = { holiday: "Holiday OT", free_week: "Free week OT", shift: "Shift OT" };

  const rows = membersQ.rows.map((member, index) => {
    const memberId = Number(member.id);
    const memberLogs = logsQ.rows.filter((l) => Number(l.member_id) === memberId);
    const logByDate = new Map(memberLogs.map((l) => [String(l.date), l]));
    const c = comp.get(memberId) || {};
    const monthly = inputs.get(memberId) || {};
    const exceptions = exceptionsQ.rows.filter((e) => Number(e.member_id) === memberId);
    const payment = payments.get(memberId);
    const roleShifts = shiftsByRole.get(Number(member.role_id)) || [];
    const otRows = otByMember.get(memberId) || [];
    // A row a person wrote (admin, supervisor, the tablet) is a decision: that
    // day is taken as it is. A row the clock-out scan wrote by itself ("auto")
    // is only a measurement, so a holiday or a free day still wins over it.
    const manualOtRows = otRows.filter((r) => r.source !== "auto");
    const clockShiftRows = new Map(
      otRows.filter((r) => r.source === "auto" && r.type === "shift").map((r) => [r.date, r])
    );
    const manualDates = new Set(manualOtRows.map((r) => r.date));
    const legacyOt = otEntriesQ.rows.filter((o) => Number(o.member_id) === memberId);

    const startedRaw = member.employment_started_at;
    const created = member.first_attendance_date || (startedRaw ? new Date(startedRaw).toISOString().slice(0, 10) : bounds.from);
    const terminated = member.terminated_at ? new Date(member.terminated_at).toISOString().slice(0, 10) : null;
    const freeSchedules = freeQ.rows.filter((f) => Number(f.member_id) === memberId);
    const isFree = (date: string) =>
      freeSchedules.some((f) =>
        f.schedule_type === "dated" ? f.free_date === date : Number(f.weekday) === new Date(`${date}T12:00:00Z`).getUTCDay()
      );
    const presentDates = new Set(memberLogs.filter((l) => l.date).map((l) => String(l.date)));
    const expectedDates = allDates.filter((d) => d >= created && (!terminated || d < terminated || presentDates.has(d)) && !isFree(d));
    const absenceDates = expectedDates.filter((d) => !presentDates.has(d));
    const excusedAbsence = new Set(exceptions.filter((e) => e.exception_type === "absence").map((e) => e.attendance_date));
    const excusedLate = new Set(exceptions.filter((e) => e.exception_type === "lateness").map((e) => e.attendance_date));
    const excusedEarly = new Set(exceptions.filter((e) => e.exception_type === "early_out").map((e) => e.attendance_date));
    /* ── deductions start only AFTER the grace ────────────────────────────
     * The owner's rule (Oct 2026): "the deduction starts if they come after
     * their maximum late time, and the leaving hour, until that nothing
     * happens". Inside the role's Maximum Late Time and Leaving Grace minutes
     * cost nothing; past them, only the minutes beyond are deducted.
     *
     * The minutes are measured from the scan and the role's own times, so an
     * install whose older rows never stored early_out_minutes (the column was
     * written as a flag only) still deducts the right amount instead of zero.
     */
    const measured = memberLogs.map((l) => {
      const shift = shiftOfLog(l, roleShifts);
      const storedLate = Number(l.late_minutes || 0);
      const storedEarly = Number(l.early_out_minutes || 0);
      const late = storedLate > 0 ? storedLate : shift && l.clock_in ? lateMinutesFor(shift, etMinutes(l.clock_in)) : 0;
      const early =
        storedEarly > 0
          ? storedEarly
          : l.early_out && shift && l.clock_out
            ? earlyOutMinutesFor(shift, etMinutes(l.clock_out))
            : 0;
      return { date: String(l.date), late, early, isFree: isFree(String(l.date)) };
    });
    const lateLogs = measured.filter((l) => l.late > 0);
    const deductibleLate = lateLogs.filter((l) => !excusedLate.has(l.date) && !l.isFree);
    const earlyLogs = measured.filter((l) => l.early > 0);
    const deductibleEarly = earlyLogs.filter((l) => !excusedEarly.has(l.date) && !l.isFree);

    /* ── the three overtime kinds, measured, not remembered ───────────────
     * A day is one kind only: a row somebody wrote for that day wins (the
     * supervisor saw something the stopwatch did not), then a registered
     * holiday, then the person's own free date, then a normal shift that ran
     * past its end. This is what keeps a holiday evening from being paid twice
     * once as holiday OT and once as Shift OT.
     */
    let autoHolidayMinutes = 0;
    let autoFreeWeekMinutes = 0;
    let autoShiftMinutes = 0;
    const autoDays: Array<{ date: string; type: string; hours: number; why: string }> = [];
    for (const date of allDates) {
      const log = logByDate.get(date);
      if (!log || manualDates.has(date)) continue;
      const shift = shiftOfLog(log, roleShifts);
      const holiday = holidayByDate.get(date);
      if (holiday) {
        const minutes = recognizedOtMinutes(shift, log);
        if (minutes > 0) {
          autoHolidayMinutes += minutes;
          autoDays.push({ date, type: "holiday", hours: minutesToHours(minutes), why: holiday.name });
        }
        continue;
      }
      if (isFree(date)) {
        const minutes = recognizedOtMinutes(shift, log);
        if (minutes > 0) {
          autoFreeWeekMinutes += minutes;
          autoDays.push({ date, type: "free_week", hours: minutesToHours(minutes), why: "His free day, worked anyway" });
        }
        continue;
      }
      // The clock-out scan may already have measured this day; its own row is
      // the same number, so use it when it is there and measure otherwise.
      const minutes = clockShiftRows.get(date)?.minutes ?? shiftOtMinutesFor(shift, log.clock_out);
      if (minutes > 0) {
        autoShiftMinutes += minutes;
        autoDays.push({ date, type: "shift", hours: minutesToHours(minutes), why: `${minutes} minutes past the shift end` });
      }
    }

    const manualMinutes = (type: OtRow["type"]) =>
      manualOtRows.filter((r) => r.type === type).reduce((s, r) => s + Number(r.minutes || 0), 0);
    const legacyHours = (type: OtRow["type"]) =>
      money(legacyOt.filter((o) => o.overtime_type === type).reduce((s, o) => s + Number(o.hours), 0));

    const holidayOtHours = money(minutesToHours(autoHolidayMinutes + manualMinutes("holiday")) + legacyHours("holiday"));
    const freeWeekOtHours = money(minutesToHours(autoFreeWeekMinutes + manualMinutes("free_week")) + legacyHours("free_week"));
    const shiftOtHours = money(minutesToHours(autoShiftMinutes + manualMinutes("shift")) + legacyHours("shift"));

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
      autoHolidayHours: minutesToHours(autoHolidayMinutes),
      autoFreeWeekHours: minutesToHours(autoFreeWeekMinutes),
      autoShiftHours: minutesToHours(autoShiftMinutes),
      holidayDays: autoDays.filter((d) => d.type === "holiday").length,
      freeWeekDays: autoDays.filter((d) => d.type === "free_week").length,
    };

    const basic = positive(c.basic_salary);
    const transport = positive(c.transport_allowance);
    const breakage = positive(monthly.breakage_shortage);
    const ctx: Record<string, number> = {
      BasicSalary: basic,
      TransportAllowance: transport,
      GrossSalary: 0,
      TaxableSalary: 0,
      OvertimeHours: money(holidayOtHours + freeWeekOtHours + shiftOtHours),
      HolidayOtHours: holidayOtHours,
      FreeWeekOtHours: freeWeekOtHours,
      ShiftOtHours: shiftOtHours,
      ScheduledDays: attendance.scheduledDays,
      ScheduledHours: attendance.scheduledHours,
      DaysPresent: attendance.daysPresent,
      ApprovedAbsences: attendance.approvedAbsences,
      UnapprovedAbsences: attendance.unapprovedAbsences,
      LateCount: attendance.lateCount,
      LateMinutes: attendance.lateMinutes,
      EarlyOutCount: attendance.earlyOutCount,
      EarlyOutMinutes: attendance.earlyOutMinutes,
    };
    const calc = (f: string) => {
      try {
        return f ? Math.max(0, money(evaluatePayrollFormula(f, ctx))) : 0;
      } catch {
        return 0;
      }
    };

    const holidayOtPay = calc(settings.holidayOtFormula);
    const freeWeekOtPay = calc(settings.freeWeekOtFormula);
    const shiftOtPay = calc(settings.shiftOtFormula);
    const overtime = money(holidayOtPay + freeWeekOtPay + shiftOtPay);
    const gross = money(basic + transport + overtime);
    ctx.GrossSalary = gross;
    const taxable = money(gross - transport);
    ctx.TaxableSalary = taxable;

    const employmentDays = periodDates.filter((d) => d >= created && (!terminated || d < terminated || presentDates.has(d))).length;
    const prorationFactor = periodDates.length ? Math.min(1, employmentDays / periodDates.length) : 1;
    const employerPension = money((basic * settings.employerPensionRate) / 100);
    const employeePension = money((basic * settings.employeePensionRate) / 100);
    const incomeTax = calc(settings.incomeTaxFormula);
    const absenceDeduction = calc(settings.absenceFormula);
    const latenessDeduction = calc(settings.latenessFormula);
    const earlyOutDeduction = calc(settings.earlyOutFormula);
    const totalDeduction = money(incomeTax + employeePension + breakage + absenceDeduction + latenessDeduction + earlyOutDeduction);

    const attendanceEvents = [
      ...absenceDates.map((date) => ({ date, dateEc: gregorianDateToEthiopian(date), type: "absence", minutes: 0, excused: excusedAbsence.has(date) })),
      ...lateLogs.map((l) => ({ date: l.date, dateEc: gregorianDateToEthiopian(l.date), type: "lateness", minutes: l.late, excused: excusedLate.has(l.date) })),
      ...earlyLogs.map((l) => ({ date: l.date, dateEc: gregorianDateToEthiopian(l.date), type: "early_out", minutes: l.early, excused: excusedEarly.has(l.date) })),
    ].sort((a, b) => b.date.localeCompare(a.date));

    const writtenEntries = manualOtRows.map((r) => ({
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
        holiday: { hours: holidayOtHours, pay: holidayOtPay, days: attendance.holidayDays },
        freeWeek: { hours: freeWeekOtHours, pay: freeWeekOtPay, days: attendance.freeWeekDays },
        shift: { hours: shiftOtHours, pay: shiftOtPay, days: autoDays.filter((d) => d.type === "shift").length },
        bufferMinutes: OT_BUFFER_MINUTES,
        arrivalGraceMinutes: OT_ARRIVAL_GRACE_MINUTES,
      },
      basicSalary: basic,
      employerPension,
      transportAllowance: transport,
      overtimePay: overtime,
      holidayOtPay,
      freeWeekOtPay,
      shiftOtPay,
      grossSalary: gross,
      taxableSalary: taxable,
      incomeTax,
      employeePension,
      totalPension: money(employerPension + employeePension),
      breakageShortage: breakage,
      absenceDeduction,
      latenessDeduction,
      earlyOutDeduction,
      totalDeduction,
      fullMonthNetPay: money(gross - totalDeduction),
      prorationDays: employmentDays,
      periodDays: periodDates.length,
      prorationFactor,
      netPay: money((gross - totalDeduction) * prorationFactor),
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
    status: period.status || "draft",
    paidAt: period.paid_at || null,
    preparedBy: period.prepared_by || "",
    checkedBy: period.checked_by || "",
    approvedBy: period.approved_by || "",
    settings,
    missingSettings: requiredPayrollSettingsMissing(settings),
    holidays,
    exceptions: exceptionsQ.rows,
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
      const breakageShortage = asNumber(body.breakageShortage);
      await pool.query(
        `INSERT INTO payroll_compensation(member_id,basic_salary,transport_allowance,updated_at) VALUES($1,COALESCE($2,0),COALESCE($3,0),now())
         ON CONFLICT(member_id) DO UPDATE SET
           basic_salary=COALESCE($2,payroll_compensation.basic_salary),
           transport_allowance=COALESCE($3,payroll_compensation.transport_allowance),
           updated_at=now()`,
        [id, basicSalary, transportAllowance]
      );
      await pool.query(
        `INSERT INTO payroll_monthly_inputs(period_key,member_id,breakage_shortage) VALUES($1,$2,COALESCE($3,0))
         ON CONFLICT(period_key,member_id) DO UPDATE SET breakage_shortage=COALESCE($3,payroll_monthly_inputs.breakage_shortage)`,
        [period, id, breakageShortage]
      );
      await pool.query("INSERT INTO payroll_audit(period_key,member_id,action,detail) VALUES($1,$2,'compensation_saved',$3::jsonb)", [
        period,
        id,
        JSON.stringify({ basicSalary, transportAllowance, breakageShortage }),
      ]);
    } else if (action === "add_overtime") {
      const id = Number(body.memberId);
      const type = String(body.overtimeType);
      const hours = positive(body.hours);
      if (!id || !["holiday", "free_week", "shift"].includes(type) || hours <= 0)
        throw new Error("Employee, overtime type and positive hours required");
      if (await isPaid(period, id)) throw new Error("This person is already paid for this month. Take the paid tick back first.");
      await pool.query("INSERT INTO payroll_overtime_entries(member_id,period_key,overtime_type,hours,note) VALUES($1,$2,$3,$4,$5)", [
        id,
        period,
        type,
        hours,
        String(body.note || ""),
      ]);
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
        await pool.query(
          `INSERT INTO payroll_payments(period_key,member_id,paid_at,method,note,snapshot) VALUES($1,$2,now(),$3,$4,$5::jsonb)
           ON CONFLICT(period_key,member_id) DO UPDATE SET paid_at=now(),method=$3,note=$4,snapshot=$5::jsonb`,
          [period, id, String(body.method || "Cash"), String(body.note || "") || null, JSON.stringify(frozen)]
        );
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
