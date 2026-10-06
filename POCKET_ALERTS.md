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
  (pocket, visible, browser closed, rings once, taps)
- `tsx scripts/verify-role-alerts.ts` - walks the whole role/event matrix: every
  ticket status, every station action, every item change and every bill request
  must wake the right roles, and the actor must never wake themselves

Both run in `npm test`.

---

## How staff use it

1. **Log in** on the phone (waiter / cashier / kitchen / barista / buna). The login tap
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

### Screen off is NOT the same as phone off

This is the question staff always ask, so in plain words:

| What she does | Does it ring? |
|---|---|
| Presses the power button once - the **screen goes dark**, phone in pocket | **Yes.** It rings, vibrates and shows the alert on the lock screen. She taps the alert and lands on the right screen. This is the normal way to work, and it is also the way to save battery. |
| Uses another app, or the browser is in the background | **Yes.** Same alert on top of whatever she is doing. |
| Closes the browser completely | **Yes** on Android; on iPhone the app must have been added to the Home Screen. |
| Holds the button and chooses **Power off** - the phone is really OFF | **No.** A phone that is off cannot receive anything. When she switches it on, alerts from the last ~15 minutes still arrive. |
| Phone on **silent / Do Not Disturb** | It **vibrates**, but no web app can make a muted phone play a sound. |

So: switching the screen off with the power button is exactly what we designed
for. Nobody has to keep the screen lit, and the battery is not drained by this.

### Volume, silent mode, battery

- The system notification uses the **ringer/notification volume**.
- The in-app bell uses the **media volume**.
- Keep the phone off silent mode and out of Do Not Disturb.
- On Android, leave Chrome on "unrestricted" battery usage (Settings -> Apps ->
  Chrome -> Battery). "Restricted" lets the system delay alerts.
- Alerts are sent with high urgency, which is what lets them wake a dozing
  phone instead of waiting for the next time it is unlocked.

---

## Who gets rung, for which event

Every action in the workflow now wakes the roles that must react. The single
source of truth is `src/lib/alerts.ts`, and `scripts/verify-role-alerts.ts`
walks the whole table so no event can be dropped by accident.

| What happens | Waiter | Cashier | Kitchen | Barista | Buna |
|---|---|---|---|---|---|
| Guest submits a QR order | **ring** | - | - | - | - |
| Guest adds items to an existing bill | **ring** | ring (if confirmed/printed) | - | - | - |
| Waiter accepts / sends an order | - | **ring** | **ring** (if it has kitchen items) | **ring** (if it has drinks) | **ring** (if it has buna) |
| Waiter or cashier accepts a QR order | ring | **ring** | **ring** (if theirs) | **ring** (if theirs) | **ring** (if theirs) |
| Items added to an already accepted bill | **ring** | **ring** | - | - | - |
| Cashier taps PRINTED & SEND (additions) | silent | - | **ring** (new items only) | **ring** (new items only) | **ring** (new items only) |
| Bill printed / kitchen accepted (first print) | silent | - | - | - | - |
| A crew starts an item | silent | - | - | - | - |
| A crew finishes an item | **ring, owner only** | - | - | - | - |
| Last item finished (whole order ready) | **ring "ORDER READY TO SERVE", owner only** | - | - | - | - |
| Cashier removes an item from a bill | silent | - | **ring** (if theirs and started) | **ring** (if theirs and started) | **ring** (if theirs and started) |
| Quantity corrected on a bill | ring | - | **ring** (if theirs) | **ring** (if theirs) | **ring** (if theirs) |
| Guest asks for the bill | **ring, owner only** | **ring** | - | - | - |
| Guest is ready to pay | silent | silent | - | - | - |
| Payment completed | silent | silent | - | - | - |
| Bill settled / paid | silent | silent | - | - | - |
| Table cleared | silent | silent | silent | silent | silent |
| **Order cancelled** | silent | silent | **ring** | **ring** | **ring** |

The **Buna** column is the traditional-coffee crew (see "The buna makers" below).
The three making crews only ring for an accepted order when that order actually
contains one of their lines - a drinks-only table no longer wakes the kitchen,
and a macchiato no longer wakes the buna makers.

**bold** = urgent: the notification stays on the lock screen until it is
tapped. Plain "ring" = informational, it fades on its own. "silent" = the
screens update, but no phone is woken.

