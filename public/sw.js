/* eslint-disable */
/**
 * Fana Cafe — service worker for POCKET-MODE alerts.
 *
 * This file is what makes an alert reach a phone that is IN A POCKET: screen
 * off, tab in the background, or the browser fully closed. The push service
 * wakes this worker even when no page is running; we show a SYSTEM
 * notification (sound + vibration come from the OS notification channel,
 * exactly like a WhatsApp message) and tapping it opens the right staff
 * screen.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE BUG THIS FILE USED TO HAVE (why staff heard nothing)
 * ─────────────────────────────────────────────────────────────────────────
 * The old version asked `clients.matchAll()` whether any window was "focused"
 * and, if so, showed NOTHING (to avoid double noise with the in-page alarm).
 *
 * A phone in a pocket with the waiter screen still open is EXACTLY that case:
 * the tab is still the focused window of the browser even though the screen
 * is off. So every real alert hit the `return` and the phone stayed silent —
 * the one moment the alarm mattered most.
 *
 * Worse, a push subscription is created with `userVisibleOnly: true`, which is
 * a PROMISE to the browser that every push shows a notification. Silently
 * swallowing pushes makes Chrome show "This site has been updated in the
 * background" and can eventually revoke the subscription altogether.
 *
 * NEW RULE — a push ALWAYS produces a notification. No exceptions.
 *   • Nobody looking at the screen  → loud notification, OS sound, vibration,
 *     it stays in the tray until tapped. Each event rings ONCE; the only
 *     repeat is the guest burst, whose quick rings are ONE ~3 second alarm.
 *   • A staff page genuinely VISIBLE and focused → we still show the
 *     notification (spec requirement) but silently, and we tell the page to
 *     ring its own in-app alarm instead, so there is one alarm, not two.
 */

const SW_VERSION = "fana-pocket-v4";
const FANA_ICON = "/logo.png";
const DEFAULT_VIBRATE = [500, 200, 500, 200, 500, 200, 800];
/**
 * A GUEST just did something (ordered, added a dish, asked for the bill). The
 * waiter cannot predict it and her phone is usually in a pocket, so this
 * pattern buzzes for a solid ~3 seconds instead of one polite tap.
 */
const CUSTOMER_VIBRATE = [800, 150, 800, 150, 800, 150, 800];

/* ── Lifecycle: take control IMMEDIATELY ───────────────────────────────────
 * Without skipWaiting/claim, a phone that already had the OLD (broken) worker
 * installed would keep using it until every tab of the site was closed — the
 * fix would never reach the staff who need it. */
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/** Windows of this app that a human can actually see right now. */
async function visibleClients() {
  try {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // visibilityState is the honest signal: locking the phone or switching
    // apps flips it to "hidden" while `focused` can stay true.
    return list.filter((c) => c.visibilityState === "visible" && c.focused);
  } catch (e) {
    return [];
  }
}

