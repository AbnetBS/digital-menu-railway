#!/usr/bin/env node
/**
 * Regression test - "EVERY action for a role rings that role".
 *
 * The complaint: a waiter with her phone in a pocket (or using another app)
 * only ever heard about brand new orders. Everything else in the workflow
 * changed in complete silence:
 *
 *   • the kitchen finished her food (it sat on the pass going cold),
 *   • the cashier printed the bill,
 *   • an order was CANCELLED while the crew kept cooking it,
 *   • the cashier removed an out-of-stock dish from her table's bill,
 *   • a quantity was corrected,
 *   • the guest tapped "bring the bill" (no status change, so nothing fired),
 *   • the bill was completed / settled / the table was cleared.
 *
 * src/lib/alerts.ts is now the single matrix of who is woken for what, and
 * this test walks it end to end so no future change can quietly drop an event.
 * It also checks that every mutation route is actually WIRED to the matrix.
 *
 * Run with: tsx scripts/verify-role-alerts.ts  (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_STAFF_ROLES,
  itemQuantityAlerts,
  itemRemovedAlerts,
  billRequestAlerts,
  stationProgressAlerts,
  ticketStatusAlerts,
  withoutActor,
  type RoleAlert,
} from "../src/lib/alerts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const failures: string[] = [];
function pass(name: string, cond: boolean) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures.push(name);
}

const TICKET = { id: 42, tableName: "Table 7", totalAmount: 640 };
const rolesOf = (alerts: RoleAlert[]) => [...new Set(alerts.flatMap((a) => a.roles))].sort();
const hasRole = (alerts: RoleAlert[], role: string) => alerts.some((a) => a.roles.includes(role as never));
const urgentFor = (alerts: RoleAlert[], role: string) =>
  alerts.some((a) => a.roles.includes(role as never) && a.urgent);

/* ── 1. Every ticket status wakes somebody ────────────────────────────────── */
{
  // Every status the workflow can reach (see TICKET_STATUS_TRANSITIONS).
  const statuses = [
    "pending_waiter",
    "confirmed",
    "printed",
    "preparing",
    "ready_for_payment",
    "completed",
    "paid",
    "closed",
    "cancelled",
  ];
  // Deliberately SILENT (owner's decision): the money and closing steps. They
  // update the screens but never wake a phone, so the alerts that do matter
  // keep their meaning.
  const silentStatuses = ["ready_for_payment", "completed", "paid", "closed"];
  for (const status of silentStatuses) {
    pass(`status "${status}" rings NOBODY (money/closing steps are silent)`, ticketStatusAlerts(status, TICKET).length === 0);
  }

  for (const status of statuses.filter((x) => !silentStatuses.includes(x))) {
    const alerts = ticketStatusAlerts(status, TICKET);
    pass(`status "${status}" rings at least one role`, alerts.length > 0 && rolesOf(alerts).length > 0);
    pass(`status "${status}" names the table in every alert`, alerts.every((a) => a.body.includes(TICKET.tableName)));
    pass(`status "${status}" gives every alert its own tag`, new Set(alerts.map((a) => a.tag)).size === alerts.length);
  }

  pass("confirmed puts the bill in the cashier's print queue, urgently", urgentFor(ticketStatusAlerts("confirmed", TICKET), "cashier"));
  pass("confirmed also tells the waiter it went through", hasRole(ticketStatusAlerts("confirmed", TICKET), "waiter"));
  pass("printed tells the waiter the crew can cook", hasRole(ticketStatusAlerts("printed", TICKET), "waiter"));
  // The screens still show all of these; they simply make no sound.
  pass("no money step wakes a phone", silentStatuses.every((st) => ticketStatusAlerts(st, TICKET).length === 0));

  // A cancellation is money burning on a pan: the two cooking crews are rung,
  // the waiter and cashier read it quietly on their screens.
  const cancelled = ticketStatusAlerts("cancelled", TICKET);
  pass("CANCELLED rings the kitchen and the barista", rolesOf(cancelled).join() === "barista,kitchen");
  pass("CANCELLED does not ring the waiter or the cashier", !hasRole(cancelled, "waiter") && !hasRole(cancelled, "cashier"));
  pass("CANCELLED is urgent and rings ONCE (no re-rings until answered)", cancelled.every((a) => a.urgent && a.repeat === 0));
  pass("CANCELLED says what to do (stop and do not serve)", cancelled.every((a) => /stop preparing/i.test(a.body)));

  pass("printed/preparing do NOT push stations here (the route pushes only newly released items)",
    !hasRole(ticketStatusAlerts("printed", TICKET), "kitchen") &&
      !hasRole(ticketStatusAlerts("preparing", TICKET), "barista"));
}

