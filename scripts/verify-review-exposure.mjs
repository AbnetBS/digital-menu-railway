#!/usr/bin/env node
/**
 * Regression test — "Public review exposure".
 *
 * Unapproved (pending-moderation) reviews must never be served to public
 * callers. Static source inspection verifies that the public reviews GET
 * filters to `isApproved === true` server-side, while the authenticated admin
 * path may see the full list.
 *
 * Run with: node scripts/verify-review-exposure.mjs  (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src", "app", "api", "reviews", "route.ts"), "utf8");

const failures = [];
function pass(name, cond) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures.push(name);
}

pass("reviews GET reads admin session", src.includes("readAdminSession"));
pass("public reviews filtered to approved (isApproved, true)", /eq\(reviews\.isApproved,\s*true\)/.test(src));
pass("admin moderation path preserves ?all=1", src.includes('get("all") === "1"'));

// POST validation: rating must be an integer 1..5, and name/text are bounded.
pass("POST validates rating is an integer 1-5", /Number\.isInteger\(rating\)/.test(src) && /rating\s*<\s*1/.test(src) && /rating\s*>\s*5/.test(src));
pass("POST bounds customerName length", /slice\(0,\s*100\)/.test(src));
pass("POST bounds reviewText length", /slice\(0,\s*2000\)/.test(src));

if (failures.length > 0) {
  console.error("\n❌ REVIEW EXPOSURE REGRESSION TEST FAILED\n");
  for (const f of failures) console.error("  • " + f);
  process.exit(1);
}
console.log("\n✅ Review exposure regression test PASSED");
console.log("   • public GET /api/reviews returns approved reviews only");
console.log("   • admin moderation still sees the full list");
