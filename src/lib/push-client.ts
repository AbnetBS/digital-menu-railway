"use client";

/**
 * Client side of POCKET-MODE alerts.
 *
 * `enablePocketAlerts()` runs from a user gesture (the LOGIN button is the
 * perfect one — it satisfies the browser's "user interacted" requirement for
 * audio, notifications and push all at once). It:
 *   1. registers/updates the service worker,
 *   2. asks for notification permission,
 *   3. subscribes this device to Web Push with the server's VAPID key,
 *   4. stores the subscription server-side under the logged-in staff role.
 *
 * `ensurePocketAlerts()` is the SELF-HEALING version: it never prompts, and it
 * is safe to call on every mount, whenever the tab becomes visible and on a
 * slow timer. Pocket alerts used to be armed ONLY at login, so any device that
 * reopened the app from a saved session (the normal case — staff rarely log in
 * twice) silently stopped receiving pushes as soon as anything invalidated the
 * subscription:
 *   • the push service expired/rotated the endpoint,
 *   • the server pruned it after a 410,
 *   • the VAPID keypair was regenerated (fresh database / settings wipe) —
 *     the phone keeps a subscription signed with the OLD key that the server
 *     can no longer push to. We now detect that key mismatch and resubscribe.
 *
 * From then on the phone receives system notifications (with sound) even when
 * the browser is closed — Android always; iPhone only when the app is
 * installed to the Home Screen (Apple's rule), which `iosPocketHint` detects.
 */

export type PushEnableResult =
  | "unsupported"
  | "denied"
  | "granted"
  | "subscribed"
  | "already"
  | "error";

export interface PocketAlertsStatus {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  /** True when the device is fully armed: permission granted + live subscription. */
  armed: boolean;
  /** iPhone/iPad that must be installed to the Home Screen first. */
  needsIosInstall: boolean;
  reason: string;
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** True on an iPhone/iPad where the app is NOT installed to the Home Screen. */
export function iosPocketHintNeeded(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent.toLowerCase();
  const isIOS = /iphone|ipad|ipod/.test(ua) || (ua.includes("macintosh") && "ontouchend" in document);
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return isIOS && !standalone;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Register (or reuse) the worker and make sure the newest sw.js is active. */
export async function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    const reg =
      (await navigator.serviceWorker.getRegistration("/")) ||
      (await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }));
    // Pull the newest worker: an old cached sw.js on a staff phone would keep
    // the old (silent) push behaviour alive forever.
    try {
      await reg.update();
    } catch {
      /* offline — the existing worker still runs */
    }
    if (reg.waiting) reg.waiting.postMessage({ type: "fana-skip-waiting" });
    return reg;
  } catch {
    return null;
  }
}

/** Does this subscription still match the server's current VAPID key? */
function keyMatches(sub: PushSubscription, publicKey: string): boolean {
  try {
    const applied = (sub.options as PushSubscriptionOptions | undefined)?.applicationServerKey;
    if (!applied) return true; // browser does not expose it — assume fine
    return bufferToBase64Url(applied as ArrayBuffer) === publicKey.replace(/=+$/, "");
  } catch {
    return true;
  }
}

/**
 * Why the last sync with the server failed, in words staff can act on. A green
 * "armed" chip must not lie: a phone can hold a perfectly valid subscription
 * while the SERVER no longer has the row (session expired, offline), which is
 * silence with no symptom.
 */
let lastSyncError = "";

async function subscribeAndStore(reg: ServiceWorkerRegistration): Promise<PushEnableResult> {
  const keyRes = await fetch("/api/push/public-key", { cache: "no-store" });
  if (!keyRes.ok) return "error";
  const { publicKey } = await keyRes.json();
  if (!publicKey) return "error";

  let sub = await reg.pushManager.getSubscription();

  // Stale key (server regenerated VAPID) → the endpoint can never be pushed
  // to again. Drop it and make a fresh one instead of failing forever.
  if (sub && !keyMatches(sub, publicKey)) {
    try {
      await sub.unsubscribe();
    } catch {
      /* ignore */
    }
    sub = null;
  }

  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
    });
  }

  // Always (re)send to the server: it is a cheap upsert and it repairs a row
  // the server pruned, or a role change on a shared device.
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });
  if (res.status === 401) {
    lastSyncError = "Your staff session expired. Log in again so alerts keep reaching this phone.";
    return "error";
  }
  if (!res.ok) {
    lastSyncError = "The server did not accept this device. Check the internet connection.";
    return "error";
  }
  const data = await res.json().catch(() => ({}));
  if (data && data.success === false) {
    lastSyncError = "The server did not accept this device. Check the internet connection.";
    return "error";
  }
  lastSyncError = "";
  return "subscribed";
}

