import { NextResponse } from "next/server";
import { db } from "@/db";
import { galleryItems } from "@/db/schema";
import { ensureDbSeeded, invalidateDbSeeded } from "@/lib/seed-db";
import { ensureTablesExist } from "@/db/migrate";
import { eq, asc } from "drizzle-orm";
import { PUBLIC_CACHE_CONTROL } from "@/lib/cache";

export async function GET() {
  await ensureTablesExist();
  await ensureDbSeeded();
  try {
    const list = await db.select().from(galleryItems).orderBy(asc(galleryItems.sortOrder), asc(galleryItems.id));
    return NextResponse.json(list, { status: 200, headers: { "Cache-Control": PUBLIC_CACHE_CONTROL } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  await ensureTablesExist();
  try {
    const body = await request.json();
    const item = await db
      .insert(galleryItems)
      .values({
        title: body.title,
        category: body.category || "General",
        imageUrl: body.imageUrl,
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
  await ensureTablesExist();
  try {
    const body = await request.json();
    if (!body.id) {
      return NextResponse.json({ error: "Gallery ID required" }, { status: 400 });
    }
    const updated = await db
      .update(galleryItems)
      .set({
        title: body.title,
        category: body.category,
        imageUrl: body.imageUrl,
        caption: body.caption,
        sortOrder: body.sortOrder ? Number(body.sortOrder) : 0,
      })
      .where(eq(galleryItems.id, body.id))
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
    if (!id) {
      return NextResponse.json({ error: "ID required" }, { status: 400 });
    }
    await db.delete(galleryItems).where(eq(galleryItems.id, Number(id)));
    invalidateDbSeeded(); // table may now be empty → self-heal on next read
    return NextResponse.json({ success: true, id: Number(id) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
