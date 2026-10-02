import { NextResponse } from "next/server";
import { db } from "@/db";
import { attendanceShifts } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { eq } from "drizzle-orm";

export async function GET() {
  await ensureTablesExist();
  
  try {
    const shifts = await db.select().from(attendanceShifts).orderBy(attendanceShifts.startTime);
    
    // If no shifts exist, create default ones
    if (shifts.length === 0) {
      const defaults = await db.insert(attendanceShifts).values([
        { name: "Morning", startTime: "08:00", endTime: "14:00", graceMinutes: 15 },
        { name: "Afternoon", startTime: "14:00", endTime: "22:00", graceMinutes: 15 },
        { name: "Full Day", startTime: "08:00", endTime: "17:00", graceMinutes: 15 },
      ]).returning();
      return NextResponse.json(defaults);
    }
    
    return NextResponse.json(shifts);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  
  await ensureTablesExist();
  
  try {
    const body = await request.json();
    const { name, startTime, endTime, graceMinutes = 15 } = body;
    
    if (!name || !startTime || !endTime) {
      return NextResponse.json({ error: "name, startTime, endTime required" }, { status: 400 });
    }
    
    const newShift = await db.insert(attendanceShifts).values({
      name,
      startTime,
      endTime,
      graceMinutes: Number(graceMinutes),
    }).returning();
    
    return NextResponse.json(newShift[0]);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  
  await ensureTablesExist();
  
  try {
    const body = await request.json();
    const { id, name, startTime, endTime, graceMinutes } = body;
    
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    
    const updated = await db.update(attendanceShifts)
      .set({ name, startTime, endTime, graceMinutes: graceMinutes !== undefined ? Number(graceMinutes) : undefined })
      .where(eq(attendanceShifts.id, Number(id)))
      .returning();
    
    return NextResponse.json(updated[0]);
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
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    
    await db.delete(attendanceShifts).where(eq(attendanceShifts.id, Number(id)));
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
