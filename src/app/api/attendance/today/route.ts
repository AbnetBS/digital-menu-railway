import { NextResponse } from "next/server";
import { db } from "@/db";
import { attendanceLogs, staffUsers } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq, desc } from "drizzle-orm";
import { etDayKey } from "@/lib/timezone";

function getTodayKey(): string {
  return etDayKey(new Date()) || new Date().toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  await ensureTablesExist();
  
  try {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get("date") || getTodayKey();
    
    const logs = await db.select().from(attendanceLogs)
      .where(eq(attendanceLogs.date, date))
      .orderBy(desc(attendanceLogs.updatedAt));
    
    const staffList = await db.select().from(staffUsers);
    const staffMap = new Map(staffList.map(s => [s.id, { name: s.name, role: s.role }]));
    
    const enriched = logs.map(l => {
      const staff = staffMap.get(l.staffId);
      const totalMinutes = l.totalMinutes || 0;
      const hours = Math.floor(totalMinutes / 60);
      const mins = totalMinutes % 60;
      
      return {
        ...l,
        staffName: staff?.name || `Staff ${l.staffId}`,
        staffRole: staff?.role || "staff",
        totalHours: l.clockOut ? `${hours}h ${mins}m` : null,
        clockInTime: l.clockIn ? new Date(l.clockIn).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : null,
        clockOutTime: l.clockOut ? new Date(l.clockOut).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : null,
      };
    });
    
    // Also get absent staff (staff who have no log today)
    const loggedStaffIds = new Set(logs.map(l => l.staffId));
    const absentStaff = staffList.filter(s => !loggedStaffIds.has(s.id)).map(s => ({
      staffId: s.id,
      staffName: s.name,
      staffRole: s.role,
      status: "absent",
      date,
    }));
    
    return NextResponse.json({
      date,
      logs: enriched,
      absent: absentStaff,
      stats: {
        present: enriched.length,
        completed: enriched.filter(l => l.clockOut).length,
        stillIn: enriched.filter(l => l.clockIn && !l.clockOut).length,
        late: enriched.filter(l => (l.lateMinutes || 0) > 0).length,
        absent: absentStaff.length,
        totalStaff: staffList.length,
      }
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
