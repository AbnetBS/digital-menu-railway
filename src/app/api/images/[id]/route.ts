import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import {
  imageVariantKey,
  snapImageHeight,
  snapImageQuality,
  snapImageWidth,
} from "@/lib/image-size";
import { buildImageVariant, createVariantCache, type ImageVariant } from "@/lib/image-variant";

/**
 * Serve ONE photo by ID — the browser caches it FOREVER (immutable).
 * This is what kills the repeated base64 flood: photo transfers once per device, never again.
 *
 * DISPLAY-SIZE VARIANTS (`?w=&h=&q=`)
 * -----------------------------------
 * Stored photos are ~900px JPEGs (100-250KB) while a menu card renders them at
 * ~190 CSS px. When the caller passes `w`/`h` (see `optimizeImageUrl`) the same
 * photo is downscaled to that box and returned as WebP (~15-30KB), so the first
 * screen of dishes can be fetched in parallel and revealed together instead of
 * downloading one card at a time on a phone that has never visited before.
 *
 * Guarantees that keep every existing flow intact:
 *   - `/api/images/{id}` with NO parameters behaves exactly as before (original
 *     bytes, original MIME type) — admin previews, receipt photos, waiter and
 *     kitchen screens and every already-printed QR are untouched.
 *   - A `cdn_images` id is immutable: replacing a photo INSERTs a NEW row, so a
 *     derived variant may also be cached `immutable` forever.
 *   - Sizes snap to a fixed allow-list (src/lib/image-size.ts), which bounds both
 *     the cache and the CPU an outsider can ask for.
 *   - Derivation is best-effort only: no sharp, animated GIF, undecodable blob or
 *     a result heavier than the original all fall back to the stored bytes.
 */

const variantCache = createVariantCache();

/**
 * IN-FLIGHT DEDUPE (opening-time thundering herd).
 *
 * The LRU above only helps AFTER a variant exists. On a cold instance — a fresh
 * deploy, a restart, or the first minute of service — 100 phones scanning their
 * QR codes ask for the SAME eight `?w=400&h=250` photos at the same moment, and
 * without this map every one of those requests runs its own Postgres fetch and
 * its own `sharp` encode of the same bytes. That is a CPU cliff exactly when the
 * room is busiest.
 *
 * One promise per variant key: the first request does the work, everybody else
 * awaits the same result. Entries are removed as soon as the work settles, so
 * the map cannot grow.
 */
const inFlightVariants = new Map<string, Promise<ImageVariant | null>>();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const numId = Number(id);
    if (!numId) return NextResponse.json({ error: "Invalid image id" }, { status: 400 });

    const searchParams = request.nextUrl.searchParams;
    const width = snapImageWidth(searchParams.get("w"));
    const height = snapImageHeight(searchParams.get("h"));
    const quality = snapImageQuality(searchParams.get("q"));
    const wantsVariant = Boolean(width || height);
    const cacheKey = wantsVariant ? imageVariantKey(numId, width, height, quality) : "";

    // Warm hit: no Postgres round-trip and no re-encode at all.
    if (cacheKey) {
      const cached = variantCache.get(cacheKey);
      if (cached) return photoResponse(cached);

      // Somebody is already deriving this exact variant — wait for their result
      // instead of encoding the same photo a second time.
      const pending = inFlightVariants.get(cacheKey);
      if (pending) {
        const shared = await pending;
        if (!shared) return NextResponse.json({ error: "Not found" }, { status: 404 });
        return photoResponse(shared);
      }
    }

    const work = loadPhoto(numId, width, height, quality, wantsVariant, cacheKey);
    if (cacheKey) {
      inFlightVariants.set(cacheKey, work);
      void work
        .catch(() => null)
        .finally(() => {
          if (inFlightVariants.get(cacheKey) === work) inFlightVariants.delete(cacheKey);
        });
    }

    const payload = await work;
    if (!payload) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return photoResponse(payload);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

/**
 * Fetch the stored bytes and (when asked) derive the display-size variant.
 * `null` means "no such photo" — every derivation failure still returns the
 * original bytes, exactly as before.
 */
async function loadPhoto(
  numId: number,
  width: number | undefined,
  height: number | undefined,
  quality: number,
  wantsVariant: boolean,
  cacheKey: string
): Promise<ImageVariant | null> {
  const rows = await db.execute(
    sql`SELECT mime_type, data FROM cdn_images WHERE id = ${numId} LIMIT 1`
  );

  const list = (rows as unknown as { rows: Array<{ mime_type: string; data: string }> }).rows ?? (rows as unknown as Array<{ mime_type: string; data: string }>);
  const row = list[0];
  if (!row?.data) return null;

  const base64 = row.data.includes(",") ? row.data.split(",")[1] : row.data;
  const buffer = Buffer.from(base64, "base64");

  let payload: ImageVariant = { body: buffer, type: row.mime_type || "image/jpeg" };
  if (wantsVariant) {
    const variant = await buildImageVariant(buffer, payload.type, width, height, quality);
    if (variant) {
      payload = variant;
      if (cacheKey) variantCache.set(cacheKey, variant);
    }
  }
  return payload;
}

/**
 * Immutable photo response — an id (and a snapped variant of it) can never
 * change content, so a browser may keep it forever.
 */
function photoResponse(payload: ImageVariant): NextResponse {
  // Copied into an ArrayBuffer-backed view: `Buffer<ArrayBufferLike>` is not a
  // valid fetch `BodyInit` under the current TypeScript DOM lib.
  const body = new Uint8Array(payload.body);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": payload.type,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
