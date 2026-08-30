import type { DailyPromotionItem } from "@/types";

/**
 * Validate and normalize the orderable part of a Daily Board announcement.
 * The database stores this compactly as JSON because a promotion belongs to one
 * announcement and consists only of references to existing menu items.
 */
export function normalizeDailyPromotionItems(value: unknown): DailyPromotionItem[] {
  if (value === null || value === undefined || value === "") return [];

  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("Promotion items must be valid JSON");
    }
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Promotion items must be a list");
  }

  return parsed.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Promotion item ${index + 1} is invalid`);
    }

    const row = item as Record<string, unknown>;
    const menuItemId = Number(row.menuItemId);
    const quantity = Number(row.quantity);
    if (!Number.isInteger(menuItemId) || menuItemId < 1) {
      throw new Error(`Promotion item ${index + 1} needs a menu item`);
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      throw new Error(`Promotion item ${index + 1} has an invalid quantity`);
    }

    return { menuItemId, quantity, isFree: row.isFree === true };
  });
}

/** Safely read stored promotion JSON for public display and order validation. */
export function parseDailyPromotionItems(value: unknown): DailyPromotionItem[] {
  try {
    return normalizeDailyPromotionItems(value);
  } catch {
    // A malformed legacy row must never become orderable.
    return [];
  }
}

/** Convert a validated promotion into its database representation. */
export function serializeDailyPromotionItems(value: unknown): string | null {
  const items = normalizeDailyPromotionItems(value);
  return items.length > 0 ? JSON.stringify(items) : null;
}
