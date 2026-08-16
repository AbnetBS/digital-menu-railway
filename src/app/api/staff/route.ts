import { NextResponse } from "next/server";
import { db } from "@/db";
import { staffUsers } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq, asc } from "drizzle-orm";
import { hashSecret } from "@/lib/auth";
import { requireAdmin } from "@/lib/session";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const pub = searchParams.get("public"); // for waiter/cashier login screens

  // The public=1 list (names + roles for the staff login picker) stays open.
  // The full admin list (with pinSet) requires an owner/admin session.
  if (pub !== "1") {
    const __auth = await requireAdmin();
    if (!__auth.ok) return __auth.response;
  }

  await ensureTablesExist();
  try {
    const list = await db.select().from(staffUsers).orderBy(asc(staffUsers.name));

    if (pub === "1") {
      // Never expose PINs on the public login picker
      return NextResponse.json(list.map((s) => ({ id: s.id, name: s.name, role: s.role })));
    }
    // Admin list: never return the PIN or its hash — only whether one is set.
    return NextResponse.json(
      list.map((s) => ({ id: s.id, name: s.name, role: s.role, pinSet: Boolean(s.pin) }))
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const __auth = await requireAdmin();
  if (!__auth.ok) return __auth.response;
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
        pin: await hashSecret(String(body.pin)),
      })
      .returning();
    // Strip the hash from the response — never echo credentials back.
    const { pin: _pin, ...safe } = newStaff[0];
    return NextResponse.json({ ...safe, pinSet: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const __auth = await requireAdmin();
  if (!__auth.ok) return __auth.response;
  await ensureTablesExist();
  try {
    const body = await request.json();
    if (!body.id) return NextResponse.json({ error: "ID required" }, { status: 400 });
    const updated = await db
      .update(staffUsers)
      .set({
        name: body.name,
        role: body.role,
        pin: body.pin ? await hashSecret(String(body.pin)) : undefined,
      })
      .where(eq(staffUsers.id, body.id))
      .returning();
    // Strip the hash from the response — never echo credentials back.
    const { pin: _pin, ...safe } = updated[0];
    return NextResponse.json({ ...safe, pinSet: Boolean(updated[0].pin) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const __auth = await requireAdmin();
  if (!__auth.ok) return __auth.response;
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
