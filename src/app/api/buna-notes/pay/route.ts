import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { bunaNotes, menuItems, tickets, ticketItems } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { requireStaffOrAdmin, readStaffSession } from "@/lib/session";
import { publish, CHANNELS } from "@/lib/realtime";
import { recordTicketEvent } from "@/lib/ticket-audit";

export const dynamic = "force-dynamic";

/**
 * POST /api/buna-notes/pay — the buna maker settled up, the cashier taps PAID.
 *
 * This is the ONLY moment a coffee note touches the tickets world, and the
 * ticket is BORN FINISHED on purpose:
 *
 *   • status "paid" + paymentStatus "paid_cash"  → terminal, so it lands in
 *     order history (Printed Today / Recently Paid) like any settled bill,
 *     with the Outdoor corner badge from orderType "outdoor";
 *   • printedAt/verifiedAt stamped now           → it enters her daily
 *     EFD cross-check the moment she taps;
 *   • the single line is station "buna" / stationStatus "done" → no station
 *     screen ever queues it (every station query excludes finished bills),
 *     which is the whole point: the buna makers already made and sold this
 *     coffee outside, nobody needs to accept anything.
 *
 * The note row is claimed (paid_at stamped) inside the SAME transaction, so a
 * double-tap can never create two tickets.
 */

/** Same synthetic negative id the outdoor order flow uses (never a real table). */
function outdoorTableId(): number {
  return -(1_000_000 + Math.floor(Math.random() * 2_140_000_000));
}

export async function POST(request: Request) {
  const auth = await requireStaffOrAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  try {
    const body = await request.json().catch(() => ({}));
    const id = Number(body?.id);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "Note ID required" }, { status: 400 });
    }
    const session = await readStaffSession();
    const actor = (session?.name || (auth.session.kind === "admin" ? "admin" : "(cashier)")).slice(0, 100);
    const actorRole = session?.role || (auth.session.kind === "admin" ? "admin" : "cashier");

    const rows = await db.select().from(bunaNotes).where(eq(bunaNotes.id, id)).limit(1);
    if (rows.length === 0) return NextResponse.json({ error: "Note not found" }, { status: 404 });
    const note = rows[0];
    if (note.paidAt) {
      return NextResponse.json({ error: "This note is already paid" }, { status: 409 });
    }

    const now = new Date();
    const quantity = Math.max(1, Number(note.quantity) || 1);
    const total = Math.max(0, Number(note.unitPrice) || 0) * quantity;
    const label = `OUTDOOR • Coffee note #${note.seq}`.slice(0, 50);

    // Category for the bill line: from the live menu row when it still exists.
    let category: string | null = null;
    if (note.menuItemId) {
      const menuRows = await db.select().from(menuItems).where(eq(menuItems.id, note.menuItemId)).limit(1);
      category = menuRows[0]?.category ?? null;
    }

    const result = await db.transaction(async (tx) => {
      // 1. CLAIM the note first, guarded on it still being unpaid. Two
      //    concurrent PAID taps: the second UPDATE matches zero rows, the
      //    transaction rolls back, exactly one ticket exists.
      const claimed = await tx
        .update(bunaNotes)
        .set({ paidAt: now, paidBy: actor })
        .where(and(eq(bunaNotes.id, id), isNull(bunaNotes.paidAt)))
        .returning();
      if (claimed.length === 0) throw new Error("ALREADY_PAID");

      // 2. The outdoor ticket, born finished (see the header comment).
      const ticketRows = await tx
        .insert(tickets)
        .values({
          tableId: outdoorTableId(),
          tableName: label,
          orderType: "outdoor",
          serviceNote: note.placeNote ?? null,
          status: "paid",
          paymentStatus: "paid_cash",
          totalAmount: total,
          createdBy: note.heldBy || actor,
          confirmedBy: actor,
          confirmedAt: now,
          printedAt: now,
          printedBy: actor,
          verifiedBy: actor,
          verifiedAt: now,
          closedAt: now,
        })
        .returning();
      const ticket = ticketRows[0];
      await tx.update(tickets).set({ orderNumber: `FANA-${ticket.id}` }).where(eq(tickets.id, ticket.id));

      // 3. One bill line: buna lane, already done — no station ever sees it.
      await tx.insert(ticketItems).values({
        ticketId: ticket.id,
        menuItemId: note.menuItemId ?? null,
        name: note.itemName,
        category,
        price: Math.max(0, Number(note.unitPrice) || 0),
        quantity,
        notes: note.placeNote ?? null,
        stationName: "buna",
        stationStatus: "done",
        stationStatusBy: actor,
        stationStatusAt: now,
      });

      // 4. Audit trail, same as every other ticket.
      await recordTicketEvent(tx, {
        ticketId: ticket.id,
        eventType: "ticket_created",
        actorName: actor,
        actorRole,
        source: "staff",
        itemName: note.itemName,
        details: `Coffee note #${note.seq} settled • ${note.itemName} ×${quantity}${note.placeNote ? ` • ${note.placeNote}` : ""}`,
      });
      await recordTicketEvent(tx, {
        ticketId: ticket.id,
        eventType: "status_changed",
        actorName: actor,
        actorRole,
        source: "staff",
        toValue: "paid",
        details: `Paid from the Coffee Note page (outdoor buna tab)`,
      });

      // 5. Link the note to its ticket.
      await tx.update(bunaNotes).set({ ticketId: ticket.id }).where(eq(bunaNotes.id, id));

      return { ticketId: ticket.id, orderNumber: `FANA-${ticket.id}` };
    });

    publish(CHANNELS.orders);
    return NextResponse.json({ ok: true, noteId: id, ...result });
  } catch (error) {
    if (error instanceof Error && error.message === "ALREADY_PAID") {
      return NextResponse.json({ error: "This note is already paid" }, { status: 409 });
    }
    console.error("[buna-notes pay]", error);
    return NextResponse.json({ error: "Could not mark this note paid. Try again." }, { status: 500 });
  }
}
