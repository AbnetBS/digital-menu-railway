import webpush from "web-push";
import { db } from "@/db";
import { siteSettings, pushSubscriptions, staffUsers } from "@/db/schema";
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
  // THE OWNER'S PHONE: the one notification that still exists (the daily total
  // the cashier sends at closing time) opens straight onto the Daily Sales
  // page of the dashboard.
  if (role === "admin") return "/admin?tab=sales";
  if (role === "cashier") return "/cashier";
  if (role === "kitchen") return "/kitchen";
  if (role === "barista") return "/barista";
  // The traditional-coffee crew takes orders like a waiter but works its own
  // lane, so it has its own screen.
  if (role === "buna") return "/buna";
  // The juice maker has their own tablet and their own lane, like the kitchen.
  if (role === "juice") return "/juice";
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
  /**
   * Extra rings while nobody has looked at the app. Every event rings once
   * (repeat: 0); the ONLY repeat left in the system is the shared
   * CUSTOMER_ALERT_RING burst below, whose quick rings are one ~3 second
   * alarm, not repeats. Max 3.
   */
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

type PushSub = typeof pushSubscriptions.$inferSelect;

/**
 * POCKET OFF-DUTY SWITCH (owner's decision, Sept 2026): staff phones kept
 * ringing at home after the shift ended. A staff member who tapped "Off duty"
 * in their app must not be rung anywhere. The switch is per PERSON
 * (staff_users.notifications_enabled), so every device subscribed under their
 * name goes silent with that one tap.
 *
 * FAIL-OPEN ON PURPOSE: a subscription with no name (very old rows), a name
 * that matches no staff record, or a database hiccup still rings. A missed
 * order alarm is far worse than one extra ring - only a person who
 * EXPLICITLY switched off is skipped.
 */
async function dropMutedSubs(subs: PushSub[]): Promise<PushSub[]> {
  try {
    const muted = await db
      .select({ name: staffUsers.name })
      .from(staffUsers)
      .where(eq(staffUsers.notificationsEnabled, false));
    if (muted.length === 0) return subs;
    const off = new Set(
      muted
        .map((m) => (m.name || "").trim().toLowerCase())
        .filter((n) => n.length > 0)
    );
    if (off.size === 0) return subs;
    return subs.filter((s) => {
      const n = (s.name || "").trim().toLowerCase();
      // A device we cannot attribute to a person can never be muted.
      return !n || !off.has(n);
    });
  } catch {
    // Never let this switch become a silence outage for the whole cafe.
    return subs;
  }
}

/** Deliver one payload to an already-fetched subscription list. */
async function deliverToSubs(subs: PushSub[], payload: PushPayload): Promise<void> {
  try {
    // Off-duty staff first: their devices must hear nothing at home.
    const live = await dropMutedSubs(subs);
    if (live.length === 0) return;
    const keys = await getVapidKeys();
    if (!keys) return;
    webpush.setVapidDetails("mailto:owner@fanacafe.example", keys.publicKey, keys.privateKey);

    await Promise.all(
      live.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            JSON.stringify({
              urgent: true,
              // Every event rings EXACTLY ONCE: 0 extra rings. The only
              // exception is a payload that carries its own repeat — the
              // shared CUSTOMER_ALERT_RING burst (whose four quick rings are
              // one ~3 second alarm, not repeats).
              repeat: 0,
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

/**
 * Fire-and-forget push to every device subscribed under the given roles.
 * NEVER throws and never blocks the caller — a push outage must not slow down
 * or fail an order. Dead endpoints (410/404) are pruned automatically.
 */
export async function sendPushToRoles(roles: string[], payload: PushPayload): Promise<void> {
  if (roles.length === 0) return;
  try {
    const subs = await db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.role, roles));
    if (subs.length === 0) return;
    await deliverToSubs(subs, payload);
  } catch {
    // push must never take the order flow down with it
  }
}

/**
 * Push to ONE named staff member — whoever OWNS the table.
 *
 * Subscriptions already store the staff name (taken from the session at
 * subscribe time), so "food ready" and "bill requested" ring only her phone
 * instead of every waiter's (owner's decision, Sept 2026).
 *
 * THE OWNER IS NOT ALWAYS A WAITER (Sept 2026): when the room is full the buna
 * makers take orders too, so the name on a ticket can belong to someone whose
 * device is subscribed under a different role. The lookup is therefore BY NAME
 * across every role, and the payload's url still resolves per subscription, so
 * tapping the notification opens the screen that person actually works on.
 *
 * SAFE FALLBACK: when the name is unknown, or that person has no live
 * subscription (new phone, alerts never armed), the whole ROLE is rung instead.
 * A missed "food ready" is worse than an extra ring.
 */
export async function sendPushToNamedStaff(
  role: string,
  staffName: string | null | undefined,
  payload: PushPayload
): Promise<void> {
  const name = (staffName || "").trim();
  if (!name) return sendPushToRoles([role], payload);
  try {
    // OFF-DUTY OWNER: this person switched their alerts off for the day, and
    // ringing them is exactly the at-home noise the switch exists to stop.
    // But their tables may still need serving, so the ROLE is rung instead
    // (dropMutedSubs inside strips everyone else who is off duty too). Same
    // philosophy as the unknown-name fallback: a missed "food ready" is
    // worse than an extra ring.
    const owner = await db
      .select({ enabled: staffUsers.notificationsEnabled })
      .from(staffUsers)
      .where(eq(staffUsers.name, name))
      .limit(1);
    if (owner.length > 0 && owner[0].enabled === false) {
      return sendPushToRoles([role], payload);
    }
    const matches = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.name, name));
    if (matches.length === 0) return sendPushToRoles([role], payload);
    await deliverToSubs(matches, payload);
  } catch {
    await sendPushToRoles([role], payload).catch(() => {});
  }
}
