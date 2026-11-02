import { NextResponse } from "next/server";
import { db, pool } from "@/db";
import {
  attendanceLogs,
  attendanceMembers,
  attendanceOtExclusions,
  attendanceOvertime,
  attendanceRoleShifts,
  payrollHolidays,
} from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { deviceAllowed } from "@/lib/attendance-device";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { etDayKey } from "@/lib/timezone";
import {
  computePayrollMoney,
  ethiopianDateToGregorian,
  minutesToHours,
  recognizedOtMinutes,
  withDefaultPayrollFormulas,
  type PayrollSettings,
} from "@/lib/payroll";
import { saveOvertimeRow } from "@/lib/attendance-overtime";
import {
  OVERTIME_TYPE_LABELS,
  clockLabel,
  etMinutes,
  hoursLabel,
  isOvertimeSource,
  isOvertimeType,
  overtimeHoursLabel,
  overtimeMinutesFromLog,
  pickShift,
  type OvertimeSource,
  type OvertimeType,
  type RoleShift,
} from "@/lib/attendance";

/**
 * OVERTIME (owner, Oct 2026).
 *
 * The tab on the Attendance page and the button on the door tablet both come
 * here, and so does the clock-out scan of a person who stayed past his shift.
 * Three kinds, one row each per person per day:
 *
 *   holiday    a public holiday or rest day that was worked
 *   free_week  the person's own free week, given up
 *   shift      hours past the end of the shift
 *
 *   GET    ?from&to[&memberId]  the rows of a range, with the names and hours
 *   POST   {memberId, date, type, hours?|minutes?, shiftLabel?, note?}
 *                              write one row (it replaces the row of the same
 *                              person + day + kind + shift, so a double tap
 *                              cannot count the same hours twice)
 *   POST   {logId} | {memberId, date}   the old plain switch: it only flips
 *                              the violet "overtime" mark on the sheet, which
 *                              is what the door device sends today
 *   DELETE ?id=n               take one row back (an admin)
 *
 * There is NO approval step (owner: the row must "list immediately"). What is
 * written here is the record; the day's box on the paper sheet turns violet
 * beside it, and the Leaderboard counts the day as an overtime day.
 *
 * Who may call it: the door tablet, which has no login of its own (exactly
 * like /api/attendance/clock), or an admin session. If the owner sets
 * ATTENDANCE_DEVICE_TOKEN, the tablet must carry it. Deleting is admin only:
 * taking hours back off somebody's pay is not a tap at the door.
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MINUTES = 24 * 60;

function todayKey(): string {
  return etDayKey(new Date()) || new Date().toISOString().slice(0, 10);
}

/** Hours or minutes from the body. Hours win when both are there, because the
 *  admin types hours and the tablet is allowed to send minutes. */
function minutesFromBody(body: any): number | null {
  const hours = body.hours === undefined || body.hours === null ? null : Number(body.hours);
  if (hours !== null && Number.isFinite(hours)) return Math.round(hours * 60);
  const minutes = body.minutes === undefined || body.minutes === null ? null : Number(body.minutes);
  if (minutes !== null && Number.isFinite(minutes)) return Math.round(minutes);
  return null;
}

async function memberNames(): Promise<Map<number, string>> {
  const members = await db
    .select({ id: attendanceMembers.id, name: attendanceMembers.name })
    .from(attendanceMembers);
  return new Map(members.map((m) => [m.id, m.name]));
}

async function loadPayrollMoneyHelpers(): Promise<{
  settings: PayrollSettings;
  compByMember: Map<number, { basicSalary: number; transportAllowance: number }>;
}> {
  const [settingsQ, compQ] = await Promise.all([
    pool.query("SELECT settings, approved FROM payroll_settings WHERE id=1"),
    pool.query("SELECT member_id, basic_salary, transport_allowance FROM payroll_compensation"),
  ]);
  const settings = withDefaultPayrollFormulas(settingsQ.rows[0]?.settings || {});
  const compByMember = new Map<number, { basicSalary: number; transportAllowance: number }>();
  for (const r of compQ.rows) {
    compByMember.set(Number(r.member_id), {
      basicSalary: Math.max(0, Number(r.basic_salary) || 0),
      transportAllowance: Math.max(0, Number(r.transport_allowance) || 0),
    });
  }
  return { settings, compByMember };
}

