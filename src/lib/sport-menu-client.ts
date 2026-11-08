"use client";

import type { SportMenu } from "@/lib/sport-menu";

/**
 * The waiter's and the owner's side of the Sport menu: one fetch of
 * GET /api/sport-menu and one price map the ordering screens can ask.
 *
 * The price the waiter shows is only a DISPLAY value. The ticket API re-reads
 * the sport row when the order is saved, so a stale screen (or a phone whose
 * clock/price cache is wrong) can never decide what a guest pays.
 */

export type SportCatalogItem = {
  id: number;
  name: string;
  category: string;
  isAvailable: boolean;
  /** What the item costs on a normal day (sale price already applied). */
  regularPrice: number;
  /** The match-day price the owner typed, or null when he did not. */
  sportPrice: number | null;
  /** True when the owner added this item's category to the sport menu. */
  categoryAdded: boolean;
};

export type SportCatalogResponse = {
  menu: SportMenu | null;
  categories: Array<{ id: number; name: string; slug: string }>;
  items: SportCatalogItem[];
  /** True on the owner's device only: the editor is his, the waiter just reads. */
  canEdit?: boolean;
  serverTime?: string;
};

/** Read the sport menu + the whole catalogue with both prices, or null. */
export async function fetchSportCatalog(scope: "waiter" | "admin" = "waiter"): Promise<SportCatalogResponse | null> {
  try {
    const response = await fetch(`/api/sport-menu${scope === "admin" ? "?scope=admin" : ""}`, { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as SportCatalogResponse;
  } catch {
    return null;
  }
}

/** menuItemId → match-day price, for the items the owner actually priced. */
export function sportPriceMap(catalog: SportCatalogResponse | null): Map<number, number> {
  const map = new Map<number, number>();
  if (!catalog?.menu || catalog.menu.active === false) return map;
  for (const price of catalog.menu.prices) {
    if (catalog.menu.categories.includes(price.category)) map.set(price.menuItemId, price.sportPrice);
  }
  return map;
}

/**
 * The price a waiter must charge for one item:
 *   • sport mode ON and the item has a match-day price  → the match-day price
 *   • sport mode ON and the item's category was added   → the normal price
 *   • sport mode OFF (or the category was never added)  → the normal price
 */
export function chargePrice(item: { id: number; category: string }, regularPrice: number, sportMode: boolean, catalog: SportCatalogResponse | null): number {
  if (!sportMode || !catalog?.menu || catalog.menu.active === false) return regularPrice;
  const typed = sportPriceMap(catalog).get(item.id);
  if (typed !== undefined) return typed;
  return regularPrice;
}

/** True when this item's category was added by the owner (so it shows a sport badge). */
export function isSportCategory(catalog: SportCatalogResponse | null, slug: string): boolean {
  return Boolean(catalog?.menu && catalog.menu.categories.includes(slug));
}

/** How many priced items, for the waiter's chip label ("Sport menu · 12"). */
export function sportPricedCount(catalog: SportCatalogResponse | null): number {
  if (!catalog?.menu) return 0;
  return catalog.menu.prices.filter((price) => catalog.menu!.categories.includes(price.category)).length;
}
