import { NextResponse } from "next/server";
import { db } from "@/db";
import { attendanceLogs, attendanceMembers, attendanceRoleShifts, attendanceRoles } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { asc, desc, eq } from "drizzle-orm";
import { etDayKey } from "@/lib/timezone";
import {
  clockLabel,
  etMinutes,
  hoursLabel,
  inStatusOf,
  isEarlyOut,
  lateMinutesFor,
  outStatusOf,
  pickShift,
  type RoleShift,
} from "@/lib/attendance";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
};

/**
 * TODAY, LIVE. One feed for both the door tablet and the admin's Today Live
 * tab: who is in, who is out, how long, late or on time, early out or overtime.
 *
 * The people on it are the ATTENDANCE list (Attendance -> Staff Members). The
 * absent count is kept in the stats - the owner asked for the wall of absent
 * names to disappear from the screens, not for the number to be lost.
 */

/** A scan this fresh is "the person standing at the door right now". */
const LAST_SCAN_WINDOW_MS = 5 * 60 * 1000;

function getTodayKey(): string {
  return etDayKey(new Date()) || new Date().toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  await ensureTablesExist();

  try {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get("date") || getTodayKey();

    const logs = await db
      .select()
      .from(attendanceLogs)
      .where(eq(attendanceLogs.date, date))
      .orderBy(desc(attendanceLogs.updatedAt));

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
    const memberById = new Map(members.map((m) => [m.id, m]));

    const nameOf = (memberId: number | null, staffId: number | null): string => {
      if (memberId && memberById.has(memberId)) return memberById.get(memberId)!.name;
      // Rows written before the attendance listing existed (staff_users).
      return `Member ${memberId ?? staffId ?? 0}`;
    };

    const enriched = logs.map((l) => {
      const member = l.memberId ? memberById.get(l.memberId) : undefined;
      const roleId = l.roleId ?? member?.roleId ?? null;
      const shifts = roleId ? shiftsByRole.get(roleId) || [] : [];
      const shift = l.clockIn && shifts.length > 0 ? pickShift(shifts, etMinutes(l.clockIn)) : null;
      const lateMinutes = shift && l.clockIn ? lateMinutesFor(shift, etMinutes(l.clockIn)) : l.lateMinutes || 0;
      const earlyOut = shift && l.clockOut ? isEarlyOut(shift, etMinutes(l.clockOut)) : Boolean(l.earlyOut);
      const measured = { ...l, lateMinutes, earlyOut };
      return {
        id: l.id,
        memberId: l.memberId,
        memberName: nameOf(l.memberId, l.staffId),
        roleName: roleId ? roleName.get(roleId) || "No role" : "No role",
        date: l.date,
        clockIn: l.clockIn,
        clockOut: l.clockOut,
        clockInTime: clockLabel(l.clockIn),
        clockOutTime: clockLabel(l.clockOut),
        totalMinutes: l.totalMinutes,
        totalHours: l.clockOut ? hoursLabel(l.totalMinutes) : null,
        lateMinutes,
        status: l.clockOut ? (earlyOut ? "early_out" : "completed") : lateMinutes > 0 ? "late" : "on_time",
        isOvertime: Boolean(l.isOvertime),
        earlyOut,
        fingerprintId: l.fingerprintId,
        clockInMethod: l.clockInMethod,
        clockOutMethod: l.clockOutMethod,
        inStatus: inStatusOf(measured),
        outStatus: outStatusOf(measured),
        updatedAt: l.updatedAt,
      };
    });

    // Who is standing at the door: the freshest scan of the last 5 minutes. The
    // Overtime button on the tablet needs a person to press it for.
    let lastScan: null | {
      logId: number;
      memberId: number | null;
      memberName: string;
      action: string;
      at: string;
      secondsAgo: number;
      isOvertime: boolean;
    } = null;
    const newest = enriched[0];
    if (newest?.updatedAt) {
      const at = new Date(newest.updatedAt).getTime();
      const secondsAgo = Math.round((Date.now() - at) / 1000);
      if (Number.isFinite(secondsAgo) && secondsAgo >= 0 && at >= Date.now() - LAST_SCAN_WINDOW_MS) {
        lastScan = {
          logId: newest.id,
          memberId: newest.memberId,
          memberName: newest.memberName,
          action: newest.clockOut ? "clock_out" : "clock_in",
          at: newest.updatedAt.toISOString(),
          secondsAgo,
          isOvertime: newest.isOvertime,
        };
      }
    }

    const loggedMemberIds = new Set(logs.map((l) => l.memberId).filter((id): id is number => Boolean(id)));
    const absentMembers = members
      .filter((m) => m.active !== false && !loggedMemberIds.has(m.id))
      .map((m) => ({
        memberId: m.id,
        memberName: m.name,
        roleName: m.roleId ? roleName.get(m.roleId) || "No role" : "No role",
        status: "absent",
        date,
      }));

    return NextResponse.json({
      date,
      logs: enriched,
      absent: absentMembers,
      lastScan,
      stats: {
        present: enriched.length,
        completed: enriched.filter((l) => l.clockOut).length,
        stillIn: enriched.filter((l) => l.clockIn && !l.clockOut).length,
        late: enriched.filter((l) => l.lateMinutes > 0).length,
        overtime: enriched.filter((l) => l.isOvertime).length,
        earlyOut: enriched.filter((l) => l.earlyOut).length,
        absent: absentMembers.length,
        totalMembers: members.filter((m) => m.active !== false).length,
      },
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
