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
export const CORRECTION_WINDOW_MS = 10 * 60 * 1000;
export const CORRECTION_LOCK_MESSAGE = "This item/order is locked: already done or sent 10 minutes ago. Printing is still available.";
const time = (stamp: Stamp) => stamp ? new Date(stamp).getTime() || 0 : 0;
const finished = (t: CorrectionTicket) => ["paid", "closed", "cancelled", "completed"].includes(t.status || "");

/** Held QR orders have not been sent. Later additions use their own arrival time.
 * Edits and printing never restart the window; a merged row retains its age.
 */
export function isCashierItemLocked(item: CorrectionItem, ticket: CorrectionTicket, now = Date.now()): boolean {
  if (item.removed || item.stationStatus === "done" || finished(ticket)) return true;
  if (!ticket.confirmedAt && !ticket.printedAt && ["pending_waiter", "confirmed"].includes(ticket.status || "")) return false;
  const sent = Math.max(time(item.createdAt), time(ticket.confirmedAt)) || time(ticket.createdAt);
  return !sent || now - sent >= CORRECTION_WINDOW_MS;
}

/** Cancelling a whole bill must never remove a protected dish along with it. */
export function isCashierOrderLocked(ticket: CorrectionTicket & { items?: CorrectionItem[] }, now = Date.now()): boolean {
  if (finished(ticket)) return true;
  const live = (ticket.items || []).filter((i) => !i.removed);
  return live.length
    ? live.some((i) => isCashierItemLocked(i, ticket, now))
    : isCashierItemLocked({}, ticket, now);
}
