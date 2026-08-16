import { NextResponse } from "next/server";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq, asc, sql } from "drizzle-orm";
import { PUBLIC_CACHE_CONTROL } from "@/lib/cache";
import { requireAdmin } from "@/lib/session";

export async function GET() {
  await ensureTablesExist();
  try {
    const list = await db.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.id));
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
    const newCat = await db
      .insert(categories)
      .values({
        name: body.name,
        slug: body.slug || body.name.toLowerCase().replace(/\s+/g, "-"),
        icon: body.icon || "Coffee",
        sortOrder: body.sortOrder ? Number(body.sortOrder) : 0,
      })
      .returning();
    return NextResponse.json(newCat[0]);
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
      return NextResponse.json({ error: "Category ID required" }, { status: 400 });
    }

    const rows = await db.select().from(categories).where(eq(categories.id, Number(body.id)));
    if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const oldSlug = rows[0].slug;
    const newSlug = String(
      body.slug ||
        body.name?.toLowerCase().replace(/&/g, "").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-") ||
        oldSlug
    );

    const updated = await db
      .update(categories)
      .set({
        name: body.name || rows[0].name,
        slug: newSlug,
        icon: body.icon || rows[0].icon,
        sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder) : rows[0].sortOrder,
      })
      .where(eq(categories.id, body.id))
      .returning();

    // When the owner renames a category → menu items follow automatically
    if (newSlug !== oldSlug) {
      await db.execute(sql`UPDATE menu_items SET category = ${newSlug} WHERE category = ${oldSlug}`);
    }

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
    await db.delete(categories).where(eq(categories.id, Number(id)));

    // FIX: once the owner deletes a category, set the flag so the seed never
    // re-inserts the default categories (they used to "come back" on refresh).
    const { siteSettings } = await import("@/db/schema");
    const { eq: eqSetting } = await import("drizzle-orm");
    const rows = await db.select().from(siteSettings).where(eqSetting(siteSettings.key, "categories_reset_flag"));
    if (rows.length > 0) {
      await db.update(siteSettings).set({ value: "on" }).where(eqSetting(siteSettings.key, "categories_reset_flag"));
    } else {
      await db.insert(siteSettings).values({ key: "categories_reset_flag", value: "on" });
    }

    return NextResponse.json({ success: true, id: Number(id) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
