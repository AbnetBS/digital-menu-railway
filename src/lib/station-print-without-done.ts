/**
 * Admin switch: may the cashier's ✓ PRINTED go out while a crew has NOT tapped
 * Done on its lines? (owner's request, Oct 2026)
 *
 * Per crew (Barista, Kitchen, Juice), stored as one site_settings JSON value:
 *
 *   OFF (the default) → the rule stays as it was: the crew must tap Done on
 *                       every line before the cashier can tap ✓ PRINTED.
 *   ON                → the cashier can print even if that crew never tapped
 *                       Done. The print then finishes that crew's open lines
 *                       (stamped "cashier print", so the admin report still
 *                       shows the crew did not click Done).
 *
 * Buna is not part of this switch: its lane is read-only and the receipt has
 * always cleared it. Stored as one JSON value (no schema migration needed).
 *
 * PURE: no database, no Next.js, no React. The tickets API reads the setting,
 * the admin screen writes it, and the regression test checks both sides.
 */
import type { StationName } from "@/lib/stations";

export const PRINT_WITHOUT_DONE_KEY = "station_print_without_done";

/** The crews the admin can switch. Same three crews as the sales visibility. */
export const PRINT_WITHOUT_DONE_STATIONS = ["barista", "kitchen", "juice"] as const;
export type PrintWithoutDoneStation = (typeof PRINT_WITHOUT_DONE_STATIONS)[number];
export type PrintWithoutDoneSettings = Record<PrintWithoutDoneStation, boolean>;

/** OFF for every crew: the stations must tap Done before the cashier can print. */
export const DEFAULT_PRINT_WITHOUT_DONE: PrintWithoutDoneSettings = {
  barista: false,
  kitchen: false,
  juice: false,
};

/**
 * Parse the stored value. Missing, malformed or non-boolean entries fall back
 * to OFF, so an unreadable setting can never open the print gate by accident.
 */
export function parsePrintWithoutDone(value: unknown): PrintWithoutDoneSettings {
  let raw: unknown = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_PRINT_WITHOUT_DONE };
    }
  }

  const result = { ...DEFAULT_PRINT_WITHOUT_DONE };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  const source = raw as Record<string, unknown>;
  for (const station of PRINT_WITHOUT_DONE_STATIONS) {
    if (typeof source[station] === "boolean") result[station] = source[station] as boolean;
  }
  return result;
}

/**
 * The crews whose UNFINISHED lines the cashier's print may skip (the switch is
 * ON). Buna is never in this set; it is handled separately by the print.
 */
export function crewsPrintMaySkip(value: unknown): Set<StationName> {
  const settings = parsePrintWithoutDone(value);
  const crews = new Set<StationName>();
  for (const station of PRINT_WITHOUT_DONE_STATIONS) {
    if (settings[station]) crews.add(station);
  }
  return crews;
}