**Every event rings EXACTLY ONCE.** The phone makes its sound (about 3 seconds
for the guest events, one ring for staff events) and then goes quiet, even if
nobody has confirmed the alert yet. The notification itself stays on the lock
screen until it is tapped - it just does not make noise again. A phone that
kept re-ringing for unanswered events during a rush trained staff to ignore
it, so that behaviour is gone.

### What is deliberately SILENT, and why

The money and closing steps - guest is ready to pay, payment completed, bill
settled, table cleared - make no sound and no notification. Staff are standing
at the counter or at the table when those happen, and a phone that rings for
everything is a phone people stop listening to. The cards still update the
moment it happens.

The same goes for four ex-alerts the owner cut (Sept 2026): the crew STARTING
a dish, the bill being PRINTED, the order moving to "preparing", and an item
being REMOVED from a bill. None of them rings the waiter any more - her screen
still updates instantly, she just has nowhere to walk for any of them, so they
are silent. Removing a dish the crew already started still rings that station
("do not prepare"); removing one they never started rings nobody at all.

A **cancelled** order rings the kitchen, the barista and the buna makers: they
are the ones who may have a pan or a jebena on the fire, and stopping them saves
food. The waiter and the cashier see the cancellation on their screen (the
waiter gets a quiet line at the top of hers) without any sound.

Three rules keep this from becoming noise:

- **You never ring yourself.** The role that performed the action is removed
  from the recipients, so the cashier printing a bill does not make her own
  tablet scream, and a waiter keying items never alarms her own phone.
- **Only the owning waiter rings.** "Food ready" and "bill requested" go to
  the waiter who accepted/sent that table - not the whole team. A QR order
  nobody accepted yet still rings every waiter, because any of them can walk
  over. Safety net: if the owner's phone has no live subscription, the whole
  waiter team is rung instead, so food never goes cold unnoticed. The owner is
  looked up BY NAME across every role, so a table accepted by a buna maker rings
  the buna maker, not the floor team.
- **A cancelled order is the loudest thing in the system.** It rings the three
  making crews with an urgent alert that stays on their lock screen until
  tapped, because food already on the fire has to stop.

**A cleared table is not an alarm.** When a waiter clears a table or a bill is
marked paid, the ticket simply leaves the crew's list. That used to fire a full
"stop preparing" alarm even when every dish was already Done - dozens of false
alarms a shift. Now a station screen only alarms for a vanishing ticket when it
still had PENDING or ACCEPTED lines on it; with everything Done it just shows a
quiet toast and the card disappears.

## The buna makers (traditional coffee)

Two people make the traditional coffee at their own place, indoors and outdoors,
and when the room is full they take orders like waiters too. They have:

- **their own role and screen**: `/buna`, staff role `buna`, added under Admin →
  Staff like any other account;
- **the waiter app**: tables, menu, send - so they can take an order when the
  floor is short-handed. They never close a bill; clearing a table stays a floor
  job;
- **their own lane**: "My Buna" is pinned above the table grid with Accept /
  Done on each traditional-buna line, the same calls the kitchen and barista
  screens make;
- **a quiet phone**: a QR order, a guest top-up, a bill request and somebody
  else's status move never wake them. Their phone rings only when
  - an accepted order contains a **traditional buna** line ("🫖 New buna to make"), or
  - food is **ready on a table they accepted** (they own it, so it rings them by name).

**Which item is traditional buna?** A per-item switch in Admin → Menu:
"🫖 Traditional Buna". It is deliberately per ITEM and not per category, so
"Jebena Buna" can sit in the Coffee category next to the macchiato and only the
traditional one leaves the barista's lane. Flagged items are stamped
`station_name = 'buna'` at order time whatever their category is
(`src/lib/stations.ts` → `stationForOrder`).

## Who receives what, and when (the release rule)

**The first order: one tap feeds everybody.**
The waiter takes the order and taps **✓ ACCEPT & SEND → Stations & Cashier**. In
that same second:

- the kitchen screen shows the kitchen dishes, and only those;
- the barista screen shows the drinks, and only those;
- the buna makers' lane shows the traditional buna, and only that;
- the cashier's queue shows the bill to key into the EFD and print.

Every crew that has a line on the bill rings, and no crew that has none. Nobody
waits for the print. A QR order from a guest is the one thing that must be
accepted first (waiter, cashier or buna maker) - that single tap then feeds the
same screens.

**Food added later: the print-and-send flow, unchanged.**
When a dish is added to a bill that is already accepted (the guest orders more,
or the waiter adds it):

1. The **cashier** is alarmed and notified. Her card shows **only the new
   items**, never the whole bill again, with the total for those items.
