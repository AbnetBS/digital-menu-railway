import webpush from "web-push";
import { db } from "@/db";
import { siteSettings, pushSubscriptions } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";

/**
 * WEB PUSH ("pocket mode") — Group 10.
 *
 * A web page can only ring while its tab is open; once the waiter's phone is
 * in her pocket with the browser closed, only the operating system can reach
 * her. Web Push does exactly that: the server calls the push service, Android/
 * iOS shows a SYSTEM notification with sound and vibration — same as WhatsApp —
 * and tapping it opens the right staff screen.
 *
 *   Android Chrome: works with the browser closed. ✅
 *   iPhone: works ONLY when the app is installed to the Home Screen
 *           (Share → Add to Home Screen) — Apple's rule, not ours.
 *
 * VAPID keys identify this server to the push services. They are generated
 * once, stored in site_settings (the private half never leaves the server and
 * is filtered from /api/settings like a password), and cached per process.
 * No environment variable to configure — it self-heals, like everything else.
 */

let cached: { publicKey: string; privateKey: string } | null = null;

export async function getVapidKeys(): Promise<{ publicKey: string; privateKey: string } | null> {
  if (cached) return cached;
  try {
    const rows = await db.select().from(siteSettings).where(inArray(siteSettings.key, ["vapid_public", "vapid_private"]));
    const pub = rows.find((r) => r.key === "vapid_public")?.value;
    const priv = rows.find((r) => r.key === "vapid_private")?.value;
    if (pub && priv) {
      cached = { publicKey: pub, privateKey: priv };
      return cached;
    }
    // First run (or the owner wiped settings): generate and persist a pair.
    const generated = webpush.generateVAPIDKeys();
    const inserts = [
      { key: "vapid_public", value: generated.publicKey },
      { key: "vapid_private", value: generated.privateKey },
    ];
    for (const row of inserts) {
      const existing = await db.select().from(siteSettings).where(eq(siteSettings.key, row.key));
      if (existing.length === 0) await db.insert(siteSettings).values(row);
    }
    cached = generated;
    return cached;
  } catch {
    // DB unavailable → push disabled for this request, everything else works
    return null;
  }
}

export function urlForRole(role: string): string {
  if (role === "cashier") return "/cashier";
  if (role === "kitchen") return "/kitchen";
  if (role === "barista") return "/barista";
  return "/waiter";
}

export interface PushPayload {
  title: string;
  body: string;
  /** Same-tag notifications replace each other instead of piling up. */
  tag?: string;
  url?: string;
  /**
   * Someone must ACT on this (new order, added items, bill request). The
   * service worker then keeps the notification on the lock screen until it is
   * tapped instead of letting it fade away unnoticed.
   */
  urgent?: boolean;
  /** Extra rings while nobody has looked at the app. Max 3. */
  repeat?: number;
  /**
   * Milliseconds between those rings. Customer-triggered events (a new QR
   * order, a guest adding items, a bill request) use a TIGHT gap so the phone
   * produces one continuous ~3 second alarm instead of a single short ding
   * that is lost in a busy room. Everything else uses the calm default.
   */
  gapMs?: number;
  /**
   * "customer" marks the three unpredictable guest actions. Staff screens turn
   * these into a full-screen prompt with one big button, and the phone rings
   * its hardest for them.
   */
  kind?: "customer" | "staff";
  /** Ticket behind the alert: enables the one-tap Confirm on the notification. */
  ticketId?: number;
  /** Extra button on the system notification, e.g. confirm without opening. */
  action?: "confirm" | null;
}

/** The 3 second alarm burst used for anything a GUEST just did. */
export const CUSTOMER_ALERT_RING = { urgent: true as const, repeat: 3, gapMs: 1100, kind: "customer" as const };

/**
 * Fire-and-forget push to every device subscribed under the given roles.
 * NEVER throws and never blocks the caller — a push outage must not slow down
 * or fail an order. Dead endpoints (410/404) are pruned automatically.
 */
export async function sendPushToRoles(roles: string[], payload: PushPayload): Promise<void> {
  if (roles.length === 0) return;
  try {
    const keys = await getVapidKeys();
    if (!keys) return;
    webpush.setVapidDetails("mailto:owner@fanacafe.example", keys.publicKey, keys.privateKey);

    const subs = await db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.role, roles));
    if (subs.length === 0) return;

    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            JSON.stringify({
              urgent: true,
              repeat: 2,
              ...payload,
              url: payload.url || urlForRole(sub.role),
            }),
            {
              // A restaurant alert is worthless late: ask the push service to
              // deliver it NOW (high urgency wakes a dozing Android phone) and
              // to drop it rather than hold it for hours if the device is off.
              urgency: "high",
              TTL: 900,
            }
          );
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          // Gone / not found → the subscription expired (app uninstalled,
          // browser cleaned up). Remove it so the table stays small.
          if (status === 404 || status === 410) {
            try {
              await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
            } catch {
              /* best effort */
            }
          }
          // 429 (too many requests) and network errors: just skip this one.
        }
      })
    );
  } catch {
    // push must never take the order flow down with it
  }
}
