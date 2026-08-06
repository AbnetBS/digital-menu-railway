import { NextResponse } from "next/server";
import { db } from "@/db";
import { announcements } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq, asc } from "drizzle-orm";

function isActiveToday(a: { startDate?: string | null; endDate?: string | null }): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (a.startDate && today < String(a.startDate)) return false;
  if (a.endDate && today > String(a.endDate)) return false;
  return true;
}

export async function GET(request: Request) {
  await ensureTablesExist();
  try {
    const { searchParams } = new URL(request.url);
    const onlyActive = searchParams.get("active") === "1";
    let list = await db.select().from(announcements).orderBy(asc(announcements.priority), asc(announcements.id));
    if (onlyActive) list = list.filter(isActiveToday);
    return NextResponse.json(list, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  await ensureTablesExist();
  try {
    const body = await request.json();
    if (!body.title) return NextResponse.json({ error: "Title required" }, { status: 400 });
    const created = await db
      .insert(announcements)
      .values({
        title: body.title,
        description: body.description || "",
        imageUrl: body.imageUrl || "",
        startDate: body.startDate || "",
        endDate: body.endDate || "",
        priority: Number(body.priority || 0),
      })
      .returning();
    return NextResponse.json(created[0]);
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
      .update(announcements)
      .set({
        title: body.title,
        description: body.description,
        imageUrl: body.imageUrl,
        startDate: body.startDate,
        endDate: body.endDate,
        priority: Number(body.priority || 0),
      })
      .where(eq(announcements.id, body.id))
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
    await db.delete(announcements).where(eq(announcements.id, Number(id)));
    return NextResponse.json({ success: true, id: Number(id) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
