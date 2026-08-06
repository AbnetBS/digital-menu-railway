import { NextResponse } from "next/server";
import { db } from "@/db";
import { menuItems } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";

const STOCK_IMG = "https://images.pexels.com/photos/16563658/pexels-photo-16563658.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=627&w=1200";

/**
 * POST /api/menu-bulk
 * body: { items: Array<{ name, category, price, description? }>  (pre-parsed rows from text)
 *        OR { text: "Name | Category | Price | Description (optional), one per line" }
 * Inserts many menu items at once (skips exact name duplicates automatically).
 */
export async function POST(request: Request) {
  await ensureTablesExist();
  try {
    const body = await request.json();
    let rows: Array<{ name: string; category: string; price: number; description?: string; dietaryTags?: string }> = [];

    if (Array.isArray(body.items)) {
      rows = body.items;
    } else if (body.text) {
      // Alternative text format: each line "Name | Category | Price | Description?"
      rows = String(body.text)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const parts = line.split("|").map((p) => p.trim());
          const [name, category, priceStr, description = ""] = parts;
          return {
            name,
            category: category?.toLowerCase() || "ethiopian-traditional-meals",
            price: Number(String(priceStr).replace(/[^\d.]/g, "")) || 0,
            description,
          };
        })
        .filter((r) => r.name && r.price > 0 && r.category);
    }

    if (rows.length === 0) {
      return NextResponse.json({ error: "Provide items array or text with 'Name | Category | Price | Description' lines" }, { status: 400 });
    }

    let insertedCount = 0;
    const skipped: string[] = [];

    for (const r of rows) {
      const existing = await db.select({ id: menuItems.id }).from(menuItems);
      const dup = existing.some((e) => e.id);
      // skip exact-name duplicates to avoid pair creation again
      const all = await db.select({ name: menuItems.name }).from(menuItems);
      const names = new Set(all.map((x) => x.name.toLowerCase().trim()));
      if (names.has(r.name.toLowerCase().trim())) {
        skipped.push(r.name);
        continue;
      }

      await db.insert(menuItems).values({
        name: r.name,
        category: r.category,
        price: Number(r.price),
        description: r.description || `${r.name} — freshly prepared daily at Fana Cafe.`,
        imageUrl: STOCK_IMG,
        isPopular: false,
        isAvailable: true,
        dietaryTags: r.dietaryTags || "",
        prepTime: "10-15 min",
        badge: "",
        sortOrder: 0,
      });
      insertedCount++;
    }

    return NextResponse.json({
      success: true,
      inserted: insertedCount,
      skippedDuplicates: skipped.length,
      skippedNames: skipped.slice(0, 10),
      message: `✅ Imported ${insertedCount} menu items${skipped.length > 0 ? ` (skipped ${skipped.length} duplicates)` : ""}`,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
