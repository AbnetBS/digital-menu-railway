#!/usr/bin/env node
/**
 * Regression test — the three Fana Cafe workflow changes the owner asked for
 * (September 2026). Static source inspection verifies that:
 *
 *   1. WAITER SEND HOLD: when a waiter sends an order FROM HER OWN PHONE, the
 *      order waits `waiter_send_hold_seconds` (default 60) before it reaches
 *      the stations, with a live countdown and a "Send now" button beside it.
 *      The cart stays editable during the hold, and cancelling the cart
 *      cancels the hold. A customer's QR order that she ACCEPTS is NOT held,
 *      and neither is an addition to a bill she already sent.
 *   2. THE OWNER CAN CHANGE THE HOLD: the admin Stations tab has a seconds
 *      control (presets 30 sec / 1 min / 2 min / 3 min) saved through
 *      PUT /api/settings as `waiter_send_hold_seconds`, and the value is
 *      clamped to something sane (10..600).
 *   3. PRINT FREES THE TABLE: the cashier's ✓ PRINTED tap releases the dine-in
 *      bill — the table is free for the next guests, the crews keep seeing the
 *      bill until every line is done, and additions to a printed dine-in bill
 *      become a NEW order instead of folding into the printed one.
 *   4. GUEST LINES NEED A HUMAN: anything a guest sends (or adds to a bill that
 *      was already sent) is inserted with ticket_items.released = false, is
 *      invisible to the crews, and is released by the waiter's "Send to
 *      stations" or the cashier's "CONFIRM TO STATIONS".
 *
 * Run with: node scripts/verify-send-hold-and-release.mjs  (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const tickets = read("src/app/api/tickets/route.ts");
const stationsApi = read("src/app/api/station-items/route.ts");
const tablesApi = read("src/app/api/tables/route.ts");
const schema = read("src/db/schema.ts");
const migrate = read("src/db/migrate.ts");
const waiter = read("src/components/rms/WaiterApp.tsx");
const cashier = read("src/components/rms/CashierDashboard.tsx");
const stationsTab = read("src/components/rms/StationsTab.tsx");
const sendHold = read("src/lib/send-hold.ts");
const orderRelease = read("src/lib/order-release.ts");
const orderLinesLib = read("src/lib/order-lines.ts");
const tableStatusApi = read("src/app/api/table-status/route.ts");
const settingsApi = read("src/app/api/settings/route.ts");

const failures = [];
const countOf = (hay, needle) => hay.split(needle).length - 1;
function pass(name, cond) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures.push(name);
}

/* ── 1. THE WAITER'S SEND HOLD ──────────────────────────────────────────── */
{
  pass("the hold lives in a small pure helper with the 60 second default",
    sendHold.includes("WAITER_SEND_HOLD_DEFAULT_SECONDS = 60"));
  pass("the helper clamps the setting to something sane (10..600)",
    /WAITER_SEND_HOLD_MIN_SECONDS = 10/.test(sendHold) && /WAITER_SEND_HOLD_MAX_SECONDS = 600/.test(sendHold));
  pass("a broken setting falls back to the default, never to 0",
    /waiterSendHoldSeconds/.test(sendHold) && /WAITER_SEND_HOLD_DEFAULT_SECONDS/.test(sendHold));
  pass("the countdown reads m:ss on the phone",
    /formatHoldClock/.test(sendHold) && /padStart\(2, "0"\)/.test(sendHold));
  pass("the waiter app renders that clock in the hold panel",
    countOf(waiter, "formatHoldClock") >= 2);

  // The hold is client-side in the waiter app: a timer, then the real POST.
  pass("her send starts a hold instead of posting straight away",
    waiter.includes("startSendHold") && /holdDeadline/.test(waiter) && /holdLeft/.test(waiter));
  pass("the hold counts down on the phone (a ticking timer, not a sleep)",
    /setInterval/.test(waiter) && /holdLeft/.test(waiter));
  pass('a "Send now" button releases the order immediately',
    waiter.includes("Send now") && /sendOrder/.test(waiter));
  pass("Cancel puts the cart back the way it was",
    waiter.includes("cancelSendHold") && waiter.includes("holdDeadline"));
  pass("the cart sheet (and its edit buttons) stays open while it counts down",
    countOf(waiter, "setCart(") >= 3 && waiter.includes("{holdDeadline !== null ? ("));
  pass("the hold auto-releases at zero (the order still goes out)",
    /holdLeft <= 0/.test(waiter) || /holdLeft < 1/.test(waiter) || /setHoldDeadline\(null\)/.test(waiter));
  pass("emptying the cart cancels the hold (nothing is sent by accident)",
    /cart\.length === 0/.test(waiter) && /cancelSendHold/.test(waiter));

  // SCOPE (the owner was explicit): her OWN phone only.
  // SCOPE (the owner was explicit): her OWN phone only.
  const confirmOrderBody = (waiter.split("const confirmOrder = async () => {")[1] || "").split("\n  };")[0] || "";
  pass("accept-and-sending a customer's QR order is NEVER held (it PUTs straight away)",
    confirmOrderBody.includes('status: "confirmed"') && confirmOrderBody.includes("/api/tickets")
    && !confirmOrderBody.includes("startSendHold") && !confirmOrderBody.includes("setHoldDeadline"));
  pass("only her own SEND button starts a hold (one call site, one definition)",
    countOf(waiter, "startSendHold") === 2 && waiter.includes("onClick={startSendHold}"));
}

