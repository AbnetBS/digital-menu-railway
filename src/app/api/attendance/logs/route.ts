import { NextResponse } from "next/server";
import { db } from "@/db";
import { attendanceFreeSchedules, attendanceLogs, attendanceMembers, attendanceRoleShifts, attendanceRoles } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { CHANNELS, publish } from "@/lib/realtime";
import { etDayKey } from "@/lib/timezone";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import {
  clockLabel,
  daysBetween,
  earlyArrivalMinutesFor,
  etMinutes,
  hoursLabel,
  inStatusOf,
  isEarlyOut,
  lateMinutesFor,
  outStatusOf,
  pickShift,
  sheetDates,
  sheetPages,
  stayedIntoNextShift,
  SHEET_MAX_DAYS,
  SHEET_RANGE_MAX_DAYS,
  type RoleShift,
} from "@/lib/attendance";
import { isFreeDate, type FreeScheduleRule } from "@/lib/free-schedule";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
};

/**
 * THE PAPER SHEET (owner, Oct 2026).
 *
 * One row per person of the attendance listing, one pair of boxes per day:
 * IN (time & signature) and OUT (time & signature), exactly like the paper he
 * used to keep.
 *
 * The range reaches up to SHEET_RANGE_MAX_DAYS (30) days now - "make it up to
 * 30 days because like that it will be very useful" - and it is still SEVEN
 * days wide per printed page: the answer carries `pages`, the tab shows one
 * page at a time with the page numbers below it, and printing emits every page
 * in order (the first 7 days, then the next 7, ...).
 *
 * Every box carries its own status so the admin tab can colour it:
 *   IN   absent (red, from registration through today) | late (yellow) | on_time (green)
 *   OUT  none | still_in | completed | early_out (blue) | overtime (violet)
 * Dates before a member's registration and after today are blank, not absent.
 */

