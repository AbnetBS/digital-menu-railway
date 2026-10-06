import { NextResponse } from "next/server";
import { db } from "@/db";
import { staffBiometrics, attendanceLogs, staffUsers, attendanceShifts } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq, and } from "drizzle-orm";
import { etDayKey } from "@/lib/timezone";

// Helper to get Ethiopia date key
function getTodayKey(): string {
  return etDayKey(new Date()) || new Date().toISOString().slice(0, 10);
}

function parseTimeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

function getNowMinutesET(): number {
  // Get current time in Ethiopia timezone
  const now = new Date();
  const etTime = new Date(now.toLocaleString("en-US", { timeZone: "Africa/Addis_Ababa" }));
  return etTime.getHours() * 60 + etTime.getMinutes();
}

export async function POST(request: Request) {
  await ensureTablesExist();
  
  try {
    const body = await request.json();
    const { fingerprintId, staffId: directStaffId, deviceId = "entrance", method = "fingerprint" } = body;

    let staffId: number | null = null;
    let staffName = "";
    let fingerId: number | null = null;

    // PIN method: direct staffId provided
    if (method === "pin" && directStaffId) {
      staffId = Number(directStaffId);
      const staff = await db.select().from(staffUsers).where(eq(staffUsers.id, staffId)).limit(1);
      if (staff.length === 0) {
        return NextResponse.json({ error: "Staff not found" }, { status: 404 });
      }
      staffName = staff[0].name;
      fingerId = null;
    } else {
      // Fingerprint method
      if (fingerprintId === undefined || fingerprintId === null) {
        return NextResponse.json({ error: "fingerprintId required" }, { status: 400 });
      }
      fingerId = Number(fingerprintId);
      
      // Find mapping
      const mapping = await db.select().from(staffBiometrics).where(eq(staffBiometrics.fingerprintId, fingerId)).limit(1);
      if (mapping.length === 0) {
        return NextResponse.json({ 
          error: "Fingerprint not enrolled",
          fingerprintId: fingerId,
          status: "not_found"
        }, { status: 404 });
      }
      staffId = mapping[0].staffId;
      
      const staff = await db.select().from(staffUsers).where(eq(staffUsers.id, staffId)).limit(1);
      if (staff.length === 0) {
        return NextResponse.json({ error: "Staff not found for fingerprint" }, { status: 404 });
      }
      staffName = staff[0].name;
    }

    if (!staffId) {
      return NextResponse.json({ error: "Staff ID not resolved" }, { status: 400 });
    }

    const todayKey = getTodayKey();
    const now = new Date();

    // Find existing log for today for this staff
    const existingLogs = await db.select().from(attendanceLogs)
      .where(and(eq(attendanceLogs.staffId, staffId), eq(attendanceLogs.date, todayKey)))
      .limit(1);

    // Get default shift for late calculation (Morning shift start 08:00 if no shift assigned)
    let shiftStartMinutes = 8 * 60; // 08:00 default
    let graceMinutes = 15;
    try {
      const shifts = await db.select().from(attendanceShifts).limit(1);
      if (shifts.length > 0) {
        shiftStartMinutes = parseTimeToMinutes(shifts[0].startTime);
        graceMinutes = shifts[0].graceMinutes;
      }
    } catch {}

    const nowMinutes = getNowMinutesET();
    const lateMinutes = Math.max(0, nowMinutes - (shiftStartMinutes + graceMinutes));

    if (existingLogs.length === 0) {
      // First scan today = CLOCK IN
      const newLog = await db.insert(attendanceLogs).values({
        staffId,
        fingerprintId: fingerId,
        date: todayKey,
        clockIn: now,
        clockInMethod: method,
        lateMinutes: lateMinutes,
        status: lateMinutes > 0 ? "late" : "on_time",
        deviceId,
      }).returning();

      return NextResponse.json({
        success: true,
        action: "clock_in",
        staffId,
        staffName,
        fingerprintId: fingerId,
        date: todayKey,
        clockIn: newLog[0].clockIn,
        lateMinutes,
        status: lateMinutes > 0 ? "late" : "on_time",
        message: `${staffName} IN ${now.toLocaleTimeString()}${lateMinutes > 0 ? ` - Late ${lateMinutes}m` : ''}`,
        oled: {
          line1: staffName.substring(0, 16),
          line2: `IN ${now.toLocaleTimeString().slice(0,5)}`,
          line3: lateMinutes > 0 ? `Late ${lateMinutes}m` : "On Time",
        },
        buzzer: "success_in",
        led: "green"
      });
    } else {
      const existing = existingLogs[0];
      
      if (!existing.clockIn) {
        // Has row but no clockIn (should not happen) - set clockIn
        const updated = await db.update(attendanceLogs)
          .set({ clockIn: now, clockInMethod: method, fingerprintId: fingerId, lateMinutes, status: lateMinutes > 0 ? "late" : "on_time", updatedAt: now })
          .where(eq(attendanceLogs.id, existing.id))
          .returning();
        
        return NextResponse.json({
          success: true,
          action: "clock_in",
          staffId,
          staffName,
          fingerprintId: fingerId,
          date: todayKey,
          clockIn: updated[0].clockIn,
          lateMinutes,
          status: lateMinutes > 0 ? "late" : "on_time",
          message: `${staffName} IN ${now.toLocaleTimeString()}`,
          oled: { line1: staffName.substring(0,16), line2: `IN ${now.toLocaleTimeString().slice(0,5)}`, line3: lateMinutes > 0 ? `Late ${lateMinutes}m` : "On Time" },
          buzzer: "success_in",
          led: "green"
        });
      } else if (!existing.clockOut) {
        // Second scan = CLOCK OUT
        const clockInTime = new Date(existing.clockIn!).getTime();
        const clockOutTime = now.getTime();
        const totalMinutes = Math.round((clockOutTime - clockInTime) / 60000);

        const updated = await db.update(attendanceLogs)
          .set({ 
            clockOut: now, 
            clockOutMethod: method,
            totalMinutes,
            status: "completed",
            updatedAt: now 
          })
          .where(eq(attendanceLogs.id, existing.id))
          .returning();

        const hours = Math.floor(totalMinutes / 60);
        const mins = totalMinutes % 60;

        return NextResponse.json({
          success: true,
          action: "clock_out",
          staffId,
          staffName,
          fingerprintId: fingerId,
          date: todayKey,
          clockIn: existing.clockIn,
          clockOut: updated[0].clockOut,
          totalMinutes,
          totalHours: `${hours}h ${mins}m`,
          message: `${staffName} OUT ${now.toLocaleTimeString()} - Worked ${hours}h ${mins}m`,
          oled: { line1: staffName.substring(0,16), line2: `OUT ${now.toLocaleTimeString().slice(0,5)}`, line3: `${hours}h ${mins}m` },
          buzzer: "success_out",
          led: "green"
        });
      } else {
        // Already has both IN and OUT today
        const totalMinutes = existing.totalMinutes || 0;
        const hours = Math.floor(totalMinutes / 60);
        const mins = totalMinutes % 60;
        
        return NextResponse.json({
          success: false,
          action: "already_completed",
          staffId,
          staffName,
          date: todayKey,
          clockIn: existing.clockIn,
          clockOut: existing.clockOut,
          totalMinutes,
          message: `${staffName} already completed today - IN ${new Date(existing.clockIn!).toLocaleTimeString()} OUT ${new Date(existing.clockOut!).toLocaleTimeString()}`,
          oled: { line1: staffName.substring(0,16), line2: "Already done", line3: `${hours}h ${mins}m` },
          buzzer: "already",
          led: "green"
        });
      }
    }
  } catch (error) {
    console.error("Attendance clock error:", error);
    return NextResponse.json({ error: String(error), status: "error", led: "red", buzzer: "error" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  await ensureTablesExist();
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") || getTodayKey();
  
  try {
    const logs = await db.select().from(attendanceLogs).where(eq(attendanceLogs.date, date));
    
    // Enrich with staff names
    const staffList = await db.select().from(staffUsers);
    const staffMap = new Map(staffList.map(s => [s.id, s.name]));
    
    const enriched = logs.map(l => ({
      ...l,
      staffName: staffMap.get(l.staffId) || `Staff ${l.staffId}`,
    }));
    
    return NextResponse.json(enriched);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
