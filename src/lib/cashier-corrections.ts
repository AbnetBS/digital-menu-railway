type Stamp = string | Date | null | undefined;
export interface CorrectionTicket {
  status?: string | null;
  createdAt?: Stamp;
  confirmedAt?: Stamp;
  printedAt?: Stamp;
}
export interface CorrectionItem {
  removed?: boolean | null;
  stationStatus?: string | null;
  createdAt?: Stamp;
}

export const CORRECTION_LOCK_MESSAGE = "This item/order is locked because it is already done or the bill is finished. Printing is still available.";
const finished = (t: CorrectionTicket) => ["paid", "closed", "cancelled", "completed"].includes(t.status || "");

/**
 * Cashier corrections stay available until the station finishes that line.
 * The old sent-time window is intentionally gone: age, printing and sending do
 * not lock an item. A line locks only when it was removed, marked done by its
 * station, or the whole bill is already finished.
 */
export function isCashierItemLocked(item: CorrectionItem, ticket: CorrectionTicket, _now?: number): boolean {
  return Boolean(item.removed) || item.stationStatus === "done" || finished(ticket);
}

/** Cancelling a whole bill must never remove a protected dish along with it. */
export function isCashierOrderLocked(ticket: CorrectionTicket & { items?: CorrectionItem[] }, _now?: number): boolean {
  if (finished(ticket)) return true;
  const live = (ticket.items || []).filter((i) => !i.removed);
  return live.some((i) => isCashierItemLocked(i, ticket));
}
