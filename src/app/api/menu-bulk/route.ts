import { NextResponse } from "next/server";
import { db } from "@/db";
import { menuItems } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { eq } from "drizzle-orm";

const STOCK_IMG = "https://images.pexels.com/photos/16563658/pexels-photo-16563658.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=300&w=480";
const DEFAULT_PREP_TIME = "10-15 min";

/**
 * Looks like a preparation-time value (e.g. "10-15 min", "30 min", "1 hr").
 * Used to decide whether the 4th pipe-separated field is a time or a description
 * when a line only has 4 parts.
 */
function looksLikePrepTime(v: string): boolean {
  const s = v.trim();
  if (!s) return false;
  return /^\d+\s*([-–]\s*\d+)?\s*(min|mins|minute|minutes|hr|hrs|hour|hours|sec|secs|minute|min)?$/i.test(s);
}

/** Parses one text line into a row (with optional prep time and description). */
function parseLine(line: string): { name: string; category: string; price: number; description?: string; prepTime?: string } {
  const parts = line.split("|").map((p) => p.trim()).filter((p, i, arr) => !(i === arr.length - 1 && p === ""));
  const [name, category, priceStr, part4, part5] = parts;

  let description: string | undefined;
  let prepTime: string | undefined;

  if (part5 !== undefined) {
    // Name | Category | Price | PrepTime | Description
    prepTime = part4 || undefined;
    description = part5 || undefined;
  } else if (part4 !== undefined) {
    if (looksLikePrepTime(part4)) {
      // Name | Category | Price | PrepTime
      prepTime = part4;
    } else {
      // Name | Category | Price | Description  (legacy format — no time column)
      description = part4;
    }
  }

  return {
    name,
    category: category?.toLowerCase() || "ethiopian-traditional-meals",
    price: Number(String(priceStr).replace(/[^\d.]/g, "")) || 0,
    description,
    prepTime,
  };
}

/**
 * POST /api/menu-bulk
 * body: { items: Array<{ name, category, price, description?, prepTime? }>  (pre-parsed rows)
 *        OR { text: "Name | Category-slug | Price | PrepTime | Description (optional)", prepTime?: "10-15 min" }
 * Inserts new items and UPDATES existing ones that share the same name (so re-pasting
 * a list after an edit only changes the differences — e.g. a new prep time).
 */
export async function POST(request: Request) {
  const __auth = await requireAdmin();
  if (!__auth.ok) return __auth.response;
  await ensureTablesExist();
  try {
    const body = await request.json();
    const globalPrepTime = body.prepTime ? String(body.prepTime).trim() : "";

    let rows: Array<{ name: string; category: string; price: number; description?: string; prepTime?: string }> = [];

    if (Array.isArray(body.items)) {
      rows = body.items;
    } else if (body.text) {
      rows = String(body.text)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(parseLine)
        .filter((r) => r.name && r.price > 0 && r.category);
    }

    if (rows.length === 0) {
      return NextResponse.json({ error: "Provide items array or text with 'Name | Category | Price | PrepTime | Description' lines" }, { status: 400 });
    }

    let insertedCount = 0;
    let updatedCount = 0;

    // Load existing menu items once and key by lowercased name so re-pastes can
    // UPDATE matching rows in place instead of always inserting duplicates.
    const existing = await db.select({ id: menuItems.id, name: menuItems.name, prepTime: menuItems.prepTime, description: menuItems.description }).from(menuItems);
    const existingByName = new Map<string, { id: number; prepTime: string | null; description: string }>();
    for (const e of existing) existingByName.set(e.name.toLowerCase().trim(), e);

    for (const r of rows) {
      const key = r.name.toLowerCase().trim();
      // Resolve the effective prep time: per-line value → global default → keep existing.
      const prepTime = r.prepTime || globalPrepTime || existingByName.get(key)?.prepTime || DEFAULT_PREP_TIME;
      const description = r.description || existingByName.get(key)?.description || `${r.name} — freshly prepared daily at Fana Cafe.`;

      const match = existingByName.get(key);
      if (match) {
        // Same name already exists → update only what differs (category, price,
        // description, prep time). Name is unchanged.
        await db
          .update(menuItems)
          .set({
            category: r.category,
            price: Number(r.price),
            description,
            prepTime,
          })
          .where(eq(menuItems.id, match.id));
        updatedCount++;
        continue;
      }

      const inserted = await db
        .insert(menuItems)
        .values({
          name: r.name,
          category: r.category,
          price: Number(r.price),
          description,
          imageUrl: STOCK_IMG,
          isPopular: false,
          isAvailable: true,
          dietaryTags: "",
          prepTime,
          badge: "",
          sortOrder: 0,
        })
        .returning({ id: menuItems.id });
      insertedCount++;
      // Track in the map so later identical names within the same paste also update.
      existingByName.set(key, { id: inserted[0].id, prepTime, description });
    }

    return NextResponse.json({
      success: true,
      inserted: insertedCount,
      updated: updatedCount,
      message: `✅ Imported ${insertedCount} items, updated ${updatedCount} existing items`,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
