import type { DailyPromotion, DailyPromotionItem, DailyPromotionType } from "@/types";

const PROMOTION_TYPES: readonly DailyPromotionType[] = [
  "special_price",
  "percentage_discount",
  "fixed_amount_discount",
  "buy_x_get_y",
  "buy_x_get_y_discounted",
  "combo",
];
const MAX_PRICE = 1_000_000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface PromotionLinePrice {
  menuItemId: number;
  quantity: number;
  regularUnitPrice: number;
  regularTotal: number;
  /** One authoritative integer ETB amount per unit, preserving exact combo totals. */
  unitPrices: number[];
  total: number;
  isFree: boolean;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Promotion details are invalid");
  }
}

function normalizeItems(value: unknown, allowLegacyFreeFlag = false): DailyPromotionItem[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Choose at least one menu item");

  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Promotion item ${index + 1} is invalid`);
    const row = item as Record<string, unknown>;
    const menuItemId = Number(row.menuItemId);
    const quantity = Number(row.quantity);
    if (!Number.isInteger(menuItemId) || menuItemId < 1) throw new Error(`Promotion item ${index + 1} needs a menu item`);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new Error(`Promotion item ${index + 1} has an invalid quantity`);

    let role: "buy" | "get" | undefined;
    if (row.role === "buy" || row.role === "get") role = row.role;
    // The first version stored `isFree`; preserve those saved Buy X Get Y cards.
    else if (allowLegacyFreeFlag) role = row.isFree === true ? "get" : "buy";
    return { menuItemId, quantity, ...(role ? { role } : {}) };
  });
}

function validPrice(value: unknown, label: string): number {
  const price = Number(value);
  if (!Number.isInteger(price) || price < 0 || price > MAX_PRICE) throw new Error(`${label} must be a whole ETB amount`);
  return price;
}

function validPercent(value: unknown, label: string): number {
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error(`${label} must be between 0 and 100`);
  return percent;
}

function validTime(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const time = String(value);
  if (!TIME_RE.test(time)) throw new Error(`${label} must use HH:MM`);
  return time;
}

/**
 * Normalize the JSON configuration held in the existing announcements
 * `promotion_items` column. An array is the previous orderable-special format
 * and is intentionally interpreted as a Buy X Get Y promotion for backwards
 * compatibility.
 */
export function normalizeDailyPromotion(value: unknown): DailyPromotion | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = parseJson(value);

  if (Array.isArray(parsed)) {
    return {
      type: "buy_x_get_y",
      items: normalizeItems(parsed, true),
      isActive: true,
    };
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Promotion details are invalid");

  const row = parsed as Record<string, unknown>;
  if (!PROMOTION_TYPES.includes(row.type as DailyPromotionType)) throw new Error("Choose a promotion type");
  const type = row.type as DailyPromotionType;
  const items = normalizeItems(row.items);
  const startTime = validTime(row.startTime, "Start time");
  const endTime = validTime(row.endTime, "End time");

  if (
    (type === "special_price" || type === "percentage_discount" || type === "fixed_amount_discount") &&
    items.length !== 1
  ) {
    throw new Error("This promotion type needs exactly one menu item");
  }
  if ((type === "buy_x_get_y" || type === "buy_x_get_y_discounted") && (!items.some((item) => item.role === "buy") || !items.some((item) => item.role === "get"))) {
    throw new Error("Buy X Get Y promotions need both Buy and Get items");
  }

  const promotion: DailyPromotion = {
    type,
    items,
    isActive: row.isActive !== false,
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {}),
  };
  if (type === "special_price" || type === "combo") promotion.specialPrice = validPrice(row.specialPrice, type === "combo" ? "Combo price" : "Special price");
  if (type === "percentage_discount") promotion.discountPercent = validPercent(row.discountPercent, "Discount");
  if (type === "fixed_amount_discount") promotion.discountAmount = validPrice(row.discountAmount, "Discount");
  if (type === "buy_x_get_y_discounted") promotion.getDiscountPercent = validPercent(row.getDiscountPercent, "Get-item discount");
  return promotion;
}

/** Read stored promotion JSON without ever making malformed legacy data orderable. */
export function parseDailyPromotion(value: unknown): DailyPromotion | null {
  try {
    return normalizeDailyPromotion(value);
  } catch {
    return null;
  }
}

/** Serialize a validated promotion into the existing `promotion_items` column. */
export function serializeDailyPromotion(value: unknown): string | null {
  const promotion = normalizeDailyPromotion(value);
  return promotion ? JSON.stringify(promotion) : null;
}

/** Uses the application's existing ISO date handling for orderability windows. */
export function isDailyPromotionOrderable(
  promotion: DailyPromotion,
  schedule: { startDate?: string | null; endDate?: string | null },
  now = new Date()
): boolean {
  if (!promotion.isActive) return false;
  const today = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 16);
  if (schedule.startDate && today < String(schedule.startDate)) return false;
  if (schedule.endDate && today > String(schedule.endDate)) return false;
  if ((!schedule.startDate || today === String(schedule.startDate)) && promotion.startTime && time < promotion.startTime) return false;
  if ((!schedule.endDate || today === String(schedule.endDate)) && promotion.endTime && time > promotion.endTime) return false;
  return true;
}

/**
 * Calculate promotion prices from an authoritative menu-price lookup. Prices
 * are whole ETB amounts, matching the existing menu_items/ticket_items schema.
 */
export function calculateDailyPromotionLinePrices(
  promotion: DailyPromotion,
  priceForMenuItem: (menuItemId: number) => number
): PromotionLinePrice[] {
  const regularPrices = promotion.items.map((item) => {
    const price = priceForMenuItem(item.menuItemId);
    if (!Number.isInteger(price) || price < 0) throw new Error("Promotion menu item no longer exists");
    return price;
  });

  if (promotion.type === "combo") {
    const regularTotal = promotion.items.reduce((sum, item, index) => sum + regularPrices[index] * item.quantity, 0);
    const bundlePrice = promotion.specialPrice ?? 0;
    let allocated = 0;
    let unitsRemaining = promotion.items.reduce((sum, item) => sum + item.quantity, 0);
    return promotion.items.map((item, index) => {
      const unitPrices: number[] = [];
      for (let unit = 0; unit < item.quantity; unit++) {
        unitsRemaining -= 1;
        // Allocate proportionally and give the final unit the remainder so the
        // persisted ticket line prices always add up to the exact combo price.
        const unitPrice = unitsRemaining === 0
          ? bundlePrice - allocated
          : regularTotal > 0 ? Math.floor((bundlePrice * regularPrices[index]) / regularTotal) : 0;
        allocated += unitPrice;
        unitPrices.push(unitPrice);
      }
      const total = unitPrices.reduce((sum, price) => sum + price, 0);
      return { menuItemId: item.menuItemId, quantity: item.quantity, regularUnitPrice: regularPrices[index], regularTotal: regularPrices[index] * item.quantity, unitPrices, total, isFree: total === 0 };
    });
  }

  return promotion.items.map((item, index) => {
    const regularUnitPrice = regularPrices[index];
    let unitPrice = regularUnitPrice;
    if (promotion.type === "special_price") unitPrice = promotion.specialPrice ?? regularUnitPrice;
    if (promotion.type === "percentage_discount") unitPrice = Math.round(regularUnitPrice * (100 - (promotion.discountPercent ?? 0)) / 100);
    if (promotion.type === "fixed_amount_discount") unitPrice = Math.max(0, regularUnitPrice - (promotion.discountAmount ?? 0));
    if (promotion.type === "buy_x_get_y" && item.role === "get") unitPrice = 0;
    if (promotion.type === "buy_x_get_y_discounted" && item.role === "get") unitPrice = Math.round(regularUnitPrice * (100 - (promotion.getDiscountPercent ?? 0)) / 100);
    const unitPrices = Array.from({ length: item.quantity }, () => unitPrice);
    return { menuItemId: item.menuItemId, quantity: item.quantity, regularUnitPrice, regularTotal: regularUnitPrice * item.quantity, unitPrices, total: unitPrice * item.quantity, isFree: unitPrice === 0 };
  });
}

export function dailyPromotionLabel(promotion: DailyPromotion): string {
  switch (promotion.type) {
    case "special_price": return "Special price";
    case "percentage_discount": return `${promotion.discountPercent}% OFF`;
    case "fixed_amount_discount": return `${promotion.discountAmount} ETB OFF`;
    case "buy_x_get_y": return "Buy X Get Y";
    case "buy_x_get_y_discounted": return `Get item ${promotion.getDiscountPercent}% OFF`;
    case "combo": return "Combo special";
  }
}
