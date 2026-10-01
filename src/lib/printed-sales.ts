/**
 * Shared sale eligibility rules for the admin report, shift report,
 * day-close total, and station sales.
 *
 * In Fana's print-queue workflow, every EFD print is an incremental receipt:
 * the first contains the initial lines, and a later print contains additions
 * that arrived after the previous print. A line counts once, at the first
 * cashier print at or after the line was created. Anything added after the
 * latest print stays out until it gets its own print. Full-payment mode keeps
 * its paid/completed rule because that workflow does not use EFD printing.
 */
export type SalesStamp = Date | string | null | undefined;

export interface SalesTicketLike {
  status?: string | null;
  printedAt?: SalesStamp;
  closedAt?: SalesStamp;
  updatedAt?: SalesStamp;
  createdAt?: SalesStamp;
  totalAmount?: number | null;
}

export interface SalesItemLike {
  price?: number | null;
  quantity?: number | null;
  removed?: boolean | null;
  createdAt?: SalesStamp;
}

function milliseconds(value: SalesStamp): number | null {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/** Timestamp used to place a non-print sale on a cafe (EAT) calendar day. */
export function saleTimestamp(ticket: SalesTicketLike): SalesStamp {
  return ticket.printedAt || ticket.closedAt || ticket.updatedAt || ticket.createdAt || null;
}

/** Does this ticket belong in revenue for the active cashier workflow? */
export function isSaleTicket(ticket: SalesTicketLike, printQueueMode = true): boolean {
  const status = String(ticket.status || "").toLowerCase();
  if (status === "cancelled") return false;
  const hasPrint = milliseconds(ticket.printedAt) !== null;
  if (status === "printed" || status === "closed") return hasPrint;
  if (status === "paid" || status === "completed") return printQueueMode ? hasPrint : true;
  return false;
}

/**
 * Print instants for one ticket. The ticket column is the precise latest print;
 * older print events preserve the earlier incremental receipts. Replacing the
 * final audit timestamp with printedAt avoids counting additions made between
 * the transaction and the subsequent audit insert as if they were already
 * printed. With no audit history, legacy bills fall back to their one known
 * print stamp.
 */
export function receiptPrintTimes(
  ticket: SalesTicketLike,
  printEvents: readonly SalesStamp[] = [],
): Date[] {
  const eventTimes = printEvents
    .map(milliseconds)
    .filter((time): time is number => time !== null)
    .sort((a, b) => a - b);
  const latest = milliseconds(ticket.printedAt);
  const times = latest === null
    ? eventTimes
    : [...eventTimes.filter((time) => time < latest), latest];
  const unique = [...new Set(times)];
  return unique.map((time) => new Date(time));
}

/** True if the active line has appeared on any EFD receipt for the ticket. */
export function isItemOnPrintedReceipt(item: SalesItemLike, printedAt: SalesStamp): boolean {
  const printTime = milliseconds(printedAt);
  if (printTime === null) return false;
  const createdTime = milliseconds(item.createdAt);
  // Old rows without a usable created_at stamp remain eligible; new rows have
  // a database timestamp and are compared exactly to the latest cashier print.
  return createdTime === null || createdTime <= printTime;
}

/** The exact print/sale timestamp at which an individual line first qualified. */
export function saleItemTimestamp(
  ticket: SalesTicketLike,
  item: SalesItemLike,
  printQueueMode = true,
  printEvents: readonly SalesStamp[] = [],
): SalesStamp {
  if (item.removed || !isSaleTicket(ticket, printQueueMode)) return null;

  const latestPrint = milliseconds(ticket.printedAt);
  if (latestPrint !== null) {
    const prints = receiptPrintTimes(ticket, printEvents);
    const created = milliseconds(item.createdAt);
    // Legacy item rows without created_at are attributed to the earliest known
    // print rather than being counted again on every reprint.
    if (created === null) return prints[0] || null;
    return prints.find((printed) => printed.getTime() >= created) || null;
  }

  const status = String(ticket.status || "").toLowerCase();
  if (!printQueueMode && (status === "paid" || status === "completed")) {
    return saleTimestamp(ticket);
  }
  return null;
}

export interface SalesItemEventLike {
  itemId?: number | null;
  eventType?: string | null;
  fromValue?: string | null;
  toValue?: string | null;
  createdAt?: SalesStamp;
}

export interface SaleLine<T extends SalesItemLike> {
  /** Quantity is the portion that appeared on this particular receipt. */
  item: T;
  soldAt: SalesStamp;
}

function parseQuantity(value: string | null | undefined): number | null {
  if (value == null || String(value).trim() === "") return null;
  const quantity = Number(value);
  return Number.isFinite(quantity) ? Math.max(0, Math.round(quantity)) : null;
}

/** Reconstruct a merged line's quantity as it stood at one receipt instant. */
function quantityAtPrint<T extends SalesItemLike>(
  item: T,
  printedAt: Date,
  itemEvents: readonly SalesItemEventLike[],
): number {
  let quantity = Math.max(0, Math.round(Number(item.quantity) || 0));
  const changes = itemEvents
    .filter((event) => event.eventType === "item_quantity_changed" && event.itemId === (item as T & { id?: number }).id)
    .map((event) => ({ event, at: milliseconds(event.createdAt) }))
    .filter((change): change is { event: SalesItemEventLike; at: number } => change.at !== null)
    .sort((a, b) => b.at - a.at);
  for (const change of changes) {
    if (change.at <= printedAt.getTime()) break;
    const before = parseQuantity(change.event.fromValue);
    if (before !== null) quantity = before;
  }
  return quantity;
}

/** Active quantities that have actually been sold, split by receipt and date. */
export function saleLinesForTicket<T extends SalesItemLike>(
  ticket: SalesTicketLike,
  items: readonly T[],
  printQueueMode = true,
  printEvents: readonly SalesStamp[] = [],
  itemEvents: readonly SalesItemEventLike[] = [],
): SaleLine<T>[] {
  if (!isSaleTicket(ticket, printQueueMode)) return [];
  const status = String(ticket.status || "").toLowerCase();
  const latestPrint = milliseconds(ticket.printedAt);
  return items.flatMap((item) => {
    if (item.removed) return [];
    if (latestPrint !== null) {
      const created = milliseconds(item.createdAt);
      const prints = receiptPrintTimes(ticket, printEvents).filter((printed) => created === null || printed.getTime() >= created);
      let printedQuantity = 0;
      const lines: SaleLine<T>[] = [];
      for (const printedAt of prints) {
        const quantityAtReceipt = quantityAtPrint(item, printedAt, itemEvents);
        // A quantity reduction cannot undo an EFD receipt. Only positive units
        // beyond everything already printed for this line can be new sales.
        const addedQuantity = Math.max(0, quantityAtReceipt - printedQuantity);
        printedQuantity = Math.max(printedQuantity, quantityAtReceipt);
        if (addedQuantity > 0) {
          lines.push({
            item: { ...item, quantity: addedQuantity },
            soldAt: printedAt,
          });
        }
      }
      return lines;
    }

    const soldAt = saleItemTimestamp(ticket, item, printQueueMode, printEvents);
    if (soldAt) return [{ item, soldAt }];
    // Full-payment deployments can have legacy rows with no usable ticket
    // timestamp. They are still paid sales; callers can retain the amount even
    // though there is no valid EAT date key on which to bucket it.
    if (!printQueueMode && !ticket.printedAt && (status === "paid" || status === "completed")) {
      return [{ item, soldAt: null }];
    }
    return [];
  });
}

/**
 * Items that make up this ticket's sale. The generic preserves the database
 * row's extra fields for callers that also need category/name/station data.
 */
export function saleItemsForTicket<T extends SalesItemLike>(
  ticket: SalesTicketLike,
  items: readonly T[],
  printQueueMode = true,
  printEvents: readonly SalesStamp[] = [],
  itemEvents: readonly SalesItemEventLike[] = [],
): T[] {
  return saleLinesForTicket(ticket, items, printQueueMode, printEvents, itemEvents).map((line) => line.item);
}

export function sumSaleItems(items: readonly SalesItemLike[]): number {
  return items.reduce((total, item) => {
    const price = Number(item.price) || 0;
    const quantity = Number(item.quantity) || 0;
    return total + price * quantity;
  }, 0);
}

/** Canonical amount to use instead of a mutable ticket.total_amount. */
export function ticketSaleAmount<T extends SalesItemLike>(
  ticket: SalesTicketLike,
  items: readonly T[],
  printQueueMode = true,
  printEvents: readonly SalesStamp[] = [],
  itemEvents: readonly SalesItemEventLike[] = [],
): number {
  return sumSaleItems(saleItemsForTicket(ticket, items, printQueueMode, printEvents, itemEvents));
}
