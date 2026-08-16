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
  REMOVED_DEFAULT_CATEGORY_SLUGS,
} from "@/lib/initial-data";
import { sql, eq } from "drizzle-orm";
import { hashSecret } from "@/lib/auth";

async function flagOn(key: string): Promise<boolean> {
  const rows = await db.select().from(siteSettings).where(eq(siteSettings.key, key));
  return rows.length > 0 && rows[0].value === "on";
}

/**
 * EXPLICIT database seeding — DEFAULT DATA ONLY.
 *
 * ⚠️ IMPORTANT: This function must NEVER be called from normal request handlers.
 * It is intended ONLY for explicit, owner-invoked setup operations:
 *   - GET/POST /api/setup  (one-time database initializer used after deployment)
 *   - GET/POST /api/seed   (explicit seed endpoint)
 *
 * What it does (all operations are ADDITIVE — it only INSERTS default data when a
 * table is EMPTY, and it never deletes or rewrites existing rows):
 *   1. Inserts DEFAULT_SETTINGS if site_settings is empty.
 *   2. Inserts any missing DEFAULT_CATEGORIES (including the "All Items" tab) —
 *      UNLESS the owner deleted categories (categories_reset_flag) or a category
 *      is in REMOVED_DEFAULT_CATEGORY_SLUGS (owner marked it unnecessary).
 *   3. Inserts DEFAULT_MENU_ITEMS only if menu_items is empty AND the owner has not
 *      factory-reset the menu (menu_reset_flag). Same for announcements/gallery flags.
 *   4. Inserts DEFAULT_REVIEWS, DEFAULT_GALLERY, DEFAULT_STAFF, DEFAULT_TABLES if
 *      their tables are empty.
 *
 * It deliberately does NOT:
 *   - delete duplicate menu items / staff (that could destroy real data)
 *   - rewrite category slugs or move menu items between categories (that could
 *     overwrite owner-created categories)
 *
 * Existing production data is never touched. (Force parameter kept for /api/setup
 * compatibility — it only bypasses the reset flags.)
 */
export async function ensureDbSeeded(force = false) {
  try {
    // When the owner Factory-Resets a section, flags stop the demo seed from restoring it
    const menuReset = force ? false : await flagOn("menu_reset_flag");
    const annReset = force ? false : await flagOn("announcements_reset_flag");
    const galReset = force ? false : await flagOn("gallery_reset_flag");
    // Categories: once the owner deletes a category, stop re-inserting the
    // default categories on every seed run (they used to "come back").
    const catReset = force ? false : await flagOn("categories_reset_flag");

    const existingSettings = await db.select().from(siteSettings);
    if (existingSettings.length === 0) {
      const settingsToInsert: Array<{ key: string; value: string }> = [];
      for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        // In production, never seed a predictable default admin password — the
        // owner must configure ADMIN_PASSWORD explicitly. Login fails closed
        // until then (see src/app/api/admin/login/route.ts).
        if (key === "admin_password" && process.env.NODE_ENV === "production") continue;
        let stringVal = typeof value === "object" ? JSON.stringify(value) : String(value);
        // Passwords are seeded as bcrypt hashes only — never plaintext.
        if (key === "admin_password" && stringVal) {
          stringVal = await hashSecret(stringVal);
        }
        settingsToInsert.push({ key, value: stringVal });
      }
      await db.insert(siteSettings).values(settingsToInsert);
    }

    // Insert any of the default categories that don't exist yet (keeps the filter
    // tabs working) — but never restore a category the owner removed.
    const currentCats = await db.select().from(categories);
    const haveSlugs = new Set(currentCats.map((c) => c.slug));
    if (!catReset) {
      for (const cat of DEFAULT_CATEGORIES) {
        if (REMOVED_DEFAULT_CATEGORY_SLUGS.includes(cat.slug)) continue;
        if (!haveSlugs.has(cat.slug)) {
          await db.execute(
            sql`INSERT INTO categories (name, slug, icon, sort_order) VALUES (${cat.name}, ${cat.slug}, ${cat.icon}, ${cat.sortOrder ?? 0})`
          );
        }
      }
    }

    // Ensure the "All Items" tab exists exactly once
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
      // Seed default staff with bcrypt-hashed PINs only — never plaintext.
      const staffToInsert = [];
      for (const s of DEFAULT_STAFF) {
        staffToInsert.push({ ...s, pin: await hashSecret(s.pin) });
      }
      await db.insert(staffUsers).values(staffToInsert);
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
