/**
 * Pure order-line helpers shared by the customer status view, the waiter bill,
 * the cashier, the kitchen/barista screens and the order-status API.
 *
 * Two problems live here:
 *
 * 1. DUPLICATE LINES. A table's bill grows over time: the customer orders tea,
 *    and ten minutes later orders tea again. Those are two separate submissions,
 *    so they used to land as two `ticket_items` rows and every screen showed
 *    "1 Tea, 1 Sandwich, 1 Tea" — which the cashier then had to add up by hand
 *    on the receipt. `groupOrderLines()` collapses identical lines into one
 *    ("2 Tea, 1 Sandwich") for READ-ONLY views, and `canMergeLines()` is the
 *    matching rule the order route uses to merge them in the DATABASE so new
 *    bills never contain the duplicate in the first place.
 *
 * 2. CUSTOMER-FACING PROGRESS. The kitchen/barista already track per-item
 *    `pending → accepted → done`; `stationProgress()` + `customerOrderPhase()`
 *    turn that into the one line a guest cares about ("your food is being
 *    prepared" / "your food is ready"). Drinks, cake and other barista items are
 *    deliberately EXCLUDED from that progress: they are made in seconds and a
 *    "preparing…" bar for a macchiato would just be noise.
 *
 * No DB, no React, no runtime imports — safe to unit-test and to use on either
 * side of the wire.
 */

export type StationStatus = "pending" | "accepted" | "done";

/** A ticket_items row (or the trimmed public shape of one). */
export interface OrderLine {
  id: number;
  ticketId?: number;
  menuItemId?: number | null;
  name: string;
  category?: string | null;
  price?: number | null;
  quantity: number;
  notes?: string | null;
  removed?: boolean | null;
  stationName?: string | null;
  stationStatus?: string | null;
  createdAt?: string | Date | null;
}

/** One collapsed line: `quantity` is the sum, `ids` keeps every source row. */
export interface GroupedOrderLine extends Omit<OrderLine, "id" | "quantity"> {
  /** Representative row id (the earliest) — safe for read-only rendering. */
  id: number;
  /** Every row id folded into this line, oldest first. */
  ids: number[];
  quantity: number;
  /** Arrival time of the earliest row (what the kitchen queues by). */
  createdAt?: string | Date | null;
}

/** Prefix the order route writes on every line that came from a Daily Board offer. */
export const PROMOTION_NOTE_PREFIX = "Daily special:";

/** True when this line was expanded from an owner-configured Daily Board offer. */
export function isPromotionLine(line: Pick<OrderLine, "notes">): boolean {
  return String(line.notes ?? "").trimStart().startsWith(PROMOTION_NOTE_PREFIX);
}

function stationOf(line: Pick<OrderLine, "stationName">): string {
  return String(line.stationName ?? "kitchen") || "kitchen";
}

/**
 * Identity of a line for merging/grouping: same dish, same unit price, same
 * note and same station. Two rows that differ in ANY of these must stay apart —
 * a "No Sugar" tea is not the same line as a plain tea, and a promotion's
 * discounted unit price is not the same line as the regular price.
 */
export function orderLineKey(line: Pick<OrderLine, "menuItemId" | "name" | "price" | "notes" | "stationName">): string {
  return [
    line.menuItemId ?? "",
    String(line.name ?? "").trim().toLowerCase(),
    Number(line.price ?? 0),
    String(line.notes ?? "").trim(),
    stationOf(line),
  ].join("|");
}

/**
 * May `incoming` be folded into `existing` (same ticket) instead of being
 * inserted as its own row?
 *
 * Deliberately conservative — anything questionable stays a separate line:
 *   • both must be live rows (not cashier-removed)
 *   • the existing row must still be `pending`: once the kitchen has ACCEPTED or
 *     finished it, folding a new tea into it would hide real new work from the
 *     crew (they would see "2 Tea" while one is already cooked)
 *   • Daily Board offer lines are never merged: they are expanded per unit on
 *     purpose so a combo's exact integer total survives, and the crew/cashier
 *     read the offer title from the note
 *   • identical dish + price + note + station (see orderLineKey)
 */
export function canMergeLines(
  existing: Pick<OrderLine, "ticketId" | "removed" | "stationStatus" | "notes" | "menuItemId" | "name" | "price" | "stationName">,
  incoming: Pick<OrderLine, "ticketId" | "removed" | "notes" | "menuItemId" | "name" | "price" | "stationName">
): boolean {
  if (existing.ticketId !== undefined && incoming.ticketId !== undefined && existing.ticketId !== incoming.ticketId) {
    return false;
  }
  if (existing.removed || incoming.removed) return false;
  if (String(existing.stationStatus ?? "pending") !== "pending") return false;
  if (isPromotionLine(existing) || isPromotionLine(incoming)) return false;
  return orderLineKey(existing) === orderLineKey(incoming);
}

/**
 * Collapse identical lines into one for READ-ONLY views (customer status,
 * waiter bill summary, order history, receipts).
 *
 * `splitByStationStatus` keeps "1 Tea (cooking)" apart from "1 Tea (new)" —
 * used by the crew screens, where the state of each row is the whole point.
 * Editable staff lists must NOT use this: their ± buttons write to a single row
 * id, so they render raw rows and rely on the database-level merge instead.
 *
 * Removed rows are always grouped apart from live ones, so `includeRemoved`
 * views (order history) can strike them out without inflating a paid bill.
 */
