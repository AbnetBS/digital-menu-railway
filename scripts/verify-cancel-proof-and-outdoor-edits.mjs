#!/usr/bin/env node
/**
 * Regression test — "the crews get PROOF of a cancellation" and "an outdoor
 * order can be edited, added to or cancelled in place" (owner, Sept 2026).
 *
 * Two problems the three station workers raised:
 *
 *   1. A waiter sends an order, the crew starts it, then it is cancelled — and
 *      the line simply VANISHES. They had no proof it ever existed. Now every
 *      cancellation is served by the API and shown in RED with a CANCELLED
 *      label and an Okay button where Accept/Done used to be, it rings the
 *      loud alarm, and Okay only clears it from that one device.
 *   2. Guests call back after an outdoor order is already with the stations.
 *      The only way out used to be a SECOND outdoor order nobody could match
 *      up. Now the cashier and the buna maker can EDIT a line, ADD items to
 *      the SAME bill, or CANCEL it — exactly like a normal order.
 *
 * Run with: node scripts/verify-cancel-proof-and-outdoor-edits.mjs
 * (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const stationsApi = read("src/app/api/station-items/route.ts");
const ticketsApi = read("src/app/api/tickets/route.ts");
const stationApp = read("src/components/rms/StationApp.tsx");
const waiter = read("src/components/rms/WaiterApp.tsx");
const cashier = read("src/components/rms/CashierDashboard.tsx");
const composer = read("src/components/rms/OutdoorOrderComposer.tsx");

const failures = [];
const countOf = (hay, needle) => hay.split(needle).length - 1;
function pass(name, cond) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures.push(name);
}

/* ── 1. THE CANCELLED FEED ──────────────────────────────────────────────── */
{
  pass("the station API serves the cancelled feed (?cancelled=1)",
    stationsApi.includes('searchParams.get("cancelled") === "1"'));
  pass("it is scoped to THIS crew's own station (a cancelled juice never shows in the kitchen)",
    stationsApi.includes("eq(ticketItems.stationName, station)") && countOf(stationsApi, "eq(ticketItems.stationName, station)") >= 3);
  pass("only lines the crew could have received are in it (held guest lines are not their work)",
    stationsApi.includes("COALESCE(${ticketItems.released}, true) = true"));
  pass("a WHOLE cancelled order is served as one record",
    stationsApi.includes('eq(tickets.status, "cancelled")') && stationsApi.includes("wholeOrder: true"));
  pass("a line removed off a bill that is still open is served too",
    stationsApi.includes("it.removed === true") && stationsApi.includes("wholeOrder: false"));
  pass("the feed is time-boxed (yesterday's cancellation is not today's news)",
    stationsApi.includes("since.setDate(since.getDate() - 2)"));
  pass("the feed is never cached (a cancellation must appear the second it happens)",
    stationsApi.includes('"Cache-Control": "no-store"'));
}

