import { NextResponse } from "next/server";
import { db } from "@/db";
import { tickets, ticketItems } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { and, eq, gte, lt } from "drizzle-orm";
import { readStaffSession } from "@/lib/session";
import { etStartOfToday } from "@/lib/timezone";

/** Shared buna lane: makers do not tap Accept/Done, so these are crew totals,
 * not invented per-person production counts. Counts are cups, not bills. */
export async function GET() {
  const staff = await readStaffSession();
  if (!staff || staff.role !== "buna") return NextResponse.json({ error: "Buna login required" }, { status: 403 });
  await ensureTablesExist();
  const start = etStartOfToday();
  const end = new Date(start.getTime() + 86400000);
  // Include older tickets that may have received new cups today, but avoid an
  // unbounded scan: query the item timestamps directly.
  const items = await db.select({ item: ticketItems, ticket: tickets })
    .from(ticketItems).innerJoin(tickets, eq(ticketItems.ticketId, tickets.id))
    .where(and(eq(ticketItems.stationName, "buna"), gte(ticketItems.createdAt, start), lt(ticketItems.createdAt, end)));
  let requested = 0, cancelled = 0, printed = 0, outdoor = 0;
  for (const { item, ticket } of items) {
    const qty = item.quantity || 0;
    requested += qty;
    if (ticket.orderType === "outdoor") outdoor += qty;
    if (item.removed || ticket.status === "cancelled") cancelled += qty;
    else if (ticket.printedAt && new Date(ticket.printedAt) >= new Date(item.createdAt!)) printed += qty;
  }
  return NextResponse.json({ requested, cancelled, printed, outdoor, pending: requested - cancelled - printed }, { headers: { "Cache-Control": "no-store" } });
}
