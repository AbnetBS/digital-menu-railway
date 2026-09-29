/**
 * THE STATION VOCABULARY — one file, so the four crews can never drift apart.
 *
 * A "station" is a crew that physically makes something:
 *
 *   kitchen  → foods, pastries, meals & snacks          (/kitchen)
 *   barista  → machine coffee & cold drinks              (/barista)
 *   buna     → TRADITIONAL coffee (jebena buna), made at the buna makers'
 *              own place, indoors and outdoors           (/buna)
 *   juice    → fresh juices, spris & punches             (/juice)
 *
 * `buna` was added (owner's decision, Sept 2026) because the traditional
 * coffee is made by its own two people, who ALSO take orders like waiters when
 * the room is full. They are not the barista: their phone must ring only for
 * their own buna lines, never for machine coffee or kitchen work.
 *
 * `juice` was added (owner's decision, Sept 2026) the same way: the juice
 * maker got their own tablet and their own lane, so fresh juices leave the
 * barista's lane exactly like the traditional buna did before them.
 *
 * WHICH ITEM GOES WHERE: a menu item flagged "Traditional buna" (menu_items.
 * is_buna) always goes to the BUNA station, whatever category it sits in —
 * the flag is per item, so "Jebena Buna" can live inside the Coffee category
 * next to the macchiato. Everything else follows the owner's category routing
 * (barista | kitchen | juice) from the Stations tab, or its own per-item
 * station override when the owner pointed that one item at a specific crew.
 *
 * This module is deliberately PURE: no database, no Next.js, no React. It is
 * imported by the alert matrix and by the regression tests.
 */

import { DEFAULT_CATEGORY_ROUTING } from "@/lib/initial-data";

export type StationName = "kitchen" | "barista" | "buna" | "juice";

/** The three crews a whole CATEGORY can be routed to (buna is per item). */
export type RoutedStation = "barista" | "kitchen" | "juice";

export function isRoutedStation(value: unknown): value is RoutedStation {
  return value === "barista" || value === "kitchen" || value === "juice";
}

/**
 * MERGE THE OWNER'S SAVED ROUTING OVER THE BUILT-IN DEFAULTS — NEVER REPLACE
 * THEM (the juice bug, 29 Sept 2026).
 *
 * The order path used to do `routing = JSON.parse(saved)`, so a saved map that
 * simply did not mention a category sent that category to the KITCHEN fallback.
 * The fresh juices were exactly that case: an older save (from before the
 * juice lane existed, or keyed with the category's stored capitalisation) had
 * no "juices" key, so every juice was routed to the kitchen — the juice maker's
 * screen showed nothing and its "Items sold" figure could only ever read 0.
 *
 * The merge also normalises every saved key (trim + lowercase) because the
 * order path lowercases the category slug before looking it up. A junk value
 * ("buna" on a category, a number, null) is ignored, never routed: the category
 * keeps the default crew, exactly like the Stations tab shows.
 */
export function mergeCategoryRouting(saved: unknown): Record<string, RoutedStation> {
  const merged: Record<string, RoutedStation> = { ...DEFAULT_CATEGORY_ROUTING };
  if (!saved || typeof saved !== "object") return merged;
  for (const [key, value] of Object.entries(saved as Record<string, unknown>)) {
    const slug = String(key || "").trim().toLowerCase();
    if (!slug || !isRoutedStation(value)) continue;
    merged[slug] = value;
  }
  return merged;
}

/** Every crew that can receive work — the order they are listed in. */
export const STATION_NAMES: StationName[] = ["kitchen", "barista", "buna", "juice"];

/**
 * Every role a login account can hold: the two floor roles, the four making
 * crews, and the owner. Kept here so the API validation and the admin dropdown
 * can never drift apart when a crew is added.
 */
export const STAFF_ROLES: string[] = ["waiter", "cashier", ...STATION_NAMES, "admin"];

export const STATION_LABELS: Record<StationName, string> = {
  kitchen: "Kitchen (Chef)",
  barista: "Barista",
  buna: "Buna Maker",
  juice: "Juice Maker",
};

/** Short label used inside alert bodies ("for the Buna Maker"). */
export const STATION_SHORT: Record<StationName, string> = {
  kitchen: "kitchen",
  barista: "barista",
  buna: "buna station",
  juice: "juice station",
};

/** True when `value` names one of the four crews. */
export function isStationName(value: unknown): value is StationName {
  return value === "kitchen" || value === "barista" || value === "buna" || value === "juice";
}

/**
 * Normalise a stored `station_name` value. Legacy rows and anything unknown
 * fall back to the KITCHEN, exactly like the old code did — an item must never
 * end up belonging to no crew, or nobody would ever press Done on it.
 */
export function stationOf(value: string | null | undefined): StationName {
  return isStationName(value) ? value : "kitchen";
}

/**
 * Which station does an ordered item belong to?
 *
 * Priority (the owner's explicit choices always beat the category default):
 *   1. the per-item traditional-buna flag (menu_items.is_buna)
 *   2. the per-item station override (menu_items.station_override) — for
 *      mixed-crew categories like "Extra Things", where a coffee cup is the
 *      barista's and a take away bag is the kitchen's
 *   3. the owner's category routing (barista | kitchen | juice), defaulting
 *      to kitchen
 */
export function stationForOrder(
  categoryRouting: Record<string, "barista" | "kitchen" | "juice">,
  categorySlug: string,
  isBunaItem: boolean,
  stationOverride?: string | null
): StationName {
  if (isBunaItem) return "buna";
  if (isStationName(stationOverride)) return stationOverride;
  const routed = categoryRouting[categorySlug];
  return isStationName(routed) ? routed : "kitchen";
}
