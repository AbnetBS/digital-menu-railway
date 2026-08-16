#!/usr/bin/env node
/**
 * Regression test — "Order price/quantity integrity".
 *
 * The public customer order endpoint must NOT trust client-supplied prices or
 * quantities. Static source inspection verifies that:
 *   1. The order route resolves the authoritative unit price from the menu
 *      (menuItems + effectivePrice) server-side.
 *   2. Quantities are validated (reject < 1 and > cap).
 *   3. Unknown/missing menu items are rejected.
 *
 * Run with: node scripts/verify-order-integrity.mjs  (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src", "app", "api", "tickets", "route.ts"), "utf8");
const itemsSrc = readFileSync(join(root, "src", "app", "api", "tickets", "items", "route.ts"), "utf8");

const failures = [];
function pass(name, cond) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures.push(name);
}

pass("order route imports menuItems", /import\s*\{[^}]*menuItems[^}]*\}\s*from\s*"@\/db\/schema"/.test(src));
pass("order route uses effectivePrice for authoritative price", src.includes("effectivePrice"));
pass("order route builds price map from menu rows", src.includes("priceById"));
pass("order route rejects quantity < 1", /qty\s*<\s*1/.test(src));
pass("order route caps quantity (<= 100)", /qty\s*>\s*100/.test(src));
pass("order route rejects non-integer quantity", /Number\.isInteger\(qty\)/.test(src));
pass("order route rejects unknown menu item", /Unknown menu item/.test(src));
pass("order route overwrites client price with resolved price", /it\.price\s*=\s*priceById\.get/.test(src));

// Item-edit route (staff adjusting quantity after order) must validate too.
pass("item-edit route validates quantity is integer 1-100", /Number\.isInteger\(qty\)/.test(itemsSrc) && /qty\s*<\s*1/.test(itemsSrc) && /qty\s*>\s*100/.test(itemsSrc));
pass("item-edit route bounds notes length", /slice\(0,\s*500\)/.test(itemsSrc));

if (failures.length > 0) {
  console.error("\n❌ ORDER INTEGRITY REGRESSION TEST FAILED\n");
  for (const f of failures) console.error("  • " + f);
  process.exit(1);
}
console.log("\n✅ Order integrity regression test PASSED");
console.log("   • prices resolved server-side from the menu");
console.log("   • quantities validated and bounded");
console.log("   • unknown menu items rejected");