function calculateEntryPay(
  type: OvertimeType,
  minutes: number,
  comp: { basicSalary: number; transportAllowance: number } | undefined,
  settings: PayrollSettings
): number {
  if (!comp || comp.basicSalary <= 0 || minutes <= 0) return 0;
  const hours = minutesToHours(minutes);
  return computePayrollMoney({
    basicSalary: comp.basicSalary,
    transportAllowance: comp.transportAllowance,
    breakageShortage: 0,
    settings,
    attendance: {
      HolidayOtHours: type === "holiday" ? hours : 0,
      FreeWeekOtHours: type === "free_week" ? hours : 0,
      ShiftOtHours: type === "shift" ? hours : 0,
      NightShiftOtHours: type === "night_shift" ? hours : 0,
    },
  }).display.overtimePay;
}

/**
 * THE LIST. Both the admin tab and the tablet read it, so a row written at the
 * door is on the page before anybody walks upstairs to say so.
 */
export async function GET(request: Request) {
  const device = deviceAllowed(request);
  const auth = await requireAdmin();
  if (!device && !auth.ok) return auth.response;

  await ensureTablesExist();

  const url = new URL(request.url);
  const to = url.searchParams.get("to") || todayKey();
  const from = url.searchParams.get("from") || to;
  const memberId = Number(url.searchParams.get("memberId") || 0);

  try {
    const conds = [gte(attendanceOvertime.date, from), lte(attendanceOvertime.date, to)];
    if (memberId) conds.push(eq(attendanceOvertime.memberId, memberId));

    const [rawRows, allMembers, shiftRows, holidays, logs, excludedRows, moneyHelpers] = await Promise.all([
      db
        .select()
        .from(attendanceOvertime)
        .where(and(...conds))
        .orderBy(desc(attendanceOvertime.date), asc(attendanceOvertime.id)),
      db.select({ id: attendanceMembers.id, name: attendanceMembers.name, roleId: attendanceMembers.roleId }).from(attendanceMembers),
      db.select().from(attendanceRoleShifts).orderBy(asc(attendanceRoleShifts.sortOrder), asc(attendanceRoleShifts.id)),
      db.select().from(payrollHolidays).where(and(gte(payrollHolidays.holidayDate, from), lte(payrollHolidays.holidayDate, to))),
      db.select().from(attendanceLogs).where(and(gte(attendanceLogs.date, from), lte(attendanceLogs.date, to))),
      db.select().from(attendanceOtExclusions).where(and(gte(attendanceOtExclusions.date, from), lte(attendanceOtExclusions.date, to))),
      loadPayrollMoneyHelpers(),
    ]);

    // Only keep manually entered overtime rows (admin / supervisor / self);
    // automatic overtime is granted exclusively for registered holiday scans.
    const rows = rawRows.filter((r) => r.source !== "auto");

    const names = new Map(allMembers.map((m) => [m.id, m.name]));
    const memberRoleById = new Map(allMembers.map((m) => [m.id, m.roleId]));
    const shiftsByRole = new Map<number, RoleShift[]>();
    for (const s of shiftRows) {
      const list = shiftsByRole.get(s.roleId) || [];
      list.push({
        label: s.label,
        startTime: s.startTime,
        endTime: s.endTime,
        lateGraceMinutes: s.lateGraceMinutes ?? 30,
        earlyLeaveGraceMinutes: s.earlyLeaveGraceMinutes ?? 0,
      });
      shiftsByRole.set(s.roleId, list);
    }

    const logOf = new Map<string, (typeof logs)[number]>();
    for (const log of logs) {
      if (!log.memberId) continue;
      if (memberId && log.memberId !== memberId) continue;
      const key = `${log.memberId}|${log.date}`;
      const prev = logOf.get(key);
      if (!prev || (log.id ?? 0) > (prev.id ?? 0)) logOf.set(key, log);
    }

    const manualHolidayKeys = new Set(
      rows.filter((r) => r.type === "holiday").map((r) => `${r.memberId}|${r.date}`)
    );
    const holidayByDate = new Map(holidays.map((h) => [h.holidayDate, h]));

    const manualOut = rows.map((row) => {
      const log = logOf.get(`${row.memberId}|${row.date}`) ?? null;
      const type = row.type as OvertimeType;
      const estimatedPay = calculateEntryPay(
        type,
        row.minutes,
        moneyHelpers.compByMember.get(row.memberId),
        moneyHelpers.settings
      );
      return {
        id: row.id,
        memberId: row.memberId,
        memberName: names.get(row.memberId) || `Member ${row.memberId}`,
        date: row.date,
        type,
        typeLabel: OVERTIME_TYPE_LABELS[type] || row.type,
        minutes: row.minutes,
        hoursLabel: overtimeHoursLabel(row.minutes),
        estimatedPay,
        shiftLabel: row.shiftLabel ?? null,
        logId: row.logId ?? null,
        source: row.source as OvertimeSource,
        enteredBy: row.enteredBy ?? null,
        note: row.note ?? holidayByDate.get(row.date)?.name ?? null,
        automatic: false,
        createdAt: row.createdAt ?? null,
        clockInLabel: log ? clockLabel(log.clockIn) : null,
        clockOutLabel: log ? clockLabel(log.clockOut) : null,
        workedLabel: log?.totalMinutes ? hoursLabel(log.totalMinutes) : null,
      };
    });

    // Surface system-calculated Holiday fingerprint scans directly in Overtime History.
    const autoHolidayOut: typeof manualOut = [];
    for (const log of logOf.values()) {
      const mId = log.memberId;
      if (!mId) continue;
      const holiday = holidayByDate.get(log.date);
      if (!holiday) continue;
      if (manualHolidayKeys.has(`${mId}|${log.date}`)) continue;
      const roleId = log.roleId ?? memberRoleById.get(mId) ?? null;
      const roleShifts = roleId ? shiftsByRole.get(roleId) || [] : [];
      const shift = log.clockIn && roleShifts.length > 0 ? pickShift(roleShifts, etMinutes(log.clockIn)) : roleShifts[0] ?? null;
      const minutes = recognizedOtMinutes(shift, log);
      if (minutes <= 0) continue;
      const estimatedPay = calculateEntryPay(
        "holiday",
        minutes,
        moneyHelpers.compByMember.get(mId),
        moneyHelpers.settings
      );
      autoHolidayOut.push({
        id: -log.id,
        memberId: mId,
        memberName: names.get(mId) || `Member ${mId}`,
        date: log.date,
        type: "holiday",
        typeLabel: OVERTIME_TYPE_LABELS.holiday,
        minutes,
        hoursLabel: overtimeHoursLabel(minutes),
        estimatedPay,
        shiftLabel: shift?.label ?? null,
        logId: log.id,
        source: "auto",
        enteredBy: "Holiday scan",
        note: holiday.name,
        automatic: true,
        createdAt: log.clockOut ?? log.clockIn ?? null,
        clockInLabel: clockLabel(log.clockIn),
        clockOutLabel: clockLabel(log.clockOut),
        workedLabel: log.totalMinutes ? hoursLabel(log.totalMinutes) : null,
      });
    }

    const out = [...manualOut, ...autoHolidayOut].sort(
      (a, b) => b.date.localeCompare(a.date) || a.memberName.localeCompare(b.memberName)
    );

    const excludedSet = new Set(excludedRows.map((r) => `${r.memberId}|${r.date}|${r.type}`));
    const activeOut = out.filter((r) => !excludedSet.has(`${r.memberId}|${r.date}|${r.type}`));
    const totalMinutes = activeOut.reduce((sum, r) => sum + (Number(r.minutes) || 0), 0);
    const totalPay = Math.round(activeOut.reduce((sum, r) => sum + (Number(r.estimatedPay) || 0), 0) * 100) / 100;

    return NextResponse.json({
      from,
      to,
      rows: out,
      exclusions: excludedRows.map((r) => ({
        id: r.id,
        memberId: r.memberId,
        date: r.date,
        type: r.type,
        authorizedBy: r.authorizedBy ?? null,
        reason: r.reason ?? null,
      })),
      totalMinutes,
      totalHoursLabel: overtimeHoursLabel(totalMinutes),
      totalPay,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

/**
 * WRITE. One entry point for all three sources; who is allowed to say what:
 *
 *   admin       the Attendance page                    -> any kind
 *   supervisor  the door tablet with the keypad open   -> any kind
 *   self        the person's own tap at the door       -> any kind
 *   auto        the clock-out scan (the route below)   -> "shift" only
 *
 * A row replaces the row of the same person + day + kind + shift, so the same
 * overtime typed twice stays counted once.
 */
export async function POST(request: Request) {
  const device = deviceAllowed(request);
  const auth = await requireAdmin();
  if (!device && !auth.ok) return auth.response;
  const isAdmin = auth.ok;

  await ensureTablesExist();

  try {
    const body = await request.json().catch(() => ({}));
    // The payroll page lets the owner pick the Ethiopian day he reads on the
    // sheet; it sends dateEc, and the conversion happens here, once.
    const dateEc = String(body.dateEc ?? "").trim();
    let date = String(body.date ?? "") || todayKey();
    if (dateEc) {
      try {
        date = ethiopianDateToGregorian(dateEc);
      } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "Use an Ethiopian date YYYY-MM-DD" }, { status: 400 });
      }
    }
    if (!DAY_RE.test(date)) {
      return NextResponse.json({ error: "A date like 2026-10-16 is needed" }, { status: 400 });
    }

    const memberId = Number(body.memberId ?? 0);
    const logId = Number(body.logId ?? 0);

    /* ── "DON'T GIVE": silence an overtime without erasing its history ────
     * Owner (2026-10-28): "if that person is accedently given that ot wrongly
     * they can make it not to deduct". Admin only: a tap at the door must
     * never be able to take somebody's pay away. One row per person+day+kind;
     * give_again removes it. Measured overtime has no typed row to remove,
     * which is why this is its own table and not a flag on attendance_overtime.
     */
    const decision = String(body.action ?? "");
    if (decision === "dont_give" || decision === "give_again") {
      if (!isAdmin) return NextResponse.json({ error: "Only an admin can decide not to give overtime" }, { status: 403 });
      const kind = String(body.type ?? "");
      if (!isOvertimeType(kind)) return NextResponse.json({ error: "Which overtime kind?" }, { status: 400 });
      if (!memberId) return NextResponse.json({ error: "Pick the person first" }, { status: 400 });
      if (decision === "give_again") {
        await db.delete(attendanceOtExclusions).where(and(
          eq(attendanceOtExclusions.memberId, memberId),
          eq(attendanceOtExclusions.date, date),
          eq(attendanceOtExclusions.type, kind)
        ));
      } else {
        await db.insert(attendanceOtExclusions).values({
          memberId,
          date,
          type: kind,
          authorizedBy: String(body.authorizedBy ?? "").trim().slice(0, 100) || "admin",
          reason: String(body.reason ?? "").trim().slice(0, 300) || "Given by mistake - do not pay",
        }).onConflictDoNothing();
      }
      return NextResponse.json({
        success: true,
        excluded: decision === "dont_give",
        message: decision === "dont_give" ? "Overtime kept in history but not given." : "Overtime given again.",
      });
    }

    // The day's line: the person's own, today unless a date came with it.
    let log: (typeof attendanceLogs.$inferSelect) | null = null;
    if (logId) {
      const rows = await db.select().from(attendanceLogs).where(eq(attendanceLogs.id, logId)).limit(1);
      log = rows[0] ?? null;
    } else if (memberId) {
      const rows = await db
        .select()
        .from(attendanceLogs)
        .where(and(eq(attendanceLogs.memberId, memberId), eq(attendanceLogs.date, date)))
        .orderBy(desc(attendanceLogs.id))
        .limit(1);
      log = rows[0] ?? null;
    }

    const type = body.type;
    const clear = String(body.action ?? "") === "clear";

    /* ── the old plain switch: only the violet mark on the sheet ─────────── */
    if (!isOvertimeType(type)) {
      if (!log) {
        return NextResponse.json(
          { error: "No scan for today yet. Scan the fingerprint first, then press Overtime." },
          { status: 404 }
        );
      }
      const updated = (
        await db
          .update(attendanceLogs)
          .set({ isOvertime: !clear, updatedAt: new Date() })
          .where(eq(attendanceLogs.id, log.id))
          .returning()
      )[0];
      const names = await memberNames();
      const memberName = updated.memberId ? names.get(updated.memberId) || `Member ${updated.memberId}` : "Member";
      return NextResponse.json({
        success: true,
        logId: updated.id,
        memberId: updated.memberId,
        memberName,
        isOvertime: Boolean(updated.isOvertime),
        clockInLabel: clockLabel(updated.clockIn),
        clockOutLabel: clockLabel(updated.clockOut),
        message: clear
          ? `${memberName} is no longer marked as overtime`
          : `Overtime saved for ${memberName}`,
      });
    }

    /* ── a real overtime row ─────────────────────────────────────────────── */
    if (!memberId) {
      return NextResponse.json({ error: "Pick the person first" }, { status: 400 });
    }
    const members = await db
      .select({ id: attendanceMembers.id, name: attendanceMembers.name, active: attendanceMembers.active })
      .from(attendanceMembers)
      .where(eq(attendanceMembers.id, memberId))
      .limit(1);
    const member = members[0];
    if (!member) return NextResponse.json({ error: "No such staff member" }, { status: 404 });

    const shiftLabel = String(body.shiftLabel ?? "").trim() || null;
    const asked = minutesFromBody(body);
    const minutes = Math.max(
      0,
      Math.min(MAX_MINUTES, asked ?? overtimeMinutesFromLog(log))
    );
    if (minutes <= 0) {
      return NextResponse.json(
        { error: "Type how many hours. The tablet can only count them from a scan when there is one." },
        { status: 400 }
      );
    }

    // Who wrote it: the admin page says "admin"; the door tablet says whether
    // the person tapped it himself or the supervisor did it for him.
    // A tablet never gets to call itself an admin, and an admin never gets to
    // call his own typing "auto": the label says who really sat at the door.
    const source: OvertimeSource = !isAdmin
      ? "self"
      : isOvertimeSource(body.source) && body.source !== "auto"
        ? body.source
        : "admin";
    const enteredBy = String(body.enteredBy ?? "").trim().slice(0, 100) || (isAdmin ? "admin" : "at the door");

    // The row is written through the one place that knows what "the same
    // overtime again" means, so a double tap updates instead of counting twice.
    const { row, replaced } = await saveOvertimeRow({
      memberId,
      date,
      type,
      shiftLabel,
      minutes,
      source,
      enteredBy,
      logId: log?.id ?? null,
      note: String(body.note ?? "").trim().slice(0, 300) || null,
    });

    // The day itself is overtime too: that is what colours the box on the sheet
    // and what the Leaderboard counts, so the two views cannot disagree.
    if (log && !log.isOvertime) {
      await db
        .update(attendanceLogs)
        .set({ isOvertime: true, updatedAt: new Date() })
        .where(eq(attendanceLogs.id, log.id));
    }

    const moneyHelpers = await loadPayrollMoneyHelpers();
    const estimatedPay = calculateEntryPay(
      type,
      row.minutes,
      moneyHelpers.compByMember.get(memberId),
      moneyHelpers.settings
    );
    const paySuffix = estimatedPay > 0 ? ` (+${estimatedPay.toFixed(2)} ETB added to Payroll)` : " (added to Payroll)";

    return NextResponse.json({
      success: true,
      replaced,
      row: {
        id: row.id,
        memberId: row.memberId,
        memberName: member.name,
        date: row.date,
        type: row.type,
        typeLabel: OVERTIME_TYPE_LABELS[row.type as OvertimeType] ?? row.type,
        minutes: row.minutes,
        hoursLabel: overtimeHoursLabel(row.minutes),
        estimatedPay,
        shiftLabel: row.shiftLabel ?? null,
        source: row.source,
        enteredBy: row.enteredBy ?? null,
        note: row.note ?? null,
      },
      message: `${member.name}: ${overtimeHoursLabel(row.minutes)} ${OVERTIME_TYPE_LABELS[type]}${paySuffix}`,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

/** Take one row back (admin only). The sheet's violet box goes with it when the
 *  day has no overtime left, because then nothing says it was overtime. */
export async function DELETE(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  await ensureTablesExist();

  try {
    const url = new URL(request.url);
    const id = Number(url.searchParams.get("id") || 0);
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const rows = await db.select().from(attendanceOvertime).where(eq(attendanceOvertime.id, id)).limit(1);
    const row = rows[0];
    if (!row) return NextResponse.json({ error: "That overtime row is gone already" }, { status: 404 });

    await db.delete(attendanceOvertime).where(eq(attendanceOvertime.id, id));

    const left = await db
      .select({ id: attendanceOvertime.id })
      .from(attendanceOvertime)
      .where(and(eq(attendanceOvertime.memberId, row.memberId), eq(attendanceOvertime.date, row.date)))
      .limit(1);
    if (left.length === 0) {
      await db
        .update(attendanceLogs)
        .set({ isOvertime: false, updatedAt: new Date() })
        .where(and(eq(attendanceLogs.memberId, row.memberId), eq(attendanceLogs.date, row.date)));
    }

    return NextResponse.json({ success: true, removedId: id, message: "Overtime removed" });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
