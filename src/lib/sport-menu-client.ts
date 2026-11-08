"use client";

import type { SportMenu } from "@/lib/sport-menu";

/**
 * THE SPORT MENU, from the waiter's side (owner, 2026-11-08).
 *
 * The owner corrected the first design: there is no "sport mode" the waiter
 * switches on, and no separate sport screen. On a match day the waiter taps
 * Sport and the NORMAL ordering screen opens, same cards, same categories, same
 * cart. The only difference is that some items already carry the event price the
 * ADMIN typed in his dashboard. Nobody but the admin edits a price.
 *
 * So a price on the waiter's screen is the EVENT price when the admin gave that
 * item one, and the ordinary menu price otherwise. There is nothing for the
 * waiter to choose, and nothing he can change.
 *
 * The server still decides the money: the ticket API re-reads the sport list and
 * stamps the event price on the lines itself (see applySportPrices in
 * /api/tickets), so a stale screen can never charge a price the admin did not
 * set.
 */

export type SportCatalogItem = {
  id: number;
  name: string;
  category: string;
  isAvailable: boolean;
  /** What the item costs on a normal day (sale price already applied). */
  regularPrice: number;
  /** The event price the admin typed, or null when he did not. */
  sportPrice: number | null;
  /** True when the admin added this item's category to the sport menu. */
  categoryAdded: boolean;
};

export type SportCatalogResponse = {
  menu: SportMenu | null;
  categories: Array<{ id: number; name: string; slug: string }>;
  items: SportCatalogItem[];
  /** True on the admin's device only: the editor is his, the waiter just reads. */
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

/** Is the event price list live? (the admin can switch it off after the match) */
export function sportPricesLive(catalog: SportCatalogResponse | null): boolean {
  return Boolean(catalog?.menu && catalog.menu.active !== false);
}

/**
 * menuItemId → event price, for the items the admin actually priced. Empty when
 * the list is switched off or no item was priced, which is exactly when the
 * waiter should see the ordinary menu.
 */
export function sportPriceMap(catalog: SportCatalogResponse | null): Map<number, number> {
  const map = new Map<number, number>();
  if (!sportPricesLive(catalog)) return map;
  for (const price of catalog!.menu!.prices) {
    if (catalog!.menu!.categories.includes(price.category)) map.set(price.menuItemId, price.sportPrice);
  }
  return map;
}

/**
 * The price a waiter must charge for one item:
 *   • the admin gave this item an event price and the list is live -> that price
 *   • everything else                                              -> the menu price
 *
 * `eventPrices` is false on the ordinary menu screen before the waiter taps
 * Sport, so nothing changes on a normal day.
 */
export function chargePrice(
  item: { id: number },
  regularPrice: number,
  eventPrices: boolean,
  catalog: SportCatalogResponse | null
): number {
  if (!eventPrices) return regularPrice;
  const typed = sportPriceMap(catalog).get(item.id);
  return typed !== undefined ? typed : regularPrice;
}

/** True when this item's category was added by the admin (for the ⚡ mark). */
export function isSportCategory(catalog: SportCatalogResponse | null, slug: string): boolean {
  return Boolean(catalog?.menu && catalog.menu.categories.includes(slug));
}

/** How many items carry an event price, for the waiter's screen header. */
export function sportPricedCount(catalog: SportCatalogResponse | null): number {
  if (!catalog?.menu) return 0;
  return catalog.menu.prices.filter((price) => catalog.menu!.categories.includes(price.category)).length;
}

/** Which items carry an event price (id → price), for the ⚡ marks on the cards. */
export function eventPriceByItem(catalog: SportCatalogResponse | null): Map<number, number> {
  return sportPriceMap(catalog);
}