/** Arm pocket alerts, ASKING for permission if needed. Call from a click. */
export async function enablePocketAlerts(): Promise<PushEnableResult> {
  if (!pushSupported()) return "unsupported";
  try {
    // 1. permission first — without "granted" nothing else matters.
    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }
    if (permission !== "granted") return "denied";

    // 2. service worker (freshest version)
    const reg = await registerWorker();
    if (!reg) return "error";
    // The worker must be active before it can own a push subscription.
    await navigator.serviceWorker.ready.catch(() => undefined);

    // 3 + 4. subscribe and store server-side
    return await subscribeAndStore(reg);
  } catch {
    return "error";
  }
}

/**
 * Keep pocket alerts alive WITHOUT ever prompting. Safe to call on mount, on
 * visibilitychange and on a timer — this is what stops "it worked yesterday,
 * today it is silent".
 */
export async function ensurePocketAlerts(): Promise<PushEnableResult> {
  if (!pushSupported()) return "unsupported";
  try {
    if (Notification.permission !== "granted") return "denied";
    const reg = await registerWorker();
    if (!reg) return "error";
    await navigator.serviceWorker.ready.catch(() => undefined);
    return await subscribeAndStore(reg);
  } catch {
    return "error";
  }
}

/** Everything the UI needs to tell staff whether their phone will ring. */
export async function pocketAlertsStatus(): Promise<PocketAlertsStatus> {
  const needsIosInstall = iosPocketHintNeeded();
  if (!pushSupported()) {
    return {
      supported: false,
      permission: "unsupported",
      subscribed: false,
      armed: false,
      needsIosInstall,
      reason: needsIosInstall
        ? "Add Fana to your Home Screen first (Share → Add to Home Screen)."
        : "This browser cannot do pocket alerts. Use Chrome on Android.",
    };
  }
  const permission = Notification.permission;
  let subscribed = false;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    if (reg) subscribed = !!(await reg.pushManager.getSubscription());
  } catch {
    /* ignore */
  }
  const armed = permission === "granted" && subscribed && !lastSyncError;
  return {
    supported: true,
    permission,
    subscribed,
    armed,
    needsIosInstall,
    reason: lastSyncError
      ? lastSyncError
      : armed
      ? "This phone will ring for new orders even with the screen off."
      : permission === "denied"
        ? "Notifications are BLOCKED for this site. Open the browser's site settings and allow notifications."
        : permission === "default"
          ? "Tap to allow notifications so this phone rings in your pocket."
          : "Tap to arm pocket alerts on this device.",
  };
}

/**
 * REAL end-to-end test: asks the SERVER to push this device, exactly like a new
 * order does. `delaySeconds` lets staff lock the phone and put it in a pocket
 * before it rings — the only honest way to test pocket mode.
 *
 * (The old helper only called showNotification() locally, which proves nothing:
 * it never touched the push service, so a broken subscription still "passed".)
 */
export async function sendTestPush(delaySeconds = 0): Promise<{ ok: boolean; sent: number; error?: string }> {
  try {
    const res = await fetch("/api/push/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delaySeconds }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, sent: 0, error: data?.error || `HTTP ${res.status}` };
    return { ok: true, sent: Number(data?.sent || 0) };
  } catch (err) {
    return { ok: false, sent: 0, error: String(err) };
  }
}

/** Local-only ring (does not touch the push service) — kept for quick checks. */
export async function testPocketAlert(): Promise<void> {
  try {
    if (!pushSupported()) return;
    const reg = await navigator.serviceWorker.getRegistration("/");
    if (!reg) return;
    await reg.showNotification("✓ Pocket alerts work!", {
      body: "You will hear this ring when new orders arrive, even with the browser closed.",
      tag: "fana-test",
      icon: "/logo.png",
    });
  } catch {
    /* ignore */
  }
}

export interface PushAlertMessage {
  type: string;
  title?: string;
  body?: string;
  tag?: string;
  url?: string;
  urgent?: boolean;
}

/**
 * Listen for pushes that arrived while THIS page was open. The worker relays
 * every push to its pages, so a visible tab rings the loud in-app alarm and
 * refreshes instantly — even if its SSE stream was frozen by the browser
 * (background tabs get throttled/frozen; a push is never throttled).
 */
export function onPushAlert(handler: (msg: PushAlertMessage) => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const listener = (event: MessageEvent) => {
    const data = event.data;
    if (data && (data.type === "fana-push" || data.type === "fana-push-opened")) handler(data);
  };
  navigator.serviceWorker.addEventListener("message", listener);
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}
