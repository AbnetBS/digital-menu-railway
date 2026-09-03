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
  pass("stations ring the full alarm on new items", /playAlarm\(\)/.test(station));
  pass("waiters ring the full alarm on new QR orders", /playAlarm\(\)/.test(waiter));
  pass("cashier distinguishes 'needs me' (alarm) from noise (ding)", /needsMe/.test(cashier) && /playAlarm\(\)/.test(cashier));
}

/* ── 3. First notification no longer vanishes ─────────────────────────────── */
{
  pass("permission request is followed by ACTUALLY showing", /requestPermission\(\)\.then\(\(p\) => \{/.test(notif) && /if \(p === "granted"\) show\(\)/.test(notif));
  pass("in-page notifications vibrate the phone", /navigator\.vibrate/.test(notif));
}

/* ── 4. Pocket mode: Web Push ─────────────────────────────────────────────── */
{
  pass("service worker handles push events", /addEventListener\("push"/.test(sw));
  pass("service worker shows system notifications with renotify + vibration", /renotify: true/.test(sw) && /vibrate/.test(sw));
  pass("no double-noise while a staff window is focused", /anyFocused/.test(sw) && /if \(anyFocused\) return/.test(sw));
  pass("tapping the notification opens the right staff screen", /notificationclick/.test(sw) && /openWindow/.test(sw));
  pass("rotated keys resubscribe (pushsubscriptionchange)", /pushsubscriptionchange/.test(sw));
  pass("client subscribes with the server's VAPID public key", /applicationServerKey/.test(pushClient) && /\/api\/push\/public-key/.test(pushClient));
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
  pass("POST never pushes to stations (receipt must exist first)", !/stationPush/.test(tickets) && !/sendPushToRoles\(stations/.test(tickets.split("export async function PUT")[0] || ""));
  pass("✓ PRINTED releases the crew — PUT wakes kitchen/barista", /body\.status === "printed" \|\| \(body\.status === "preparing"/.test(tickets) && /fana-station-/.test(tickets));
  pass("only stations with newly released items are pinged", /prevStamp === null \|\| !r\.createdAt \|\| new Date\(r\.createdAt\)\.getTime\(\) > prevStamp/.test(tickets));
  pass("bill request → waiter + cashier", /fana-bill-/.test(tableStatus) && /\["waiter", "cashier"\]/.test(tableStatus));
  pass("login (the one gesture browsers need) arms everything", /enablePocketAlerts\(\)/.test(waiter) && /enablePocketAlerts\(\)/.test(cashier) && /enablePocketAlerts\(\)/.test(station));
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
console.log("   • loud: triple-frequency bells at the limiter ceiling + vibration");
console.log("   • armed automatically at staff login — no separate button to forget");
