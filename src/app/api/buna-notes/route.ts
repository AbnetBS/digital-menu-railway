import { NextResponse } from "next/server";
import { and, desc, eq, gte, isNull, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { bunaNotes, menuItems } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { effectivePrice } from "@/lib/price";
import { requireStaffOrAdmin, readStaffSession } from "@/lib/session";
import { publish, CHANNELS } from "@/lib/realtime";
import { etStartOfToday } from "@/lib/timezone";

export const dynamic = "force-dynamic";

/**
 * THE COFFEE NOTE (owner's decision, Sept 2026) — the cashier's held tab for
 * OUTDOOR buna sales.
 *
 * The buna makers sell traditional coffee outside (gate, parking, the offices
 * next door) and they do not watch their phones, so those sales can never go
 * through the station flow: an outdoor buna order would sit "pending" forever.
 * Instead:
 *
 *   a call comes in → POST (item defaults to the menu's buna, quantity,
 *   place note) → the note is HELD here, invisible to the outdoor orders list
 *   and to every station screen → the buna maker settles up → POST /pay →
 *   only then is a real outdoor ticket created, born paid, straight into
 *   order history with the Outdoor corner badge.
 *
 * PRICE AUTHORITY: the client never sends a price or a name. The server
 * resolves the menu item (explicit pick, or the menu's buna as the default)
 * and snapshots its effective price, so a manipulated request cannot invent
 * amounts that would corrupt bills and reports.
 */

/** How many of today's settled notes ride along (the "already paid" strip). */
const PAID_TODAY_LIMIT = 30;

/** One held note row may hold between 1 and this many cups. */
const MAX_NOTE_QUANTITY = 99;

interface ResolvedItem {
  id: number;
  name: string;
  category: string | null;
  price: number;
}

/**
 * Resolve the item for a note. An explicit menuItemId must exist; no pick
 * means "buna as default": the first menu item flagged Traditional buna, else
 * the first whose name says buna. Returns null when the menu has no buna item
 * and none was picked (the client must then choose one).
 */
async function resolveNoteItem(menuItemId: unknown): Promise<ResolvedItem | null | "missing"> {
  const wanted = Number(menuItemId);
  if (Number.isInteger(wanted) && wanted > 0) {
    const rows = await db.select().from(menuItems).where(eq(menuItems.id, wanted)).limit(1);
    if (rows.length === 0) return "missing";
    return { id: rows[0].id, name: rows[0].name, category: rows[0].category ?? null, price: effectivePrice(rows[0]).price };
  }
  const all = await db.select().from(menuItems).orderBy(menuItems.id);
  const buna =
    all.find((m) => Boolean(m.isBuna)) ||
    all.find((m) => /buna/i.test(String(m.name || "")) && m.isAvailable !== false);
  if (!buna) return null;
  return { id: buna.id, name: buna.name, category: buna.category ?? null, price: effectivePrice(buna).price };
}

function normalizeQuantity(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_NOTE_QUANTITY) return 1;
  return n;
}

function normalizePlaceNote(value: unknown): string | null {
  const note = String(value || "").trim().replace(/\s+/g, " ").slice(0, 200);
  return note ? note : null;
}

/** Today's next note number: max seq of today's notes + 1 (restarts daily). */
async function nextSeqToday(): Promise<number> {
  const rows = await db
    .select({ maxSeq: sql<number>`coalesce(max(${bunaNotes.seq}), 0)::int` })
    .from(bunaNotes)
    .where(gte(bunaNotes.heldAt, etStartOfToday()));
  return (Number(rows[0]?.maxSeq) || 0) + 1;
}