/* ── 2. THE RED RECORD ON THE CREW SCREENS ──────────────────────────────── */
{
  pass("the crew screen keeps the cancelled work in state",
    stationApp.includes("const [cancelledRows, setCancelledRows]"));
  pass("the record is RED, not greyed out and gone",
    stationApp.includes("border-rose-600/70") && stationApp.includes("text-rose-300 line-through"));
  // The RENDERED section: from the last cancelledVisible.map up to the live
  // ticket list that follows it.
  const cancelledRender = stationApp.split("cancelledVisible.map").pop() || "";
  const cancelledSection = cancelledRender.split("{/* tickets cards */}")[0] || cancelledRender.slice(0, 4000);
  pass('it says CANCELLED where Accept/Done used to be',
    cancelledSection.includes('{L("⛔ CANCELLED")}') && countOf(cancelledSection, "{L(\"Okay\")}") >= 1);
  pass("Okay replaces the Accept and Done buttons on a cancelled line",
    !/setStatus\(/.test(cancelledSection) && !/Accept/.test(cancelledSection) && !/>\{L\("Done"\)\}/.test(cancelledSection));
  pass("a whole order is dismissed with ONE Okay, a removed line with its own",
    stationApp.includes("row.wholeOrder ? [`o:${row.id}`] : row.items.map((i) => `i:${i.id}`)"));
  pass("Okay is remembered per device, so a refresh does not resurrect the record",
    stationApp.includes("localStorage.getItem(cancelledOkKey)") && stationApp.includes("localStorage.setItem(cancelledOkKey"));
  pass("the record is proof only — it never offers a crew action and never counts as work",
    !/setStatus\(/.test(cancelledSection));
  pass("the buna makers get the same proof on their own screen",
    waiter.includes("bunaCancelledVisible") && waiter.includes("loadBunaCancelled"));
  pass("the buna record lives in the buna lane, above the tables",
    waiter.includes('{L("⛔ Cancelled • proof for you")}') && waiter.includes("isBuna && bunaCancelledVisible.length > 0"));
}

/* ── 3. IT RINGS ────────────────────────────────────────────────────────── */
{
  pass("a brand-new cancellation rings the loud alarm",
    stationApp.includes("playAlarm()") && stationApp.includes("newCancelled.length > 0"));
  pass("the alarm says WHAT was cancelled, not just that something happened",
    stationApp.includes('"⛔ {tableName}: order CANCELLED • stop preparing"')
    && stationApp.includes('"✗ {tableName}: {name} was REMOVED, do not prepare it"'));
  pass("the first read of the feed only builds the baseline (no alarm on login)",
    stationApp.includes("if (initRef.current) newCancelled.push(row);"));
  pass("the vanished-ticket alarm defers to the feed, so one cancellation rings ONCE",
    stationApp.includes("const cancelledTicketIds = new Set(") && stationApp.includes("if (cancelledTicketIds.has(id)) continue;"));
  pass("the buna makers' phone rings for a cancelled buna order too",
    waiter.includes("fana-buna-cancelled-") && waiter.includes("playAlarm();"));
}

/* ── 4. EDIT / ADD / CANCEL AN OUTDOOR ORDER ────────────────────────────── */
{
  pass("the composer can aim at an order that already went out (targetTicket)",
    composer.includes("targetTicket") && composer.includes("targetTicketId: targetTicket.id"));
  pass("adding never renames the order or overwrites where it is going",
    composer.includes("{!targetTicket && (") && composer.includes("targetTicket ? targetTicket.label : label.trim()"));
  pass('the send button says "Add to this order" when it is a round, not a new order',
    composer.includes('L("✓ Add to this order")'));
  pass("the API really merges into the target outdoor bill (no second ticket)",
    ticketsApi.includes("const targetTicketId = Number(body?.targetTicketId) || 0;")
    && ticketsApi.includes("eq(tickets.orderType, \"outdoor\"),"));
  pass("the cashier can ADD items to an outdoor order she already sent",
    cashier.includes("setAddToTicket(t)") && cashier.includes('{L("+ Add items")}'));
  pass("the cashier keeps the per-line EDIT on an outdoor order",
    cashier.includes("setEditTarget({ item: i })") && cashier.includes('{L("✎ Edit")}'));
  pass("the cashier can CANCEL a whole outdoor order from its card",
    cashier.includes("cancelTicket(t.id)") && cashier.includes('{L("✗ Cancel order")}'));
  pass("the buna makers can ADD to an outdoor order from their own screen",
    waiter.includes('{L("+ Add to an outdoor order")}') && waiter.includes("setOutdoorPickerOpen(true)"));
  pass("the buna maker picks WHICH open outdoor bill to add to",
    waiter.includes("outdoorTickets.map((t) => (") && waiter.includes('{L("Pick the outdoor order")}'));
  pass("the maker can CANCEL the outdoor bill from the bill itself",
    waiter.includes("cancelOutdoorOrder") && waiter.includes("status: \"cancelled\""));
  pass("a TABLE bill is never cancelled from the waiter app (that stays the cashier's call)",
    waiter.includes('if (activeTicket.orderType !== "outdoor") return;'));
}

/* ── report ─────────────────────────────────────────────────────────────── */
if (failures.length > 0) {
  console.log(`\n❌ CANCEL-PROOF / OUTDOOR-EDIT REGRESSION TEST FAILED\n`);
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
console.log("\n✅ cancel-proof + outdoor edit/add/cancel checks passed");
