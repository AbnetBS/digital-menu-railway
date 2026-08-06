import { NextResponse } from "next/server";
import { db } from "@/db";
import { staffUsers } from "@/db/schema";
import { ensureDbSeeded } from "@/lib/seed-db";
import { ensureTablesExist } from "@/db/migrate";
import { eq, asc } from "drizzle-orm";

export async function GET(request: Request) {
  await ensureTablesExist();
  await ensureDbSeeded();
  try {
    const { searchParams } = new URL(request.url);
    const pub = searchParams.get("public"); // for waiter/cashier login screens
    const list = await db.select().from(staffUsers).orderBy(asc(staffUsers.name));

    if (pub === "1") {
      // Never expose PINs on the public login picker
      return NextResponse.json(list.map((s) => ({ id: s.id, name: s.name, role: s.role })));
    }
    return NextResponse.json(list);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  await ensureTablesExist();
  try {
    const body = await request.json();
    if (!body.name || !body.pin) {
      return NextResponse.json({ error: "Name and PIN required" }, { status: 400 });
    }
    const newStaff = await db
      .insert(staffUsers)
      .values({
        name: body.name,
        role: ["waiter","cashier","barista","kitchen","admin"].includes(body.role) ? body.role : "waiter",
        pin: String(body.pin),
      })
      .returning();
    return NextResponse.json(newStaff[0]);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  await ensureTablesExist();
  try {
    const body = await request.json();
    if (!body.id) return NextResponse.json({ error: "ID required" }, { status: 400 });
    const updated = await db
      .update(staffUsers)
      .set({
        name: body.name,
        role: body.role,
        pin: body.pin ? String(body.pin) : undefined,
      })
      .where(eq(staffUsers.id, body.id))
      .returning();
    return NextResponse.json(updated[0]);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  await ensureTablesExist();
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });
    await db.delete(staffUsers).where(eq(staffUsers.id, Number(id)));
    return NextResponse.json({ success: true, id: Number(id) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
