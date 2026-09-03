import { NextResponse } from "next/server";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq } from "drizzle-orm";
import { requireStaff, requireStaffOrAdmin } from "@/lib/session";

/**
 * POST /api/push/subscribe — register THIS device for pocket-mode alerts.
 *
 * The role and staff name are taken from the SESSION cookie (server-side),
 * never from the request body: a logged-in waiter can only subscribe as a
 * waiter, so a stolen public key can never make a phone receive cashier
 * notifications. Admins are not subscribed — the admin panel has its own
 * desktop popup alerts.
 *
 * DELETE /api/push/subscribe?endpoint=... — unregister a device (logout of
 * alerts without logging out of the app).
 */
export async function POST(request: Request) {
  const __auth = await requireStaff();
  if (!__auth.ok) return __auth.response;
  const staff = __auth.session;
  await ensureTablesExist();
  try {
    const body = await request.json();
    const endpoint = String(body?.subscription?.endpoint || "");
    const p256dh = String(body?.subscription?.keys?.p256dh || "");
    const auth = String(body?.subscription?.keys?.auth || "");
    if (!endpoint || !p256dh || !auth) {
      return NextResponse.json({ error: "Valid push subscription required" }, { status: 400 });
    }

    // Upsert by endpoint: re-subscribing the same device refreshes its keys
    // instead of piling up dead rows.
    const existing = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    if (existing.length > 0) {
      await db
        .update(pushSubscriptions)
        .set({ p256dh, auth, role: staff.role, name: staff.name, createdAt: new Date() })
        .where(eq(pushSubscriptions.id, existing[0].id));
    } else {
      await db.insert(pushSubscriptions).values({ endpoint, p256dh, auth, role: staff.role, name: staff.name });
    }
    return NextResponse.json({ success: true, role: staff.role });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const __auth = await requireStaffOrAdmin();
  if (!__auth.ok) return __auth.response;
  await ensureTablesExist();
  try {
    const { searchParams } = new URL(request.url);
    const endpoint = searchParams.get("endpoint");
    if (!endpoint) return NextResponse.json({ error: "endpoint required" }, { status: 400 });
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
