import { NextResponse } from "next/server";
import { db } from "@/db";
import { announcements } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq, asc } from "drizzle-orm";
import { PUBLIC_CACHE_CONTROL } from "@/lib/cache";
import { fixSiteText } from "@/lib/brand";
import { deleteOrphanedCdnImages, persistImageRef } from "@/lib/image-store";
import { requireAdmin } from "@/lib/session";

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
    // GROUP 4 / ITEM 6 — safety cap on the owner-managed board (200 is far
    // beyond realistic usage; a real board is a handful of active items).
    let list = await db.select().from(announcements).orderBy(asc(announcements.priority), asc(announcements.id)).limit(200);
    if (onlyActive) list = list.filter(isActiveToday);
    // Brand/address guard — old rows may still say "Golagul Building"; always
    // serve the correct "Town Square Building" / brand text.
    list = list.map((a) => ({
      ...a,
      title: fixSiteText(a.title),
      description: fixSiteText(a.description),
    }));
    return NextResponse.json(list, { status: 200, headers: { "Cache-Control": PUBLIC_CACHE_CONTROL } });
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
    if (!body.title) return NextResponse.json({ error: "Title required" }, { status: 400 });
    const created = await db
      .insert(announcements)
      .values({
        title: body.title,
        description: body.description || "",
        imageUrl: await persistImageRef(body.imageUrl || ""),
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
  const __auth = await requireAdmin();
  if (!__auth.ok) return __auth.response;
  await ensureTablesExist();
  try {
    const body = await request.json();
    if (!body.id) return NextResponse.json({ error: "ID required" }, { status: 400 });
    const existing = await db.select().from(announcements).where(eq(announcements.id, body.id));
    if (existing.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const updated = await db
      .update(announcements)
      .set({
        title: body.title,
        description: body.description,
        imageUrl: await persistImageRef(body.imageUrl ?? ""),
        startDate: body.startDate,
        endDate: body.endDate,
        priority: Number(body.priority || 0),
      })
      .where(eq(announcements.id, body.id))
      .returning();
    // Drop the old cdn_images row if the image was replaced/removed.
    await deleteOrphanedCdnImages([existing[0].imageUrl]);
    return NextResponse.json(updated[0]);
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
    const existing = await db.select().from(announcements).where(eq(announcements.id, Number(id)));
    await db.delete(announcements).where(eq(announcements.id, Number(id)));
    if (existing.length > 0) await deleteOrphanedCdnImages([existing[0].imageUrl]);
    return NextResponse.json({ success: true, id: Number(id) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
