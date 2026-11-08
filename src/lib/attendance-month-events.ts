import { pool } from "@/db";
import { ethiopianMonthBounds, gregorianDateToEthiopian } from "@/lib/payroll";
import {
  earlyOutMinutesFor,
  etMinutes,
  lateMinutesFor,
  pickShift,
  type OvertimeType,
  type RoleShift,
} from "@/lib/attendance";
import { isFreeDate, type FreeScheduleRule } from "@/lib/free-schedule";
import {
  decisionKey,
  sortDecisionEvents,
  type DecisionEvent,
  type DecisionStatus,
} from "@/lib/attendance-decisions";

/**
 * THE MONTH'S ATTENDANCE EVENTS, WITH THEIR DECISION (owner, 2026-11-08).
 *
 * One place builds every lateness, early-out, absence and overtime event of an
 * Ethiopian payroll month and says what the supervisor did about it:
 *
 *   pending   nobody decided. It pays nothing and costs nothing.
 *   approved  DEDUCT (lateness / early out / absence) or ADD (overtime).
 *   denied    DO NOT DEDUCT: the reasonable excuse. Kept as a history row.
 *
 * The report screen and the payroll money both read THIS function, so there is
 * no way for a screen to show "pending" while the salary already took the
 * money. The decisions themselves live where payroll already looked for them:
 *   • denied lateness / early out / absence -> payroll_exceptions
 *   • denied overtime                       -> attendance_ot_exclusions
 *   • approved overtime                     -> attendance_overtime (source "supervisor")
 * A pending row simply has no row in either table, which is what "no decision"
 * means in money terms.
 *
 * The minutes are re-measured on every read from the role's own grace, exactly
 * like the payroll page, so changing Maximum Late Time in Role & Time changes
 * the chargeable minutes the supervisor is asked to confirm.
 */

export type MonthEventRow = DecisionEvent & {
  /** The raw measured minutes, before the supervisor's decision. */
  measuredMinutes: number;
  /** The shift label the scan was measured against, when there was one. */
  shift: string | null;
};

type LogRow = {
  member_id: number;
  date: string;
  clock_in: string | null;
  clock_out: string | null;
  late_minutes: number | null;
  early_out: number | null;
  early_out_minutes: number | null;
};

type MemberRow = {
  id: number;
  name: string;
  role_id: number | null;
  terminated_at: string | null;
  first_date: string | null;
  created_at: string | null;
  employment_started_at: string | null;
};

const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Africa/Addis_Ababa" });

export type MonthEventsResult = {
  period: string;
  from: string;
  to: string;
  /** Every event, decisions included, newest day first (the report's order). */
  events: MonthEventRow[];
  /** The 20-odd people the report can be filtered by. */
  members: Array<{ id: number; name: string }>;
};

/**
 * Build one month. `today` is injected so the "today is never an absence yet"
 * rule can be tested without waiting for midnight.
 */
