import { NextResponse } from "next/server";
import { db } from "@/db";
import { siteSettings } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq } from "drizzle-orm";
import { fixSiteText } from "@/lib/brand";
import { hashSecret } from "@/lib/auth";
import { deleteOrphanedCdnImages, persistImageRef } from "@/lib/image-store";
import { requireAdmin } from "@/lib/session";

// Sensitive settings keys that must never be returned to a client.
const SECRET_KEYS = new Set(["admin_password"]);

// Settings keys that hold an uploaded image (stored as a cdn_images reference).
const IMAGE_SETTING_KEYS = new Set(["logo_url", "hero_bg_image"]);

export async function GET() {
  await ensureTablesExist();
  try {
    const allSettings = await db.select().from(siteSettings);
    const settingsMap: Record<string, string> = {};
    allSettings.forEach((s) => {
      // Never leak credentials (or their hashes) to any client.
      if (SECRET_KEYS.has(s.key)) return;
      // Brand + address guard: business is "Fana Cafe & Restaurant" located in
      // Town Square Building — never serve historical "FanaQueen" or
      // "Golagul Building" text to any client, even if the DB still holds it.
      settingsMap[s.key] = fixSiteText(s.value);
    });
    return NextResponse.json(settingsMap, { status: 200, headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } });
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
    const entries = Object.entries(body);
    // Old values of any setting whose previous value was a cdn image reference
    // (e.g. logo_url, hero_bg_image) — cleaned up after the write if orphaned.
    const oldImageRefs: string[] = [];
    for (const [key, val] of entries) {
      let stringVal = typeof val === "object" ? JSON.stringify(val) : String(val);

      // Passwords are stored as bcrypt hashes only — never plaintext.
      if (key === "admin_password" && stringVal) {
        stringVal = await hashSecret(stringVal);
      }

      // Uploaded images (logo, hero) are persisted to cdn_images at save time —
      // a data-URL becomes a `/api/images/{id}` reference, never an inline blob.
      if (IMAGE_SETTING_KEYS.has(key) && stringVal) {
        stringVal = await persistImageRef(stringVal);
      }

      const existing = await db.select().from(siteSettings).where(eq(siteSettings.key, key));
      if (existing.length > 0) {
        oldImageRefs.push(existing[0].value);
        await db
          .update(siteSettings)
          .set({ value: stringVal, updatedAt: new Date() })
          .where(eq(siteSettings.key, key));
      } else {
        await db.insert(siteSettings).values({ key, value: stringVal });
      }
    }
    await deleteOrphanedCdnImages(oldImageRefs);
    return NextResponse.json({ success: true, message: "Settings updated successfully" });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
