import { ticketEvents } from "@/db/schema";

export type TicketEventType =
  | "ticket_created"
  | "submission_added"
  | "item_quantity_changed"
  | "item_notes_changed"
  | "item_removed"
  | "item_edited"
  | "status_changed"
  | "ticket_sent"
  | "ticket_printed"
  | "bill_requested"
  | "additions_released";

export interface TicketEventInput {
  ticketId: number;
  eventType: TicketEventType;
  actorName?: string | null;
  actorRole?: string | null;
  source?: string | null;
  itemId?: number | null;
  itemName?: string | null;
  fromValue?: string | null;
  toValue?: string | null;
  details?: string | null;
  createdAt?: Date;
}

// The root Drizzle client and transaction clients share insert().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function recordTicketEvent(client: any, input: TicketEventInput) {
  await client.insert(ticketEvents).values({
    ticketId: input.ticketId,
    eventType: input.eventType,
    actorName: input.actorName ? String(input.actorName).slice(0, 100) : null,
    actorRole: input.actorRole ? String(input.actorRole).slice(0, 20) : null,
    source: input.source ? String(input.source).slice(0, 20) : null,
    itemId: input.itemId ?? null,
    itemName: input.itemName ? String(input.itemName).slice(0, 200) : null,
    fromValue: input.fromValue ?? null,
    toValue: input.toValue ?? null,
    details: input.details ?? null,
    createdAt: input.createdAt || new Date(),
  });
}

export function summarizeSubmissionLines(lines: Array<{ name: string; quantity: number }>): string {
  return lines
    .map((line) => `${line.name} ×${Math.max(1, Number(line.quantity) || 0)}`)
    .join(", ")
    .slice(0, 500);
}