export async function GET(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  await ensureTablesExist();

  try {
    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const date = searchParams.get("date");
    const memberIdFilter = searchParams.get("memberId");
    const today = etDayKey(new Date()) || new Date().toISOString().slice(0, 10);

    const members = await db.select().from(attendanceMembers);
    const roles = await db.select().from(attendanceRoles);
    const shiftRows = await db
      .select()
      .from(attendanceRoleShifts)
      .orderBy(asc(attendanceRoleShifts.sortOrder), asc(attendanceRoleShifts.id));
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
    const roleName = new Map(roles.map((r) => [r.id, r.name]));

    const rows = members
      .filter((m) => m.active !== false)
      .filter((m) => !memberIdFilter || m.id === Number(memberIdFilter))
      .map((m) => ({
        id: m.id,
        name: m.name,
        roleId: m.roleId,
        role: m.roleId ? roleName.get(m.roleId) || "No role" : "No role",
        // Registration date in the attendance sheet's Ethiopian calendar.
        registeredOn: etDayKey(m.createdAt),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const dates = date ? [date] : sheetDates(from, to);

    let logs: typeof attendanceLogs.$inferSelect[] = [];
    if (dates.length > 0) {
      logs = await db
        .select()
        .from(attendanceLogs)
        .where(
          date
            ? eq(attendanceLogs.date, date)
            : and(gte(attendanceLogs.date, dates[0]), lte(attendanceLogs.date, dates[dates.length - 1]))
        );
    }

    // THE FREE DAYS (owner, 2026-11-07): "i add free days for each person so
    // when that person isn't put his finger at that time there will not be
    // absent label which is red box". A registered free day is violet "Free
    // day" instead of the red Absent, and a person who comes in anyway is
    // marked blue "Worked" - the paid overtime, if any, is entered by hand.
    const freeRows = await db.select().from(attendanceFreeSchedules);
    const freeByMember = new Map<number, FreeScheduleRule[]>();
    for (const f of freeRows) {
      const list = freeByMember.get(f.memberId) || [];
      list.push({
        scheduleType: String(f.scheduleType || ""),
        weekday: f.weekday === null || f.weekday === undefined ? null : Number(f.weekday),
        freeDate: f.freeDate ? String(f.freeDate) : null,
        freeUntil: f.freeUntil ? String(f.freeUntil) : null,
      });
      freeByMember.set(f.memberId, list);
    }

    const matrix: Record<number, Record<string, ReturnType<typeof cellOf> | null>> = {};
    for (const r of rows) {
      matrix[r.id] = {};
      const freeRules = freeByMember.get(r.id) || [];
      for (const d of dates) {
        const log = logs.find((l) => l.memberId === r.id && l.date === d) || null;
        const roleId = log?.roleId ?? r.roleId;
        const shifts = roleId ? shiftsByRole.get(roleId) || [] : [];
        const freeDay = freeRules.length > 0 && isFreeDate(freeRules, d);
        matrix[r.id][d] = cellOf(log, shifts, freeDay);
      }
    }

    const pages = sheetPages(dates);

    return NextResponse.json({
      from: dates[0] ?? from,
      to: dates[dates.length - 1] ?? to,
      dates,
      // The printed pages: 7 day-columns each, so a 30-day ask comes back as
      // five pages and the print is divided exactly the same way.
      pages,
      pageDays: SHEET_MAX_DAYS,
      pageCount: pages.length,
      today,
      // True when the owner asked for more than a month and it was cut back.
      capped: from && to ? Math.abs(daysBetween(from, to)) + 1 > SHEET_RANGE_MAX_DAYS : false,
      requestedDays: from && to ? Math.abs(daysBetween(from, to)) + 1 : dates.length,
      maxDays: SHEET_RANGE_MAX_DAYS,
      // `staffList` keeps its old name: the print area reads it for the rows.
      staffList: rows,
      matrix,
      logs: logs.map((l) => ({
        ...l,
        clockInTime: clockLabel(l.clockIn),
        clockOutTime: clockLabel(l.clockOut),
        totalHours: l.clockOut ? hoursLabel(l.totalMinutes) : null,
      })),
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

/**
 * One box of the sheet: the times plus the colour it must be printed in.
 *
 * `freeDay` comes from the person's own free schedule. A free day with no scan
 * is never red; a free day he worked is blue "Worked". The violet "stayed into
 * the next shift" mark is measured here, not paid: the owner turned the
 * automatic Shift OT off on 2026-11-07 and enters paid overtime himself.
 */
function cellOf(
  log: typeof attendanceLogs.$inferSelect | null,
  shifts: RoleShift[] = [],
  freeDay = false
) {
  if (!log && !freeDay) return null;
  const context = { freeDay };
  if (!log) {
    return {
      logId: null,
      memberId: null,
      clockInTime: null,
      clockOutTime: null,
      totalHours: null,
      lateMinutes: 0,
      isOvertime: false,
      earlyOut: false,
      freeDay: true,
      stayedNextShift: false,
      status: "free",
      inStatus: inStatusOf(null, context),
      outStatus: outStatusOf(null, context),
      fingerprintId: null,
      clockInMethod: null,
    };
  }
  const shift = log.clockIn && shifts.length > 0 ? pickShift(shifts, etMinutes(log.clockIn)) : null;
  const lateMinutes = shift && log.clockIn ? lateMinutesFor(shift, etMinutes(log.clockIn)) : log.lateMinutes || 0;
  const earlyOut = shift && log.clockOut ? isEarlyOut(shift, etMinutes(log.clockOut)) : Boolean(log.earlyOut);
  // STAYED UNTIL THE NEXT SHIFT: his OUT is nearer the next shift's leaving
  // time than his own. A mark only (violet), never money.
  // Measured on every OUT after his own shift end, whether he left early or
  // stayed past it: the mark is "he was here into the next shift's time".
  const stay = shift && log.clockOut ? stayedIntoNextShift(shifts, shift, etMinutes(log.clockOut)) : null;
  // SENT IN EARLY: hours before his own shift start (supervisor sends him in
  // early). Marked violet on the paper, never paid by itself.
  const earlyArrivalMinutes = shift && log.clockIn ? earlyArrivalMinutesFor(shift, etMinutes(log.clockIn)) : 0;
  const measured = { ...log, lateMinutes, earlyOut };
  return {
    logId: log.id,
    memberId: log.memberId,
    clockInTime: clockLabel(log.clockIn),
    clockOutTime: clockLabel(log.clockOut),
    totalHours: log.clockOut ? hoursLabel(log.totalMinutes) : null,
    lateMinutes,
    isOvertime: Boolean(log.isOvertime),
    earlyOut,
    freeDay,
    stayedNextShift: Boolean(stay),
    earlyArrivalMinutes,
    stayedShiftLabel: stay?.shift.label ?? null,
    status: log.clockOut ? (earlyOut ? "early_out" : "completed") : lateMinutes > 0 ? "late" : "on_time",
    // The violet OT mark: early arrival before his own shift, or left after
    // his own shift but close to the next one. Both say "extra hours here".
    markedOvertime: Boolean(log.isOvertime) || earlyArrivalMinutes > 0 || Boolean(stay),
    inStatus: inStatusOf(measured, { ...context, earlyArrival: earlyArrivalMinutes > 0 }),
    outStatus: outStatusOf(measured, { ...context, stayedNextShift: Boolean(stay) }),
    fingerprintId: log.fingerprintId,
    clockInMethod: log.clockInMethod,
  };
}

export async function DELETE(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  await ensureTablesExist();

  try {
    const id = Number(new URL(request.url).searchParams.get("id"));
    if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });

    const removed = await db.delete(attendanceLogs).where(eq(attendanceLogs.id, id)).returning({ id: attendanceLogs.id });
    if (removed.length === 0) return NextResponse.json({ error: "Line not found" }, { status: 404 });
    publish(CHANNELS.attendance);
    return NextResponse.json({ success: true, message: "Line deleted" });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
