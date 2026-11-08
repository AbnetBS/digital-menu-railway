/**
 * THE SPORT MENU (owner, 2026-11-07)
 *
 * Match days: "the price of cold drink, hot drink and pastry got increased".
 * The owner's own plan, in his words: "the easiest way to add this is to use
 * that group button, rename the groups to sport, then when they click it there
 * will be increased price and they will click and send it like normal order".
 *
 * So this is a SECOND MENU that exists only for the waiter's orders. It is
 * built by adding whole categories (Hot Drinks, Cold Drinks, Pastry, ...) and
 * then typing the match-day price against each item. The ordinary customer
 * menu, the QR page and the cashier screens never see it: a guest who scans the
 * table code keeps reading the normal price all night.
 *
 * WHAT IS NOT ADDED stays exactly the normal menu. The sport view lists every
 * category; a category that was not added keeps its ordinary name and its
 * ordinary price. Adding a category does not change its name, so "Hot Drinks"
 * stays "Hot Drinks" with a sport badge and a higher number.
 *
 * THE PRICE IS THE SERVER'S DECISION, never the phone's. A waiter screen holds
 * a cart with numbers in it, and a stale screen or a tampered request must not
 * be able to invent a price. So the ticket API re-reads the sport menu itself
 * and rewrites the unit price of every sport line (see applySportPrices in
 * src/app/api/tickets/route.ts). The cart only carries WHICH sport menu and
 * WHICH item, plus the number to show the waiter.
 */

export const SPORT_MENU_NAME = "Sport";

/** One typed match-day price. */
export type SportPrice = {
  menuItemId: number;
  /** What the item costs on a normal day, copied when the row is created. */
  regularPrice: number;
  /** What it costs today, typed by the owner. */
  sportPrice: number;
  /** The category slug the item belongs to, so a category can be removed whole. */
  category: string;
};

export type SportMenu = {
  id: number;
  name: string;
  /** The categories the owner added, in the order he added them. */
  categories: string[];
  prices: SportPrice[];
  /** True while the match-day prices are the ones the waiters are given. */
  active: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

/** The row shape the database returns (snake_case), for both drivers. */
export type SportMenuRow = {
  id: number;
  name?: string | null;
  active?: boolean | null;
  categories?: unknown;
  prices?: unknown;
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
};

/** A category slug list out of jsonb, cleaned and de-duplicated. */
export function parseSportCategories(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? safeJson(value) : [];
  const out: string[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const slug = String(entry ?? "").trim();
    if (slug && !out.includes(slug)) out.push(slug);
  }
  return out;
}

/** A price list out of jsonb, with every number made safe. */
export function parseSportPrices(value: unknown): SportPrice[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? safeJson(value) : [];
  const out: SportPrice[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const menuItemId = Number(row.menuItemId);
    const sportPrice = Number(row.sportPrice);
    if (!Number.isInteger(menuItemId) || menuItemId < 1) continue;
    if (!Number.isFinite(sportPrice) || sportPrice < 0) continue;
    out.push({
      menuItemId,
      regularPrice: Math.max(0, Math.round(Number(row.regularPrice) || 0)),
      sportPrice: Math.round(sportPrice),
      category: String(row.category ?? ""),
    });
  }
  // One price per item: the last save wins, which is what the owner expects
  // when he retypes a number in the same row.
  const byItem = new Map<number, SportPrice>();
  for (const price of out) byItem.set(price.menuItemId, price);
  return [...byItem.values()];
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

/** The database row as the app's SportMenu. */
export function sportMenuFromRow(row: SportMenuRow): SportMenu {
  return {
    id: Number(row.id),
    name: String(row.name || SPORT_MENU_NAME),
    categories: parseSportCategories(row.categories),
    prices: parseSportPrices(row.prices),
    active: row.active !== false,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

/**
 * The price a waiter must charge for one item in one sport menu.
 *   - the item has a typed sport price    -> that price
 *   - it has none but its category is in  -> the normal price (nothing invented)
 *   - anything else                       -> null (the item is not on the sport
 *                                            menu at all, so the caller keeps
 *                                            the ordinary price)
 * A disabled menu answers null for everything, so switching it off restores the
 * normal prices instantly without deleting the owner's work.
 */
export function sportPriceFor(menu: SportMenu | null | undefined, menuItemId: number, regularPrice: number): number | null {
  if (!menu || !menu.active) return null;
  const typed = menu.prices.find((price) => price.menuItemId === menuItemId);
  return typed ? typed.sportPrice : Math.max(0, Math.round(Number(regularPrice) || 0));
}

/**
 * Which categories the sport view shows, and whether each one has sport prices.
 * A category the owner never added is listed with `added: false`, so the waiter
 * sees the whole menu on a match day exactly as he sees it every other day.
 */
export type SportCategoryView = {
  slug: string;
  name: string;
  added: boolean;
  /** How many of the category's items already have a typed sport price. */
  pricedItems: number;
  totalItems: number;
};

export function sportCategoryViews(
  catalog: Array<{ slug: string; name: string }>,
  items: Array<{ id: number; category: string }>,
  menu: SportMenu | null | undefined
): SportCategoryView[] {
  const added = new Set(menu?.categories || []);
  const priced = new Set((menu?.prices || []).map((price) => price.menuItemId));
  const byCategory = new Map<string, Array<{ id: number; category: string }>>();
  for (const item of items) {
    const list = byCategory.get(item.category) || [];
    list.push(item);
    byCategory.set(item.category, list);
  }
  const views: SportCategoryView[] = catalog
    .filter((category) => (byCategory.get(category.slug) || []).length > 0)
    .map((category) => {
      const list = byCategory.get(category.slug) || [];
      return {
        slug: category.slug,
        name: category.name,
        added: added.has(category.slug),
        pricedItems: list.filter((item) => priced.has(item.id)).length,
        totalItems: list.length,
      };
    });
  // A price whose category vanished from the catalogue still has to be counted,
  // so nothing the owner typed disappears without a word.
  for (const slug of added) {
    if (views.some((view) => view.slug === slug)) continue;
    views.push({ slug, name: slug, added: true, pricedItems: 0, totalItems: 0 });
  }
  return views;
}

/** "Hot Drinks" out of a catalog entry, for error messages and the sheet. */
export function sportCategoryName(catalog: Array<{ slug: string; name: string }>, slug: string): string {
  return catalog.find((category) => category.slug === slug)?.name || slug;
}
