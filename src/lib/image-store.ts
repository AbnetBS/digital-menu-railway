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
export async function persistImageRef(ref: string | null | undefined, client: any = db): Promise<string> {
  const s = typeof ref === "string" ? ref.trim() : "";
  if (s === "" || !isInlineDataUrl(s)) return s;

  const mimeMatch = s.match(/^data:([^;]+);base64,/i);
  const mime = (mimeMatch ? mimeMatch[1] : "").toLowerCase();
  const payload = s.slice(s.indexOf(",") + 1);
  const allowedMime = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
  if (!mimeMatch || !allowedMime.has(mime) || !/^[a-z0-9+/=\\s]+$/i.test(payload)) {
    throw new Error("Only JPEG, PNG, GIF, and WebP image uploads are allowed");
  }

  // Enforce the upload limit server-side too; the browser check is not a
  // security boundary. Validate magic bytes so a text/HTML/SVG data URL cannot
  // be stored and later served with an executable content type.
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length > 10 * 1024 * 1024) throw new Error("Image upload exceeds the 10MB limit");
  const isJpeg = mime === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = mime === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isGif = mime === "image/gif" && (bytes.subarray(0, 6).toString() === "GIF87a" || bytes.subarray(0, 6).toString() === "GIF89a");
  const isWebp = mime === "image/webp" && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  if (!isJpeg && !isPng && !isGif && !isWebp) throw new Error("Image content does not match its MIME type");

  const inserted = await client.execute(
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
