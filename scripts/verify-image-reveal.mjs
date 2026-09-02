#!/usr/bin/env node
/**
 * Regression test — "food photos appear TOGETHER on a QR scan".
 *
 * The customer menu used to paint the grid the instant the menu JSON arrived and
 * then let every <img> fetch on its own, so a phone that had never visited
 * watched dish 1 download, then dish 2, then dish 3…
 *
 * The fix has three pieces, and this guard checks each is still wired in:
 *   1. The first screen of photos is preloaded in ONE parallel, high-priority
 *      batch (<link rel="preload" as="image" fetchpriority="high">) instead of a
 *      sequential trickle — and a hard timeout means one dead photo can never
 *      hold the menu hostage.
 *   2. Each photo sits on a shimmer placeholder and fades in with the rest of
 *      its batch; nothing is ever allowed to stay invisible.
 *   3. Photos are requested at their RENDERED size, so the batch is small enough
 *      to land together on a phone connection (byte side is covered by
 *      scripts/verify-image-display.ts).
 *
 * Static source inspection only — zero dependencies, runs anywhere.
 * Run with: node scripts/verify-image-reveal.mjs   (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const failures = [];
const pass = (name, cond) => {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures.push(name);
};

// ── 1. The batch preloader (src/components/ImageReveal.tsx) ─────────────────
const reveal = read("src/components/ImageReveal.tsx");
{
  pass("ImageReveal exports ImageBatchProvider", /export function ImageBatchProvider/.test(reveal));
  pass("ImageReveal exports RevealImage", /export function RevealImage/.test(reveal));
  pass("batch is fired as image preloads", /rel = "preload"/.test(reveal) && /as = "image"/.test(reveal));
  pass("preloads ask for HIGH priority (no sequential trickle)", /fetchpriority", "high"/.test(reveal));
  pass("preloads start in one loop, not one after another", /for \(const href of list\)/.test(reveal));
  pass("a timeout releases the batch even if a photo never arrives", /setTimeout\(release, timeoutMs\)/.test(reveal));
  pass("failed photos release the batch too (error listener)", /addEventListener\("error", settle\)/.test(reveal));
  pass("preload links are cleaned up again", /link\.remove\(\)/.test(reveal));
  pass("an empty batch never holds anything back", /if \(list\.length === 0\) return;/.test(reveal));
  pass("batch membership is derived by value, not array identity", /uniqueUrls\(urls\)\.join\(SEP\)/.test(reveal));
}

// ── 2. The photo component itself ───────────────────────────────────────────
{
  pass("photos fade in instead of popping", /transition-opacity/.test(reveal) && /opacity-0/.test(reveal) && /opacity-100/.test(reveal));
  pass("a shimmer placeholder fills the card while downloading", /img-shimmer/.test(reveal));
  pass("gated photos wait for the batch, the rest show as they land", /waitsForBatch \|\| released|!waitsForBatch \|\| released/.test(reveal));
  pass("first-screen photos are eager + high priority", /loading=\{eager \? "eager" : "lazy"\}/.test(reveal) && /fetchPriority=\{eager \? "high" : "auto"\}/.test(reveal));
  pass("below-the-fold photos stay lazy (no wasted mobile data)", /: "lazy"/.test(reveal));
  pass("broken photos still fall back to the placeholder SVG", /el\.src = fallbackSrc/.test(reveal) && /FALLBACK_FOOD_IMAGE/.test(reveal));
  pass("a photo can never stay invisible forever (safety timer)", /setTimeout\(\(\) => setReady\(true\)/.test(reveal));
  pass("cached photos that finished before hydration are still shown", /node\.complete && node\.naturalWidth > 0/.test(reveal));
}

// ── 3. Wired into the customer QR menu ──────────────────────────────────────
const app = read("src/components/rms/CustomerMenuApp.tsx");
{
  pass("customer menu imports the batch provider", /import \{[^}]*ImageBatchProvider[^}]*RevealImage[^}]*\} from "@\/components\/ImageReveal"/s.test(app));
  pass("the menu grid is wrapped in ImageBatchProvider", /<ImageBatchProvider[\s\S]{0,140}urls=\{firstScreenPhotoUrls\}/.test(app));
  pass("only the FIRST SCREEN is gated", /slice\(0, FIRST_SCREEN_PHOTOS\)/.test(app));
  pass("cards render through RevealImage", /<RevealImage[\s\S]{0,220}MENU_CARD_IMG_W, MENU_CARD_IMG_H/.test(app));
  pass("no menu card is left on a bare <img>", !/<img src=\{optimizeImageUrl\(m\.imageUrl/.test(app));
  pass("card photos request their rendered size", /optimizeImageUrl\(m\.imageUrl, MENU_CARD_IMG_W, MENU_CARD_IMG_H\)/.test(app));
  pass("searching does not blink photos back to placeholders", /search\.trim\(\)\s*\?\s*\[\]/.test(app));
  pass("the branded loading skeleton is untouched", /menuLoading && menuItems\.length === 0/.test(app));
}

// ── 3b. Round 2 — server preload + below-the-fold streaming ─────────────────
const imageUrl = read("src/lib/image-url.ts");
const imageUtils = read("src/lib/image-utils.ts");
const preview = read("src/lib/menu-preview.ts");
const menuPage = read("src/app/menu/page.tsx");
{
  // The server <link> and the client batch must ask for IDENTICAL urls, or the
  // browser downloads every first-screen photo twice.
  pass("the photo box is defined once, in a server-safe module", /export const MENU_CARD_IMG_W = 400/.test(imageUrl) && /export const MENU_CARD_IMG_H = 250/.test(imageUrl));
  pass("the first-screen count is shared too", /export const FIRST_SCREEN_PHOTOS = 8/.test(imageUrl));
  pass("image-url.ts is server-safe (no \"use client\")", !/^"use client"/m.test(imageUrl));
  pass("image-utils.ts re-exports it so existing callers are untouched", /from "@\/lib\/image-url"/.test(imageUtils) && /MENU_CARD_IMG_W/.test(imageUtils));
  pass("the grid imports the shared constants instead of redefining them", /FIRST_SCREEN_PHOTOS,\s*\} from "@\/lib\/image-utils"/.test(app) && !/const MENU_CARD_IMG_W =/.test(app));

  pass("/menu renders on the server and is never baked at build time", /export const dynamic = "force-dynamic"/.test(menuPage) && !/^"use client"/m.test(menuPage));
  pass("/menu emits high-priority image preloads for the first screen", /rel="preload"/.test(menuPage) && /as="image"/.test(menuPage) && /fetchPriority="high"/.test(menuPage));
  pass("the preload lookup uses the same order as /api/menu", /orderBy\(asc\(menuItems\.sortOrder\), asc\(menuItems\.id\)\)/.test(preview));
  pass("the preload lookup builds urls through optimizeImageUrl", /optimizeImageUrl\(row\.imageUrl, MENU_CARD_IMG_W, MENU_CARD_IMG_H\)/.test(preview));
  pass("a slow or unreachable database can never block the menu page", /PRELOAD_BUDGET_MS/.test(preview) && /catch \{\s*return \[\];/.test(preview));
  pass("the Suspense shell around the menu app is kept", /<Suspense/.test(menuPage) && /<CustomerMenuApp \/>/.test(menuPage));

  pass("the batch announces when the first screen has landed", /onReleased\?: \(\) => void/.test(reveal) && /if \(released\) onReleasedRef\.current\?\.\(\)/.test(reveal));
  pass("the below-the-fold warm-up waits for that signal", /useIdleImagePrefetch\(nextScreenPhotoUrls\)/.test(app) && /releasedFor === firstScreenSignature/.test(app));
  pass("the warm-up covers a few photos at LOW priority", /NEXT_SCREEN_PHOTOS = 4/.test(app) && /fetchpriority", "low"/.test(reveal));
  pass("the warm-up is skipped on Data Saver / 2G", /connection\?\.saveData/.test(reveal) && /effectiveType === "2g"/.test(reveal));
  pass("the warm-up runs while the browser is idle", /requestIdleCallback\(start/.test(reveal));
  pass("the warm-up removes its links again", /for \(const link of links\) link\.remove\(\);/.test(reveal));
}

// ── 4. Shimmer styling + reduced motion ─────────────────────────────────────
const css = read("src/app/globals.css");
{
  pass("globals.css defines .img-shimmer", /\.img-shimmer\s*\{/.test(css));
  pass("shimmer respects prefers-reduced-motion", /prefers-reduced-motion[\s\S]{0,120}\.img-shimmer\s*\{\s*animation: none/.test(css));
}

// ── 5. The endpoint keeps serving originals when asked ──────────────────────
const route = read("src/app/api/images/[id]/route.ts");
{
  pass("parameterless /api/images/{id} still serves the stored bytes", /payload = \{ body: buffer, type: row\.mime_type/.test(route) || /body: buffer, type: row\.mime_type/.test(route));
  pass("sizes are snapped through the allow-list", /snapImageWidth\(/.test(route) && /snapImageHeight\(/.test(route) && /snapImageQuality\(/.test(route));
  pass("a failed derivation falls back to the original", /if \(variant\)/.test(route));
  pass("photos remain immutably cacheable", /immutable/.test(route));
}
const utils = read("src/lib/image-utils.ts");
{
  pass("only /api/images refs are rewritten", /trimmed\.startsWith\("\/api\/images\/"\)/.test(imageUrl));
  pass("data: URLs are still returned untouched", /trimmed\.startsWith\("data:"\)/.test(imageUrl));
  pass("pexels optimisation is untouched", /images\.pexels\.com/.test(imageUrl));
  pass("optimizeImageUrl still comes out of image-utils", /optimizeImageUrl,\n\} from "@\/lib\/image-url"/.test(imageUtils) || /optimizeImageUrl/.test(imageUtils));
  pass("the browser-only uploader still lives in image-utils", /export function compressImage/.test(imageUtils));
}

// ── Report ──────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error("\n❌ IMAGE REVEAL REGRESSION TEST FAILED\n");
  for (const f of failures) console.error("  • " + f);
  process.exit(1);
}
console.log("\n✅ Image reveal regression test PASSED");
console.log("   • first-screen photos preload in one parallel high-priority batch");
console.log("   • the batch fades in together, with a timeout so it can never stall");
console.log("   • the customer QR menu is wired to it and nothing else changed");
console.log("   • /menu preloads the first screen server-side; the next screen warms at idle");
