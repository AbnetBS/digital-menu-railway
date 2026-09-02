/**
 * Server-side "display size" derivation for stored photos.
 *
 * A dish photo is uploaded once as a ~900px JPEG (100-250KB) but is rendered in
 * a ~190 CSS-px menu card. Deriving the exact rendered size (WebP, ~15-30KB) is
 * what lets a whole screen of dishes download in parallel and appear together on
 * a phone that has never visited before, instead of trickling in card by card.
 *
 * EVERY failure path here returns `null`, which means "serve the stored
 * original": sharp is an optional dependency, animated GIFs are left alone, an
 * undecodable blob is passed through, and a derived image that is somehow
 * HEAVIER than the original is discarded. A variant can only ever help.
 *
 * `cdn_images` ids are immutable (replacing a photo INSERTs a new row), so both
 * the in-process cache below and the browser's `immutable` cache are safe.
 */

export interface ImageVariant {
  body: Buffer;
  type: string;
}

/** Derived variants are small; keep the most recent N in process memory. */
const DEFAULT_MAX_CACHED_VARIANTS = 150;

/**
 * Tiny LRU keyed by `imageVariantKey(id, w, h, q)`. A hit skips BOTH the
 * Postgres round-trip and the re-encode, so the second customer on the same
 * Railway instance is served from memory.
 */
export function createVariantCache(maxEntries = DEFAULT_MAX_CACHED_VARIANTS) {
  const store = new Map<string, ImageVariant>();
  return {
    get size() {
      return store.size;
    },
    get(key: string): ImageVariant | null {
      const hit = store.get(key);
      if (!hit) return null;
      // Refresh recency so hot menu photos are never the ones evicted.
      store.delete(key);
      store.set(key, hit);
      return hit;
    },
    set(key: string, variant: ImageVariant): void {
      store.set(key, variant);
      while (store.size > maxEntries) {
        const oldest = store.keys().next();
        if (oldest.done) break;
        store.delete(oldest.value);
      }
    },
  };
}

export type VariantCache = ReturnType<typeof createVariantCache>;

// Lazy + memoised so a deployment without the optional `sharp` binary still
// boots and simply serves originals.
let sharpLoader: Promise<any> | null = null;
function loadSharp(): Promise<any> {
  if (!sharpLoader) {
    sharpLoader = import("sharp")
      .then((mod) => mod.default ?? mod)
      .catch(() => null);
  }
  return sharpLoader;
}

/**
 * Downscale/centre-crop `buffer` into the requested display box and encode WebP.
 * Returns null when the original bytes should be served instead.
 */
export async function buildImageVariant(
  buffer: Buffer,
  mimeType: string,
  width: number | undefined,
  height: number | undefined,
  quality: number
): Promise<ImageVariant | null> {
  if (!width && !height) return null;
  // Keep animated GIFs intact — one decoded frame would lose the animation.
  if (mimeType === "image/gif") return null;
  if (!buffer.length) return null;

  const sharp = await loadSharp();
  if (!sharp) return null;

  try {
    let pipeline = sharp(buffer, { failOn: "none" }).rotate(); // honour EXIF orientation
    pipeline =
      width && height
        ? // Centre crop — the same box the CSS `object-cover` card shows.
          pipeline.resize({ width, height, fit: "cover", position: "centre", withoutEnlargement: true })
        : pipeline.resize({ width, height, withoutEnlargement: true });

    const body = await pipeline.webp({ quality }).toBuffer();
    // Never serve a "thumbnail" that is heavier than the stored original.
    if (!body.length || body.length >= buffer.length) return null;
    return { body, type: "image/webp" };
  } catch {
    return null;
  }
}
