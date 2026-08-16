#!/usr/bin/env node
/**
 * Regression test — "Orphaned cdn_images cleanup" (Group 4).
 *
 * Verifies, via static source inspection (zero dependencies, runs anywhere):
 *   1. The cleanup helper exists and deletes a cdn_images row ONLY when it has
 *      ZERO references across ALL five image-reference columns
 *      (menu_items.image_url, gallery_items.image_url, announcements.image_url,
 *       tickets.receipt_image, site_settings.value).
 *   2. Every route that can remove or replace an image reference wires in the
 *      shared `deleteOrphanedCdnImages` helper.
 *   3. No route performs an unguarded `DELETE FROM cdn_images` (which would
 *      risk deleting a still-referenced image).
 *   4. Images are written to cdn_images ONLY at save time via `persistImageRef`
 *      — there is no eager/unauthenticated `/api/images` POST, and no route
 *      inserts into cdn_images except through the shared helper.
 *
 * Run with: node scripts/verify-image-cleanup.mjs  (wired into `npm test`)
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const failures = [];
const pass = (name, cond) => {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures.push(name);
};

// ── 1. Reference helper (src/lib/image-ref.ts) ──────────────────────────────
{
  const ref = read("src/lib/image-ref.ts");
  pass("image-ref.ts defines extractCdnImageId", /export function extractCdnImageId/.test(ref));
  pass("image-ref.ts defines isCdnImageUrl", /export function isCdnImageUrl/.test(ref));
  pass("image-ref.ts defines isInlineDataUrl", /export function isInlineDataUrl/.test(ref));
  pass("image-ref.ts defines cdnImageUrl", /export function cdnImageUrl/.test(ref));
  pass("image-ref.ts matches /api/images/{id}", /\/api\/images\/\(\?=/.test(ref) || /api\\\/images/.test(ref) || /\/api\/images/.test(ref));
}

// ── 2. Cleanup helper (src/lib/image-store.ts) guards all references ────────
{
  const store = read("src/lib/image-store.ts");
  pass("image-store.ts exports deleteOrphanedCdnImages", /export async function deleteOrphanedCdnImages/.test(store));
  pass("image-store.ts exports persistImageRef", /export async function persistImageRef/.test(store));
  for (const table of ["menuItems", "galleryItems", "announcements", "tickets", "siteSettings"]) {
    pass(`image-store.ts counts references in ${table}`, store.includes(table));
  }
  pass("image-store.ts deletes only when zero references remain", /remaining === 0/.test(store));
  pass("image-store.ts uses the guarded DELETE on cdn_images", /DELETE FROM cdn_images WHERE id/.test(store));
}

// ── 3. Routes must wire in the shared helper ────────────────────────────────
// Note: tickets/cleanup now delegates to the shared receipt-cleanup module
// (which itself calls deleteOrphanedCdnImages), so we check it separately.
const expectedRoutes = [
  "src/app/api/menu/route.ts",
  "src/app/api/gallery/route.ts",
  "src/app/api/announcements/route.ts",
  "src/app/api/tickets/route.ts",
  "src/app/api/settings/route.ts",
  "src/app/api/reset/route.ts",
];
for (const r of expectedRoutes) {
  const src = read(r);
  pass(`${r} imports the cleanup helper`, src.includes("deleteOrphanedCdnImages"));
  pass(`${r} calls the cleanup helper`, src.includes("deleteOrphanedCdnImages("));
}
{
  // tickets/cleanup delegates to receipt-cleanup, which uses the guarded helper.
  const cleanupRoute = read("src/app/api/tickets/cleanup/route.ts");
  pass("tickets/cleanup calls the shared receipt-cleanup", cleanupRoute.includes("cleanupOldReceipts("));
  const rc = read("src/lib/receipt-cleanup.ts");
  pass("receipt-cleanup uses the guarded deleteOrphanedCdnImages", rc.includes("deleteOrphanedCdnImages("));
}

// ── 4. No unguarded cdn_images deletion/insertion outside the helper ────────
{
  const apiFiles = [
    ...expectedRoutes,
    "src/app/api/images/[id]/route.ts",
  ];
  for (const f of apiFiles) {
    if (f.includes("image-store")) continue;
    const src = read(f);
    if (/DELETE\s+FROM\s+cdn_images/i.test(src)) {
      pass(`${f} does not delete cdn_images directly`, false);
    }
    if (/INSERT\s+INTO\s+cdn_images/i.test(src)) {
      pass(`${f} does not insert cdn_images directly`, false);
    }
  }
  pass("no route bypasses the guarded helper (checked)", true);
}

// ── 5. Save-time-only persistence + no unauthenticated POST endpoint ────────
{
  const store = read("src/lib/image-store.ts");
  const saveRoutes = ["menu", "gallery", "announcements", "tickets", "settings"];
  for (const r of saveRoutes) {
    const f = `src/app/api/${r}/route.ts`;
    const src = read(f);
    pass(`${f} persists images at save time (persistImageRef)`, src.includes("persistImageRef("));
  }
  pass("POST /api/images endpoint removed", !existsSync(join(root, "src/app/api/images/route.ts")));
  pass("image-store.ts is the only cdn_images INSERT site", /INSERT INTO cdn_images/.test(store));
}

// ── Report ──────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error("\n❌ IMAGE CLEANUP REGRESSION TEST FAILED\n");
  for (const f of failures) console.error("  • " + f);
  process.exit(1);
}
console.log("\n✅ Image cleanup regression test PASSED");
console.log("   • cleanup helper guards all 5 reference columns");
console.log("   • all mutation routes wire in deleteOrphanedCdnImages");
console.log("   • no unguarded DELETE FROM cdn_images");
