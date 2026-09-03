"use client";

/**
 * In-page system notifications (the tab is open but maybe in the background).
 *
 * Group 10 fix: the old version only ASKED for permission the first time and
 * then dropped the notification on the floor — so the very first alert staff
 * ever received was silence. Now the notification is sent as soon as the
 * permission is granted, and every alert vibrates the phone as well.
 */

interface NotificationProps {
  message: string;
  title?: string;
  icon?: string;
  /** Same-tag notifications replace each other instead of piling up. */
  tag?: string;
}

export function triggerDesktopNotification({
  message,
  title = "Fana Cafe Alert",
  icon = "/logo.png",
  tag = "fana-cafe-notification",
}: NotificationProps) {
  if (typeof window === "undefined" || !("Notification" in window)) return;

  const show = () => {
    try {
      const n = new Notification(title, {
        body: message,
        icon,
        badge: icon,
        tag,
        requireInteraction: false,
        silent: false, // let the OS play its notification sound too
      });
      // Phone in pocket with the page open: vibrate as well.
      try {
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          navigator.vibrate([300, 100, 300, 100, 300]);
        }
      } catch {
        /* ignore */
      }
      // Auto-close so old alerts don't pile up in the tray.
      setTimeout(() => n.close(), 12_000);
    } catch {
      /* some platforms throw on constructor — never break the app for a bell */
    }
  };

  if (Notification.permission === "granted") {
    show();
    return;
  }

  if (Notification.permission === "default") {
    // ASK and then ACTUALLY SHOW once granted (the old code only asked).
    Notification.requestPermission().then((p) => {
      if (p === "granted") show();
    }).catch(() => {});
  }
  // "denied" → the user said no; the in-app sound + web push still cover them.
}