function tellPages(message) {
  return self.clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then((list) => {
      for (const client of list) {
        try {
          client.postMessage(message);
        } catch (e) {
          /* client went away */
        }
      }
    })
    .catch(() => {});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

self.addEventListener("push", (event) => {
  let data = {
    title: "Fana Cafe",
    body: "New activity, open the app.",
    tag: "fana-orders",
    url: "/waiter",
    urgent: true,
    // Each event rings EXACTLY ONCE: 0 extra rings for plain or malformed
    // payloads. The only repeat left is the one a payload brings itself —
    // the guest burst, whose quick rings ARE one continuous alarm.
    repeat: 0,
    // Milliseconds between re-rings. Guest events override this with ~1.1s so
    // the rings run together into one continuous alarm.
    gapMs: 7000,
    kind: "staff",
    ticketId: null,
    action: null,
  };
  try {
    if (event.data) {
      const parsed = event.data.json();
      if (parsed && typeof parsed === "object") data = { ...data, ...parsed };
    }
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }

  const tag = data.tag || "fana-orders";
  const url = data.url || "/waiter";

  event.waitUntil(
    (async () => {
      const seen = await visibleClients();
      const someoneIsLooking = seen.length > 0;

      // Always tell open pages, so a page that IS on screen rings its loud
      // in-app alarm (and refreshes its list) the instant the push lands.
      await tellPages({ type: "fana-push", title: data.title, body: data.body, tag, url, urgent: !!data.urgent });

      if (someoneIsLooking) {
        // A notification MUST still be shown (userVisibleOnly), but the page
        // is already ringing — keep this one quiet so there is no double noise.
        // NOTE: `silent: true` together with `vibrate` throws a TypeError, so
        // the quiet variant carries no vibration pattern.
        await self.registration.showNotification(data.title, {
          body: data.body,
          tag,
          renotify: false,
          silent: true,
          requireInteraction: false,
          icon: FANA_ICON,
          badge: FANA_ICON,
          data: { url },
        });
        return;
      }

      // ── POCKET MODE: nobody is looking. Ring like a phone call. ──
      const isCustomer = data.kind === "customer";
      // One-tap answer straight from the lock screen: a guest order can be
      // confirmed without unlocking, finding the tab and hunting for the table.
      const actions = [];
      if (data.action === "confirm" && data.ticketId) {
        actions.push({ action: "confirm", title: "✓ Confirm" });
      }
      actions.push({ action: "open", title: "Open" });

      const show = (ringTag) =>
        self.registration.showNotification(data.title, {
          body: data.body,
          tag: ringTag,
          // Re-alert (sound + heads-up) even when an older notification with
          // the same tag is still in the tray — each new order deserves a ring.
          renotify: true,
          // Stays in the tray until staff actually tap it: an order must not
          // disappear from the lock screen after a few seconds.
          requireInteraction: !!data.urgent,
          icon: FANA_ICON,
          badge: FANA_ICON,
          vibrate: isCustomer ? CUSTOMER_VIBRATE : DEFAULT_VIBRATE,
          timestamp: Date.now(),
          actions,
          data: { url, ticketId: data.ticketId || null, kind: data.kind || "staff" },
        });

      await show(tag);

      // REPEAT RINGS: kept ONLY for the ~3 second GUEST burst — a payload with
      // repeat: 3 and gapMs ~1.1s (CUSTOMER_ALERT_RING) re-shows the
      // notification three more times so the rings run together into ONE
      // continuous ~3 second alarm. Every other event arrives with repeat: 0
      // and rings exactly once; the loop below then never runs.
      const repeats = Math.max(0, Math.min(3, Number(data.repeat) || 0));
      const gap = Math.max(600, Math.min(30000, Number(data.gapMs) || 7000));
      for (let i = 0; i < repeats; i += 1) {
        await sleep(gap);
        try {
          const stillThere = await self.registration.getNotifications({ tag });
          if (stillThere.length === 0) break; // tapped or swiped away → done
          const back = await visibleClients();
          if (back.length > 0) break; // staff are looking at the app now
          await show(tag);
        } catch (e) {
          break;
        }
      }
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  const info = event.notification.data || {};
  const url = info.url || "/waiter";
  const ticketId = info.ticketId || null;
  const isConfirm = event.action === "confirm" && ticketId;
  event.notification.close();
  event.waitUntil(
    (async () => {
      // ── ONE-TAP CONFIRM FROM THE LOCK SCREEN ──
      // The waiter does not have to unlock, find the tab, find the table and
      // tap Confirm: the worker calls the same API the app calls. The session
      // cookie rides along because this is a same-origin request.
      if (isConfirm) {
        try {
          const res = await fetch("/api/tickets", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ id: ticketId, status: "confirmed" }),
          });
          if (res.ok) {
            await self.registration.showNotification("✓ Order confirmed", {
              body: "The order was confirmed from your notification.",
              tag: `fana-confirm-ok-${ticketId}`,
              icon: FANA_ICON,
              badge: FANA_ICON,
              silent: true,
              data: { url },
            });
            await tellPages({ type: "fana-refresh" });
            return;
          }
          await self.registration.showNotification("Could not confirm", {
            body: res.status === 401 ? "Your session expired. Open the app and log in." : "Open the app and confirm it there.",
            tag: `fana-confirm-fail-${ticketId}`,
            icon: FANA_ICON,
            badge: FANA_ICON,
            data: { url },
          });
        } catch (e) {
          /* offline: fall through and just open the app */
        }
      }
      try {
        // Close any repeat rings of the same alert still sitting in the tray.
        const siblings = await self.registration.getNotifications({ tag: event.notification.tag });
        for (const n of siblings) n.close();
      } catch (e) {
        /* ignore */
      }
      try {
        const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        // Focus an already-open window on the right page if there is one…
        for (const client of clientList) {
          if (new URL(client.url).pathname === url && "focus" in client) {
            try {
              client.postMessage({ type: "fana-push-opened", url });
            } catch (e) {
              /* ignore */
            }
            return client.focus();
          }
        }
        // …otherwise reuse a window we already have.
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

/**
 * Pages can ask the worker things (used by the in-app "pocket alerts" chip to
 * prove the worker is alive and which version is running).
 */
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "fana-ping") {
    try {
      event.source.postMessage({ type: "fana-pong", version: SW_VERSION });
    } catch (e) {
      /* ignore */
    }
  }
  if (data.type === "fana-skip-waiting") self.skipWaiting();
});

// The push service rotates subscription keys from time to time; resubscribe
// with the new keys so the device keeps receiving alerts.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        let sub = await self.registration.pushManager.getSubscription();
        if (!sub && event.oldSubscription && event.oldSubscription.options) {
          // Chrome hands us the old options — re-subscribe with the same key.
          sub = await self.registration.pushManager.subscribe(event.oldSubscription.options);
        }
        if (!sub) return;
        await fetch("/api/push/resubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            oldEndpoint: event.oldSubscription ? event.oldSubscription.endpoint : null,
            subscription: sub.toJSON ? sub.toJSON() : sub,
          }),
        });
      } catch (e) {
        /* best effort */
      }
    })()
  );
});