export async function monthAttendanceEvents(
  periodKey: string,
  options: { today?: string } = {}
): Promise<MonthEventsResult> {
  const [year, month] = periodKey.split("-").map(Number);
  const bounds = ethiopianMonthBounds(year, month);
  const today = options.today || dayKey(new Date());

  const [membersQ, logsQ, shiftsQ, freeQ, decisionsQ, exclusionsQ, overtimeQ, holidaysQ] = await Promise.all([
    pool.query<MemberRow>(
      `SELECT m.id, m.name, m.role_id, m.terminated_at, m.created_at, m.employment_started_at,
              (SELECT min(l.date) FROM attendance_logs l WHERE l.member_id = m.id) AS first_date
         FROM attendance_members m
        ORDER BY m.name`
    ),
    pool.query<LogRow>(
      `SELECT member_id, date, clock_in, clock_out, late_minutes, early_out, early_out_minutes
         FROM attendance_logs
        WHERE date BETWEEN $1 AND $2 AND member_id IS NOT NULL`,
      [bounds.from, bounds.to]
    ),
    pool.query(
      "SELECT role_id,label,start_time,end_time,late_grace_minutes,early_leave_grace_minutes FROM attendance_role_shifts ORDER BY role_id,sort_order,id"
    ),
    pool.query("SELECT * FROM attendance_free_schedules"),
    pool.query(
      "SELECT member_id,attendance_date,event_type,decision,decided_by,reason FROM payroll_deduction_decisions WHERE period_key=$1",
      [periodKey]
    ),
    pool.query("SELECT member_id,date,type FROM attendance_ot_exclusions WHERE date BETWEEN $1 AND $2", [bounds.from, bounds.to]),
    pool.query(
      `SELECT member_id,date,type,minutes,shift_label,source FROM attendance_overtime
        WHERE date BETWEEN $1 AND $2 ORDER BY date,id`,
      [bounds.from, bounds.to]
    ),
    pool.query("SELECT holiday_date,name FROM payroll_holidays WHERE holiday_date BETWEEN $1 AND $2", [bounds.from, bounds.to]),
  ]);

  const shiftsByRole = new Map<number, RoleShift[]>();
  for (const r of shiftsQ.rows as Array<{
    role_id: number;
    label: string;
    start_time: string;
    end_time: string;
    late_grace_minutes: number | null;
    early_leave_grace_minutes: number | null;
  }>) {
    const list = shiftsByRole.get(Number(r.role_id)) || [];
    list.push({
      label: r.label,
      startTime: r.start_time,
      endTime: r.end_time,
      lateGraceMinutes: r.late_grace_minutes ?? 30,
      earlyLeaveGraceMinutes: r.early_leave_grace_minutes ?? 0,
    });
    shiftsByRole.set(Number(r.role_id), list);
  }

  const freeByMember = new Map<number, FreeScheduleRule[]>();
  for (const f of freeQ.rows as Array<Record<string, unknown>>) {
    const id = Number(f.member_id);
    const list = freeByMember.get(id) || [];
    list.push({
      scheduleType: String(f.schedule_type || ""),
      weekday: f.weekday === null || f.weekday === undefined ? null : Number(f.weekday),
      freeDate: f.free_date ? String(f.free_date) : null,
      freeUntil: f.free_until ? String(f.free_until) : null,
    });
    freeByMember.set(id, list);
  }

  /**
   * THE LEDGER IS THE DECISION. A lateness / early-out / absence row has a
   * decision only when a supervisor pressed a button on the report. No row
   * means pending: nothing charged, nothing paid. (The older
   * payroll_exceptions table is still honoured as "do not deduct" so a month
   * that already had exceptions does not start charging them again.)
   */
  const decided = new Map<string, { status: DecisionStatus; by: string; reason: string }>();
  for (const e of decisionsQ.rows as Array<{
    member_id: number;
    attendance_date: string;
    event_type: string;
    decision: string;
    decided_by: string;
    reason: string | null;
  }>) {
    const key = `${e.event_type}|${Number(e.member_id)}|${String(e.attendance_date)}`;
    decided.set(key, {
      status: e.decision === "deduct" ? "approved" : "denied",
      by: String(e.decided_by || ""),
      reason: String(e.reason || ""),
    });
  }
  const legacyExcusedQ = await pool.query<{
    member_id: number;
    attendance_date: string;
    exception_type: string;
    authorized_by: string;
    reason: string;
  }>("SELECT member_id,attendance_date,exception_type,authorized_by,reason FROM payroll_exceptions WHERE period_key=$1", [
    periodKey,
  ]);
  for (const e of legacyExcusedQ.rows) {
    const key = `${e.exception_type}|${Number(e.member_id)}|${String(e.attendance_date)}`;
    if (!decided.has(key)) decided.set(key, { status: "denied", by: e.authorized_by, reason: e.reason });
  }
  const excusedOt = new Map<string, { by: string; reason: string }>();
  for (const e of exclusionsQ.rows as Array<{ member_id: number; date: string; type: string; authorized_by?: string; reason?: string }>) {
    excusedOt.set(`overtime|${Number(e.member_id)}|${String(e.date)}`, {
      by: String(e.authorized_by || ""),
      reason: String(e.reason || ""),
    });
  }
  const approvedOt = new Map<string, { by: string; label: string | null }>();
  for (const o of overtimeQ.rows as Array<{
    member_id: number;
    date: string;
    type: OvertimeType;
    minutes: number;
    shift_label: string | null;
    source: string;
  }>) {
    const key = `overtime|${Number(o.member_id)}|${String(o.date)}`;
    // A supervisor's ADD is the only overtime that is already decided. Measured
    // and auto rows wait like everything else.
    if (o.source === "supervisor") approvedOt.set(key, { by: "", label: o.shift_label });
  }
  const holidayByDate = new Map(
    (holidaysQ.rows as Array<{ holiday_date: string; name: string }>).map((h) => [String(h.holiday_date), String(h.name)])
  );

  const logsByMember = new Map<number, LogRow[]>();
  for (const l of logsQ.rows) {
    const id = Number(l.member_id);
    const list = logsByMember.get(id) || [];
    list.push(l);
    logsByMember.set(id, list);
  }

  /** Every calendar day from `from` to `min(to, today)`: the days that can be judged. */
  const judgedDays: string[] = [];
  for (let d = new Date(`${bounds.from}T00:00:00Z`); ; d = new Date(d.getTime() + 86_400_000)) {
    const key = d.toISOString().slice(0, 10);
    if (key > bounds.to) break;
    judgedDays.push(key);
  }

  const events: MonthEventRow[] = [];

  for (const member of membersQ.rows) {
    const memberId = Number(member.id);
    const memberLogs = logsByMember.get(memberId) || [];
    const logByDate = new Map(memberLogs.map((l) => [String(l.date), l]));
    const roleShifts = shiftsByRole.get(Number(member.role_id)) || [];
    /**
     * Absences are counted from the day this person became an employee, never
     * from the first of the month: a waiter hired on the 20th was not absent
     * for the 19 days before that, and a brand-new person must not open the
     * report with 28 red rows. The earliest of the three honest signals wins:
     * the employment start the owner typed, the first scan ever, or the moment
     * the row was created.
     */
    const startsOn = [
      member.employment_started_at ? String(member.employment_started_at).slice(0, 10) : null,
      member.first_date ? String(member.first_date) : null,
      member.created_at ? dayKey(new Date(member.created_at)) : null,
    ]
      .filter((d): d is string => Boolean(d))
      .sort()[0] || bounds.from;
    const terminated = member.terminated_at ? String(member.terminated_at).slice(0, 10) : null;
    const freeRules = freeByMember.get(memberId) || [];
    const isFree = (date: string) => isFreeDate(freeRules, date);

    const push = (
      date: string,
      type: "lateness" | "early_out" | "absence" | "overtime",
      minutes: number,
      label?: string | null,
      overtimeType?: string
    ) => {
      const key = decisionKey({ memberId, date, type });
      let status: DecisionStatus = "pending";
      let decidedBy = "";
      let reason = "";
      if (type === "overtime") {
        const excused = excusedOt.get(key);
        const added = approvedOt.get(key);
        if (excused) {
          status = "denied";
          decidedBy = excused.by;
          reason = excused.reason;
        } else if (added) {
          status = "approved";
          decidedBy = added.by;
        }
      } else {
        const d = decided.get(key);
        if (d) {
          status = d.status;
          decidedBy = d.by;
          reason = d.reason;
        }
      }
      events.push({
        memberId,
        memberName: String(member.name),
        date,
        dateEc: gregorianDateToEthiopian(date),
        type,
        // The measurement, whatever the decision is: the report has to be able to
        // say "late 30 min" BEFORE anybody decides, and a decided row keeps the
        // same number so the two lines of the history agree.
        minutes,
        measuredMinutes: minutes,
        status,
        decidedBy,
        reason,
        label: label || undefined,
        overtimeType,
        affectsMoney: status !== "pending",
        shift: label || null,
      });
    };

    for (const log of memberLogs) {
      const date = String(log.date);
      if (isFree(date)) continue;
      // A log from before this person was on the list (a legacy row, a re-used
      // id) is not his to be judged on.
      if (date < startsOn) continue;
      const shift = pickShift(roleShifts, etMinutes(log.clock_in || "")) ?? roleShifts[0] ?? null;
      const storedLate = Math.max(0, Math.round(Number(log.late_minutes || 0)));
      const storedEarly = Math.max(0, Math.round(Number(log.early_out_minutes || 0)));
      const rawLate = shift && log.clock_in ? lateMinutesFor(shift, etMinutes(log.clock_in)) : storedLate;
      const rawEarly =
        shift && log.clock_out ? earlyOutMinutesFor(shift, etMinutes(log.clock_out)) : log.early_out ? storedEarly : 0;
      if (rawLate > 0) push(date, "lateness", Math.min(rawLate, 8 * 60), shift?.label || null);
      if (rawEarly > 0) push(date, "early_out", Math.min(rawEarly, 8 * 60), shift?.label || null);
    }

    // A day without a scan is an absence only once the day is over.
    for (const date of judgedDays) {
      if (date >= today) continue;
      if (date < startsOn) continue;
      if (terminated && date >= terminated) continue;
      if (isFree(date)) continue;
      if (logByDate.has(date)) continue;
      if (holidayByDate.has(date)) continue;
      push(date, "absence", 0);
    }

    // Overtime rows the system measured or a person typed: each is one decision.
    for (const o of overtimeQ.rows as Array<{
      member_id: number;
      date: string;
      type: string;
      minutes: number;
      shift_label: string | null;
    }>) {
      if (Number(o.member_id) !== memberId) continue;
      push(
        String(o.date),
        "overtime",
        Math.max(0, Math.round(Number(o.minutes) || 0)),
        o.shift_label,
        String(o.type)
      );
    }
  }

  return {
    period: periodKey,
    from: bounds.from,
    to: bounds.to,
    events: sortDecisionEvents(events),
    members: membersQ.rows.map((m) => ({ id: Number(m.id), name: String(m.name) })),
  };
}
