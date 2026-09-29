import { NextResponse } from "next/server";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq } from "drizzle-orm";
import { readAdminSession, readStaffSession, requireStaffOrAdmin } from "@/lib/session";

/**
 * POST /api/push/subscribe — register THIS device for phone alerts.
 *
 * WHO STILL GETS THEM (owner's decision, 29 Sept 2026): only the OWNER. Every
 * staff phone notification was removed (the crews and the waiters read their
 * moments on the screens: alarm, sound, voice and the in-system cards), and the
 * one notification left is today's total sale, sent when the cashier closes the
 * day. So this route now subscribes the ADMIN dashboard's device as role
 * "admin"; a staff session may still subscribe (older devices keep working),
 * but no route sends role notifications any more.
 *
 * The role and name are taken from the SESSION cookie (server-side), never from
 * the request body: a device can only ever subscribe as the person who is
 * signed in on it.
 *
 * DELETE /api/push/subscribe?endpoint=... — unregister a device (logout of
 * alerts without logging out of the app).
 */
export async function POST(request: Request) {
  const staffSession = await readStaffSession();
  let role = "admin";
  let name = "Owner";
  if (staffSession) {
    role = staffSession.role;
    name = staffSession.name;
  } else if (!(await readAdminSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
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
        .set({ p256dh, auth, role, name, createdAt: new Date() })
        .where(eq(pushSubscriptions.id, existing[0].id));
    } else {
      await db.insert(pushSubscriptions).values({ endpoint, p256dh, auth, role, name });
    }
    return NextResponse.json({ success: true, role });
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
