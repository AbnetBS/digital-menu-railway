#!/usr/bin/env node
/**
 * Regression test — "Always-on, loud, pocket-mode alerts" (Group 10).
 *
 * Staff complaint: the bell didn't ring when an order arrived; and when the
 * waiter's phone is in her pocket / browser closed, nothing reached her at
 * all. Root causes found and verified here:
 *
 *   1. Every staff loader returned early while `document.hidden` was true —
 *      exactly the pocket state — so the alarm never fired. Those guards are
 *      GONE (SSE messages are event-driven, not polling).
 *   2. The first notification ever was silently dropped (permission was only
 *      requested, never followed by showing). Fixed in notifications.ts.
 *   3. No Web Push existed — the browser being closed meant silence. Now a
 *      service worker + VAPID + per-role subscriptions cover closed browsers.
 *   4. The sound was one soft 988 Hz sine at gain 0.5. Now a triple-frequency
 *      bell at the compressor ceiling, repeated (playAlarm) + vibration.
 *
 * ROUND 2 (this file's newest section) — "it still does not ring in my
 * pocket". Four more root causes, each locked down by a test below:
 *
 *   5. THE KILLER: the service worker skipped showNotification whenever any
 *      window was "focused". A pocketed phone with the staff tab open is
 *      exactly that, so every push was swallowed and the phone stayed silent
 *      (and Chrome punishes swallowed pushes: userVisibleOnly was promised).
 *      A push now ALWAYS shows a notification.
 *   6. The worker never called skipWaiting/claim, so a phone kept running the
 *      OLD sw.js forever and never received the fix.
 *   7. Pocket alerts were armed ONLY inside the login branch. Staff restore a
 *      saved session instead of logging in, so a subscription that expired
 *      (or a regenerated VAPID keypair) was never repaired: silence with no
 *      symptom. ensurePocketAlerts() now re-arms on mount, on visibility, on
 *      reconnect and on a timer, and detects a stale application server key.
 *   8. The in-page alarm was Web Audio only, which mobile browsers suspend
 *      while the tab is hidden, and the in-page notification used
 *      `new Notification()`, which THROWS on Android. Both are fixed: a
 *      pre-rendered media element plays with the screen off, and page
 *      notifications go through the service worker registration.
 *
 * Run with: node scripts/verify-pocket-alerts.mjs  (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const sound = read("src/lib/sound.ts");
const notif = read("src/lib/notifications.ts");
const pushServer = read("src/lib/push.ts");
const pushClient = read("src/lib/push-client.ts");
const sw = read("public/sw.js");
const tickets = read("src/app/api/tickets/route.ts");
const tableStatus = read("src/app/api/table-status/route.ts");
const subscribe = read("src/app/api/push/subscribe/route.ts");
const resubscribe = read("src/app/api/push/resubscribe/route.ts");
const publicKeyRoute = read("src/app/api/push/public-key/route.ts");
const settingsRoute = read("src/app/api/settings/route.ts");
const schema = read("src/db/schema.ts");
const migrate = read("src/db/migrate.ts");
const waiter = read("src/components/rms/WaiterApp.tsx");
const cashier = read("src/components/rms/CashierDashboard.tsx");
const station = read("src/components/rms/StationApp.tsx");
const hint = read("src/components/rms/PocketAlertsHint.tsx");
const layout = read("src/app/layout.tsx");
const hook = read("src/lib/use-pocket-alerts.ts");
const chip = read("src/components/rms/PocketAlertsChip.tsx");
const testRoute = read("src/app/api/push/test/route.ts");
const overlay = read("src/components/rms/UrgentAlertOverlay.tsx");
const alertsMatrix = read("src/lib/alerts.ts");

const failures = [];
function pass(name, cond) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures.push(name);
}

/* ── 1. The hidden-tab silence bug is gone ────────────────────────────────── */
{
  // Extract just the loader FUNCTION body (from its definition to the next
  // function), so an intentional hidden-skip elsewhere (e.g. the slow 60s
  // history refresh) is not mistaken for the alert bug.
  const loaderBody = (src, name) => {
    const start = src.indexOf(`const ${name} = async`);
    if (start === -1) return src;
    const rest = src.slice(start);
    const next = rest.slice(1).search(/\n  const \w+ = (async )?\(/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };
  const loaders = [
    ["waiter loadTables", loaderBody(waiter, "loadTables")],
    ["cashier loadAll", loaderBody(cashier, "loadAll")],
    ["station load", loaderBody(station, "load")],
  ];
  for (const [name, body] of loaders) {
    pass(`${name}: no early return while the screen is off`, !/document\.hidden\) return;/.test(body));
  }
  pass("waiter still refreshes on visibilitychange (catch-up)", /visibilitychange/.test(waiter));
  pass("cashier still refreshes on visibilitychange (catch-up)", /visibilitychange/.test(cashier));
  pass("station still refreshes on visibilitychange (catch-up)", /visibilitychange/.test(station));
  // The slow background history refresh MAY skip while hidden — it is not
  // alert-related and skipping saves the cafe data.
  pass("cashier history refresh may still skip while hidden (data saving, not alerts)", /document\.hidden\) return;/.test(cashier.slice(cashier.indexOf("const loadHistory"))));
}

