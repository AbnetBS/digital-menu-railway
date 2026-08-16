/**
 * Pure helpers for recognizing image references. No DB or runtime imports, so
 * these are safe to use anywhere (including tests and edge runtimes).
 *
 * Two kinds of image values exist in this app:
 *   - `/api/images/{id}`  → a row in the `cdn_images` table (base64 blob),
 *     served via an immutable-cache endpoint.
 *   - `data:image/...;base64,...` → an inline data-URL (the fallback path when
 *     the image API is unavailable). These never touch `cdn_images`.
 */

const CDN_URL_RE = /^\/api\/images\/(\d+)/;

/** Parse the numeric `cdn_images` id out of a stored reference (or null). */
export function extractCdnImageId(ref: string | null | undefined): number | null {
  if (!ref) return null;
  const m = CDN_URL_RE.exec(ref.trim());
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** True when the value is a `/api/images/{id}` reference (vs inline/other). */
export function isCdnImageUrl(ref: string | null | undefined): boolean {
  return extractCdnImageId(ref) !== null;
}

/** True when the value is an inline `data:` URL (never references cdn_images). */
export function isInlineDataUrl(ref: string | null | undefined): boolean {
  return typeof ref === "string" && ref.startsWith("data:");
}

/** Canonical reference string for a cdn_images id. */
export function cdnImageUrl(id: number): string {
  return `/api/images/${id}`;
}