/** GET: the Coffee Note page state — held notes + today's settled ones. */
export async function GET() {
  const auth = await requireStaffOrAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  try {
    const held = await db.select().from(bunaNotes).where(isNull(bunaNotes.paidAt)).orderBy(desc(bunaNotes.heldAt));
    const paidToday = await db
      .select()
      .from(bunaNotes)
      .where(and(isNotNull(bunaNotes.paidAt), gte(bunaNotes.paidAt, etStartOfToday())))
      .orderBy(desc(bunaNotes.paidAt))
      .limit(PAID_TODAY_LIMIT);
    return NextResponse.json({ held, paidToday }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[buna-notes GET]", error);
    return NextResponse.json({ error: "Could not load the coffee notes" }, { status: 500 });
  }
}

/** POST: hold a new note (the cashier just took a call). */
export async function POST(request: Request) {
  const auth = await requireStaffOrAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  try {
    const body = await request.json().catch(() => ({}));
    const session = await readStaffSession();
    const actor = (session?.name || (auth.session.kind === "admin" ? "admin" : "(cashier)")).slice(0, 100);

    const item = await resolveNoteItem(body?.menuItemId);
    if (item === "missing") {
      return NextResponse.json({ error: "That menu item does not exist" }, { status: 400 });
    }
    if (!item) {
      return NextResponse.json(
        { error: "No buna item on the menu. Pick an item for this note." },
        { status: 400 }
      );
    }

    const inserted = await db
      .insert(bunaNotes)
      .values({
        seq: await nextSeqToday(),
        menuItemId: item.id,
        itemName: item.name.slice(0, 200),
        unitPrice: item.price,
        quantity: normalizeQuantity(body?.quantity),
        placeNote: normalizePlaceNote(body?.placeNote),
        heldBy: body?.heldBy ? String(body.heldBy).slice(0, 100) : actor,
      })
      .returning();

    publish(CHANNELS.orders);
    return NextResponse.json({ note: inserted[0] }, { status: 201 });
  } catch (error) {
    console.error("[buna-notes POST]", error);
    return NextResponse.json({ error: "Could not hold this note. Try again." }, { status: 500 });
  }
}

/** PUT: edit a HELD note (item, amount or place). Paid notes are read-only. */
export async function PUT(request: Request) {
  const auth = await requireStaffOrAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  try {
    const body = await request.json().catch(() => ({}));
    const id = Number(body?.id);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "Note ID required" }, { status: 400 });
    }

    const rows = await db.select().from(bunaNotes).where(eq(bunaNotes.id, id)).limit(1);
    if (rows.length === 0) return NextResponse.json({ error: "Note not found" }, { status: 404 });
    if (rows[0].paidAt) {
      return NextResponse.json({ error: "This note is already paid and lives in order history" }, { status: 409 });
    }

    const updates: Record<string, unknown> = {};
    if (body?.menuItemId !== undefined && body?.menuItemId !== null) {
      const item = await resolveNoteItem(body.menuItemId);
      if (item === "missing" || !item) {
        return NextResponse.json({ error: "That menu item does not exist" }, { status: 400 });
      }
      updates.menuItemId = item.id;
      updates.itemName = item.name.slice(0, 200);
      updates.unitPrice = item.price;
    }
    if (body?.quantity !== undefined) updates.quantity = normalizeQuantity(body.quantity);
    if (body?.placeNote !== undefined) updates.placeNote = normalizePlaceNote(body.placeNote);

    const updated = await db.update(bunaNotes).set(updates).where(eq(bunaNotes.id, id)).returning();
    publish(CHANNELS.orders);
    return NextResponse.json({ note: updated[0] });
  } catch (error) {
    console.error("[buna-notes PUT]", error);
    return NextResponse.json({ error: "Could not update this note. Try again." }, { status: 500 });
  }
}

/** DELETE: drop a HELD note (a wrong take — it never was an order). */
export async function DELETE(request: Request) {
  const auth = await requireStaffOrAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  try {
    const { searchParams } = new URL(request.url);
    const id = Number(searchParams.get("id") || 0);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "Note ID required" }, { status: 400 });
    }

    const rows = await db.select().from(bunaNotes).where(eq(bunaNotes.id, id)).limit(1);
    if (rows.length === 0) return NextResponse.json({ error: "Note not found" }, { status: 404 });
    if (rows[0].paidAt) {
      return NextResponse.json(
        { error: "Paid notes belong to order history and cannot be deleted" },
        { status: 409 }
      );
    }

    await db.delete(bunaNotes).where(eq(bunaNotes.id, id));
    publish(CHANNELS.orders);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[buna-notes DELETE]", error);
    return NextResponse.json({ error: "Could not delete this note. Try again." }, { status: 500 });
  }
}
