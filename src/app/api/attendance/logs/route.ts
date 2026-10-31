import { NextResponse } from "next/server";
import { db } from "@/db";
import { attendanceLogs, attendanceMembers, attendanceRoleShifts, attendanceRoles } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { etDayKey } from "@/lib/timezone";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import {
  clockLabel,
  daysBetween,
  etMinutes,
  hoursLabel,
  inStatusOf,
  isEarlyOut,
  lateMinutesFor,
  outStatusOf,
  pickShift,
  sheetDates,
  sheetPages,
  SHEET_MAX_DAYS,
  SHEET_RANGE_MAX_DAYS,
  type RoleShift,
} from "@/lib/attendance";

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

    const matrix: Record<number, Record<string, ReturnType<typeof cellOf> | null>> = {};
    for (const r of rows) {
      matrix[r.id] = {};
      for (const d of dates) {
        const log = logs.find((l) => l.memberId === r.id && l.date === d) || null;
        const roleId = log?.roleId ?? r.roleId;
        const shifts = roleId ? shiftsByRole.get(roleId) || [] : [];
        matrix[r.id][d] = cellOf(log, shifts);
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

/** One box of the sheet: the times plus the colour it must be printed in. */
function cellOf(log: typeof attendanceLogs.$inferSelect | null, shifts: RoleShift[] = []) {
  if (!log) return null;
  const shift = log.clockIn && shifts.length > 0 ? pickShift(shifts, etMinutes(log.clockIn)) : null;
  const lateMinutes = shift && log.clockIn ? lateMinutesFor(shift, etMinutes(log.clockIn)) : log.lateMinutes || 0;
  const earlyOut = shift && log.clockOut ? isEarlyOut(shift, etMinutes(log.clockOut)) : Boolean(log.earlyOut);
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
    status: log.clockOut ? (earlyOut ? "early_out" : "completed") : lateMinutes > 0 ? "late" : "on_time",
    inStatus: inStatusOf(measured),
    outStatus: outStatusOf(measured),
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
    return NextResponse.json({ success: true, message: "Line deleted" });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
