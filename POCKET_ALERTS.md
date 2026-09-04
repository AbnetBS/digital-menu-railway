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
| 9 | Only a handful of moments pushed anything | Food went ready, bills were printed, items were removed and orders were CANCELLED without a single phone making a sound | Every workflow event now goes through one matrix (`src/lib/alerts.ts`); see the table below |

Two automated tests protect all of this:

- `node scripts/verify-pocket-alerts.mjs` - source-level rules
- `node scripts/verify-pocket-alerts-runtime.mjs` - **executes** `public/sw.js`
  in a fake service-worker world and asserts what a phone actually does
  (pocket, visible, browser closed, re-rings, taps)
- `tsx scripts/verify-role-alerts.ts` - walks the whole role/event matrix: every
  ticket status, every station action, every item change and every bill request
  must wake the right roles, and the actor must never wake themselves

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

Every action in the workflow now wakes the roles that must react. The single
source of truth is `src/lib/alerts.ts`, and `scripts/verify-role-alerts.ts`
walks the whole table so no event can be dropped by accident.

| What happens | Waiter | Cashier | Kitchen | Barista |
|---|---|---|---|---|
| Guest submits a QR order | **ring** | - | - | - |
| Guest adds items to an existing bill | **ring** | ring (if confirmed/printed) | - | - |
| Waiter accepts / sends an order | - | **ring** | **ring** | **ring** |
| Waiter or cashier accepts a QR order | ring | **ring** | **ring** | **ring** |
| Cashier taps PRINTED | ring | - | - | - |
| Items added to an already accepted bill | **ring** | **ring** | **ring** (if theirs) | **ring** (if theirs) |
| Kitchen/barista starts an item | ring | - | - | - |
| Kitchen/barista finishes an item | **ring** | - | - | - |
| Last item finished (whole order ready) | **ring "ORDER READY TO SERVE"** | - | - | - |
| Cashier removes an item from a bill | **ring** | - | **ring** (if theirs) | **ring** (if theirs) |
| Quantity corrected on a bill | ring | - | **ring** (if theirs) | **ring** (if theirs) |
| Guest asks for the bill | **ring** | **ring** | - | - |
| Guest is ready to pay | **ring** | **ring** | - | - |
| Payment completed | ring | **ring** (verify and mark paid) | - | - |
| Bill settled / paid | ring | ring | - | - |
| Table cleared | - | ring | ring | ring |
| **Order cancelled** | **ring** | **ring** | **ring** | **ring** |

**bold** = urgent: the notification stays on the lock screen and re-rings until
somebody answers it. Plain "ring" = informational, it fades on its own.

Two rules keep this from becoming noise:

- **You never ring yourself.** The role that performed the action is removed
  from the recipients, so the cashier printing a bill does not make her own
  tablet scream, and a waiter keying items never alarms her own phone.
- **A cancelled order is the loudest thing in the system.** It reaches all four
  roles and re-rings three times, because food already on the fire has to stop.

## One tap feeds everybody (the release rule)

The kitchen and the barista used to wait for the cashier to tap PRINTED before
they could see an order. They no longer wait. **Acceptance is the release:**

- The waiter takes the order and taps **✓ ACCEPT & SEND → Kitchen, Barista &
  Cashier**. In that same second the dish list appears on the kitchen and
  barista screens and the bill appears in the cashier's print queue. All three
  phones ring.
- The cashier still keys the bill into the EFD and taps **✓ PRINTED**. That tap
  is now only the record of the print (it feeds "Printed Today", the daily
  cross-check against the EFD receipt count). Nobody is waiting for it, and it
  does not ring the crew a second time for food they are already cooking.
- A QR order from a guest is the one thing that still waits: it must be
  accepted by the waiter or the cashier first. That single tap then reaches all
  three screens exactly the same way.
- Dishes a guest adds to a bill that is already accepted go straight to the
  crew, and the waiter and cashier both get the loud guest alarm for them.

That is two taps for the whole order (waiter accepts, cashier prints), and
nothing in the chain waits for anybody.

## The three GUEST events ring the loudest

A guest is the only person the crew cannot predict. Three things a guest can do
now get a stronger alert than anything staff do:

1. A **new QR order** arrives.
2. The guest **adds items** to a bill that already exists.
3. The guest **asks for the bill** from their own phone.

What happens on the waiter's phone and the cashier's tablet:

- **About 3 seconds of alarm, not one ding.** The notification is re-shown
  three more times about 1.1 seconds apart, so the rings run together into one
  continuous alarm. (Staff-to-staff alerts still wait 7 seconds between rings,
  so they never nag.)
- **A long, hard vibration** (four ~0.8 second buzzes). This is the part that
  is felt through a pocket, and it is the only part that still works when the
  phone is on silent.
- **A CONFIRM button on the notification itself.** For a new order the waiter
  can confirm it straight from the lock screen: no unlocking, no finding the
  tab, no hunting for the table. If her session has expired, the phone says so
  instead of failing quietly.
- **A full-screen alert inside the app**, with the table name in big letters and
  one big button (`OPEN & CONFIRM` / `OPEN BILL` / `GOT IT`). It re-plays the
  alarm every 10 seconds, up to 5 times, until somebody presses the button.
  Pressing it opens exactly that table.

### The guest's own bill button

On the customer menu, the old read-only status bar is now the **bill button**.
Once the table has an order, the guest sees one line of live status plus a big
`Request the bill / receipt` button with a receipt icon. One tap and the
waiter's phone buzzes, rings, and shows the table. The guest no longer has to
wave at anybody. A guest may ask for the bill while food is still cooking:
during a rush that is exactly what people want, and the waiter decides when to
walk over.

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
