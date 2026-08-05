import { NextResponse } from "next/server";
import { db } from "@/db";
import { staffUsers } from "@/db/schema";
import { ensureDbSeeded } from "@/lib/seed-db";
import { ensureTablesExist } from "@/db/migrate";
import { and, eq } from "drizzle-orm";

export async function POST(request: Request) {
  await ensureTablesExist();
  await ensureDbSeeded();
  try {
    const { name, pin, role } = await request.json();

    const matches = await db
      .select()
      .from(staffUsers)
      .where(and(eq(staffUsers.name, String(name || "")), eq(staffUsers.role, String(role || "waiter"))));

    const staff = matches[0];
    if (staff && staff.pin === String(pin)) {
      return NextResponse.json({
        success: true,
        staff: { id: staff.id, name: staff.name, role: staff.role },
      });
    }

    return NextResponse.json({ success: false, error: "Invalid name or PIN" }, { status: 401 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
