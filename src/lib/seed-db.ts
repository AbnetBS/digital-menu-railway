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

export async function ensureDbSeeded(force = false) {
  // NOTE: runs on every call — the 7 tiny SELECTs cost ~50ms total, but this is the ONLY
  // safe way to guarantee data self-heals: if a table ever becomes EMPTY (items deleted by
  // mistake), the defaults are restored on the very next request instead of never coming back.
  // (Force parameter kept for /api/setup compatibility.)
  try {
    // When the owner Factory-Resets a section, flags stop the demo seed from restoring it
    const menuReset = force ? false : await flagOn("menu_reset_flag");
    const annReset = force ? false : await flagOn("announcements_reset_flag");
    const galReset = force ? false : await flagOn("gallery_reset_flag");

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

    // 3) Insert any of the 13 default categories that don't exist yet
    const afterMigrationCats = await db.select().from(categories);
    const haveSlugs = new Set(afterMigrationCats.map((c) => c.slug));
    for (const cat of DEFAULT_CATEGORIES) {
      if (cat.slug === "all" && haveSlugs.has("all")) continue;
      if (!haveSlugs.has(cat.slug)) {
        await db.execute(
          sql`INSERT INTO categories (name, slug, icon, sort_order) VALUES (${cat.name}, ${cat.slug}, ${cat.icon}, ${cat.sortOrder ?? 0})`
        );
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
