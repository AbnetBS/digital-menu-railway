import { NextResponse } from "next/server";
import { db } from "@/db";
import { pushSubscriptions, staffUsers } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq } from "drizzle-orm";
import { readAdminSession, readStaffSession, requireStaff } from "@/lib/session";
import { sendPushToRoles, urlForRole } from "@/lib/push";

/**
 * POST /api/push/test — ring THIS role's devices for real.
 *
 * The only phone that still receives notifications is the OWNER's (the daily
 * total), so this route serves the owner's device: it can be signed in with the
 * ADMIN session here. A staff session still works, for the one remaining case
 * where a device was subscribed before the staff notifications were removed.
 *
 * This route takes the full production path (VAPID → push service → service
 * worker → system notification). With `delaySeconds` the owner can lock the
 * phone, walk away and hear whether it really rings.
 */
export async function POST(request: Request) {
  const staffSession = await readStaffSession();
  let role = "admin";
  let displayName = "Owner";
  if (staffSession) {
    const __auth = await requireStaff();
    if (!__auth.ok) return __auth.response;
    role = staffSession.role;
    displayName = staffSession.name;
    // OFF-DUTY staff would hear NOTHING from a test (their pushes are muted
    // server-side), which looks exactly like a broken phone. Say it plainly
    // instead of letting them chase a problem that is just the switch.
    const me = await db
      .select({ notificationsEnabled: staffUsers.notificationsEnabled })
      .from(staffUsers)
      .where(eq(staffUsers.id, staffSession.staffId))
      .limit(1);
    if (me.length > 0 && me[0].notificationsEnabled === false) {
      return NextResponse.json(
        {
          success: false,
          sent: 0,
          error: "Your alerts are switched OFF (off duty). Tap 'Back on duty' first, then test again.",
        },
        { status: 409 }
      );
    }
  } else if (!(await readAdminSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await ensureTablesExist();
  try {
    const body = await request.json().catch(() => ({}));
    const delaySeconds = Math.max(0, Math.min(60, Number(body?.delaySeconds) || 0));

    const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.role, role));
    if (subs.length === 0) {
      return NextResponse.json(
        {
          success: false,
          sent: 0,
          error: "No device is subscribed for this login yet. Tap the phone-alerts button on the Daily Sales page and allow notifications.",
        },
        { status: 409 }
      );
    }

    const payload = {
      title: "🔔 Fana test alert",
      body:
        delaySeconds > 0
          ? `Phone test for ${displayName}. If you hear this with the screen off, alerts work.`
          : `Phone alerts are working for ${displayName}.`,
      // Unique tag so repeated tests always ring instead of replacing silently.
      tag: `fana-test-${Date.now()}`,
      url: urlForRole(role),
      urgent: true,
      // One ring per event, even for a test: no push call may pass its own
      // repeat above 0 apart from the shared CUSTOMER_ALERT_RING burst.
      repeat: 0,
    };

    if (delaySeconds > 0) {
      // Fire later so the phone can be locked first (single-instance app, so a
      // plain timer is the right tool — no queue infrastructure needed).
      setTimeout(() => {
        void sendPushToRoles([role], payload);
      }, delaySeconds * 1000);
    } else {
      void sendPushToRoles([role], payload);
    }

    return NextResponse.json({ success: true, sent: subs.length, delaySeconds, role });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
