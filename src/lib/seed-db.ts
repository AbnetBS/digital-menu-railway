import { db } from "@/db";
import { siteSettings, categories, menuItems, reviews, galleryItems, staffUsers, cafeTables } from "@/db/schema";
import {
  DEFAULT_SETTINGS,
  DEFAULT_CATEGORIES,
  DEFAULT_MENU_ITEMS,
  DEFAULT_REVIEWS,
  DEFAULT_GALLERY,
  DEFAULT_TABLES,
  DEFAULT_STAFF,
  CATEGORY_SLUG_MAP,
} from "@/lib/initial-data";
import { sql, eq } from "drizzle-orm";

async function flagOn(key: string): Promise<boolean> {
  const rows = await db.select().from(siteSettings).where(eq(siteSettings.key, key));
  return rows.length > 0 && rows[0].value === "on";
}

/**
 * PERFORMANCE (Group 1): the full seed pipeline used to run on EVERY data-route
 * request (~20–35 statements, including two full-table DELETE dedups). It now runs
 * exactly ONCE per server process; subsequent calls return the memoized result with
 * zero SQL. Concurrent first requests (e.g. 10 visitors right after deploy) all await
 * the same shared promise, so only one full seed ever runs.
 *
 * Self-healing contract preserved: destructive endpoints (admin deletes / factory
 * resets) call invalidateDbSeeded(), so the next read re-verifies and restores default
 * data if a table was emptied. Plain reads never pay that cost again.
 */
const globalForSeed = globalThis as typeof globalThis & {
  __fanaSeedDone?: boolean;
  __fanaSeedPromise?: Promise<{ success: boolean; error?: string }> | null;
};

