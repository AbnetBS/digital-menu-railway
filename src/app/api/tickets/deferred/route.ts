import { NextResponse } from "next/server";
import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/db";
import { deferredTicketSends, siteSettings } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { requireStaff } from "@/lib/session";
import { waiterSendHoldSeconds, WAITER_SEND_HOLD_DEFAULT_SECONDS } from "@/lib/send-hold";

type DeferredOrderBody = {
  idempotencyKey?: unknown;
  order?: Record<string, unknown>;
};

function keyFrom(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 64) : "";
}

/** Save/update/cancel a waiter's not-yet-due order for the durable server worker. */
export async function POST(request: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();

  try {
    const body = (await request.json()) as DeferredOrderBody;
    const key = keyFrom(body?.idempotencyKey);
    const order = body?.order;
    const items = order?.items;
    const isGroupRound = order?.groupOrder === true && Number(order?.targetTicketId) > 0;
    const validTable = Number.isInteger(Number(order?.tableId)) && Number(order?.tableId) > 0;
    if (!key || !order || !Array.isArray(items) || items.length === 0 || (!validTable && !isGroupRound)) {
      return NextResponse.json({ error: "Invalid deferred order" }, { status: 400 });
    }

    const settingRows = await db.select().from(siteSettings).where(eq(siteSettings.key, "waiter_send_hold_seconds")).limit(1);
    const seconds = waiterSendHoldSeconds(settingRows[0]?.value ?? WAITER_SEND_HOLD_DEFAULT_SECONDS);
    const dueAt = new Date(Date.now() + seconds * 1000);
    const payload = {
      ...order,
      waiterName: auth.session.name,
      idempotencyKey: key,
      _deferredActorRole: auth.session.role,
    };

    const inserted = await db.insert(deferredTicketSends).values({
      idempotencyKey: key,
      payload: JSON.stringify(payload),
      dueAt,
      status: "pending",
      attempts: 0,
      createdBy: auth.session.name,
    }).onConflictDoNothing().returning({ idempotencyKey: deferredTicketSends.idempotencyKey, dueAt: deferredTicketSends.dueAt });

    if (inserted[0]) {
      return NextResponse.json({ idempotencyKey: key, dueAt: inserted[0].dueAt, holdSeconds: seconds });
    }

    // A network retry with the same key must not restart/extend its countdown.
    const existing = await db.select().from(deferredTicketSends)
      .where(eq(deferredTicketSends.idempotencyKey, key)).limit(1);
    if (!existing[0] || existing[0].createdBy !== auth.session.name) {
      return NextResponse.json({ error: "Deferred order not found" }, { status: 404 });
    }
    return NextResponse.json({ idempotencyKey: key, dueAt: existing[0].dueAt, holdSeconds: seconds });
  } catch (error) {
    console.error("Could not schedule deferred ticket:", error);
    return NextResponse.json({ error: "Could not schedule this order" }, { status: 500 });
  }
}

/** Update the saved lines while the waiter is still reviewing the order. */
export async function PATCH(request: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();

  try {
    const body = await request.json();
    const key = keyFrom(body?.idempotencyKey);
    const items = body?.items;
    if (!key || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: "Invalid deferred order update" }, { status: 400 });
    }
    const updated = await db.transaction(async (tx) => {
      const rows = await tx.select().from(deferredTicketSends)
        .where(and(
          eq(deferredTicketSends.idempotencyKey, key),
          eq(deferredTicketSends.createdBy, auth.session.name),
          eq(deferredTicketSends.status, "pending"),
          gt(deferredTicketSends.dueAt, new Date()),
        )).limit(1).for("update");
      if (!rows[0]) return false;

      const payload = JSON.parse(rows[0].payload) as Record<string, unknown>;
      payload.items = items;
      await tx.update(deferredTicketSends)
        .set({ payload: JSON.stringify(payload), updatedAt: new Date() })
        .where(eq(deferredTicketSends.idempotencyKey, key));
      return true;
    });
    if (!updated) return NextResponse.json({ error: "This order is already being sent" }, { status: 409 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Could not update deferred ticket:", error);
    return NextResponse.json({ error: "Could not save order changes" }, { status: 500 });
  }
}

/** Cancel a send hold; a due/claimed send is already being released. */
export async function DELETE(request: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();

  try {
    const { searchParams } = new URL(request.url);
    const key = keyFrom(searchParams.get("idempotencyKey"));
    if (!key) return NextResponse.json({ error: "Order key required" }, { status: 400 });
    const removed = await db.delete(deferredTicketSends).where(and(
      eq(deferredTicketSends.idempotencyKey, key),
      eq(deferredTicketSends.createdBy, auth.session.name),
      inArray(deferredTicketSends.status, ["pending", "failed"]),
    )).returning({ idempotencyKey: deferredTicketSends.idempotencyKey });
    return NextResponse.json({ success: true, cancelled: removed.length > 0 });
  } catch (error) {
    console.error("Could not cancel deferred ticket:", error);
    return NextResponse.json({ error: "Could not cancel this order" }, { status: 500 });
  }
}
