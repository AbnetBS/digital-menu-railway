/**
 * THE RELEASE RULES — one file, so the API routes, the staff screens and the
 * regression tests can never disagree about WHEN the stations may see a line.
 *
 * Three decisions the owner made in Sept 2026 live here:
 *
 * 1. PRINT FREES THE TABLE. The cashier's ✓ PRINTED tap also clears the table,
 *    because the waiters kept forgetting to. A DINE-IN bill carrying
 *    `printed_at` is finished for the floor: the next guest at that table
 *    starts a brand new bill, so nothing may ever merge into it again. Outdoor
 *    and group bills are exempt — a group takes more rounds on the same bill,
 *    so their print stays a re-print, not a release.
 *
 * 2. THE STATIONS SEE ONLY RELEASED LINES. A bill releases its food the moment
 *    staff SEND it (the waiter's ✓ ACCEPT & SEND, a staff-sent new order, or
 *    the cashier's CONFIRM & SEND on a held QR order). Everything already on
 *    the bill at that second is the crews' work immediately — exactly like
 *    before. What is NEW: a line a GUEST added to a bill that was already sent
 *    is born held (`ticket_items.released = false`). It waits on the cashier's
 *    and the waiter's screens as "guest added items, confirm before the
 *    stations get them", and only their confirmation lets the crews see it.
 *    Staff keying stays instant: a waiter standing at the table already read
 *    the order back to the guest.
 *
 * 3. A RELEASED BILL CLOSES ITSELF once every line on it is finished, so a
 *    forgotten "Table cleared" can never leave a stack of half-dead bills
 *    behind (see station-items PUT).
 *
 * This module is deliberately PURE: no database, no Next.js, no React.
 */

import type { StationName } from "@/lib/stations";

/** A ticket shape these rules need — a subset of the DB row / the API payload. */
export interface ReleaseTicket {
  status?: string | null;
  orderType?: string | null;
  confirmedAt?: string | Date | null;
  printedAt?: string | Date | null;
}

/** A line shape these rules need. */
export interface ReleaseLine {
  removed?: boolean | null;
  /** False = held back from the stations until staff confirm it. */
  released?: boolean | null;
  stationStatus?: string | null;
  stationName?: string | null;
}

/**
 * Statuses that hide a bill from the station screens: finished bills, a voided
 * order, and an order nobody has accepted yet (pending_waiter — the waiter's
 * job to confirm).
 */
export const STATION_HIDDEN_STATUSES = ["paid", "cancelled", "closed", "pending_waiter"] as const;

/** Has this bill been SENT to the crews (the release stamp)? */
export function isBillSent(ticket: ReleaseTicket | null | undefined): boolean {
  if (!ticket) return false;
  return Boolean(ticket.confirmedAt || ticket.printedAt);
}

/**
 * Is this bill still the CURRENT bill of its table?
 *
 * A dine-in bill the cashier printed is finished for the floor: the table is
 * free and the next guest opens a new bill. Outdoor/group bills keep their
 * bill open across rounds, so their print never releases the "table".
 */
export function isTableReleased(ticket: ReleaseTicket | null | undefined): boolean {
  if (!ticket) return false;
  if (String(ticket.orderType || "dine_in") === "outdoor") return false;
  return Boolean(ticket.printedAt);
}

/** Does this ticket still occupy its table on the floor boards? */
export function occupiesTable(ticket: ReleaseTicket | null | undefined): boolean {
  if (!ticket) return false;
  if (["paid", "cancelled", "closed"].includes(String(ticket.status || ""))) return false;
  return !isTableReleased(ticket);
}

/** Is this line held back from the stations until staff confirm it? */
export function isLineHeld(line: ReleaseLine | null | undefined): boolean {
  if (!line) return false;
  // Rows written before the release gate existed read as released.
  return line.released === false;
}

/** May the crew of `station` see this line of this bill right now? */
export function lineVisibleToStation(line: ReleaseLine, ticket: ReleaseTicket): boolean {
  if (line.removed) return false;
  if (isLineHeld(line)) return false;
  if (STATION_HIDDEN_STATUSES.includes(String(ticket.status || "") as (typeof STATION_HIDDEN_STATUSES)[number])) {
    return false;
  }
  return isBillSent(ticket);
}

/** Live (not removed, not finished) lines of a bill. */
export function liveLines(lines: ReleaseLine[] | undefined | null): ReleaseLine[] {
  return (lines || []).filter((l) => !l.removed);
}

/** Lines a guest added that staff have not confirmed to the stations yet. */
export function heldLines(lines: ReleaseLine[] | undefined | null): ReleaseLine[] {
  return liveLines(lines).filter((l) => isLineHeld(l));
}

/** Units (sum of quantities) a guest is still waiting for staff to confirm. */
export function heldUnits(lines: ReleaseLine[] | undefined | null): number {
  return heldLines(lines).reduce((s, l) => s + (Number((l as { quantity?: number }).quantity) || 0), 0);
}

/**
 * Is every live line of this bill finished, so the bill can close itself?
 * Used to retire a bill whose table the cashier already freed: the crews
 * finished the food, so nobody needs to remember to clear it.
 */
export function allLinesFinished(lines: ReleaseLine[] | undefined | null): boolean {
  const live = liveLines(lines);
  if (live.length === 0) return true;
  return live.every((l) => String(l.stationStatus || "pending") === "done");
}

/** The crews that have at least one live line on this bill. */
export function stationsOfLines(lines: ReleaseLine[] | undefined | null): StationName[] {
  const seen = new Set<StationName>();
  for (const l of liveLines(lines)) {
    const raw = String(l.stationName || "kitchen");
    if (raw === "kitchen" || raw === "barista" || raw === "buna" || raw === "juice") seen.add(raw);
  }
  return [...seen];
}