/* ── 2. The kitchen finishing food (the alert that did not exist) ─────────── */
{
  const base = { ...TICKET, station: "kitchen", itemName: "Shiro", quantity: 2 };
  const oneReady = stationProgressAlerts("done", { ...base, wholeOrderReady: false });
  pass("a finished dish rings the WAITER", hasRole(oneReady, "waiter"));
  pass("a finished dish is urgent (food goes cold)", urgentFor(oneReady, "waiter"));
  pass("a finished dish names the dish and the table",
    oneReady.every((a) => a.body.includes("Shiro") && a.body.includes(TICKET.tableName)));

  const allReady = stationProgressAlerts("done", { ...base, wholeOrderReady: true });
  pass("the LAST finished dish says the whole order is ready", allReady.some((a) => /ORDER READY/i.test(a.title)));

  const started = stationProgressAlerts("accepted", { ...base, wholeOrderReady: false });
  pass("the crew starting work informs the waiter quietly", hasRole(started, "waiter") && started.every((a) => !a.urgent));

  pass("an unknown station action rings nobody", stationProgressAlerts("pending", { ...base, wholeOrderReady: false }).length === 0);
}

/* ── 3. Items removed or corrected on a live bill ─────────────────────────── */
{
  const removedKitchen = itemRemovedAlerts({ ...TICKET, itemName: "Tibs", station: "kitchen" });
  pass("a removed item rings the waiter (she must tell the guest)", urgentFor(removedKitchen, "waiter"));
  pass("a removed item rings the station that was cooking it", urgentFor(removedKitchen, "kitchen"));
  pass("a removed item never rings the wrong station", !hasRole(removedKitchen, "barista"));

  const removedBarista = itemRemovedAlerts({ ...TICKET, itemName: "Macchiato", station: "barista" });
  pass("a removed drink rings the barista", hasRole(removedBarista, "barista") && !hasRole(removedBarista, "kitchen"));

  const removedNoStation = itemRemovedAlerts({ ...TICKET, itemName: "Water", station: "" });
  pass("an item with no station still rings the waiter", hasRole(removedNoStation, "waiter") && removedNoStation.length === 1);

  const qty = itemQuantityAlerts({ ...TICKET, itemName: "Tibs", station: "kitchen", fromQuantity: 2, toQuantity: 4 });
  pass("a quantity change tells both waiter and station", hasRole(qty, "waiter") && hasRole(qty, "kitchen"));
  pass("a quantity change spells out the old and new number", qty.every((a) => a.body.includes("2 to 4")));
}

/* ── 4. The guest asking for the bill ─────────────────────────────────────── */
{
  const bill = billRequestAlerts(TICKET);
  pass("a bill request rings waiter and cashier urgently",
    urgentFor(bill, "waiter") && urgentFor(bill, "cashier"));
}

/* ── 4b. EVERY event rings EXACTLY ONCE (no re-rings while unanswered) ────── */
{
  // During a rush a phone that keeps re-ringing for an unanswered event trains
  // staff to ignore it. Every alert in the matrix must have repeat === 0: one
  // ring, then quiet, even if nobody has reacted yet.
  const statuses = ["pending_waiter", "confirmed", "printed", "preparing", "cancelled"];
  const matrixAlerts: RoleAlert[] = [
    ...statuses.flatMap((s) => ticketStatusAlerts(s, TICKET)),
    ...stationProgressAlerts("done", { ...TICKET, station: "kitchen", itemName: "Shiro", quantity: 2, wholeOrderReady: false }),
    ...stationProgressAlerts("done", { ...TICKET, station: "kitchen", itemName: "Shiro", quantity: 1, wholeOrderReady: true }),
    ...stationProgressAlerts("accepted", { ...TICKET, station: "barista", itemName: "Macchiato", quantity: 1, wholeOrderReady: false }),
    ...itemRemovedAlerts({ ...TICKET, itemName: "Tibs", station: "kitchen" }),
    ...itemRemovedAlerts({ ...TICKET, itemName: "Macchiato", station: "barista" }),
    ...itemQuantityAlerts({ ...TICKET, itemName: "Tibs", station: "kitchen", fromQuantity: 2, toQuantity: 4 }),
    ...itemQuantityAlerts({ ...TICKET, itemName: "Tibs", station: "", fromQuantity: 1, toQuantity: 2 }),
    ...billRequestAlerts(TICKET),
  ];
  pass(`every alert in the matrix has repeat 0 (${matrixAlerts.length} alerts checked)`,
    matrixAlerts.length > 0 && matrixAlerts.every((a) => a.repeat === 0));
}

/* ── 5. Nobody rings their own phone ──────────────────────────────────────── */
{
  const cancelled = ticketStatusAlerts("cancelled", TICKET);
  const confirmedAsCashier = withoutActor(ticketStatusAlerts("confirmed", TICKET), "cashier");
  pass("the actor's own role is dropped", !hasRole(confirmedAsCashier, "cashier") && hasRole(confirmedAsCashier, "waiter"));
  pass("everyone else still gets it", rolesOf(confirmedAsCashier).join() === "barista,kitchen,waiter");

  const confirmedByWaiter = withoutActor(ticketStatusAlerts("confirmed", TICKET), "waiter");
  pass("a waiter accepting rings the kitchen, the barista and the cashier", rolesOf(confirmedByWaiter).join() === "barista,cashier,kitchen");

  const soloAlert = withoutActor(stationProgressAlerts("done", { ...TICKET, station: "kitchen", itemName: "Shiro", quantity: 1, wholeOrderReady: true }), "waiter");
  pass("an alert with no recipients left is dropped entirely", soloAlert.length === 0);
  pass("no actor given = nobody filtered", withoutActor(cancelled, null).length === cancelled.length);
}

