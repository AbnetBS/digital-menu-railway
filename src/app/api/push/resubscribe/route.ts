import { NextResponse } from "next/server";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq } from "drizzle-orm";
import { requireStaff } from "@/lib/session";

/**
 * POST /api/push/resubscribe — the push service rotated this device's keys
 * (pushsubscriptionchange in the service worker). Same trust model as
 * /api/push/subscribe: role/name come from the session cookie, never the body.
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
    const oldEndpoint = body?.oldEndpoint ? String(body.oldEndpoint) : null;
    if (!endpoint || !p256dh || !auth) {
      return NextResponse.json({ error: "Valid push subscription required" }, { status: 400 });
    }

    if (oldEndpoint && oldEndpoint !== endpoint) {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, oldEndpoint));
    }

    const existing = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    if (existing.length > 0) {
      await db
        .update(pushSubscriptions)
        .set({ p256dh, auth, role: staff.role, name: staff.name, createdAt: new Date() })
        .where(eq(pushSubscriptions.id, existing[0].id));
    } else {
      await db.insert(pushSubscriptions).values({ endpoint, p256dh, auth, role: staff.role, name: staff.name });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
