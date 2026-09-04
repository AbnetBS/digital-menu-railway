import { NextResponse } from "next/server";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq } from "drizzle-orm";
import { requireStaff } from "@/lib/session";
import { sendPushToRoles, urlForRole } from "@/lib/push";

/**
 * POST /api/push/test — ring THIS staff role's devices for real.
 *
 * Staff kept asking "is my phone actually armed?" and the only previous test
 * showed a notification locally in the browser, which proves nothing: it never
 * touches the push service, so a dead subscription still looked fine.
 *
 * This route takes the full production path (VAPID → push service → service
 * worker → system notification). With `delaySeconds` the waiter can lock the
 * phone, drop it in a pocket and hear whether pocket mode really works.
 */
export async function POST(request: Request) {
  const __auth = await requireStaff();
  if (!__auth.ok) return __auth.response;
  const staff = __auth.session;
  await ensureTablesExist();
  try {
    const body = await request.json().catch(() => ({}));
    const delaySeconds = Math.max(0, Math.min(60, Number(body?.delaySeconds) || 0));

    const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.role, staff.role));
    if (subs.length === 0) {
      return NextResponse.json(
        {
          success: false,
          sent: 0,
          error: "No device is subscribed for your role yet. Tap 'Arm pocket alerts' and allow notifications.",
        },
        { status: 409 }
      );
    }

    const payload = {
      title: "🔔 Fana test alert",
      body:
        delaySeconds > 0
          ? `Pocket test for ${staff.name || staff.role}. If you hear this with the screen off, alerts work.`
          : `Pocket alerts are working for ${staff.name || staff.role}.`,
      // Unique tag so repeated tests always ring instead of replacing silently.
      tag: `fana-test-${Date.now()}`,
      url: urlForRole(staff.role),
      urgent: true,
      repeat: 1,
    };

    if (delaySeconds > 0) {
      // Fire later so the phone can be locked first (single-instance app, so a
      // plain timer is the right tool — no queue infrastructure needed).
      setTimeout(() => {
        void sendPushToRoles([staff.role], payload);
      }, delaySeconds * 1000);
    } else {
      void sendPushToRoles([staff.role], payload);
    }

    return NextResponse.json({ success: true, sent: subs.length, delaySeconds, role: staff.role });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
