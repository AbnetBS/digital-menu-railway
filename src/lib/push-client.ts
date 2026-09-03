"use client";

/**
 * Client side of POCKET-MODE alerts (Group 10).
 *
 * Call `enablePocketAlerts()` from a user gesture (the LOGIN button is the
 * perfect one — it satisfies the browser's "user interacted" requirement for
 * audio, notifications and push all at once). It:
 *   1. registers the service worker,
 *   2. asks for notification permission,
 *   3. subscribes this device to Web Push with the server's VAPID key,
 *   4. stores the subscription server-side under the logged-in staff role.
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

export async function enablePocketAlerts(): Promise<PushEnableResult> {
  if (!pushSupported()) return "unsupported";
  try {
    // 1. permission first — without "granted" nothing else matters.
    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }
    if (permission !== "granted") return "denied";

    // 2. service worker
    const reg = await navigator.serviceWorker.register("/sw.js");

    // 3. existing subscription?
    let sub = await reg.pushManager.getSubscription();
    const keyRes = await fetch("/api/push/public-key");
    if (!keyRes.ok) return "error";
    const { publicKey } = await keyRes.json();
    if (!publicKey) return "error";

    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
      });
    }

    // 4. tell the server (role comes from the session cookie, not from here)
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    if (!res.ok) return "error";
    const data = await res.json().catch(() => ({}));
    if (data && data.success === false) return "error";
    return "subscribed";
  } catch {
    return "error";
  }
}

/** Test ring so staff can verify their device right after enabling (no guesswork). */
export async function testPocketAlert(): Promise<void> {
  try {
    if (!pushSupported()) return;
    const reg = await navigator.serviceWorker.getRegistration();
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
