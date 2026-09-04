"use client";

/**
 * In-page system notifications (the tab is open, maybe in the background).
 *
 * TWO bugs used to make these vanish:
 *
 *   1. The very first alert was dropped: the code only ASKED for permission
 *      and never showed the notification once it was granted.
 *   2. It used `new Notification(...)` — which THROWS on Android Chrome
 *      ("Illegal constructor"; Android only allows notifications through a
 *      service worker registration). Every staff phone therefore fell into the
 *      silent catch block, which is exactly the device that must ring.
 *
 * Now we show through the service worker registration when there is one (all
 * mobile browsers) and fall back to the constructor on desktop.
 */

interface NotificationProps {
  message: string;
  title?: string;
  icon?: string;
  /** Same-tag notifications replace each other instead of piling up. */
  tag?: string;
  /** Keep it on screen until it is tapped (something must be done). */
  urgent?: boolean;
  /** Where tapping the notification should take the user. */
  url?: string;
}

/**
 * When a Web Push for the same event already reached this device, the OS has
 * ALREADY shown (and rung) a notification. The page's own detector would then
 * stack a second one for the same order. The service-worker relay calls
 * `markPushHandled()`, and any in-page notification within this window is
 * skipped: one event, one notification. The loud in-app alarm still plays.
 */
const PUSH_DEDUPE_MS = 15_000;
let lastPushAt = 0;

export function markPushHandled() {
  lastPushAt = Date.now();
}

export function pushJustHandled(): boolean {
  return Date.now() - lastPushAt < PUSH_DEDUPE_MS;
}

function vibratePhone() {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate([300, 100, 300, 100, 300]);
    }
  } catch {
    /* ignore */
  }
}

export function triggerDesktopNotification({
  message,
  title = "Fana Cafe Alert",
  icon = "/logo.png",
  tag = "fana-cafe-notification",
  urgent = true,
  url,
}: NotificationProps) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  // The system notification from Web Push already rang for this event.
  if (pushJustHandled()) {
    vibratePhone();
    return;
  }

  const show = async () => {
    vibratePhone(); // pocket: felt even when the room is loud
    // Preferred path: the service worker. Works on Android + desktop, and the
    // notification survives the page being backgrounded.
    try {
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.getRegistration("/");
        if (reg) {
          await reg.showNotification(title, {
            body: message,
            icon,
            badge: icon,
            tag,
            renotify: true,
            requireInteraction: urgent,
            silent: false,
            vibrate: [300, 100, 300, 100, 300],
            data: { url: url || window.location.pathname },
          } as NotificationOptions);
          return;
        }
      }
    } catch {
      /* fall through to the desktop constructor */
    }

    try {
      const n = new Notification(title, {
        body: message,
        icon,
        badge: icon,
        tag,
        requireInteraction: false,
        silent: false, // let the OS play its notification sound too
      });
      n.onclick = () => {
        try {
          window.focus();
          n.close();
        } catch {
          /* ignore */
        }
      };
      // Auto-close so old alerts don't pile up in the tray.
      setTimeout(() => n.close(), 12_000);
    } catch {
      /* some platforms throw on constructor — never break the app for a bell */
    }
  };

  if (Notification.permission === "granted") {
    void show();
    return;
  }

  if (Notification.permission === "default") {
    // ASK and then ACTUALLY SHOW once granted (the old code only asked).
    Notification.requestPermission()
      .then((p) => {
        if (p === "granted") void show();
      })
      .catch(() => {});
  }
  // "denied" → the user said no; the in-app sound + web push still cover them.
}
