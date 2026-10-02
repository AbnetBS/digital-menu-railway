import { NextResponse } from "next/server";
import { db } from "@/db";
import { attendanceLogs, staffUsers } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { gte, lte, and, desc, eq } from "drizzle-orm";

export async function GET(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  
  await ensureTablesExist();
  
  try {
    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from"); // YYYY-MM-DD
    const to = searchParams.get("to"); // YYYY-MM-DD
    const date = searchParams.get("date"); // single date
    const staffId = searchParams.get("staffId");
    
    let logs;
    
    if (date) {
      const { eq } = await import("drizzle-orm");
      const { attendanceLogs } = await import("@/db/schema");
      logs = await db.select().from(attendanceLogs).where(eq(attendanceLogs.date, date)).orderBy(desc(attendanceLogs.date));
    } else if (from && to) {
      logs = await db.select().from(attendanceLogs)
        .where(and(gte(attendanceLogs.date, from), lte(attendanceLogs.date, to)))
        .orderBy(desc(attendanceLogs.date));
    } else if (from) {
      logs = await db.select().from(attendanceLogs)
        .where(gte(attendanceLogs.date, from))
        .orderBy(desc(attendanceLogs.date));
    } else {
      // Last 30 days by default
      logs = await db.select().from(attendanceLogs).orderBy(desc(attendanceLogs.date)).limit(200);
    }
    
    // Filter by staff if requested
    let filtered = logs;
    if (staffId) {
      filtered = logs.filter(l => l.staffId === Number(staffId));
    }
    
    // Enrich with staff names
    const staffList = await db.select().from(staffUsers);
    const staffMap = new Map(staffList.map(s => [s.id, s.name]));
    
    const enriched = filtered.map(l => {
      const totalMinutes = l.totalMinutes || 0;
      const hours = Math.floor(totalMinutes / 60);
      const mins = totalMinutes % 60;
      
      return {
        ...l,
        staffName: staffMap.get(l.staffId) || `Staff ${l.staffId}`,
        totalHours: l.clockOut ? `${hours}h ${mins}m` : null,
        clockInTime: l.clockIn ? new Date(l.clockIn).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : null,
        clockOutTime: l.clockOut ? new Date(l.clockOut).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : null,
      };
    });
    
    // For paper sheet view: group by staff and date
    // Build matrix: staff x dates
    const dates = [...new Set(enriched.map(l => l.date))].sort();
    const staffIds = [...new Set(enriched.map(l => l.staffId))].sort();
    
    const matrix: Record<number, Record<string, typeof enriched[0] | null>> = {};
    for (const sid of staffIds) {
      matrix[sid] = {};
      for (const d of dates) {
        matrix[sid][d] = enriched.find(l => l.staffId === sid && l.date === d) || null;
      }
    }
    
    return NextResponse.json({
      logs: enriched,
      matrix,
      dates,
      staffIds,
      staffList: staffList.map(s => ({ id: s.id, name: s.name, role: s.role })),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  
  await ensureTablesExist();
  
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });
    
    await db.delete(attendanceLogs).where(eq(attendanceLogs.id, Number(id)));
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