/* ── 6. The routes are actually wired to the matrix ───────────────────────── */
{
  const ticketsRoute = read("src/app/api/tickets/route.ts");
  const stationRoute = read("src/app/api/station-items/route.ts");
  const itemsRoute = read("src/app/api/tickets/items/route.ts");
  const tableStatus = read("src/app/api/table-status/route.ts");

  pass("ticket status changes go through the matrix", /ticketStatusAlerts\(/.test(ticketsRoute) && /withoutActor\(/.test(ticketsRoute));
  pass("the ticket route knows WHO acted (to skip their own phone)", /readStaffSession\(\)/.test(ticketsRoute) && /actor\?\.role/.test(ticketsRoute));
  pass("station progress pushes the waiter", /stationProgressAlerts\(/.test(stationRoute) && /sendPushToRoles/.test(stationRoute));
  pass("station route computes whether the WHOLE order is ready", /wholeOrderReady/.test(stationRoute));
  pass("item removal pushes waiter + station", /itemRemovedAlerts\(/.test(itemsRoute));
  pass("quantity edits push waiter + station", /itemQuantityAlerts\(/.test(itemsRoute));
  {
    // The guest burst is the ONE alarm left in the system: its four quick
    // rings ~1.1s apart are a single ~3 second alarm, not repeats. The shared
    // constant must stay untouched, and no route may pass its own repeat
    // above 0 apart from that constant.
    const pushLib = read("src/lib/push.ts");
    const billAlerts = billRequestAlerts(TICKET);
    pass("bill requests ring the full guest burst, exactly once (constant untouched)",
      /CUSTOMER_ALERT_RING/.test(tableStatus) &&
      /export const CUSTOMER_ALERT_RING = \{ urgent: true as const, repeat: 3, gapMs: 1100, kind: "customer" as const \};/.test(pushLib) &&
      billAlerts.every((a) => a.repeat === 0));
    for (const [name, src] of [["tickets", ticketsRoute], ["station-items", stationRoute], ["tickets/items", itemsRoute], ["table-status", tableStatus]] as const) {
      const ownRepeats = [...src.matchAll(/repeat:\s*(\d+)/g)].map((m) => Number(m[1]));
      pass(`${name}: no push passes its own repeat above 0 (got [${ownRepeats.join(", ")}])`,
        ownRepeats.every((r) => r === 0));
    }
  }

  // Alerts may never take an order flow down with them.
  for (const [name, src] of [["tickets", ticketsRoute], ["station-items", stationRoute], ["tickets/items", itemsRoute]] as const) {
    pass(`${name}: alerts are fire-and-forget and cannot fail the request`, /void sendPushToRoles/.test(src) && /catch/.test(src));
  }
}

/* ── 7. The staff screens ring in-app for the same events ─────────────────── */
{
  const waiter = read("src/components/rms/WaiterApp.tsx");
  const station = read("src/components/rms/StationApp.tsx");
  const cashier = read("src/components/rms/CashierDashboard.tsx");

  pass("waiter screen alarms when food is READY", /readyRef/.test(waiter) && /ready to serve/i.test(waiter));
  pass("waiter screen alarms when the guest asks for the bill", /billAskedRef/.test(waiter));
  pass("waiter screen announces status moves made by others", /statusMoveLabel/.test(waiter) && /ORDER CANCELLED/.test(waiter));
  pass("waiter never alarms herself for her own taps", /ownStatusRef/.test(waiter) && /noteOwnStatus\(/.test(waiter));
  pass("station screen alarms when a line is removed or changed", /itemSigRef/.test(station) && /was REMOVED/.test(station));
  pass("station screen alarms when the whole order disappears", /stop preparing/.test(station));
  pass("cashier reacts to bill requests (no status change involved)", /receiptRequestedAt \? 1 : 0/.test(cashier));
  pass("cashier only sounds for events in her message list", /const loudEvents = newEvents\.filter\(\(t\) => eventMessage\(t\) !== null\)/.test(cashier));
  pass("payment and closing moments are not in that list", !/ready_for_payment: `/.test(cashier) && !/closed: `/.test(cashier) && !/paid: `/.test(cashier) && !/completed: `/.test(cashier));
}

if (failures.length > 0) {
  console.error("\n❌ ROLE-ALERT COVERAGE TEST FAILED\n");
  for (const f of failures) console.error("  • " + f);
  process.exit(1);
}
console.log("\n✅ Role-alert coverage test PASSED");
console.log("   • every ticket status, every station action, every item change and every");
console.log("     bill request now wakes the roles that must react");
console.log("   • every event rings EXACTLY ONCE (repeat 0); the only repeat left is");
console.log("     the shared CUSTOMER_ALERT_RING burst, whose quick rings are one");
console.log("     ~3 second alarm, not repeats");
console.log("   • the person who performed the action is never rung by their own tap");
