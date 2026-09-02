/**
 * Pure photo-URL helpers.
 *
 * These live in their own module WITHOUT `"use client"` on purpose: the same
 * rules must be usable from both sides of the app.
 *
 *  • client  — `optimizeImageUrl()` builds the `?w=&h=` variant URL every card
 *              renders (see `ImageReveal`).
 *  • server  — `src/app/menu/page.tsx` needs the IDENTICAL url for the
 *              first screen so the `<link rel="preload">` tags it emits match,
 *              byte for byte, the requests the browser will later make from the
 *              menu grid. A preload that differs by one query parameter is a
 *              wasted round-trip: the browser would download the photo twice.
 *
 * `src/lib/image-utils.ts` re-exports everything here, so existing imports keep
 * working; the browser-only `compressImage()` stays there.
 */

export const FALLBACK_FOOD_IMAGE = "/images/placeholder-food.svg";
export const FALLBACK_DRINK_IMAGE = "/images/placeholder-drink.svg";

/**
 * Menu-card photo size. Cards are ~190 CSS px wide, so 400x250 covers 2x-DPR
 * phones without shipping the stored 900px original (~150-250KB → ~15-30KB).
 *
 * These three constants are shared by BOTH halves of the first-screen preload —
 * `src/app/menu/page.tsx` (server `<link rel="preload">`) and the customer grid
 * (client `ImageBatchProvider`). If they ever drift apart the browser sees two
 * different URLs for the same photo and downloads it twice, which is exactly the
 * sequential trickle this pipeline exists to remove.
 */
export const MENU_CARD_IMG_W = 400;
export const MENU_CARD_IMG_H = 250;
/**
 * How many dish photos fit on the first screen (2 columns × ~3 rows + a little
 * scroll buffer). These are preloaded in parallel and revealed together; the
 * rest stay lazy so scrolling is what costs data, not opening the menu.
 */
export const FIRST_SCREEN_PHOTOS = 8;

/**
 * Adds `?w=&h=` to an application-served photo (`/api/images/{id}`) so the
 * endpoint downscales it to the size actually being rendered instead of sending
 * the stored ~900px original. A menu-card photo drops from ~150-250KB to
 * ~15-30KB (WebP), which is what lets a whole screen of dishes arrive together
 * on a phone that has never visited before.
 *
 * Only a bare `/api/images/{id}` ref is rewritten: anything that already carries
 * a query string is returned untouched, so calling this twice is safe and no
 * other local asset (`/logo.png`, `/images/placeholder-*.svg`) is affected.
 */
function withDisplaySize(ref: string, maxWidth: number, maxHeight: number): string {
  if (!/^\/api\/images\/\d+\/?$/.test(ref)) return ref;
  const width = Math.max(1, Math.round(maxWidth));
  const height = Math.max(1, Math.round(maxHeight));
  return `${ref.replace(/\/$/, "")}?w=${width}&h=${height}`;
}

/**
 * Optimizes image URLs for the size they are rendered at:
 *   - `/api/images/{id}` → same URL + `?w=&h=` (server-side downscale, see above)
 *   - Pexels hotlinks    → strict crop, dimensions and compression parameters
 *   - local static files (`/images/...`, `/logo.png`) and inline `data:` URLs
 *     are returned as-is.
 */
export function optimizeImageUrl(
  url: string | null | undefined,
  maxWidth = 480,
  maxHeight = 320
): string {
  if (!url || typeof url !== "string") return FALLBACK_FOOD_IMAGE;
  const trimmed = url.trim();
  if (!trimmed) return FALLBACK_FOOD_IMAGE;

  // Inline data URLs are already the final bytes — never touch them.
  if (trimmed.startsWith("data:")) {
    return trimmed;
  }

  // Application photos: ask the endpoint for the rendered size.
  if (trimmed.startsWith("/api/images/")) {
    return withDisplaySize(trimmed, maxWidth, maxHeight);
  }

  // Any other local static file stays untouched.
  if (trimmed.startsWith("/")) {
    return trimmed;
  }

  // Dynamic Pexels CDN optimization
  if (trimmed.includes("images.pexels.com")) {
    try {
      const parsed = new URL(trimmed);
      parsed.searchParams.set("auto", "compress");
      parsed.searchParams.set("cs", "tinysrgb");
      parsed.searchParams.set("fit", "crop");
      parsed.searchParams.set("w", String(maxWidth));
      parsed.searchParams.set("h", String(maxHeight));
      return parsed.toString();
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}
