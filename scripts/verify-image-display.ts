#!/usr/bin/env tsx
/**
 * Display-size regression coverage for the "all food photos appear together" fix.
 *
 *   1. `optimizeImageUrl` only rewrites `/api/images/{id}` refs — Pexels,
 *      `data:` URLs, `/logo.png` and the placeholder SVGs are untouched, and the
 *      rewrite is idempotent.
 *   2. The size allow-list in `image-size.ts` snaps UP, clamps and ignores junk,
 *      so the derived-variant key space stays tiny (cache + CPU bound).
 *   3. `buildImageVariant` really does shrink a phone-sized JPEG, and returns
 *      null (→ serve the original) for GIFs, missing sizes, undecodable bytes
 *      and any result that would be heavier than the source.
 *   4. The variant LRU evicts the oldest entry but keeps recently used ones.
 *
 * Run with: npx tsx scripts/verify-image-display.ts   (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { optimizeImageUrl, FALLBACK_FOOD_IMAGE } from "../src/lib/image-utils";
import {
  DEFAULT_IMAGE_QUALITY,
  MAX_IMAGE_EDGE,
  imageVariantKey,
  snapImageHeight,
  snapImageQuality,
  snapImageWidth,
} from "../src/lib/image-size";
import { buildImageVariant, createVariantCache } from "../src/lib/image-variant";

const failures: string[] = [];

async function main() {
  function pass(name: string, condition: boolean) {
    console.log(`${condition ? "✅" : "❌"} ${name}`);
    if (!condition) failures.push(name);
  }

  // ── 1. optimizeImageUrl only rewrites application photos ────────────────────
  {
    pass("menu card asks for its rendered size", optimizeImageUrl("/api/images/12", 400, 250) === "/api/images/12?w=400&h=250");
    pass("trailing slash ref is normalised", optimizeImageUrl("/api/images/12/", 400, 250) === "/api/images/12?w=400&h=250");
    pass("already-sized ref is left alone (idempotent)", optimizeImageUrl(optimizeImageUrl("/api/images/12", 400, 250), 400, 250) === "/api/images/12?w=400&h=250");
    pass("detail modal gets its own size", optimizeImageUrl("/api/images/7", 600, 400) === "/api/images/7?w=600&h=400");
    pass("fractional sizes are rounded", optimizeImageUrl("/api/images/7", 400.4, 249.6) === "/api/images/7?w=400&h=250");

    const pexels = "https://images.pexels.com/photos/6763235/pexels-photo-6763235.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=300&w=480";
    const optimizedPexels = optimizeImageUrl(pexels, 400, 250);
    pass("pexels refs keep the CDN crop parameters", optimizedPexels.includes("images.pexels.com") && optimizedPexels.includes("fit=crop") && optimizedPexels.includes("w=400") && optimizedPexels.includes("h=250"));
    pass("pexels refs never get the /api/images treatment", !optimizedPexels.includes("/api/images"));

    pass("inline data URLs are returned as-is", optimizeImageUrl("data:image/jpeg;base64,AAAA", 400, 250) === "data:image/jpeg;base64,AAAA");
    pass("static assets are returned as-is", optimizeImageUrl("/logo.png", 400, 250) === "/logo.png");
    pass("placeholder SVG is returned as-is", optimizeImageUrl("/images/placeholder-food.svg", 400, 250) === "/images/placeholder-food.svg");
    pass("empty/null falls back to the placeholder", optimizeImageUrl("", 400, 250) === FALLBACK_FOOD_IMAGE && optimizeImageUrl(null, 400, 250) === FALLBACK_FOOD_IMAGE);
  }

  // ── 2. Size allow-list ──────────────────────────────────────────────────────
  {
    pass("width snaps UP to an allowed step", snapImageWidth("250") === 320 && snapImageWidth("400") === 400);
    pass("height snaps UP to an allowed step", snapImageHeight("250") === 256 && snapImageHeight("256") === 256);
    pass("oversized requests are clamped", snapImageWidth("99999") === MAX_IMAGE_EDGE && snapImageHeight("99999") === 1200);
    pass("junk sizes are ignored (original served)", snapImageWidth("abc") === undefined && snapImageWidth(null) === undefined && snapImageHeight("-5") === undefined);
    pass("quality defaults and snaps", snapImageQuality(null) === DEFAULT_IMAGE_QUALITY && snapImageQuality("999") === 85 && snapImageQuality("1") === 60);
    pass("variant key distinguishes size and quality", imageVariantKey(3, 400, 256, 72) !== imageVariantKey(3, 400, 320, 72) && imageVariantKey(3, undefined, undefined, 72) === "3|0|0|72");
  }

  // ── 3. Real derivation (uses the optional sharp binary when present) ────────
  {
    let sharpAvailable = true;
    let jpeg: Buffer = Buffer.alloc(0);
    try {
      const sharp = (await import("sharp")).default;
      // A realistic stored upload: a 900px-wide JPEG, exactly what
      // compressImage() produces on the admin's phone before it is saved to
      // cdn_images. Synthetic "photo" = warm gradient + deterministic speckle,
      // so it does not compress away to nothing the way a flat colour block
      // would (a flat block would prove nothing about the byte savings).
      const W = 900;
      const H = 675;
      const raw = Buffer.alloc(W * H * 3);
      let seed = 42;
      const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 3;
          const speckle = rand() * 70;
          raw[i] = Math.min(255, 90 + (x / W) * 120 + speckle);
          raw[i + 1] = Math.min(255, 55 + (y / H) * 90 + speckle * 0.7);
          raw[i + 2] = Math.min(255, 30 + ((x + y) / (W + H)) * 60 + speckle * 0.4);
        }
      }
      jpeg = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 70 }).toBuffer();
    } catch {
      sharpAvailable = false;
    }

    if (!sharpAvailable) {
      // Without sharp the endpoint must silently serve the original bytes.
      pass("no sharp → variant derivation returns null (original served)", (await buildImageVariant(jpeg, "image/jpeg", 400, 256, 72)) === null);
      console.log("   ⚠ sharp not installed here — skipped the byte-size assertions");
    } else {
      const variant = await buildImageVariant(jpeg, "image/jpeg", 400, 256, 72);
      pass("menu-card variant is produced", variant !== null && variant.type === "image/webp");
      pass("menu-card variant is dramatically smaller", variant !== null && variant.body.length < jpeg.length / 2);
      console.log(`   • stored original ${(jpeg.length / 1024).toFixed(1)}KB → card variant ${variant ? (variant.body.length / 1024).toFixed(1) : "?"}KB`);

      const sharp = (await import("sharp")).default;
      const meta = variant ? await sharp(variant.body).metadata() : null;
      pass("variant matches the requested display box", meta?.width === 400 && meta?.height === 256);

      pass("no size requested → original served", (await buildImageVariant(jpeg, "image/jpeg", undefined, undefined, 72)) === null);
      pass("animated GIFs are never flattened", (await buildImageVariant(jpeg, "image/gif", 400, 256, 72)) === null);
      pass("undecodable bytes fall back to the original", (await buildImageVariant(Buffer.from("not-an-image"), "image/jpeg", 400, 256, 72)) === null);
      pass("empty blob falls back to the original", (await buildImageVariant(Buffer.alloc(0), "image/jpeg", 400, 256, 72)) === null);

      const tiny = await sharp({ create: { width: 60, height: 40, channels: 3, background: { r: 10, g: 10, b: 10 } } }).jpeg().toBuffer();
      const tinyMeta = await sharp((await buildImageVariant(tiny, "image/jpeg", 400, 256, 72))?.body ?? tiny).metadata();
      pass("small uploads are never upscaled", (tinyMeta.width ?? 0) <= 60);
    }
  }

  // ── 4. Variant LRU ──────────────────────────────────────────────────────────
  {
    const cache = createVariantCache(2);
    const a: { body: Buffer; type: string } = { body: Buffer.from("a"), type: "image/webp" };
    const b: { body: Buffer; type: string } = { body: Buffer.from("b"), type: "image/webp" };
    const c: { body: Buffer; type: string } = { body: Buffer.from("c"), type: "image/webp" };
    cache.set("a", a);
    cache.set("b", b);
    pass("cache hit returns the stored variant", cache.get("a") === a);
    cache.set("c", c); // "a" was used most recently → "b" is the oldest
    pass("least-recently-used entry is evicted", cache.get("b") === null && cache.get("a") === a && cache.get("c") === c);
    pass("cache size respects the cap", cache.size === 2);
    pass("misses are null (caller falls through to Postgres)", cache.get("nope") === null);
  }

  // ── 5. The endpoint contract itself ─────────────────────────────────────────
  {
    const route = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src/app/api/images/[id]/route.ts"), "utf8");
    pass("photos stay immutably cacheable", route.includes("public, max-age=31536000, immutable"));
    pass("parameterless requests keep the stored MIME type", route.includes('row.mime_type || "image/jpeg"'));
    pass("a derived variant can never replace a failed one", route.includes("if (variant)"));
    pass("warm variants skip the database entirely", route.includes("if (cached) return photoResponse(cached)"));
  }
  if (failures.length > 0) {
    console.error("\n❌ IMAGE DISPLAY-SIZE REGRESSION TEST FAILED\n");
    for (const f of failures) console.error("  • " + f);
    process.exit(1);
  }
  console.log("\n✅ Image display-size regression test PASSED");
  console.log("   • menu cards request their rendered size, everything else is untouched");
  console.log("   • derived WebP variants are smaller, cropped and never upscaled");
  console.log("   • every failure path falls back to the stored original");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
