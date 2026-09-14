import { NextResponse } from "next/server";
import { db } from "@/db";
import { tickets, ticketItems } from "@/db/schema";
import { recordTicketEvent } from "@/lib/ticket-audit";
import { ensureTablesExist } from "@/db/migrate";
import { eq, and } from "drizzle-orm";
import { requireStaffOrAdmin } from "@/lib/session";
import { publish, CHANNELS } from "@/lib/realtime";
import { sendPushToRoles } from "@/lib/push";
import { itemQuantityAlerts, itemRemovedAlerts, itemNotesAlerts, itemEditedAfterPrintAlerts, withoutActor, type RoleAlert } from "@/lib/alerts";
import { readStaffSession } from "@/lib/session";

/** Send a built alert list, never blocking or failing the caller. */
function ring(alerts: RoleAlert[], actorRole?: string | null) {
  for (const alert of withoutActor(alerts, actorRole)) {
    void sendPushToRoles(alert.roles, {
      title: alert.title,
      body: alert.body,
      tag: alert.tag,
      urgent: alert.urgent,
      repeat: alert.repeat,
    }).catch(() => {});
  }
}

/** The bill an item belongs to, for the alert text (status + print stamp included). */
async function ticketOf(ticketId: number) {
  const rows = await db
    .select({ id: tickets.id, tableName: tickets.tableName, totalAmount: tickets.totalAmount, status: tickets.status, printedAt: tickets.printedAt })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  return rows[0] || null;
}

/** True when this bill already went out through the EFD (its receipt exists). */
function isPrintedBill(t: { status: string | null; printedAt: Date | string | null } | null): boolean {
  return !!t && t.status === "printed" && !!t.printedAt;
}

