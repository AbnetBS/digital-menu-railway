import { db } from "@/db";
import { menuItems, galleryItems, announcements, tickets, siteSettings } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { extractCdnImageId, cdnImageUrl, isInlineDataUrl } from "@/lib/image-ref";

/**
 * Image persistence + orphaned-image cleanup.
 *
 * Images are stored as base64 blobs in the `cdn_images` table, referenced by a
 * short `/api/images/{id}` URL from menu/gallery/announcement/receipt/settings
 * rows. This module owns BOTH the only insert path (persistImageRef) and the
 * only delete path (deleteOrphanedCdnImages) for `cdn_images`, so a blob can
 * only ever be created at save-time (never on a canceled upload) and is always
 * removed once its last reference disappears.
 */

/**
 * Persist an image reference at SAVE time.
 *
 *   - inline `data:` URL  → INSERT into `cdn_images`, return `/api/images/{id}`
 *   - `/api/images/{id}`  → already persisted, returned unchanged
 *   - external URL / ""   → returned unchanged
 *
 * This is deliberately the ONLY place that writes to `cdn_images`. The client
 * keeps the compressed data-URL in memory while the user is editing; nothing
 * touches the database until the record is actually saved. Canceled edits and
 * canceled uploads therefore never create a row.
 */
export async function persistImageRef(ref: string | null | undefined): Promise<string> {
  const s = typeof ref === "string" ? ref.trim() : "";
  if (s === "" || !isInlineDataUrl(s)) return s;

  const mimeMatch = s.match(/^data:([^;]+);base64,/);
  const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";

  const inserted = await db.execute(
    sql`INSERT INTO cdn_images (mime_type, data, created_at) VALUES (${mime}, ${s}, now()) RETURNING id`
  );
  const rows =
    (inserted as unknown as { rows: Array<{ id: number }> }).rows ??
    (inserted as unknown as Array<{ id: number }>);
  const id = rows[0]?.id;
  // If insertion somehow failed, fall back to the inline URL so the save still
  // works (mirrors the old client-side fallback).
  if (!id) return s;
  return cdnImageUrl(id);
}

/**
 * Count live references to a cdn_images row across every column that can store
 * an image reference. A row is orphaned only when this returns 0.
 */
async function countReferences(ref: string): Promise<number> {
  const [menu, gallery, anns, tk, settings] = await Promise.all([
    db.select({ id: menuItems.id }).from(menuItems).where(eq(menuItems.imageUrl, ref)),
    db.select({ id: galleryItems.id }).from(galleryItems).where(eq(galleryItems.imageUrl, ref)),
    db.select({ id: announcements.id }).from(announcements).where(eq(announcements.imageUrl, ref)),
    db.select({ id: tickets.id }).from(tickets).where(eq(tickets.receiptImage, ref)),
    // Any settings value that equals the URL (logo_url, hero_bg_image, …).
    db.select({ key: siteSettings.key }).from(siteSettings).where(eq(siteSettings.value, ref)),
  ]);
  return menu.length + gallery.length + anns.length + tk.length + settings.length;
}

/**
 * Delete `cdn_images` rows that are no longer referenced anywhere.
 *
 * Accepts raw stored reference values (URLs and/or inline data-URLs). Inline
 * data-URLs and non-cdn URLs are ignored (they never reference cdn_images).
 * Each candidate id is checked across ALL reference tables before deletion, so
 * a still-referenced image is never removed.
 *
 * Returns the ids that were deleted (for observability/tests).
 */
export async function deleteOrphanedCdnImages(
  refs: Array<string | null | undefined>
): Promise<number[]> {
  const ids = new Set<number>();
  for (const ref of refs) {
    const id = extractCdnImageId(ref);
    if (id !== null) ids.add(id);
  }

  const deleted: number[] = [];
  for (const id of ids) {
    const ref = cdnImageUrl(id);
    const remaining = await countReferences(ref);
    if (remaining === 0) {
      await db.execute(sql`DELETE FROM cdn_images WHERE id = ${id}`);
      deleted.push(id);
    }
  }
  return deleted;
}