2. She keys those items into the EFD and taps **✓ PRINTED & SEND**.
3. Only then do the new items appear on the kitchen/barista list for that table
   number, added to the order that is already there - and only the crew that
   actually got new work is rung.

The waiter is alarmed for guest additions too, so she knows the table changed.

**The cashier taps once per print.** On a first print the button reads
`✓ PRINTED` (the record for "Printed Today", your daily EFD cross-check); on an
addition card it reads `✓ PRINTED & SEND`, because that tap is what sends the
new items to the crew.

## The three GUEST events ring the loudest

A guest is the only person the crew cannot predict. Three things a guest can do
now get a stronger alert than anything staff do:

1. A **new QR order** arrives.
2. The guest **adds items** to a bill that already exists.
3. The guest **asks for the bill** from their own phone.

What happens on the waiter's phone and the cashier's tablet:

- **About 3 seconds of alarm, not one ding.** The notification is re-shown
  three more times about 1.1 seconds apart, so the rings run together into one
  continuous alarm. That burst is the ONE alarm for the event: after it the
  phone is silent, even if nobody has confirmed yet. (Staff-to-staff alerts
  ring exactly once, so they never nag.)
- **A long, hard vibration** (four ~0.8 second buzzes). This is the part that
  is felt through a pocket, and it is the only part that still works when the
  phone is on silent.
- **A CONFIRM button on the notification itself.** For a new order the waiter
  can confirm it straight from the lock screen: no unlocking, no finding the
  tab, no hunting for the table. If her session has expired, the phone says so
  instead of failing quietly.
- **A full-screen alert inside the app**, with the table name in big letters and
  one big button (`OPEN & CONFIRM` / `OPEN BILL` / `GOT IT`). It rings the same
  single alarm and then stays on screen SILENTLY, with the big button, until
  somebody presses it. Pressing it opens exactly that table.

### The guest's own bill button

On the customer menu the live order-status feature (the pill, the panel with
the dish list and the kitchen progress bar) is switched off for now. The only
thing a guest sees after ordering is the **bill button**: a big
`Request the bill / receipt` button with a receipt icon that appears once the
table has an order. One tap and the waiter's phone buzzes, rings, and shows
the table. The guest no longer has to wave at anybody. A guest may ask for the
bill while food is still cooking: during a rush that is exactly what people
want, and the waiter decides when to walk over. After the tap the button is
replaced by a confirmation line with the time, and it never comes back for the
same bill.

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

## The owner's daily total (the one phone that still rings)

Everything above is the staff matrix. The **only** phone this system rings any
more is the owner's, and it rings for one thing: **today's total sale**.

| Moment | Who presses | What is sent |
|--------|-------------|--------------|
| "Today's shift end" (the cashier's button) | cashier | the printed bills up to that moment, as one normal notification |
| The owner's chosen time, if nobody pressed it | the system, on its own | the day's final number |
| "Send today's total to my phone" (Daily Sales tab) | the owner | today's live total, on demand, without touching the day |

**Sending the total does not close the day.** The tap is a snapshot: sales
printed after it keep counting towards today's total, and the same button sends
the bigger, later number. That is why the automatic send still goes out when
the cashier closed the day early, and why it can only send once a day (it holds
its own marker, and a send that reached nobody gives the day back so it keeps
trying).

### If the owner "allowed notifications" but nothing arrives

| Symptom | Cause | What to do |
|---------|-------|------------|
| The chip is not green | The browser allows notifications but the SERVER has no row for this device | Press **Turn on notifications** on the Daily Sales tab |
| "Nothing is registered to receive it" | No device is filed under this login | Same as above, then press **Send today's total to my phone** |
| It worked and then went quiet after days | The push service rotated the endpoint, or the VAPID keys were regenerated | Open the Daily Sales tab; it re-syncs on every visit and repairs the row |
| The total never arrives at the automatic time, and the page says the system already sent it | The automatic send already went out today (it is once a day) | Press **Send today's total to my phone** |
| The test button is green but the phone is silent | The phone cannot be reached (no data, battery saver) | Open the app once on the phone, then test again |

Every send writes a line in the server log, so the cause is never silent again:

```
[day-close] 2026-10-03: 12450 ETB on 88 bill(s) sent to 1 owner phone(s)
[day-close] 2026-10-03: 12450 ETB on 88 bill(s) was NOT delivered to any owner phone (tried 0, failed 0, pruned 0).
```