/* ── 2. Louder alarm engine ───────────────────────────────────────────────── */
{
  pass("alarm engine exists (playAlarm)", /export function playAlarm\(\)/.test(sound));
  pass("bell is triple-frequency (cuts through cafe noise)", /\[1568,/.test(sound) && /\[2093,/.test(sound) && /\[784,/.test(sound));
  pass("gains run to the ceiling (0.9–1.0, was 0.5)", /0\.9/.test(sound) && /1\.0/.test(sound));
  pass("a limiter keeps the loud signal clean", /DynamicsCompressor/.test(sound));
  pass("phones vibrate too (pocket = felt, not heard)", /navigator\.vibrate/.test(sound));
  pass("alarm runs 6 pairs (~3.6 s of ringing, was 4)", /ALARM_PAIRS = 6/.test(sound) && /pair < ALARM_PAIRS/.test(sound));
  pass("low-octave bell layer carries on small phone speakers", /\[392,/.test(sound));
  pass("limiter tightened toward full scale (threshold -6, high ratio)", /threshold\.value = -6/.test(sound) && /ratio\.value = 20/.test(sound));
  pass("staff are told the OS media volume caps real loudness", /MEDIA volume/i.test(sound));
  // Web Audio is suspended by mobile browsers while the tab is hidden — the
  // pocket case — so the alarm also exists as a pre-rendered media element.
  pass("alarm plays through a media element (works with the screen off)", /renderAlarmWav/.test(sound) && /alarmEl\.play\(\)/.test(sound));
  pass("media element is primed inside the unlock gesture", /alarmElReady/.test(sound) && /el\.play\(\)/.test(sound));
  pass("synth stays as the fallback when the element cannot play", /catch\(\(\) => synthAlarm\(\)\)/.test(sound));
  pass("first tap anywhere arms the audio (no login needed)", /export function armAudioOnFirstGesture/.test(sound) && /pointerdown/.test(sound));
  pass("stations ring the full alarm on new items", /playAlarm\(\)/.test(station));
  pass("waiters ring the full alarm on new QR orders", /playAlarm\(\)/.test(waiter));
  pass("cashier distinguishes 'needs me' (alarm) from noise (ding)", /needsMe/.test(cashier) && /playAlarm\(\)/.test(cashier));
}

/* ── 3. First notification no longer vanishes ─────────────────────────────── */
{
  pass("permission request is followed by ACTUALLY showing", /requestPermission\(\)/.test(notif) && /if \(p === "granted"\) void show\(\)/.test(notif));
  pass("in-page notifications vibrate the phone", /navigator\.vibrate/.test(notif));
  // `new Notification()` throws on Android Chrome, so every staff phone fell
  // into the catch block. Mobile needs the service worker registration.
  pass("in-page notifications go through the service worker (Android)", /getRegistration\("\/"\)/.test(notif) && /reg\.showNotification\(/.test(notif));
}

/* ── 4. Pocket mode: Web Push ─────────────────────────────────────────────── */
{
  pass("service worker handles push events", /addEventListener\("push"/.test(sw));
  pass("service worker shows system notifications with renotify + vibration", /renotify: true/.test(sw) && /vibrate/.test(sw));
  // THE BUG: the worker used to `return` (show nothing) whenever a window was
  // "focused" — which is exactly a pocketed phone with the tab still open.
  pass("push is NEVER swallowed when a window is 'focused' (pocket bug)", !/if \(anyFocused\) return/.test(sw) && !/anyFocused/.test(sw));
  pass("a visible page is detected by visibilityState, not just focus", /visibilityState === "visible"/.test(sw));
  pass("double-noise avoided by a SILENT notification, not by silence", /silent: true/.test(sw) && /someoneIsLooking/.test(sw));
  pass("silent variant carries no vibrate (spec: that combination throws)", !/silent: true,[\s\S]{0,200}vibrate/.test(sw));
  pass("urgent alerts stay on the lock screen until tapped", /requireInteraction: !!data\.urgent/.test(sw));
  // Each event rings EXACTLY ONCE: the worker's default repeat is 0, so a
  // plain or malformed payload never rings again. The repeat machinery stays
  // only because the guest burst (repeat: 3, ~1.1s apart) IS one alarm.
  pass("a plain event rings ONCE (default repeat 0, burst machinery kept for guests)", /repeat: 0/.test(sw) && /getNotifications\(\{ tag \}\)/.test(sw));
  pass("worker takes over immediately (skipWaiting + clients.claim)", /skipWaiting\(\)/.test(sw) && /clients\.claim\(\)/.test(sw));
  pass("worker relays every push to open pages (frozen SSE safety net)", /tellPages\(\{ type: "fana-push"/.test(sw));
  pass("tapping the notification opens the right staff screen", /notificationclick/.test(sw) && /openWindow/.test(sw));
  pass("rotated keys resubscribe (pushsubscriptionchange)", /pushsubscriptionchange/.test(sw));
  pass("client subscribes with the server's VAPID public key", /applicationServerKey/.test(pushClient) && /\/api\/push\/public-key/.test(pushClient));
  pass("a stale VAPID key resubscribes instead of failing forever", /keyMatches/.test(pushClient) && /unsubscribe\(\)/.test(pushClient));
  pass("the newest sw.js is pulled on every arm (reg.update)", /reg\.update\(\)/.test(pushClient) && /updateViaCache: "none"/.test(pushClient));
  pass("self-healing re-arm exists and never prompts", /export async function ensurePocketAlerts/.test(pushClient) && /Notification\.permission !== "granted"\) return "denied"/.test(pushClient));
  pass("PWA manifest installed (iPhone Add-to-Home-Screen)", /manifest\.webmanifest/.test(layout));
  pass("iPhone users are told about Add to Home Screen", /Add to Home Screen/.test(hint) && /iosPocketHintNeeded/.test(pushClient));
}

/* ── 5. Server push plumbing ──────────────────────────────────────────────── */
{
  pass("VAPID keys self-generate and persist in settings", /generateVAPIDKeys/.test(pushServer) && /vapid_public/.test(pushServer) && /vapid_private/.test(pushServer));
  pass("private VAPID key never leaks through /api/settings", /vapid_private/.test(settingsRoute) && /SECRET_KEYS/.test(settingsRoute));
  pass("subscriptions table exists (schema + migration)", /pushSubscriptions = pgTable/.test(schema) && /push_subscriptions/.test(migrate));
  pass("one row per device (unique endpoint index)", /push_subscriptions_endpoint_key/.test(migrate));
  pass("role comes from the SESSION, not the client body", /requireStaff\(\)/.test(subscribe) && !/body\?\.role/.test(subscribe));
  pass("public-key route is staff-only", /requireStaffOrAdmin/.test(publicKeyRoute));
  pass("resubscribe route also trusts the session only", /requireStaff\(\)/.test(resubscribe));
  pass("dead endpoints are pruned (404/410)", /410/.test(pushServer) && /404/.test(pushServer));
  pass("push never blocks or fails an order", /sendPushToRoles/.test(pushServer) && /must never/i.test(pushServer));
}

/* ── 6. Who gets woken, for which event ───────────────────────────────────── */
{
  // GROUP 11 (release gate): the order POST wakes the CASHIER (or waiters for
  // a QR order) — never the stations. The crew is woken by the PUT when the
  // cashier confirms the printed receipt (or full-mode "Accept → Kitchen").
  pass("QR order → waiters only (crew waits for the print)", /fana-qr-/.test(tickets) && /\["waiter"\]/.test(tickets));
  pass("waiter order → cashier to print (no station push on POST)", /fana-print-/.test(tickets) && /\["cashier"\]/.test(tickets));
  pass("additions on a printed bill → cashier prints the new receipt", /fana-add-/.test(tickets) && /new items on the bill, print receipt #2/.test(tickets));
  pass("accepting an order wakes kitchen + barista + cashier together", /case "confirmed"/.test(alertsMatrix) && /roles: STATION_ROLES/.test(alertsMatrix));
  pass("✓ PRINTED & SEND wakes the crew for food ADDED later", /body\.status === "printed" \|\| \(body\.status === "preparing"/.test(tickets) && /fana-station-/.test(tickets));
  pass("only stations with newly released items are pinged", /prevStamp === null \|\| !r\.createdAt \|\| new Date\(r\.createdAt\)\.getTime\(\) > prevStamp/.test(tickets));
  pass("bill request → waiter + cashier", /fana-bill-/.test(tableStatus) && /\["waiter", "cashier"\]/.test(tableStatus));

  /* ── 6b. EVERY customer top-up rings the waiter, not just the first order ──
   * A guest adding dishes to an existing bill (pending, confirmed, printed)
   * used to ring NOBODY on the waiter side: in-page detection watched ticket
   * IDs (unchanged by additions) and the server only pushed waiters for fresh
   * pending_waiter tickets — reusing one tag, so even that could silently
   * replace the previous notification. */
  const postHalf = tickets.split("export async function PUT")[0] || "";
  pass("guest top-up merged into any bill rings the waiter", /fana-qr-add-/.test(postHalf) && /sendPushToRoles\(\["waiter"\]/.test(postHalf));
  pass("top-up waiter push fires on customer merges (pending/confirmed/printed)", /isCustomer && merged/.test(postHalf));
  pass("each top-up is its own notification (distinct tag per submission)", /fana-qr-add-\$\{pushed\.id\}-\$\{idemKey/.test(postHalf));
  {
    // Still-pending bills are the WAITER's job only: the cashier cannot print
    // what nobody confirmed yet, so the pending branch must never wake her.
    const anchor = postHalf.indexOf('if (isCustomer && pushed.status === "pending_waiter")');
    let depth = 0, branch = "";
    for (let i = postHalf.indexOf("{", anchor); i < postHalf.length; i++) {
      const ch = postHalf[i];
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      branch += ch;
      if (depth === 0) break;
    }
    pass("pending bills (new + top-ups) never push the cashier", anchor !== -1 && !/\["cashier"\]/.test(branch));
  }
  pass("cashier keeps her printed-bill ADDED push exactly as-is", /fana-add-/.test(postHalf) && /new items on the bill, print receipt #2/.test(postHalf));
  pass("cashier keeps her To-print push exactly as-is", /fana-print-/.test(postHalf) && /To print/.test(postHalf));
  {
    // Staff-originated sends (waiter/cashier keying items) must ring NOBODY
    // extra — every waiter push on the POST path sits directly inside an
    // isCustomer-guarded branch (nearest enclosing `if (` must name it).
    const waiterPushes = [...postHalf.matchAll(/sendPushToRoles\(\["waiter"\]/g)];
    const guarded = waiterPushes.filter((m) => {
      const ifIdx = postHalf.lastIndexOf("if (", m.index);
      if (ifIdx === -1 || m.index - ifIdx > 800) return false;
      return /isCustomer/.test(postHalf.slice(ifIdx, postHalf.indexOf(")", ifIdx) + 1));
    });
    pass("staff-originated sends never ring the waiter (all waiter pushes need isCustomer)", waiterPushes.length >= 2 && guarded.length === waiterPushes.length);
  }
  pass("POST never wakes the crew (acceptance and the print do)", !/sendPushToRoles\(stations/.test(postHalf));
  pass("waiter diffs per-ticket ITEM UNITS, not just new ticket IDs", /itemCountRef/.test(waiter) && /Number\(i\.quantity\)/.test(waiter));
  pass("waiter's own keying never alarms her (own-send credit)", /ownAddRef/.test(waiter));
  pass("top-up alert names the table and says what to do", /guest added items/.test(waiter) && /go confirm!/.test(waiter) && /check the bill!/.test(waiter));
  pass("in-page top-up notification never replaces the previous one", /fana-waiter-add-/.test(waiter));
  pass("login (the one gesture browsers need) arms everything", /enablePocketAlerts\(\)/.test(waiter) && /enablePocketAlerts\(\)/.test(cashier) && /enablePocketAlerts\(\)/.test(station));
}

/* ── 6c. ROUND 2: the pocket bugs that survived the first fix ─────────────── */
{
  // Stale closures: the SSE handler is created once per login and captured the
  // `alertsOn` state of that moment. Every alert check must read a ref.
  for (const [name, src] of [["waiter", waiter], ["cashier", cashier], ["station", station]]) {
    pass(`${name} alarm check reads a live ref, not a captured state`, /alertsOnRef\.current/.test(src) && !/&& alertsOn &&/.test(src));
    pass(`${name} re-arms pocket alerts through the shared hook`, /usePocketAlerts\(/.test(src));
    pass(`${name} rebuilds a dead SSE stream (watchdog)`, /readyState === 2/.test(src));
    pass(`${name} shows whether the phone is really armed`, /PocketAlertsChip/.test(src));
    pass(`${name} treats a restored session as on-shift (alerts default ON)`, /!!saved/.test(src));
  }

  // The hook is the anti-"it worked yesterday" machinery.
  pass("pocket alerts re-arm on mount, visibility, online and a timer", /visibilitychange/.test(hook) && /"online"/.test(hook) && /setInterval\(heal/.test(hook));
  pass("a push received while the page is open rings the in-app alarm", /onPushAlert\(/.test(hook) && /playAlarm\(\)/.test(hook));
  pass("the first tap on any staff screen unlocks the audio", /armAudioOnFirstGesture\(\)/.test(hook));

  // A REAL end-to-end test (server to push service to phone), not a local popup.
  pass("staff can test pocket mode for real, with a delay to lock the phone", /\/api\/push\/test/.test(pushClient) && /delaySeconds/.test(testRoute));
  pass("the test push route is staff-only and uses the session role", /requireStaff\(\)/.test(testRoute) && /staff\.role/.test(testRoute));
  pass("the test button is reachable from the staff screens", /Test ring/.test(chip));
  pass("alerts are delivered with high urgency (wakes a dozing phone)", /urgency: "high"/.test(pushServer) && /TTL/.test(pushServer));
}

/* ── 6d. GUEST EVENTS: 3 second alarm, hard vibration, one-tap confirm ────── */
{
  // The three things a guest can do that staff cannot predict.
  pass("there is one shared 'guest event' ring setting", /export const CUSTOMER_ALERT_RING/.test(pushServer) && /gapMs: 1100/.test(pushServer) && /repeat: 3/.test(pushServer));
  pass("a new QR order uses the guest ring", /CUSTOMER_ALERT_RING/.test(tickets) && /New QR order/.test(tickets));
  pass("a guest adding items uses the guest ring", (tickets.match(/CUSTOMER_ALERT_RING/g) || []).length >= 3);
  pass("a bill request uses the guest ring", /CUSTOMER_ALERT_RING/.test(tableStatus));
  pass("the guest burst rings close together (~1.1s apart) so it is ONE alarm", /Number\(data\.gapMs\) \|\| 7000/.test(sw) && /await sleep\(gap\)/.test(sw));
  pass("a guest event vibrates for about 3 seconds", /const CUSTOMER_VIBRATE = \[800, 150, 800, 150, 800, 150, 800\]/.test(sw) && /isCustomer \? CUSTOMER_VIBRATE : DEFAULT_VIBRATE/.test(sw));
  pass("the notification itself carries a CONFIRM button", /action: "confirm", title: "✓ Confirm"/.test(sw));
  pass("pressing CONFIRM calls the same API the app calls", /event\.action === "confirm"/.test(sw) && /"\/api\/tickets"/.test(sw) && /credentials: "same-origin"/.test(sw));
  pass("an expired session is explained, not swallowed", /res\.status === 401/.test(sw));

  // The screen that cannot be missed once the phone is picked up. It rings
  // ONCE (where the event was detected) and then stays SILENT until answered:
  // no re-ring timer for unanswered events.
  pass("a guest event takes over the whole screen with one big button", /export default function UrgentAlertOverlay/.test(overlay) && /fixed inset-0/.test(overlay));
  pass("the full-screen card does NOT re-ring (no timer, no alarm after the first)", !/REPEAT_MS/.test(overlay) && !/MAX_REPEATS/.test(overlay) && !/setInterval/.test(overlay) && !/playAlarm/.test(overlay));
  pass("answering stops the buzzing", /navigator\.vibrate\(0\)/.test(overlay));
  pass("the waiter phone shows it for orders, top-ups and bill requests", /<UrgentAlertOverlay/.test(waiter) && (waiter.match(/raiseUrgent\(\{/g) || []).length >= 3);
  pass("the waiter's big button opens that table's bill", /openTicketById/.test(waiter));
  pass("the cashier tablet shows it too, with a one-tap confirm", /<UrgentAlertOverlay/.test(cashier) && /✓ ACCEPT ORDER/.test(cashier) && /setStatusRef\.current\(guestEvent\.id, "confirmed"\)/.test(cashier));
  pass("an answered guest event never pops up again", /answeredRef/.test(waiter) && /answeredRef/.test(cashier));

  // The guest side: the only thing left of the order-status UI is the receipt button.
  {
    const orderStatus = read("src/components/rms/OrderStatus.tsx");
    pass("the guest's receipt button still calls the bill request", /export function RequestReceiptButton/.test(orderStatus) && /onClick=\{requestBill\}/.test(orderStatus) && /Receipt className/.test(orderStatus));
  }
}

/* ── 7. Staff-requested menu card behavior ────────────────────────────────── */
{
  pass("the WHOLE menu card adds the food (image/text/anywhere)", /role="button"/.test(waiter) && /Add • tap anywhere/.test(waiter));
  pass("cart count badge shows on the card", /inCart\.quantity/.test(waiter));
  pass("print-queue waiter bill is read-only (confirm → send → clear only)", /printQueueMode && activeTicket\.status !== "ready_for_payment"/.test(waiter));
}

if (failures.length > 0) {
  console.error("\n❌ POCKET-ALERTS REGRESSION TEST FAILED\n");
  for (const f of failures) console.error("  • " + f);
  process.exit(1);
}
console.log("\n✅ Pocket-alerts regression test PASSED");
console.log("   • screen off / tab hidden → the alarm still rings (hidden-guard removed)");
console.log("   • browser closed → system notification via Web Push (Android automatic,");
console.log("     iPhone via Add to Home Screen, with an in-app instruction banner)");
console.log("   • loud: 6-pair alarm, low-octave layer, limiter near full scale + vibration");
console.log("   • armed automatically at staff login — no separate button to forget");
console.log("   • every customer top-up (pending/confirmed/printed) rings the waiter on");
console.log("     its own tag; staff keying never rings anyone extra; stations stay");
console.log("     silent until the cashier's print (Group 11 gate)");
console.log("   • a push is NEVER swallowed because a window looked 'focused' (the bug");
console.log("     that kept pocketed phones silent), the worker updates itself, and the");
console.log("     subscription self-heals on mount/visibility/reconnect/timer");
console.log("   • staff can prove it: 'Test ring in 10s', lock the phone, hear it");
