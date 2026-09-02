import { NextResponse } from "next/server";
import { db } from "@/db";
import { tickets, ticketItems } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { and, asc, desc, eq, isNull, notInArray } from "drizzle-orm";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { publish, CHANNELS } from "@/lib/realtime";
import {
  customerOrderPhase,
  groupOrderLines,
  stationProgress,
  type CustomerOrderPhase,
  type OrderLine,
} from "@/lib/order-lines";

/**
 * PUBLIC, table-scoped order status for the guest's own phone (Group 8).
 *
 * WHY IT EXISTS
 * -------------
 * The kitchen and barista already move each item through pending → accepted →
 * done, but the guest could not see any of it: `/api/tickets` is staff-only. So
 * after scanning the QR a guest had no idea whether the food was queued, cooking
 * or ready, and had to wave at a waiter to ask for the bill.
 *
 * `GET  /api/table-status?table=N` → the live status of that table's open bill.
 * `POST /api/table-status`         → the guest taps "bring us the bill/receipt".
 *
 * It is table-scoped ON PURPOSE: a bill can be opened by the WAITER's phone, and
 * the guest who then scans the same table QR must see that same order (and be
 * able to add to it). There is no per-device token to key on, so the table id —
 * already public via the QR code printed on it — is the scope.
 *
 * WHAT IT NEVER EXPOSES
 * ---------------------
 * No staff names, no PIN/session data, no receipt photos, no payment
 * verification audit, no other table's data, no historical bills older than the
 * grace window below. Both methods are rate-limited per IP, and the POST can only
 * stamp `receipt_requested_at` on an OPEN bill of that table — it can never
 * change an order status, a payment status, a price or a quantity.
 */

/** A guest's phone polls every ~12s while the menu is open. */
const READ_LIMIT = 240;
/** "Bring the bill" is a human tap — a handful is plenty. */
const REQUEST_LIMIT = 20;
const WINDOW_MS = 10 * 60 * 1000;

/** After payment the panel stays available this long (thank-you + review prompt). */
const RECENTLY_CLOSED_GRACE_MS = 30 * 60 * 1000;

interface PublicLine {
  name: string;
  quantity: number;
  notes: string;
  station: "kitchen" | "barista";
  stationStatus: string;
}

interface TableStatusPayload {
  tableId: number;
  ticket: null | {
    id: number;
    orderNumber: string | null;
    status: string;
    paymentStatus: string;
    totalAmount: number;
    createdAt: string | null;
    updatedAt: string | null;
    closedAt: string | null;
    receiptRequestedAt: string | null;
    phase: CustomerOrderPhase;
    /** Food progress — the bar the guest actually watches. */
    kitchen: ReturnType<typeof stationProgress>;
    /** Drinks/cake: shown as a list only, deliberately without a progress bar. */
    barista: ReturnType<typeof stationProgress>;
    lines: PublicLine[];
  };
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The table's open bill, or one closed within the grace window (paid thank-you). */
async function findVisibleTicket(tableId: number) {
  const open = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.tableId, tableId), notInArray(tickets.status, ["paid", "cancelled"])))
    .orderBy(desc(tickets.updatedAt))
    .limit(1);
  if (open.length > 0) return open[0];

  const closed = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.tableId, tableId), eq(tickets.status, "paid")))
    .orderBy(desc(tickets.closedAt))
    .limit(1);
  const row = closed[0];
  if (!row) return null;
  const closedAt = row.closedAt ? new Date(row.closedAt).getTime() : 0;
  return Date.now() - closedAt <= RECENTLY_CLOSED_GRACE_MS ? row : null;
}

async function buildPayload(tableId: number): Promise<TableStatusPayload> {
  const ticket = await findVisibleTicket(tableId);
  if (!ticket) return { tableId, ticket: null };

  const rows = await db
    .select()
    .from(ticketItems)
    .where(eq(ticketItems.ticketId, ticket.id))
    .orderBy(asc(ticketItems.id));

  const lines = rows as unknown as OrderLine[];
  // One line per dish, however many times it was added during the visit — the
  // same rule the waiter, cashier and receipt screens use.
  const grouped = groupOrderLines(lines, { splitByStationStatus: false });

  return {
    tableId,
    ticket: {
      id: ticket.id,
      orderNumber: ticket.orderNumber ?? null,
      status: ticket.status,
      paymentStatus: ticket.paymentStatus ?? "unpaid",
      totalAmount: Number(ticket.totalAmount) || 0,
      createdAt: iso(ticket.createdAt),
      updatedAt: iso(ticket.updatedAt),
      closedAt: iso(ticket.closedAt),
      receiptRequestedAt: iso(ticket.receiptRequestedAt),
      phase: customerOrderPhase(ticket, lines),
      kitchen: stationProgress(lines, "kitchen"),
      barista: stationProgress(lines, "barista"),
      lines: grouped.map((line) => ({
        name: line.name,
        quantity: line.quantity,
        notes: String(line.notes ?? ""),
        station: (String(line.stationName ?? "kitchen") === "barista" ? "barista" : "kitchen") as "kitchen" | "barista",
        stationStatus: String(line.stationStatus ?? "pending"),
      })),
    },
  };
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const tableId = Number(searchParams.get("table") || 0);
    if (!Number.isInteger(tableId) || tableId <= 0) {
      return NextResponse.json({ error: "Valid table required" }, { status: 400 });
    }

    const rl = checkRateLimit(`table-status:${getClientIp(request)}`, READ_LIMIT, WINDOW_MS);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } }
      );
    }

    await ensureTablesExist();
    return NextResponse.json(await buildPayload(tableId), { headers: NO_STORE });
  } catch (error) {
    console.error("[table-status GET]", error);
    return NextResponse.json({ error: "Could not load order status" }, { status: 500 });
  }
}

/**
 * "We are done — please bring the bill/receipt."
 *
 * Stamps `receipt_requested_at` once and publishes a realtime refresh so the
 * cashier and waiter see the request immediately. Idempotent: tapping again (or
 * two guests at the same table tapping) keeps the FIRST request time.
 */
export async function POST(request: Request) {
  try {
    const rl = checkRateLimit(`table-status-request:${getClientIp(request)}`, REQUEST_LIMIT, WINDOW_MS);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please wave at your waiter." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } }
      );
    }

    const body = await request.json().catch(() => ({}));
    const tableId = Number(body?.table || 0);
    if (!Number.isInteger(tableId) || tableId <= 0) {
      return NextResponse.json({ error: "Valid table required" }, { status: 400 });
    }

    await ensureTablesExist();

    const open = await db
      .select({ id: tickets.id, receiptRequestedAt: tickets.receiptRequestedAt })
      .from(tickets)
      .where(and(eq(tickets.tableId, tableId), notInArray(tickets.status, ["paid", "cancelled"])))
      .orderBy(desc(tickets.updatedAt))
      .limit(1);

    if (open.length === 0) {
      return NextResponse.json(
        { error: "There is no open order for this table yet." },
        { status: 404, headers: NO_STORE }
      );
    }

    if (!open[0].receiptRequestedAt) {
      await db
        .update(tickets)
        // Guarded on the row still being un-requested, so two guests tapping at
        // once cannot overwrite the first request time.
        .set({ receiptRequestedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(tickets.id, open[0].id), isNull(tickets.receiptRequestedAt)));
      publish(CHANNELS.orders);
    }

    return NextResponse.json(await buildPayload(tableId), { headers: NO_STORE });
  } catch (error) {
    console.error("[table-status POST]", error);
    return NextResponse.json({ error: "Could not send the request" }, { status: 500 });
  }
}