export function groupOrderLines(
  lines: OrderLine[],
  options: { splitByStationStatus?: boolean; includeRemoved?: boolean } = {}
): GroupedOrderLine[] {
  const { splitByStationStatus = false, includeRemoved = false } = options;
  const byKey = new Map<string, GroupedOrderLine>();

  for (const line of lines) {
    if (!includeRemoved && line.removed) continue;
    // `removed` is part of the key ON PURPOSE: an audit/history view can ask for
    // removed rows (includeRemoved) and still strike them out separately. Folding
    // a cashier-removed "Tea" into the live "Tea" would inflate the quantity AND
    // the line total of a bill that was already paid.
    const key = `${orderLineKey(line)}|${line.removed ? "removed" : "live"}${
      splitByStationStatus ? `|${line.stationStatus ?? "pending"}` : ""
    }`;
    const found = byKey.get(key);
    if (found) {
      found.quantity += Number(line.quantity) || 0;
      found.ids.push(line.id);
      continue;
    }
    byKey.set(key, {
      ...line,
      id: line.id,
      ids: [line.id],
      quantity: Number(line.quantity) || 0,
    });
  }
  return [...byKey.values()];
}

export interface StationProgress {
  /** Distinct lines for this station (after collapsing duplicates). */
  lines: number;
  /** Total units to make (sum of quantities). */
  units: number;
  pending: number;
  accepted: number;
  done: number;
  /** idle = nothing for this station · queued · preparing · ready */
  state: "idle" | "queued" | "preparing" | "ready";
}

/** Progress of one crew station, measured in UNITS (2 Tea = 2 units). */
export function stationProgress(lines: OrderLine[], station: "kitchen" | "barista"): StationProgress {
  const own = lines.filter((l) => !l.removed && stationOf(l) === station);
  const grouped = groupOrderLines(own, { splitByStationStatus: true });
  const unitsOf = (status: StationStatus) =>
    grouped.filter((g) => String(g.stationStatus ?? "pending") === status).reduce((s, g) => s + g.quantity, 0);

  const pending = unitsOf("pending");
  const accepted = unitsOf("accepted");
  const done = unitsOf("done");
  const units = pending + accepted + done;

  let state: StationProgress["state"] = "idle";
  if (units > 0) {
    if (pending === 0 && accepted === 0) state = "ready";
    else if (accepted > 0 || done > 0) state = "preparing";
    else state = "queued";
  }
  return { lines: grouped.length, units, pending, accepted, done, state };
}

/** What the guest's own screen says, in one word. */
export type CustomerOrderPhase =
  | "none"
  | "waiting"      // sent, waiter has not confirmed yet
  | "confirmed"    // accepted, kitchen has not started
  | "preparing"    // kitchen is cooking
  | "ready"        // kitchen finished everything
  | "drinks_only"  // barista items only — no progress bar (made in seconds)
  | "bill"         // ready_for_payment / completed
  | "paid"
  | "cancelled";

export interface PhaseTicket {
  status?: string | null;
  paymentStatus?: string | null;
}

/**
 * Order-level phase shown to the customer.
 *
 * Barista-only bills (coffee, juice, cake) intentionally skip the
 * preparing/ready phases — those items are handed over almost immediately, so a
 * progress bar would be noise. Everything else is driven by the KITCHEN's
 * per-item accept/done buttons, which already exist.
 */
export function customerOrderPhase(ticket: PhaseTicket | null, lines: OrderLine[]): CustomerOrderPhase {
  if (!ticket) return "none";
  const status = String(ticket.status ?? "");
  if (status === "cancelled") return "cancelled";
  // Group 9: "closed" = the waiter cleared the table after the bill was settled
  // in the EFD/POS — for the guest this is the finished/thank-you state.
  if (status === "paid" || status === "closed" || String(ticket.paymentStatus ?? "").startsWith("paid_")) return "paid";
  if (status === "ready_for_payment" || status === "completed") return "bill";
  if (status === "pending_waiter") return "waiting";

  const kitchen = stationProgress(lines, "kitchen");
  if (kitchen.units === 0) return "drinks_only";
  if (kitchen.state === "ready") return "ready";
  if (kitchen.state === "preparing") return "preparing";
  return "confirmed";
}

/* ───────────────── time formatting (browser-local) ─────────────────
   Postgres `timestamp` values round-trip as a correct instant, so formatting in
   the viewer's own timezone is what both the crew in the kitchen and the guest
   at the table expect to read. */

function toDate(value?: string | Date | null): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "14:35" — the clock time an order arrived (the crew's #1 question). */
export function formatClock(value?: string | Date | null): string {
  const d = toDate(value);
  if (!d) return "n/a";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "02 Sep 2026" — the date an order arrived. */
export function formatDayMonthYear(value?: string | Date | null): string {
  const d = toDate(value);
  if (!d) return "n/a";
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

/** "14:35 · 02 Sep 2026" */
export function formatDateTime(value?: string | Date | null): string {
  const d = toDate(value);
  if (!d) return "n/a";
  return `${formatClock(d)} · ${formatDayMonthYear(d)}`;
}

/** Whole minutes since `value` (0 if it is in the future/invalid). */
export function minutesSince(value?: string | Date | null, now: number = Date.now()): number {
  const d = toDate(value);
  if (!d) return 0;
  return Math.max(0, Math.floor((now - d.getTime()) / 60000));
}

/** "just now" / "6 min" — how long the crew has had this order. */
export function waitingLabel(value?: string | Date | null, now: number = Date.now()): string {
  const mins = minutesSince(value, now);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min";
  return `${mins} min`;
}