/** Full seed + migration normalization. Only runs once per process (or on force/invalidate). */
async function runFullSeed(force = false) {
  try {
    // When the owner Factory-Resets a section, flags stop the demo seed from restoring it
    const menuReset = force ? false : await flagOn("menu_reset_flag");
    const annReset = force ? false : await flagOn("announcements_reset_flag");
    const galReset = force ? false : await flagOn("gallery_reset_flag");
    // Categories: once the owner deletes a category, stop re-inserting the
    // 13 default categories on every seed run (they used to "come back").
    const catReset = force ? false : await flagOn("categories_reset_flag");

    // Deduplicate accidental pairs (menu items repeating by name, staff repeating by name+role) —
    // happens from legacy save flows; keep the OLDEST, delete the rest.
    await db.execute(sql`DELETE FROM menu_items t1 USING menu_items t2 WHERE t1.name = t2.name AND t1.id > t2.id`);
    await db.execute(sql`DELETE FROM staff_users t1 USING staff_users t2 WHERE t1.name = t2.name AND t1.role = t2.role AND t1.id > t2.id`);

    const existingSettings = await db.select().from(siteSettings);
    if (existingSettings.length === 0) {
      const settingsToInsert = Object.entries(DEFAULT_SETTINGS).map(([key, value]) => ({
        key,
        value: typeof value === "object" ? JSON.stringify(value) : String(value),
      }));
      await db.insert(siteSettings).values(settingsToInsert);
    }

    // ── Category migration: move legacy slugs to the 13-type list, keep nothing orphaned ──
    const existingCategories = await db.select().from(categories);
    const existingSlugs = new Set(existingCategories.map((c) => c.slug));

    // 1) Move existing menu items to new slugs (legacy category names map → new ones)
    for (const [oldSlug, newSlug] of Object.entries(CATEGORY_SLUG_MAP)) {
      await db.execute(sql`UPDATE menu_items SET category = ${newSlug} WHERE category = ${oldSlug}`);
      await db.execute(sql`UPDATE categories SET slug = ${newSlug} WHERE slug = ${oldSlug}`);
    }

    // 2) Remove legacy default categories (old 5-type system) when they duplicate new ones
    const legacyDefaultSlugs = ["signature-coffee", "fresh-drinks", "food", "snacks", "pastries"];
    for (const legacy of legacyDefaultSlugs) {
      if (!CATEGORY_SLUG_MAP[legacy]) continue;
      const newSlug = CATEGORY_SLUG_MAP[legacy];
      const legacyRow = existingCategories.find((c) => c.slug === legacy);
      if (legacyRow) {
        await db.execute(sql`DELETE FROM categories WHERE slug = ${legacy} AND id = ${legacyRow.id}`);
        // reinsert as the new slug only if absent
        if (!existingSlugs.has(newSlug)) {
          await db.insert(categories).values({
            name: legacyRow.name,
            slug: newSlug,
            icon: legacyRow.icon,
            sortOrder: legacyRow.sortOrder ?? 0,
          });
        }
      }
    }

    // 3) Insert any of the 13 default categories that don't exist yet —
    //    UNLESS the owner has deleted categories (categories_reset_flag),
    //    in which case their curation is respected and nothing is restored.
    const afterMigrationCats = await db.select().from(categories);
    const haveSlugs = new Set(afterMigrationCats.map((c) => c.slug));
    if (!catReset) {
      for (const cat of DEFAULT_CATEGORIES) {
        if (cat.slug === "all" && haveSlugs.has("all")) continue;
        if (!haveSlugs.has(cat.slug)) {
          await db.execute(
            sql`INSERT INTO categories (name, slug, icon, sort_order) VALUES (${cat.name}, ${cat.slug}, ${cat.icon}, ${cat.sortOrder ?? 0})`
          );
        }
      }
    }

    // 4) Ensure the "All Items" tab exists exactly once
    const allRows = await db.execute(sql`SELECT id FROM categories WHERE slug = 'all'`);
    if (allRows.rows.length === 0) {
      await db.execute(sql`INSERT INTO categories (name, slug, icon, sort_order) VALUES ('All Items', 'all', 'Utensils', 0)`);
    }

    const existingMenuItems = await db.select().from(menuItems);
    if (existingMenuItems.length === 0 && !menuReset) {
      await db.insert(menuItems).values(
        DEFAULT_MENU_ITEMS.map((item) => ({
          name: item.name,
          category: item.category,
          price: item.price,
          description: item.description,
          imageUrl: item.imageUrl,
          isPopular: item.isPopular,
          isAvailable: item.isAvailable,
          dietaryTags: item.dietaryTags ?? "",
          prepTime: item.prepTime ?? "10 min",
          badge: item.badge ?? "",
          sortOrder: item.sortOrder,
        }))
      );
    }

    const existingReviews = await db.select().from(reviews);
    if (existingReviews.length === 0) {
      await db.insert(reviews).values(
        DEFAULT_REVIEWS.map((rev) => ({
          customerName: rev.customerName,
          rating: rev.rating,
          reviewText: rev.reviewText,
          reviewDate: rev.reviewDate,
          isApproved: rev.isApproved,
          isVerified: rev.isVerified,
        }))
      );
    }

    const existingGallery = await db.select().from(galleryItems);
    if (existingGallery.length === 0 && !galReset) {
      await db.insert(galleryItems).values(
        DEFAULT_GALLERY.map((gal) => ({
          title: gal.title,
          category: gal.category,
          imageUrl: gal.imageUrl,
          caption: gal.caption,
          sortOrder: gal.sortOrder,
        }))
      );
    }

    const existingStaff = await db.select().from(staffUsers);
    if (existingStaff.length === 0) {
      await db.insert(staffUsers).values(DEFAULT_STAFF);
    }

    const existingTables = await db.select().from(cafeTables);
    if (existingTables.length === 0) {
      await db.insert(cafeTables).values(DEFAULT_TABLES);
    }

    return { success: true };
  } catch (error) {
    console.error("Db Seed Error:", error);
    return { success: false, error: String(error) };
  }
}

export async function ensureDbSeeded(force = false) {
  if (force) {
    // /api/setup and explicit repair paths bypass the memo completely.
    globalForSeed.__fanaSeedDone = false;
    globalForSeed.__fanaSeedPromise = null;
    return runFullSeed(true);
  }

  if (globalForSeed.__fanaSeedDone) {
    return { success: true };
  }

  // One shared promise per process: concurrent callers collapse into a single run.
  if (!globalForSeed.__fanaSeedPromise) {
    globalForSeed.__fanaSeedPromise = runFullSeed(false)
      .then((res) => {
        if (res.success) globalForSeed.__fanaSeedDone = true;
        return res;
      })
      .finally(() => {
        // Clear on completion so a FAILED run is retried by the next caller;
        // a successful run is short-circuited by __fanaSeedDone above.
        globalForSeed.__fanaSeedPromise = null;
      });
  }
  return globalForSeed.__fanaSeedPromise;
}

/**
 * Call after any write that can empty a seeded table (admin DELETE handlers,
 * factory resets). The next read then re-runs the seed once to self-heal defaults —
 * the documented behavior, without paying for it on every request.
 */
export function invalidateDbSeeded() {
  globalForSeed.__fanaSeedDone = false;
  globalForSeed.__fanaSeedPromise = null;
}
