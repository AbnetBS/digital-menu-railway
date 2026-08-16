/**
 * Runtime unit test for the pure image-reference helpers
 * (src/lib/image-ref.ts) — no database required.
 *
 * Covers the parsing that decides WHICH stored values reference a cdn_images
 * row (and therefore may be cleaned up) vs. which are inline data-URLs or
 * external URLs (which must NEVER touch cdn_images).
 *
 * Run with: npx tsx scripts/image-cleanup-self-test.ts
 */
import { extractCdnImageId, isCdnImageUrl, isInlineDataUrl, cdnImageUrl } from "../src/lib/image-ref";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures += 1;
}

// ── extractCdnImageId ───────────────────────────────────────────────────────
check("parses /api/images/42 → 42", extractCdnImageId("/api/images/42") === 42);
check("parses with trailing slash tolerated", extractCdnImageId("/api/images/7") === 7);
check("trims surrounding whitespace", extractCdnImageId("  /api/images/9  ") === 9);
check("rejects inline data-URL", extractCdnImageId("data:image/jpeg;base64,AAAA") === null);
check("rejects external URL", extractCdnImageId("https://images.pexels.com/x.jpg") === null);
check("rejects empty string", extractCdnImageId("") === null);
check("rejects null", extractCdnImageId(null) === null);
check("rejects undefined", extractCdnImageId(undefined) === null);
check("rejects non-numeric id", extractCdnImageId("/api/images/abc") === null);
check("rejects zero id", extractCdnImageId("/api/images/0") === null);
check("ignores a URL that merely contains /api/images", extractCdnImageId("https://x.com/api/images/5") === null);

// ── isCdnImageUrl ───────────────────────────────────────────────────────────
check("isCdnImageUrl true for /api/images/1", isCdnImageUrl("/api/images/1") === true);
check("isCdnImageUrl false for data-URL", isCdnImageUrl("data:image/png;base64,x") === false);
check("isCdnImageUrl false for pexels", isCdnImageUrl("https://images.pexels.com/a.jpg") === false);
check("isCdnImageUrl false for null", isCdnImageUrl(null) === false);

// ── isInlineDataUrl ─────────────────────────────────────────────────────────
check("isInlineDataUrl true for data:", isInlineDataUrl("data:image/jpeg;base64,x") === true);
check("isInlineDataUrl false for /api/images/1", isInlineDataUrl("/api/images/1") === false);
check("isInlineDataUrl false for null", isInlineDataUrl(null) === false);

// ── cdnImageUrl round-trip ──────────────────────────────────────────────────
check("cdnImageUrl(5) round-trips through extract", extractCdnImageId(cdnImageUrl(5)) === 5);

console.log(failures === 0 ? "\nALL IMAGE-REF CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
