import { NextResponse } from "next/server";
import { db } from "@/db";
import { staffBiometrics, staffUsers } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { eq } from "drizzle-orm";

export async function GET(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  
  await ensureTablesExist();
  
  try {
    const { searchParams } = new URL(request.url);
    const staffId = searchParams.get("staffId");
    
    let biometrics;
    if (staffId) {
      biometrics = await db.select().from(staffBiometrics).where(eq(staffBiometrics.staffId, Number(staffId)));
    } else {
      biometrics = await db.select().from(staffBiometrics);
    }
    
    const staffList = await db.select().from(staffUsers);
    const staffMap = new Map(staffList.map(s => [s.id, s.name]));
    
    const enriched = biometrics.map(b => ({
      ...b,
      staffName: staffMap.get(b.staffId) || `Staff ${b.staffId}`,
    }));
    
    return NextResponse.json(enriched);
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
    const { staffId, fingerprintId, fingerName = "Right Index", enrolledBy = "Admin" } = body;
    
    if (!staffId || fingerprintId === undefined) {
      return NextResponse.json({ error: "staffId and fingerprintId required" }, { status: 400 });
    }
    
    const fid = Number(fingerprintId);
    if (fid < 1 || fid > 1000) {
      return NextResponse.json({ error: "fingerprintId must be 1-1000" }, { status: 400 });
    }
    
    // Check if fingerprintId already exists
    const existing = await db.select().from(staffBiometrics).where(eq(staffBiometrics.fingerprintId, fid)).limit(1);
    if (existing.length > 0) {
      return NextResponse.json({ error: `Fingerprint ID ${fid} already enrolled for staff ${existing[0].staffId}` }, { status: 409 });
    }
    
    // Check staff exists
    const staff = await db.select().from(staffUsers).where(eq(staffUsers.id, Number(staffId))).limit(1);
    if (staff.length === 0) {
      return NextResponse.json({ error: "Staff not found" }, { status: 404 });
    }
    
    // Check how many fingerprints this staff already has (max 5)
    const staffBios = await db.select().from(staffBiometrics).where(eq(staffBiometrics.staffId, Number(staffId)));
    if (staffBios.length >= 5) {
      return NextResponse.json({ error: `Staff already has ${staffBios.length} fingerprints (max 5)` }, { status: 400 });
    }
    
    const newBio = await db.insert(staffBiometrics).values({
      staffId: Number(staffId),
      fingerprintId: fid,
      fingerName,
      enrolledBy,
    }).returning();
    
    return NextResponse.json({
      ...newBio[0],
      staffName: staff[0].name,
      message: `Enrolled ${fingerName} as ID ${fid} for ${staff[0].name}`
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
    const fingerprintId = searchParams.get("fingerprintId");
    
    if (id) {
      await db.delete(staffBiometrics).where(eq(staffBiometrics.id, Number(id)));
      return NextResponse.json({ success: true, message: `Deleted biometric ${id}` });
    } else if (fingerprintId) {
      await db.delete(staffBiometrics).where(eq(staffBiometrics.fingerprintId, Number(fingerprintId)));
      return NextResponse.json({ success: true, message: `Deleted fingerprint ID ${fingerprintId}` });
    } else {
      return NextResponse.json({ error: "id or fingerprintId required" }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
