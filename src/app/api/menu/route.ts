import { NextResponse } from "next/server";
import { db } from "@/db";
import { menuItems } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq, asc } from "drizzle-orm";
import { PUBLIC_CACHE_CONTROL } from "@/lib/cache";
import { deleteOrphanedCdnImages, persistImageRef } from "@/lib/image-store";
import { requireAdmin } from "@/lib/session";
import { isStationName } from "@/lib/stations";

/**
 * Per-item station override: null/"" = follow the category routing;
 * otherwise one of the three crews. Invalid values are rejected so a bad
 * client can never write a station nobody screens.
 */
function parseStationOverride(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value);
  if (!isStationName(s)) throw new Error("Invalid station override");
  return s;
}

export async function GET() {
  await ensureTablesExist();
  try {
    const items = await db.select().from(menuItems).orderBy(asc(menuItems.sortOrder), asc(menuItems.id));
    return NextResponse.json(items, { status: 200, headers: { "Cache-Control": PUBLIC_CACHE_CONTROL } });
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
    const newItem = await db
      .insert(menuItems)
      .values({
        name: body.name,
        category: body.category,
        price: Number(body.price),
        description: body.description || "",
        imageUrl: body.imageUrl
          ? await persistImageRef(String(body.imageUrl))
          : "https://images.pexels.com/photos/16563658/pexels-photo-16563658.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=300&w=480",
        isPopular: Boolean(body.isPopular),
        isAvailable: body.isAvailable !== undefined ? Boolean(body.isAvailable) : true,
        // Traditional buna: the item is made by the buna makers, so its order
        // lines are routed to the "buna" station instead of the barista.
        isBuna: Boolean(body.isBuna),
        // Per-item station override (e.g. Extra Things: coffee cup → barista,
        // take away bag → kitchen). Null = follow the category routing.
        stationOverride: parseStationOverride(body.stationOverride),
        dietaryTags: body.dietaryTags || "",
        prepTime: body.prepTime || "10-15 min",
        badge: body.badge || "",
        salePrice: body.salePrice ? Number(body.salePrice) : null,
        saleStart: body.saleStart || "",
        saleEnd: body.saleEnd || "",
        sortOrder: body.sortOrder ? Number(body.sortOrder) : 0,
      })
      .returning();
    return NextResponse.json(newItem[0]);
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
      return NextResponse.json({ error: "Item ID required" }, { status: 400 });
    }

    // Load the current row so partial updates never blank out other fields
    const existing = await db.select().from(menuItems).where(eq(menuItems.id, Number(body.id)));
    if (existing.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const cur = existing[0];

    const updated = await db
      .update(menuItems)
      .set({
        name: body.name ?? cur.name,
        category: body.category ?? cur.category,
        price: body.price !== undefined && body.price !== null ? Number(body.price) : cur.price,
        description: body.description ?? cur.description,
        imageUrl: body.imageUrl !== undefined ? await persistImageRef(String(body.imageUrl)) : cur.imageUrl,
        isPopular: body.isPopular !== undefined ? Boolean(body.isPopular) : cur.isPopular,
        isAvailable: body.isAvailable !== undefined ? Boolean(body.isAvailable) : cur.isAvailable,
        isBuna: body.isBuna !== undefined ? Boolean(body.isBuna) : cur.isBuna,
        stationOverride:
          body.stationOverride !== undefined ? parseStationOverride(body.stationOverride) : cur.stationOverride,
        dietaryTags: body.dietaryTags ?? cur.dietaryTags,
        prepTime: body.prepTime ?? cur.prepTime,
        badge: body.badge ?? cur.badge,
        salePrice: body.salePrice !== undefined ? (body.salePrice ? Number(body.salePrice) : null) : cur.salePrice,
        saleStart: body.saleStart !== undefined ? body.saleStart : cur.saleStart,
        saleEnd: body.saleEnd !== undefined ? body.saleEnd : cur.saleEnd,
        sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder) : cur.sortOrder,
      })
      .where(eq(menuItems.id, body.id))
      .returning();

    // Only a changed photo can become orphaned. Avoid five reference-table
    // queries on ordinary price/name/availability edits (including a potentially
    // large tickets scan) while preserving cleanup when a photo really changes.
    if (cur.imageUrl !== updated[0]?.imageUrl) {
      await deleteOrphanedCdnImages([cur.imageUrl]);
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
      return NextResponse.json({ error: "Item ID required" }, { status: 400 });
    }

    const existing = await db.select().from(menuItems).where(eq(menuItems.id, Number(id)));
    await db.delete(menuItems).where(eq(menuItems.id, Number(id)));
    if (existing.length > 0) await deleteOrphanedCdnImages([existing[0].imageUrl]);
    return NextResponse.json({ success: true, id: Number(id) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
