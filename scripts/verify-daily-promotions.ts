#!/usr/bin/env tsx
/**
 * Pure promotion pricing/scheduling regression coverage. The ticket route
 * independently calls these helpers with DB-derived menu prices.
 */
import { calculateDailyPromotionLinePrices, isDailyPromotionOrderable, normalizeDailyPromotion } from "../src/lib/daily-promotion";

const prices = new Map([[1, 1034], [2, 100], [3, 50], [4, 400], [5, 200], [6, 100]]);
const priceFor = (menuItemId: number) => prices.get(menuItemId) ?? -1;
const total = (rows: ReturnType<typeof calculateDailyPromotionLinePrices>) => rows.reduce((sum, row) => sum + row.total, 0);

function assert(name: string, condition: boolean) {
  console.log(`${condition ? "✅" : "❌"} ${name}`);
  if (!condition) throw new Error(`Failed: ${name}`);
}

function promotion(value: unknown) {
  const parsed = normalizeDailyPromotion(value);
  if (!parsed) throw new Error("Expected promotion configuration");
  return parsed;
}

const cases: Array<[string, unknown, number]> = [
  ["special price", { type: "special_price", items: [{ menuItemId: 1, quantity: 1 }], isActive: true, specialPrice: 800 }, 800],
  ["percentage discount", { type: "percentage_discount", items: [{ menuItemId: 1, quantity: 1 }], isActive: true, discountPercent: 20 }, 827],
  ["fixed amount discount", { type: "fixed_amount_discount", items: [{ menuItemId: 1, quantity: 1 }], isActive: true, discountAmount: 100 }, 934],
  ["fixed discount never goes negative", { type: "fixed_amount_discount", items: [{ menuItemId: 3, quantity: 1 }], isActive: true, discountAmount: 100 }, 0],
  ["buy X get Y free", { type: "buy_x_get_y", items: [{ menuItemId: 2, quantity: 2, role: "buy" }, { menuItemId: 3, quantity: 1, role: "get" }], isActive: true }, 200],
  ["buy X get Y discounted", { type: "buy_x_get_y_discounted", items: [{ menuItemId: 2, quantity: 2, role: "buy" }, { menuItemId: 3, quantity: 1, role: "get" }], isActive: true, getDiscountPercent: 50 }, 225],
  ["combo bundle", { type: "combo", items: [{ menuItemId: 4, quantity: 1 }, { menuItemId: 5, quantity: 1 }, { menuItemId: 6, quantity: 1 }], isActive: true, specialPrice: 500 }, 500],
];

for (const [name, config, expected] of cases) {
  assert(name, total(calculateDailyPromotionLinePrices(promotion(config), priceFor)) === expected);
}

const buyGetFree = calculateDailyPromotionLinePrices(promotion(cases[4][1]), priceFor);
assert("configured free item is exactly zero", buyGetFree[1].isFree && buyGetFree[1].total === 0);

const legacy = normalizeDailyPromotion([
  { menuItemId: 2, quantity: 2, isFree: false },
  { menuItemId: 3, quantity: 1, isFree: true },
]);
assert("previous orderable-special array remains compatible", Boolean(legacy) && total(calculateDailyPromotionLinePrices(legacy!, priceFor)) === 200);

const inactive = promotion({ type: "special_price", items: [{ menuItemId: 1, quantity: 1 }], isActive: false, specialPrice: 800 });
assert("inactive promotion is not orderable", !isDailyPromotionOrderable(inactive, {}, new Date("2026-08-30T18:00:00.000Z")));

const timed = promotion({ type: "special_price", items: [{ menuItemId: 1, quantity: 1 }], isActive: true, startTime: "17:00", endTime: "20:00", specialPrice: 800 });
const schedule = { startDate: "2026-08-30", endDate: "2026-08-30" };
assert("future time window is not orderable", !isDailyPromotionOrderable(timed, schedule, new Date("2026-08-30T16:59:00.000Z")));
assert("active time window is orderable", isDailyPromotionOrderable(timed, schedule, new Date("2026-08-30T18:00:00.000Z")));
assert("expired time window is not orderable", !isDailyPromotionOrderable(timed, schedule, new Date("2026-08-30T20:01:00.000Z")));

console.log("\n✅ Daily promotion pricing and scheduling regression test PASSED");