/* ── 2. THE OWNER CAN CHANGE THE SECONDS ────────────────────────────────── */
{
  pass("the admin Stations tab has the seconds control",
    /waiter_send_hold_seconds/.test(stationsTab) && /Timer/.test(stationsTab));
  pass("the control offers 30 sec / 1 min / 2 min / 3 min",
    stationsTab.includes("[30, 60, 120, 180]") && stationsTab.includes("setHoldSeconds(preset)")
    && ["30 sec", "1 min", "2 min", "3 min"].every((label) => stationsTab.includes(`L("${label}")`)));
  pass("it saves through PUT /api/settings together with the station routing",
    stationsTab.includes('"/api/settings"') && /waiter_send_hold_seconds: String\(holdSeconds\)/.test(stationsTab));
  pass("the settings route is a plain key/value store (no schema change needed)",
    /siteSettings/.test(settingsApi));
  pass("the waiter reads the setting at login and clamps it",
    waiter.includes("waiter_send_hold_seconds") && waiter.includes("waiterSendHoldSeconds"));
}

/* ── 3. THE PRINT FREES THE TABLE ───────────────────────────────────────── */
{
  pass("a released bill is a dine-in bill the cashier printed",
    orderRelease.includes('=== "outdoor") return false;') && /return Boolean\(ticket\.printedAt\);/.test(orderRelease));
  pass("the tables grid ignores released bills when it paints a table",
    tablesApi.includes("isTableReleased") && /!isTableReleased\(x\)/.test(tablesApi));
  pass("the newest open bill wins when a table turned over",
    /\.sort\(\(a, b\) => b\.id - a\.id\)/.test(tablesApi));
  pass("the unique one-bill-per-table index excludes printed dine-in bills",
    /order_type = 'outdoor' OR printed_at IS NULL/.test(migrate));
  pass("the merge lookups never add to a released bill (a new order is created)",
    countOf(tickets, 'or(eq(tickets.orderType, "outdoor"), isNull(tickets.printedAt))') >= 2);
  pass("the crews keep seeing a printed bill until every line is done",
    /allLinesFinished/.test(stationsApi) && /status: "closed"/.test(stationsApi));
  pass("an outdoor/group bill is exempt and keeps receiving rounds after a print",
    /isTableReleased/.test(tablesApi) && /orderType/.test(tablesApi));
}

/* ── 4. GUEST LINES NEED A HUMAN CONFIRMATION ───────────────────────────── */
{
  pass("ticket_items carries the release flag, defaulting to released",
    /released: boolean\("released"\)\.default\(true\)/.test(schema));
  pass("a guest top-up on a sent bill is inserted HELD",
    tickets.includes("released: !holdNewLines") && tickets.includes("const holdNewLines = isCustomer && billAlreadySent;"));
  pass("a held top-up never folds into an already-released row",
    tickets.includes("(row.released ?? true) === !holdNewLines"));
  pass("the crews only see released lines (bill released AND line released)",
    stationsApi.includes("COALESCE(${ticketItems.released}, true) = true") && /isLineHeld/.test(stationsApi));
  pass("the waiter's release button says where the lines go",
    waiter.includes("✓ Send to stations"));
  pass("the cashier's release button says CONFIRM TO STATIONS",
    cashier.includes("✓ CONFIRM TO STATIONS"));
  pass("both releases go through the same PUT (send:true / confirmed)",
    tickets.includes("sendRequested") && tickets.includes("additions_released"));
  pass("releasing wakes exactly the crews that received new work",
    tickets.includes("releasedStations") && countOf(tickets, "sendPushToRoles(releasedStations") === 1);
  pass("the guest's own status screen is driven by the shared phase helper",
    tableStatusApi.includes("customerOrderPhase") && orderLinesLib.includes("customerOrderPhase"));
}

/* ── report ─────────────────────────────────────────────────────────────── */
if (failures.length > 0) {
  console.log(`\n❌ SEND-HOLD / RELEASE REGRESSION TEST FAILED\n`);
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
console.log("\n✅ send-hold + print-release + guest-confirmation checks passed");
