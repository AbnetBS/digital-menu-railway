import { NextResponse } from "next/server";
import { db } from "@/db";
import { galleryItems } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq, asc } from "drizzle-orm";
import { PUBLIC_CACHE_CONTROL } from "@/lib/cache";
import { fixSiteText } from "@/lib/brand";
import { deleteOrphanedCdnImages, persistImageRef } from "@/lib/image-store";
import { requireAdmin } from "@/lib/session";

export async function GET() {
  await ensureTablesExist();
  try {
    // GROUP 4 / ITEM 6 — safety cap: gallery is owner-managed, but never allow
    // an unbounded response (500 is far beyond realistic cafe usage).
    const list = await db.select().from(galleryItems).orderBy(asc(galleryItems.sortOrder), asc(galleryItems.id)).limit(500);
    // Brand/address guard — old gallery titles/captions may still reference
    // "Golagul Building"; always serve the correct "Town Square Building" text.
    const guarded = list.map((g) => ({
      ...g,
      title: fixSiteText(g.title),
      caption: g.caption ? fixSiteText(g.caption) : g.caption,
    }));
    return NextResponse.json(guarded, { status: 200, headers: { "Cache-Control": PUBLIC_CACHE_CONTROL } });
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
    const item = await db
      .insert(galleryItems)
      .values({
        title: body.title,
        category: body.category || "General",
        imageUrl: await persistImageRef(body.imageUrl ?? ""),
        caption: body.caption || "",
        sortOrder: body.sortOrder ? Number(body.sortOrder) : 0,
      })
      .returning();
    return NextResponse.json(item[0]);
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
    if (!body.id) {
      return NextResponse.json({ error: "Gallery ID required" }, { status: 400 });
    }
    const existing = await db.select().from(galleryItems).where(eq(galleryItems.id, body.id));
    if (existing.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const updated = await db
      .update(galleryItems)
      .set({
        title: body.title,
        category: body.category,
        imageUrl: await persistImageRef(body.imageUrl ?? ""),
        caption: body.caption,
        sortOrder: body.sortOrder ? Number(body.sortOrder) : 0,
      })
      .where(eq(galleryItems.id, body.id))
      .returning();
    // Drop the old cdn_images row if the photo was replaced/removed.
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
    if (!id) {
      return NextResponse.json({ error: "ID required" }, { status: 400 });
    }
    const existing = await db.select().from(galleryItems).where(eq(galleryItems.id, Number(id)));
    await db.delete(galleryItems).where(eq(galleryItems.id, Number(id)));
    if (existing.length > 0) await deleteOrphanedCdnImages([existing[0].imageUrl]);
    return NextResponse.json({ success: true, id: Number(id) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
