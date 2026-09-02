import { asc } from "drizzle-orm";
import { db } from "@/db";
import { menuItems } from "@/db/schema";
import { optimizeImageUrl, MENU_CARD_IMG_W, MENU_CARD_IMG_H, FIRST_SCREEN_PHOTOS } from "@/lib/image-url";

/**
 * SERVER-SIDE first-screen photo lookup (image loading, round 2).
 *
 * WHY
 * ---
 * `ImageBatchProvider` already fires the first screen of dish photos in parallel
 * as soon as the menu JSON lands in the browser. But that JSON can only be
 * requested after the page's JS has downloaded, booted and hydrated — on a
 * Ethiopian mobile connection that is 1-2s during which the radio is idle as far
 * as the photos are concerned.
 *
 * `/menu` now emits `<link rel="preload" as="image">` for exactly those photos
 * from the SERVER, so the bytes are already in flight while the JS is still
 * arriving. When the skeleton clears, the first screen is (almost always) ready
 * to be painted in one go instead of shimmering first.
 *
 * The URLs must match the client byte for byte or the browser downloads each
 * photo twice, so both sides use the same box constants and the same
 * `optimizeImageUrl()` (from the server-safe `@/lib/image-url`).
 *
 * SAFETY
 * ------
 * A preload is an optimisation, never a dependency: this fails soft to `[]`
 * (page renders exactly as before) if Postgres is slow, unreachable, or the
 * tables do not exist yet. The budget below caps how long the HTML may wait.
 */

/** Box constants live in `@/lib/image-url` so this SERVER preload and the client
 * grid can never drift apart — a mismatched `?w=&h=` would make the browser
 * download every first-screen photo twice. */
/** Hard cap on how long a page render may wait for the preload lookup. */
export const PRELOAD_BUDGET_MS = 1200;

/**
 * Photo URLs of the first menu cards, in the same order `/api/menu` returns
 * (`sortOrder`, then `id`) — which is the order the customer grid renders.
 */
export async function firstScreenPhotoUrls(
  limit: number = FIRST_SCREEN_PHOTOS,
  budgetMs: number = PRELOAD_BUDGET_MS
): Promise<string[]> {
  if (limit <= 0) return [];

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Any failure (no tables yet, no DATABASE_URL, a dropped connection) simply
    // resolves to the fallback: the menu still renders, it just starts its own
    // preloads client-side like it did before.
    const query = db
      .select({ imageUrl: menuItems.imageUrl })
      .from(menuItems)
      .orderBy(asc(menuItems.sortOrder), asc(menuItems.id))
      .limit(limit)
      .catch(() => [] as { imageUrl: string | null }[]);

    const rows = await Promise.race([
      query,
      new Promise<{ imageUrl: string | null }[]>((resolve) => {
        timer = setTimeout(() => resolve([]), budgetMs);
      }),
    ]);

    const urls: string[] = [];
    for (const row of rows) {
      const url = optimizeImageUrl(row.imageUrl, MENU_CARD_IMG_W, MENU_CARD_IMG_H);
      if (url && !urls.includes(url)) urls.push(url);
    }
    return urls;
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}
