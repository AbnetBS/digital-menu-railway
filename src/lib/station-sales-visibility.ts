/**
 * Admin-controlled visibility for the station sales panel.
 *
 * Sales are visible by default to preserve the existing station screens. The
 * owner can independently hide the sales tile and API data for Barista,
 * Kitchen, or Juice without changing the station's order queue or admin
 * reports. Stored as one site_settings JSON value (no schema migration needed).
 */
export const STATION_SALES_VISIBILITY_KEY = "station_sales_visibility";

export const STATION_SALES_STATIONS = ["barista", "kitchen", "juice"] as const;
export type StationSalesStation = (typeof STATION_SALES_STATIONS)[number];
export type StationSalesVisibility = Record<StationSalesStation, boolean>;

export const DEFAULT_STATION_SALES_VISIBILITY: StationSalesVisibility = {
  barista: true,
  kitchen: true,
  juice: true,
};

/** Parse old, missing, or malformed setting values without hiding the panel. */
export function parseStationSalesVisibility(value: unknown): StationSalesVisibility {
  let raw: unknown = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_STATION_SALES_VISIBILITY };
    }
  }

  const result = { ...DEFAULT_STATION_SALES_VISIBILITY };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  const source = raw as Record<string, unknown>;
  for (const station of STATION_SALES_STATIONS) {
    if (typeof source[station] === "boolean") result[station] = source[station] as boolean;
  }
  return result;
}

export function isStationSalesVisible(value: unknown, station: string): boolean {
  if (!STATION_SALES_STATIONS.includes(station as StationSalesStation)) return true;
  return parseStationSalesVisibility(value)[station as StationSalesStation];
}
