# Pocket alerts: making staff phones ring for every order

This is the "WhatsApp style" alert system: a new order (or a guest adding
items to a bill) must reach the waiter, the cashier and the crew **even when
the phone is in a pocket with the screen off, the tab in the background, or
the browser closed**.

---

## What was broken (and is now fixed)

| # | Bug | Effect on staff | Fix |
|---|-----|-----------------|-----|
| 1 | The service worker skipped `showNotification()` whenever any window reported `focused` | A pocketed phone with the staff tab still open is exactly that case, so **every push was swallowed and the phone stayed silent**. Chrome also punishes swallowed pushes (`userVisibleOnly` was promised) and can revoke the subscription | A push **always** shows a notification. "Someone is looking" is now decided by `visibilityState === "visible"` and only downgrades the notification to silent, never to nothing |
| 2 | The worker never called `skipWaiting()` / `clients.claim()` | A phone kept running the OLD `sw.js` forever, so deploying a fix changed nothing on that device | The new worker takes over immediately, `sw.js` is served with `no-store`, and every arm calls `registration.update()` |
| 3 | Pocket alerts were armed **only inside the login branch** | Staff restore a saved session instead of logging in, so an expired endpoint, a pruned row or regenerated VAPID keys were never repaired. Silence, with no symptom | `ensurePocketAlerts()` re-arms on mount, on visibility, when the network returns and every 5 minutes, and detects a stale application server key (unsubscribe and resubscribe) |
| 4 | In-page notifications used `new Notification(...)` | That constructor **throws on Android Chrome**, so on the very devices that matter the popup never appeared | Page notifications go through the service worker registration |
| 5 | The in-app alarm was Web Audio only | Mobile browsers suspend an `AudioContext` while the tab is hidden, which is the pocket case | The alarm is a pre-rendered bell played through an `<audio>` element (primed on the first tap, so it plays with the screen off); Web Audio stays as the fallback |
| 6 | `alertsOn` was captured by the SSE handler at login time (stale closure) | Turning alerts on afterwards never reached the handler, so the alarm stayed off for the rest of the shift | Every alarm check reads a live ref |
| 7 | The SSE stream could die silently (throttled background tab, proxy timeout) | A frozen order list and no alarm until the app was reopened | A watchdog rebuilds a CLOSED stream, and each push is relayed by the worker to the open page as a second, independent path |
| 8 | The only "test" showed a local popup | It proved nothing: a dead subscription still looked fine | `POST /api/push/test` sends a **real** push through the push service, optionally delayed so the phone can be locked first |

Two automated tests protect all of this:

- `node scripts/verify-pocket-alerts.mjs` - source-level rules
- `node scripts/verify-pocket-alerts-runtime.mjs` - **executes** `public/sw.js`
  in a fake service-worker world and asserts what a phone actually does
  (pocket, visible, browser closed, re-rings, taps)

Both run in `npm test`.

---

## How staff use it

1. **Log in** on the phone (waiter / cashier / kitchen / barista). The login tap
   unlocks the alarm sound and arms pocket alerts in one go. Tap **Allow** when
   the browser asks about notifications.
2. Look at the chip in the top bar:
   - **Pocket ON** (green): this phone will ring with the screen off.
   - **Pocket OFF** (red, pulsing): tap it, read the one-line reason, tap
     **Arm pocket alerts**.
3. Prove it: tap the chip, choose **Test ring in 10s**, lock the phone and put
   it in a pocket. The real alert arrives from the server exactly like an order.

### Android (Chrome)

Works with the browser closed, no install needed.

### iPhone / iPad

Apple only allows this for apps installed to the Home Screen:
**Share -> Add to Home Screen**, then always open Fana from that icon.
The app shows this instruction automatically on iPhones.

### Volume, silent mode, battery

- The system notification uses the **ringer/notification volume**.
- The in-app bell uses the **media volume**.
- Keep the phone off silent mode and out of Do Not Disturb. If the OS is muted,
  the phone still vibrates, but no web app can override a muted device.
- Do not put the browser into "restricted battery usage" on Android, and leave
  the staff tab open when possible.

---

## Who gets rung, for which event

| Event | Rings |
|-------|-------|
| Guest submits a QR order | Waiter |
| Guest adds items to an existing bill (any status) | Waiter (own tag per submission), plus cashier when the bill is confirmed or printed |
| Waiter sends an order | Cashier (print queue) |
| Additions on an already printed bill | Cashier ("print receipt #2") |
| Cashier taps **PRINTED** (or "Accept -> Kitchen" in full mode) | Kitchen and/or barista, only for newly released items |
| Guest asks for the bill | Waiter and cashier |

Staff keying items themselves never rings their own phone.

---

## Troubleshooting

| Symptom | Cause | What to do |
|---------|-------|------------|
| Chip says "Notifications are BLOCKED" | The browser permission was denied once | Chrome: tap the padlock in the address bar -> Permissions -> Notifications -> Allow, then tap **Arm pocket alerts** |
| Chip says "Your staff session expired" | The 12 hour staff cookie ended | Log in again |
| Chip is green but the test never arrives | The push service cannot reach the phone (no data, extreme battery saver) | Open the app once on the phone, then test again |
| iPhone never rings | The app is not installed to the Home Screen | Share -> Add to Home Screen and open Fana from the icon |
| It rings but very quietly | Ringer volume or Do Not Disturb | Raise the ringer volume, disable DND for the browser/PWA |
| Nothing rings after a deployment | An old service worker | Reload the staff page once; the new worker installs itself and takes over immediately |

The VAPID keys are generated by the server on first use and stored in
`site_settings` (`vapid_public` / `vapid_private`). The private key is filtered
out of `/api/settings`. Nothing to configure by hand.
