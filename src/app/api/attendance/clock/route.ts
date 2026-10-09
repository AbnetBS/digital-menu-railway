import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  attendanceBiometrics,
  attendanceLogs,
  attendanceMembers,
  attendanceRoleShifts,
} from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { verifySecret } from "@/lib/auth";
import { and, eq } from "drizzle-orm";
import { etDayKey } from "@/lib/timezone";
import {
  REPEAT_SCAN_LOCK_MINUTES,
  clockLabel,
  etMinutes,
  hoursLabel,
  isEarlyOut,
  lateMinutesFor,
  pickShift,
  rescanAction,
  type RoleShift,
} from "@/lib/attendance";

/**
 * ONE SCAN = ONE LINE ON THE PAPER SHEET.
 *
 * Called by the ESP32 (fingerprintId), by the door tablet (backup PIN) and by
 * the admin (a manual correction). The person is looked up on the ATTENDANCE
 * list (Attendance -> Staff Members), never on the staff login list.
 *
 * The owner's three rules live here and nowhere else:
 *   • LATE: 15 minutes after the entrance time of the role he belongs to
 *     (role Morning 12:30 -> late from 12:46). src/lib/attendance.ts.
 *   • SCAN TWICE: a second scan inside one hour of the IN only answers
 *     "already registered" - a wet finger must not close the day. After the
 *     hour the next scan is the OUT.
 *   • EARLY OUT: leaving before the time out of that role is written down, so
 *     the sheet can colour that box.
 */

function getTodayKey(): string {
  return etDayKey(new Date()) || new Date().toISOString().slice(0, 10);
}

/** The periods of the member's role, ordered by their entrance time. */
async function roleShiftsOf(roleId: number | null): Promise<RoleShift[]> {
  if (!roleId) return [];
  try {
    const rows = await db.select().from(attendanceRoleShifts).where(eq(attendanceRoleShifts.roleId, roleId));
    return rows
      .map((r) => ({ label: r.label, startTime: r.startTime, endTime: r.endTime }))
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  } catch {
    return [];
  }
}

