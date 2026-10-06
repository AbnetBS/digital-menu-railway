import { NextResponse } from "next/server";
import { db } from "@/db";
import { staffBiometrics, staffUsers } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";

// This endpoint is for ESP32 to fetch fingerprintId -> staff mapping
// No admin auth required - ESP32 device needs it, but we can add simple secret later
export async function GET() {
  await ensureTablesExist();
  
  try {
    const biometrics = await db.select().from(staffBiometrics);
    const staffList = await db.select().from(staffUsers);
    const staffMap = new Map(staffList.map(s => [s.id, s.name]));
    
    const mappings = biometrics.map(b => ({
      fingerprintId: b.fingerprintId,
      staffId: b.staffId,
      staffName: staffMap.get(b.staffId) || `Staff ${b.staffId}`,
      fingerName: b.fingerName,
    }));
    
    // Also return as simple object for ESP32: { "1": "Mulu", "2": "Abebe" }
    const simpleMap: Record<number, string> = {};
    for (const m of mappings) {
      simpleMap[m.fingerprintId] = m.staffName;
    }
    
    return NextResponse.json({
      count: mappings.length,
      mappings,
      simpleMap, // for ESP32 OLED quick display
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
