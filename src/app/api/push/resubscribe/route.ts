import { NextResponse } from "next/server";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq } from "drizzle-orm";
import { readAdminSession, readStaffSession, requireStaffOrAdmin } from "@/lib/session";

/**
 * POST /api/push/resubscribe — the push service rotated this device's keys
 * (pushsubscriptionchange in the service worker). Same trust model as
 * /api/push/subscribe: role/name come from the session cookie, never the body.
 *
 * THE OWNER IS SERVED HERE TOO (fixed 3 Oct 2026). This route used to require
 * a STAFF session, but the only phone this cafe rings today is the OWNER's:
 * his dashboard subscribes under the admin session and the daily total is sent
 * to role "admin". So when the push service rotated the keys on his phone, the
 * worker called this route, got a 401, and the new endpoint was never stored.
 * The old row stayed in the table until the push service answered 410 and
 * pruned it - and from then on the owner's phone was deaf while his Daily
 * Sales page still said "Notifications on". That is precisely the "I allowed
 * notifications and never received the total" report, and it is why the
 * resubscribe route accepts the admin session now, with the same precedence as
 * /api/push/subscribe: the owner first, then the crew member.
 */
export async function POST(request: Request) {
  const staffSession = await readStaffSession();
  const adminSession = await readAdminSession();
  if (!staffSession && !adminSession) {
    const __auth = await requireStaffOrAdmin();
    if (!__auth.ok) return __auth.response;
  }
  const role = adminSession ? "admin" : staffSession?.role || "waiter";
  const name = adminSession ? "Owner" : staffSession?.name || "staff";
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