// PUT: edit item quantity or notes (waiter can adjust before payment)
export async function PUT(request: Request) {
  const __auth = await requireStaffOrAdmin();
  if (!__auth.ok) return __auth.response;
  await ensureTablesExist();
  try {
    const body = await request.json();
    if (!body.itemId) return NextResponse.json({ error: "Item ID required" }, { status: 400 });

    const updates: Record<string, unknown> = {};
    if (body.quantity !== undefined) {
      // Validate server-side (mirrors order submission): a bill's total is
      // recomputed from quantity, so an invalid value (NaN, negative, huge, or
      // fractional) would corrupt the ticket total and revenue/reports.
      const qty = Number(body.quantity);
      if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty < 1 || qty > 100) {
        return NextResponse.json({ error: "Quantity must be a whole number from 1 to 100" }, { status: 400 });
      }
      updates.quantity = qty;
    }
    if (body.notes !== undefined) {
      // notes is an unbounded text column — cap it to a reasonable length.
      updates.notes = String(body.notes).slice(0, 500);
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    // Read the line BEFORE the edit so the alert can say "2 to 4" — and so a
    // correction to a line the crew already STARTED can be recognised below.
    const before = await db.select().from(ticketItems).where(eq(ticketItems.id, body.itemId)).limit(1);
    if (before.length === 0) return NextResponse.json({ error: "Item not found" }, { status: 404 });
    const actor = __auth.session.kind === "staff" ? await readStaffSession() : null;
    const actorName = actor?.name || (__auth.session.kind === "admin" ? "admin" : null);
    const actorRole = actor?.role || (__auth.session.kind === "admin" ? "admin" : null);

    const qtyChanged = updates.quantity !== undefined && Number(updates.quantity) !== before[0].quantity;
    const qtyIncreased = qtyChanged && Number(updates.quantity) > before[0].quantity;
    const notesChanged = updates.notes !== undefined && String(updates.notes) !== String(before[0].notes || "");
    const wasStarted = before[0].stationStatus === "accepted" || before[0].stationStatus === "done";

    // MORE WORK ON A STARTED LINE reopens it. Raising "2 Tea" to "4 Tea" after
    // the crew finished means 2 more teas to make — leaving the line greyed
    // out as done would hide real work. A changed note on a started line is
    // the same: the crew must re-read it. Lowering a quantity never reopens
    // (the food is already made; only the bill changes).
    const reopened = wasStarted && (qtyIncreased || notesChanged);
    if (reopened) updates.stationStatus = "pending";

    // The line edit and the bill-total recompute share one transaction so two
    // staff correcting the same bill at once cannot leave a stale total.
    const updated = await db.transaction(async (tx) => {
      const rows = await tx
        .update(ticketItems)
        .set(updates)
        .where(eq(ticketItems.id, body.itemId))
        .returning();
      if (rows[0]) {
        const items = await tx
          .select()
          .from(ticketItems)
          .where(and(eq(ticketItems.ticketId, rows[0].ticketId), eq(ticketItems.removed, false)));
        const total = items.reduce((s: number, i: { price: number; quantity: number }) => s + i.price * i.quantity, 0);
        await tx
          .update(tickets)
          // Stamp the correction moment: a printed bill edited now changed
          // AFTER its EFD receipt went out, and the cashier's card flags it.
          .set({ totalAmount: total, updatedAt: new Date(), itemsEditedAt: new Date() })
          .where(eq(tickets.id, rows[0].ticketId));
        if (qtyChanged) {
          await recordTicketEvent(tx, {
            ticketId: rows[0].ticketId,
            eventType: "item_quantity_changed",
            actorName,
            actorRole,
            itemId: rows[0].id,
            itemName: rows[0].name,
            fromValue: String(before[0].quantity),
            toValue: String(rows[0].quantity),
            details: `${rows[0].name}: quantity ${before[0].quantity} → ${rows[0].quantity}`,
          });
        }
        if (notesChanged) {
          await recordTicketEvent(tx, {
            ticketId: rows[0].ticketId,
            eventType: "item_notes_changed",
            actorName,
            actorRole,
            itemId: rows[0].id,
            itemName: rows[0].name,
            fromValue: String(before[0].notes || ""),
            toValue: String(rows[0].notes || ""),
            details: `${rows[0].name}: note changed`,
          });
        }
        if (qtyChanged || notesChanged) {
          await recordTicketEvent(tx, {
            ticketId: rows[0].ticketId,
            eventType: "item_edited",
            actorName,
            actorRole,
            itemId: rows[0].id,
            itemName: rows[0].name,
            details: `${rows[0].name} was corrected on the bill`,
          });
        }
      }
      return rows;
    });
    if (!updated[0]) return NextResponse.json({ error: "Item not found" }, { status: 404 });

    // A corrected quantity changes what the crew must cook and what the guest
    // pays, so it rings the waiter and the station that owns the line. A
    // changed note rings the owning station only when the line was already
    // started (a pending line's note is simply read fresh when cooking starts).
    // Unchanged values ring nobody — the editors always send both fields.
    try {
      const ticket = qtyChanged || notesChanged ? await ticketOf(updated[0].ticketId) : null;
      if (ticket) {
        if (qtyChanged) {
          ring(
            itemQuantityAlerts({
              id: ticket.id,
              tableName: ticket.tableName,
              totalAmount: ticket.totalAmount,
              itemName: updated[0].name,
              station: updated[0].stationName,
              fromQuantity: before[0].quantity,
              toQuantity: updated[0].quantity,
            }),
            actorRole
          );
        }
        if (notesChanged && wasStarted) {
          ring(
            itemNotesAlerts({
              id: ticket.id,
              tableName: ticket.tableName,
              totalAmount: ticket.totalAmount,
              itemName: updated[0].name,
              station: updated[0].stationName,
            }),
            actorRole
          );
        }
        // The bill already went out through the EFD and someone just changed
        // what it claims: the cashier must re-key it. (When she is the editor
        // herself the ring is skipped — her own card flags the bill instead.)
        if ((qtyChanged || notesChanged) && isPrintedBill(ticket)) {
          ring(
            itemEditedAfterPrintAlerts({
              id: ticket.id,
              tableName: ticket.tableName,
              totalAmount: ticket.totalAmount,
              itemName: updated[0].name,
              station: updated[0].stationName,
            }),
            actorRole
          );
        }
      }
    } catch {
      /* alerts must never fail an edit */
    }

    publish(CHANNELS.orders);
    return NextResponse.json({ ...updated[0], reopened });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE: cashier removes unavailable item (soft-remove, stays visible as removed)
export async function DELETE(request: Request) {
  const __auth = await requireStaffOrAdmin();
  if (!__auth.ok) return __auth.response;
  await ensureTablesExist();
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    const hard = searchParams.get("hard") === "1";
    if (!id) return NextResponse.json({ error: "Item ID required" }, { status: 400 });

    const rows = await db.select().from(ticketItems).where(eq(ticketItems.id, Number(id)));
    if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const actor = __auth.session.kind === "staff" ? await readStaffSession() : null;
    const actorName = actor?.name || (__auth.session.kind === "admin" ? "admin" : null);
    const actorRole = actor?.role || (__auth.session.kind === "admin" ? "admin" : null);

    // The removal and the bill-total recompute share one transaction so two
    // staff correcting the same bill at once cannot leave a stale total.
    await db.transaction(async (tx) => {
      if (hard) {
        await tx.delete(ticketItems).where(eq(ticketItems.id, Number(id)));
      } else {
        await tx.update(ticketItems).set({ removed: true }).where(eq(ticketItems.id, Number(id)));
      }
      const items = await tx
        .select()
        .from(ticketItems)
        .where(and(eq(ticketItems.ticketId, rows[0].ticketId), eq(ticketItems.removed, false)));
      const total = items.reduce((s: number, i: { price: number; quantity: number }) => s + i.price * i.quantity, 0);
      await tx
        .update(tickets)
        // Stamp the correction moment (see PUT above): a removal from a
        // printed bill also changes what the EFD receipt claims.
        .set({ totalAmount: total, updatedAt: new Date(), itemsEditedAt: new Date() })
        .where(eq(tickets.id, rows[0].ticketId));
      await recordTicketEvent(tx, {
        ticketId: rows[0].ticketId,
        eventType: "item_removed",
        actorName,
        actorRole,
        itemId: rows[0].id,
        itemName: rows[0].name,
        fromValue: `${rows[0].name} ×${rows[0].quantity}`,
        toValue: hard ? "deleted" : "removed",
        details: `${rows[0].name} was removed from the bill`,
      });
      await recordTicketEvent(tx, {
        ticketId: rows[0].ticketId,
        eventType: "item_edited",
        actorName,
        actorRole,
        itemId: rows[0].id,
        itemName: rows[0].name,
        details: `${rows[0].name} was removed from the bill`,
      });
    });

    // Removing a dish the crew ALREADY STARTED must stop them ("do not
    // prepare"). But a dish still PENDING was never in the pan — nobody needs
    // an alarm for it, the screens just update (this is also what keeps the
    // waiter's own bill-editor removals silent for the kitchen).
    const wasPending = !rows[0].stationStatus || rows[0].stationStatus === "pending";
    try {
      const ticket = await ticketOf(rows[0].ticketId);
      if (ticket) {
        if (!wasPending) {
          ring(
            itemRemovedAlerts({
              id: ticket.id,
              tableName: ticket.tableName,
              totalAmount: ticket.totalAmount,
              itemName: rows[0].name,
              station: rows[0].stationName,
            }),
            actorRole
          );
        }
        // A removal from a printed bill changes what the EFD receipt claims:
        // the cashier must re-key it (skipped when she removed it herself).
        if (isPrintedBill(ticket)) {
          ring(
            itemEditedAfterPrintAlerts({
              id: ticket.id,
              tableName: ticket.tableName,
              totalAmount: ticket.totalAmount,
              itemName: rows[0].name,
              station: rows[0].stationName,
            }),
            actorRole
          );
        }
      }
    } catch {
      /* alerts must never fail a removal */
    }

    publish(CHANNELS.orders);
    return NextResponse.json({ success: true, id: Number(id) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
