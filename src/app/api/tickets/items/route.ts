import { isCashierItemLocked, CORRECTION_LOCK_MESSAGE } from "@/lib/cashier-corrections";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { tickets, ticketItems } from "@/db/schema";
import { recordTicketEvent } from "@/lib/ticket-audit";
import { ensureTablesExist } from "@/db/migrate";
import { eq, and } from "drizzle-orm";
import { requireStaffOrAdmin } from "@/lib/session";
import { publish, CHANNELS } from "@/lib/realtime";
import { readStaffSession } from "@/lib/session";

/*
 * PHONE NOTIFICATIONS ARE GONE (owner's decision, 29 Sept 2026): a corrected
 * quantity, a changed note and a removed dish used to ring the crew's phones
 * through @/lib/alerts. The owner removed every staff phone notification — the
 * crews read those moments on their screens (the alarm, the sound and the
 * realtime list) and the in-system cards cover the rest. The only phone that
 * still rings is the owner's, once, for the daily total
 * (see /api/reports/day-close).
 */

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
      if (__auth.session.kind === "staff" && actorRole === "cashier") {
        const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, before[0].ticketId)).for("update");
        const [item] = await tx.select().from(ticketItems).where(eq(ticketItems.id, before[0].id)).for("update");
        if (!ticket || !item || isCashierItemLocked(item, ticket)) throw new Error(CORRECTION_LOCK_MESSAGE);
      }

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

    // Corrections update every screen through the realtime channel below; the
    // crew that already started the line hears its alarm + sound from the live
    // list itself. No phone is rung (owner's decision, 29 Sept 2026).

    publish(CHANNELS.orders);
    return NextResponse.json({ ...updated[0], reopened });
  } catch (error) {
    if (error instanceof Error && error.message === CORRECTION_LOCK_MESSAGE) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
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
      if (__auth.session.kind === "staff" && actorRole === "cashier") {
        const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, rows[0].ticketId)).for("update");
        const [item] = await tx.select().from(ticketItems).where(eq(ticketItems.id, rows[0].id)).for("update");
        if (!ticket || !item || isCashierItemLocked(item, ticket)) throw new Error(CORRECTION_LOCK_MESSAGE);
      }
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

    // A removed dish updates the crew's screen through the realtime channel
    // below, with its own alarm + sound from the live list. No phone is rung
    // (owner's decision, 29 Sept 2026).

    publish(CHANNELS.orders);
    return NextResponse.json({ success: true, id: Number(id) });
  } catch (error) {
    if (error instanceof Error && error.message === CORRECTION_LOCK_MESSAGE) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