export async function POST(request: Request) {
  await ensureTablesExist();

  try {
    const body = await request.json();
    const {
      fingerprintId,
      memberId: directMemberId,
      deviceId = "entrance",
      method = "fingerprint",
      pin,
    } = body;

    /* ── who is scanning? ──────────────────────────────────────────────── */
    let memberId: number | null = null;
    let memberName = "";
    let fingerId: number | null = null;

    if (method === "pin") {
      // The backup for a wet or dirty finger: name from the dropdown + PIN.
      const id = Number(directMemberId);
      if (!id) return NextResponse.json({ error: "Select a name first", led: "red", buzzer: "error" }, { status: 400 });
      const rows = await db.select().from(attendanceMembers).where(eq(attendanceMembers.id, id)).limit(1);
      if (rows.length === 0) {
        return NextResponse.json({ error: "That name is not on the attendance list", led: "red", buzzer: "error" }, { status: 404 });
      }
      if (!rows[0].pin) {
        return NextResponse.json(
          { error: `${rows[0].name} has no PIN. Ask the admin to add one.`, led: "red", buzzer: "error" },
          { status: 400 }
        );
      }
      const okPin = await verifySecret(String(pin ?? ""), rows[0].pin);
      if (!okPin) {
        return NextResponse.json({ error: "Incorrect PIN", led: "red", buzzer: "error" }, { status: 401 });
      }
      memberId = rows[0].id;
      memberName = rows[0].name;
    } else {
      if (fingerprintId === undefined || fingerprintId === null) {
        return NextResponse.json({ error: "fingerprintId required", led: "red", buzzer: "error" }, { status: 400 });
      }
      fingerId = Number(fingerprintId);
      const mapping = await db
        .select()
        .from(attendanceBiometrics)
        .where(eq(attendanceBiometrics.fingerprintId, fingerId))
        .limit(1);
      if (mapping.length === 0) {
        return NextResponse.json(
          { error: "Fingerprint not enrolled", fingerprintId: fingerId, status: "not_found", led: "red", buzzer: "error" },
          { status: 404 }
        );
      }
      const rows = await db
        .select()
        .from(attendanceMembers)
        .where(eq(attendanceMembers.id, mapping[0].memberId))
        .limit(1);
      if (rows.length === 0) {
        return NextResponse.json({ error: "Member not found for that fingerprint", led: "red", buzzer: "error" }, { status: 404 });
      }
      memberId = rows[0].id;
      memberName = rows[0].name;
    }

    if (!memberId) {
      return NextResponse.json({ error: "Member not resolved", led: "red", buzzer: "error" }, { status: 400 });
    }

    /* ── the times of his role ─────────────────────────────────────────── */
    const member = await db.select().from(attendanceMembers).where(eq(attendanceMembers.id, memberId)).limit(1);
    const roleId = member[0]?.roleId ?? null;
    const shifts = await roleShiftsOf(roleId);

    const todayKey = getTodayKey();
    const now = new Date();
    const nowMinutes = etMinutes(now);
    const clockInShift = pickShift(shifts, nowMinutes);

    const existingLogs = await db
      .select()
      .from(attendanceLogs)
      .where(and(eq(attendanceLogs.memberId, memberId), eq(attendanceLogs.date, todayKey)))
      .limit(1);

    const base = {
      success: true,
      memberId,
      // `staffName` stays in the answer: the flashed ESP32 reads that field.
      staffName: memberName,
      memberName,
      fingerprintId: fingerId,
      date: todayKey,
    };

    /* ── no line yet today: this scan is the IN ────────────────────────── */
    if (existingLogs.length === 0 || !existingLogs[0].clockIn) {
      const lateMinutes = lateMinutesFor(clockInShift, nowMinutes);
      const status = lateMinutes > 0 ? "late" : "on_time";
      const inTime = clockLabel(now) || "";
      const values = {
        memberId,
        roleId,
        fingerprintId: fingerId,
        date: todayKey,
        clockIn: now,
        clockInMethod: method,
        lateMinutes,
        status,
        deviceId,
        updatedAt: now,
      };

      const row =
        existingLogs.length === 0
          ? (await db.insert(attendanceLogs).values(values).returning())[0]
          : (await db.update(attendanceLogs).set(values).where(eq(attendanceLogs.id, existingLogs[0].id)).returning())[0];

      return NextResponse.json({
        ...base,
        logId: row.id,
        action: "clock_in",
        clockIn: row.clockIn,
        clockInLabel: inTime,
        lateMinutes,
        status,
        isOvertime: false,
        message: `${memberName} IN ${inTime}${lateMinutes > 0 ? ` • Late ${lateMinutes}m` : ""}`,
        oled: {
          line1: memberName.substring(0, 16),
          line2: `IN ${inTime}`,
          line3: lateMinutes > 0 ? `Late ${lateMinutes}m` : "On Time",
        },
        buzzer: "success_in",
        led: "green",
      });
    }

    const existing = existingLogs[0];

    /* ── already inside: an hour decides between "already" and the OUT ─── */
    if (!existing.clockOut) {
      const minutesSinceIn = Math.round((now.getTime() - new Date(existing.clockIn!).getTime()) / 60000);
      // The rule itself lives in src/lib/attendance.ts, where the guard tests it.
      if (rescanAction(existing.clockIn, now) === "already_registered") {
        const inTime = clockLabel(existing.clockIn) || "";
        const waitMinutes = REPEAT_SCAN_LOCK_MINUTES - minutesSinceIn;
        return NextResponse.json({
          ...base,
          logId: existing.id,
          success: false,
          action: "already_registered",
          clockIn: existing.clockIn,
          clockInLabel: inTime,
          lateMinutes: existing.lateMinutes || 0,
          status: existing.status,
          message: `${memberName} already registered • IN ${inTime}`,
          oled: {
            line1: memberName.substring(0, 16),
            line2: "Already IN " + inTime,
            line3: `OUT after ${waitMinutes}m`,
          },
          buzzer: "already",
          led: "green",
        });
      }

      // One hour has passed: this scan is the OUT.
      const totalMinutes = Math.round((now.getTime() - new Date(existing.clockIn!).getTime()) / 60000);
      const inShift =
        pickShift(shifts, etMinutes(existing.clockIn!)) || clockInShift;
      const early = isEarlyOut(inShift, nowMinutes);
      const status = early ? "early_out" : "completed";

      const row = (
        await db
          .update(attendanceLogs)
          .set({
            clockOut: now,
            clockOutMethod: method,
            totalMinutes,
            status,
            earlyOut: early,
            updatedAt: now,
          })
          .where(eq(attendanceLogs.id, existing.id))
          .returning()
      )[0];

      const outTime = clockLabel(now) || "";
      const hours = hoursLabel(totalMinutes) || "";

      return NextResponse.json({
        ...base,
        logId: row.id,
        action: "clock_out",
        clockIn: existing.clockIn,
        clockInLabel: clockLabel(existing.clockIn),
        clockOut: row.clockOut,
        clockOutLabel: outTime,
        totalMinutes,
        totalHours: hours,
        earlyOut: early,
        isOvertime: Boolean(row.isOvertime),
        status,
        message: `${memberName} OUT ${outTime} • ${hours}${early ? " • Early out" : ""}`,
        oled: {
          line1: memberName.substring(0, 16),
          line2: `OUT ${outTime}`,
          line3: early ? `Early out ${hours}` : hours,
        },
        buzzer: "success_out",
        led: "green",
      });
    }

    /* ── the day is already closed ─────────────────────────────────────── */
    const totalMinutes = existing.totalMinutes || 0;
    return NextResponse.json({
      ...base,
      logId: existing.id,
      success: false,
      action: "already_registered",
      clockIn: existing.clockIn,
      clockInLabel: clockLabel(existing.clockIn),
      clockOut: existing.clockOut,
      clockOutLabel: clockLabel(existing.clockOut),
      totalMinutes,
      totalHours: hoursLabel(totalMinutes) || "",
      status: existing.status,
      message: `${memberName} already registered today`,
      oled: {
        line1: memberName.substring(0, 16),
        line2: "Already done",
        line3: hoursLabel(totalMinutes) || "",
      },
      buzzer: "already",
      led: "green",
    });
  } catch (error) {
    console.error("Attendance clock error:", error);
    return NextResponse.json(
      { error: String(error), status: "error", led: "red", buzzer: "error" },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  await ensureTablesExist();
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") || getTodayKey();

  try {
    const logs = await db.select().from(attendanceLogs).where(eq(attendanceLogs.date, date));
    const members = await db.select().from(attendanceMembers);
    const nameOf = new Map(members.map((m) => [m.id, m.name]));

    return NextResponse.json(
      logs.map((l) => ({
        ...l,
        staffName: l.memberId ? nameOf.get(l.memberId) || `Member ${l.memberId}` : `Staff ${l.staffId}`,
        clockInLabel: clockLabel(l.clockIn),
        clockOutLabel: clockLabel(l.clockOut),
      }))
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
