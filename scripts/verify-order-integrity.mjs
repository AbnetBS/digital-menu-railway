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
const promotionSrc = readFileSync(join(root, "src", "lib", "daily-promotion.ts"), "utf8");

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
pass("daily promotion is re-read from announcements server-side", /import\s*\{[^}]*announcements[^}]*\}\s*from\s*"@\/db\/schema"/.test(src) && src.includes("parseDailyPromotion"));
pass("daily promotion must still be active and exactly match configured items", src.includes("isDailyPromotionOrderable") && src.includes("configuredItem.menuItemId") && src.includes("configuredItem.quantity"));
pass("promotion prices are calculated from trusted server configuration", src.includes("calculateDailyPromotionLinePrices") && src.includes("promotionLine.unitPrices"));
pass("daily promotion items retain normal out-of-stock protection", src.includes("if (!menuRow.isAvailable)"));
pass("promotion helper supports all configured promotion types", ["special_price", "percentage_discount", "fixed_amount_discount", "buy_x_get_y", "buy_x_get_y_discounted", "combo"].every((type) => promotionSrc.includes(`\"${type}\"`)));
pass("promotion helper retains legacy orderable-special arrays", promotionSrc.includes("Array.isArray(parsed)") && promotionSrc.includes("allowLegacyFreeFlag"));
pass("promotion helper guards inactive and time-windowed offers", promotionSrc.includes("!promotion.isActive") && promotionSrc.includes("promotion.startTime") && promotionSrc.includes("promotion.endTime"));
pass("combo allocation preserves the configured exact bundle total", promotionSrc.includes("bundlePrice - allocated"));

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
console.log("   • daily-promotion items, availability, and prices are resolved server-side");
