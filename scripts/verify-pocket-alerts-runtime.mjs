#!/usr/bin/env node
/**
 * RUNTIME regression test for pocket-mode alerts.
 *
 * The other pocket-alerts test reads the source and checks that the right
 * patterns are there. That was not enough: the bug that kept waiters' phones
 * silent lived in the BEHAVIOUR of public/sw.js, and the old source-level test
 * happily asserted the buggy rule ("if a window is focused, show nothing").
 *
 * So this test EXECUTES the real service worker inside a fake
 * ServiceWorkerGlobalScope and asserts what a phone would actually do:
 *
 *   1. Phone in a pocket, screen off, staff tab still open (the exact failing
 *      case: the client reports focused === true but visibilityState hidden)
 *      → a LOUD system notification must be shown, with vibration, and it must
 *      stay until it is tapped.
 *   2. Somebody is really looking at the staff screen (visible + focused)
 *      → a notification is STILL shown (userVisibleOnly is a promise to the
 *      browser) but silent, and the page is told to ring its own alarm.
 *   3. Browser fully closed (no clients at all) → loud notification.
 *   4. An unanswered alert re-rings; a dismissed one does not.
 *   5. Tapping the notification opens/focuses the right staff screen.
 *   6. install/activate take control immediately (skipWaiting + claim), so a
 *      phone running the old worker actually receives the fix.
 *
 * Run with: node scripts/verify-pocket-alerts-runtime.mjs  (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "public/sw.js"), "utf8");

const failures = [];
function pass(name, cond) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures.push(name);
}

/** Build a fake service-worker world and evaluate the real sw.js inside it. */
function loadWorker({ clients = [], notifications = [], onShow = null } = {}) {
  const listeners = new Map();
  const shown = [];
  const posted = [];
  const claimed = { skipWaiting: false, claim: false };
  let tray = [...notifications];

  const self = {
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    skipWaiting: () => {
      claimed.skipWaiting = true;
    },
    registration: {
      showNotification: async (title, options) => {
        shown.push({ title, options });
        tray.push({ tag: options.tag, close: () => {} });
        // Lets a test simulate staff swiping the alert away mid-ring.
        if (onShow) onShow(shown.length, { emptyTray: () => { tray = []; } });
      },
      getNotifications: async ({ tag } = {}) => tray.filter((n) => !tag || n.tag === tag),
      pushManager: { getSubscription: async () => null, subscribe: async () => null },
    },
    clients: {
      matchAll: async () => clients,
      claim: async () => {
        claimed.claim = true;
      },
      openWindow: async (url) => {
        posted.push({ type: "openWindow", url });
        return { url };
      },
    },
  };

  for (const client of clients) {
    client.postMessage = (msg) => posted.push({ to: client.url, msg });
    client.focus = async () => {
      posted.push({ type: "focus", url: client.url });
      return client;
    };
    client.navigate = async (url) => {
      posted.push({ type: "navigate", url });
      return client;
    };
  }

  const sandbox = {
    self,
    fetch: async () => ({ ok: true }),
    URL,
    Date,
    console,
    // Instant timers: the worker's re-ring waits 7s between rings, which we do
    // not want to actually sit through in a test.
    setTimeout: (fn) => {
      Promise.resolve().then(fn);
      return 0;
    },
    clearTimeout: () => {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  const fire = async (type, event) => {
    const handlers = listeners.get(type) || [];
    const waits = [];
    const ev = { ...event, waitUntil: (p) => waits.push(p) };
    for (const handler of handlers) handler(ev);
    await Promise.all(waits);
  };

  return {
    fire,
    shown,
    posted,
    claimed,
    emptyTray: () => {
      tray = [];
    },
  };
}

const pushEvent = (payload) => ({
  data: { json: () => payload, text: () => JSON.stringify(payload) },
});

const ORDER = {
  title: "New QR order",
  body: "Table 4 - 320 ETB - tap to confirm",
  tag: "fana-qr-91",
  url: "/waiter",
  urgent: true,
  repeat: 1,
};

/* ── 1. POCKET: screen off, tab open (client focused but hidden) ─────────── */
{
  const w = loadWorker({
    clients: [{ url: "https://fana.example/waiter", focused: true, visibilityState: "hidden" }],
  });
  await w.fire("push", pushEvent({ ...ORDER, repeat: 0 }));

  pass("pocket (screen off, tab focused): a notification IS shown", w.shown.length >= 1);
  const first = w.shown[0];
  pass("pocket: it is NOT silent", first && first.options.silent !== true);
  pass("pocket: it vibrates", !!(first && Array.isArray(first.options.vibrate) && first.options.vibrate.length > 0));
  pass("pocket: it waits on the lock screen until tapped", !!(first && first.options.requireInteraction === true));
  pass("pocket: it carries the staff screen to open", !!(first && first.options.data && first.options.data.url === "/waiter"));
  pass("pocket: the order title/body reach the phone", !!(first && first.title === ORDER.title && first.options.body === ORDER.body));
}

/* ── 2. Someone is actually looking at the screen ─────────────────────────── */
{
  const w = loadWorker({
    clients: [{ url: "https://fana.example/waiter", focused: true, visibilityState: "visible" }],
  });
  await w.fire("push", pushEvent(ORDER));

  pass("visible page: a notification is still shown (userVisibleOnly kept)", w.shown.length === 1);
  pass("visible page: it is silent, so there is no double noise", !!(w.shown[0] && w.shown[0].options.silent === true));
  pass("visible page: silent notification has no vibrate (spec would throw)", !!(w.shown[0] && w.shown[0].options.vibrate === undefined));
  const relay = w.posted.find((p) => p.msg && p.msg.type === "fana-push");
  pass("visible page: the page is told to ring its in-app alarm", !!relay && relay.msg.tag === ORDER.tag);
}

/* ── 3. Browser closed: no clients at all ─────────────────────────────────── */
{
  const w = loadWorker({ clients: [] });
  await w.fire("push", pushEvent({ ...ORDER, repeat: 0 }));
  pass("browser closed: the phone still rings", w.shown.length === 1 && w.shown[0].options.silent !== true);
}

/* ── 4. Re-ring until answered ────────────────────────────────────────────── */
{
  const w = loadWorker({ clients: [] });
  await w.fire("push", pushEvent({ ...ORDER, repeat: 2 }));
  pass("an ignored alert rings again (repeat rings)", w.shown.length === 3);

  // Staff swipe the notification away after the first ring: the tray empties,
  // and the worker must stop nagging.
  const dismissed = loadWorker({
    clients: [],
    onShow: (count, api) => {
      if (count === 1) api.emptyTray();
    },
  });
  await dismissed.fire("push", pushEvent({ ...ORDER, repeat: 2 }));
  pass("a dismissed alert stops re-ringing", dismissed.shown.length === 1);

  // Staff came back to the app between rings: stop nagging as well.
  const returned = [{ url: "https://fana.example/waiter", focused: false, visibilityState: "hidden" }];
  const cameBack = loadWorker({
    clients: returned,
    onShow: (count) => {
      if (count === 1) {
        returned[0].focused = true;
        returned[0].visibilityState = "visible";
      }
    },
  });
  await cameBack.fire("push", pushEvent({ ...ORDER, repeat: 2 }));
  pass("staff opening the app stops the re-rings", cameBack.shown.length === 1);
}

/* ── 5. Tapping the notification ──────────────────────────────────────────── */
{
  const w = loadWorker({
    clients: [{ url: "https://fana.example/waiter", focused: false, visibilityState: "hidden" }],
  });
  let closed = false;
  await w.fire("notificationclick", {
    notification: {
      tag: "fana-qr-91",
      data: { url: "/waiter" },
      close: () => {
        closed = true;
      },
    },
  });
  pass("tap closes the notification", closed);
  pass("tap focuses the already-open staff screen", w.posted.some((p) => p.type === "focus" && p.url.endsWith("/waiter")));

  const cold = loadWorker({ clients: [] });
  await cold.fire("notificationclick", {
    notification: { tag: "fana-station-3", data: { url: "/kitchen" }, close: () => {} },
  });
  pass("tap with no window open launches the right screen", cold.posted.some((p) => p.type === "openWindow" && p.url === "/kitchen"));
}

/* ── 6. The fix actually reaches phones running the old worker ────────────── */
{
  const w = loadWorker();
  await w.fire("install", {});
  await w.fire("activate", {});
  pass("install calls skipWaiting", w.claimed.skipWaiting);
  pass("activate claims open pages", w.claimed.claim);
}

/* ── 7. A malformed payload must never silence the phone ──────────────────── */
{
  const w = loadWorker({ clients: [] });
  await w.fire("push", {
    data: {
      json: () => {
        throw new Error("not json");
      },
      text: () => "Table 2 needs you",
    },
  });
  pass("a broken payload still rings (falls back to plain text)", w.shown.length >= 1 && w.shown[0].options.body === "Table 2 needs you");
}

if (failures.length > 0) {
  console.error("\n❌ POCKET-ALERTS RUNTIME TEST FAILED\n");
  for (const f of failures) console.error("  • " + f);
  process.exit(1);
}
console.log("\n✅ Pocket-alerts RUNTIME test PASSED");
console.log("   • the worker was executed, not just read: a pocketed phone with the tab");
console.log("     still open now gets a loud, persistent, vibrating notification");
console.log("   • a visible page gets a silent notification plus an in-app alarm");
console.log("   • ignored alerts re-ring, answered ones stop, taps open the right screen");
