/* eslint-disable */
/**
 * Fana Cafe — service worker for POCKET-MODE alerts (Group 10).
 *
 * This file is what makes notifications reach a phone whose browser is CLOSED.
 * The push service wakes this worker even when no page is open; we show a
 * SYSTEM notification (sound + vibration come from the OS, exactly like a
 * WhatsApp message) and tapping it opens the right staff screen.
 *
 * If a staff window IS open and focused, the page plays its own loud in-app
 * alarm already — showing a system notification too would be double noise, so
 * we skip it in that case.
 */
const FANA_ICON = "/logo.png";

self.addEventListener("push", (event) => {
  let data = { title: "Fana Cafe", body: "", tag: "fana-orders", url: "/waiter" };
  try {
    if (event.data) {
      const parsed = event.data.json();
      if (parsed && typeof parsed === "object") data = { ...data, ...parsed };
    }
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }

  event.waitUntil(
    (async () => {
      // Is one of our windows open and on-screen? Then the in-page alarm
      // already rang — don't stack a system notification on top of it.
      try {
        const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        const anyFocused = clientList.some((client) => client.focused);
        if (anyFocused) return;
      } catch (e) {
        /* matchAll unsupported → just show the notification */
      }

      await self.registration.showNotification(data.title, {
        body: data.body,
        tag: data.tag || "fana-orders",
        // Re-alert (sound + heads-up) even when an older notification with the
        // same tag is still in the tray — each new order deserves a ring.
        renotify: true,
        requireInteraction: false,
        icon: FANA_ICON,
        badge: FANA_ICON,
        vibrate: [400, 150, 400, 150, 400, 150, 400],
        data: { url: data.url },
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  const url = (event.notification.data && event.notification.data.url) || "/waiter";
  event.notification.close();
  event.waitUntil(
    (async () => {
      try {
        const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        // Focus an already-open window on the right page if there is one…
        for (const client of clientList) {
          if (new URL(client.url).pathname === url && "focus" in client) {
            return client.focus();
          }
        }
        // …otherwise open one.
        if (clientList.length > 0 && "focus" in clientList[0] && "navigate" in clientList[0]) {
          const focused = await clientList[0].focus();
          return focused.navigate(url);
        }
      } catch (e) {
        /* fall through to openWindow */
      }
      return self.clients.openWindow(url);
    })()
  );
});

// The push service rotates subscription keys from time to time; resubscribe
// with the new keys so the device keeps receiving alerts.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const reg = await self.registration.pushManager.getSubscription();
        if (!reg) return;
        await fetch("/api/push/resubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ oldEndpoint: event.oldSubscription ? event.oldSubscription.endpoint : null, subscription: reg }),
        });
      } catch (e) {
        /* best effort */
      }
    })()
  );
});
