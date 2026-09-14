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
  itemNotesAlerts,
  itemEditedAfterPrintAlerts,
  billRequestAlerts,
  stationProgressAlerts,
  ticketStatusAlerts,
  ticketOwner,
  withoutActor,
  type RoleAlert,
} from "../src/lib/alerts";
import { readyPhrase } from "../src/lib/ready-phrase";

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

  // Also SILENT (owner's decision, Sept 2026): "bill printed" and "kitchen
  // accepted" are information, not a call to act — the waiter has nowhere to
  // walk for either, so ringing her is pure noise. Screens still update.
  for (const status of ["printed", "preparing"]) {
    pass(`status "${status}" rings NOBODY (owner: noise, screens still update)`, ticketStatusAlerts(status, TICKET).length === 0);
  }

  for (const status of statuses.filter((x) => ![...silentStatuses, "printed", "preparing"].includes(x))) {
    const alerts = ticketStatusAlerts(status, TICKET);
    pass(`status "${status}" rings at least one role`, alerts.length > 0 && rolesOf(alerts).length > 0);
    pass(`status "${status}" names the table in every alert`, alerts.every((a) => a.body.includes(TICKET.tableName)));
    pass(`status "${status}" gives every alert its own tag`, new Set(alerts.map((a) => a.tag)).size === alerts.length);
  }

  pass("confirmed puts the bill in the cashier's print queue, urgently", urgentFor(ticketStatusAlerts("confirmed", TICKET), "cashier"));
  pass("confirmed also tells the waiter it went through", hasRole(ticketStatusAlerts("confirmed", TICKET), "waiter"));
  // The screens still show all of these; they simply make no sound.
  pass("no money step wakes a phone", silentStatuses.every((st) => ticketStatusAlerts(st, TICKET).length === 0));

  // A cancellation is money burning on a pan: the cooking crews are rung,
  // the waiter and cashier read it quietly on their screens.
  const cancelled = ticketStatusAlerts("cancelled", TICKET);
  pass("CANCELLED rings all four cooking crews (kitchen, barista, buna, juice)", rolesOf(cancelled).join() === "barista,buna,juice,kitchen");
  pass("CANCELLED does not ring the waiter or the cashier", !hasRole(cancelled, "waiter") && !hasRole(cancelled, "cashier"));
  pass("CANCELLED is urgent and rings ONCE (no re-rings until answered)", cancelled.every((a) => a.urgent && a.repeat === 0));
  pass("CANCELLED says what to do (stop and do not serve)", cancelled.every((a) => /stop preparing/i.test(a.body)));

  pass("printed/preparing do NOT push stations here (the route never re-pushes on print — instant release rings them at the send)",
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
  pass("spoken ready call is 'Table 7 is ready'", readyPhrase("Table 7") === "Table 7 is ready");
  pass("spoken ready call prefixes a bare table number", readyPhrase("5") === "Table 5 is ready");
  pass("spoken ready call reads outdoor names without a second Table",
    readyPhrase("OUTDOOR • White car") === "Outdoor, White car is ready");

  const started = stationProgressAlerts("accepted", { ...base, wholeOrderReady: false });
  pass("the crew starting work rings NOBODY (owner: noise — only DONE rings)", started.length === 0);

  pass("an unknown station action rings nobody", stationProgressAlerts("pending", { ...base, wholeOrderReady: false }).length === 0);
}

/* ── 3. Items removed or corrected on a live bill ─────────────────────────── */
{
  const removedKitchen = itemRemovedAlerts({ ...TICKET, itemName: "Tibs", station: "kitchen" });
  pass("a removed item does NOT ring the waiter (owner: noise)", !hasRole(removedKitchen, "waiter"));
  pass("a removed item rings the station that was cooking it", urgentFor(removedKitchen, "kitchen"));
  pass("a removed item never rings the wrong station", !hasRole(removedKitchen, "barista"));

  const removedBarista = itemRemovedAlerts({ ...TICKET, itemName: "Macchiato", station: "barista" });
  pass("a removed drink rings the barista", hasRole(removedBarista, "barista") && !hasRole(removedBarista, "kitchen"));

  const removedNoStation = itemRemovedAlerts({ ...TICKET, itemName: "Water", station: "" });
  pass("an item with no station rings nobody (screens update silently)", removedNoStation.length === 0);

  const qty = itemQuantityAlerts({ ...TICKET, itemName: "Tibs", station: "kitchen", fromQuantity: 2, toQuantity: 4 });
  pass("a quantity change tells both waiter and station", hasRole(qty, "waiter") && hasRole(qty, "kitchen"));
  pass("a quantity change spells out the old and new number", qty.every((a) => a.body.includes("2 to 4")));

  // A note changed on a line the crew already STARTED: they would never
  // re-read it, so the owning station is rung urgently (the waiter is not —
  // she wrote it herself or stands next to the cashier who did).
  const note = itemNotesAlerts({ ...TICKET, itemName: "Tea", station: "barista" });
  pass("a changed note rings ONLY the owning station, urgently",
    rolesOf(note).join() === "barista" && urgentFor(note, "barista"));
  pass("a changed note says to re-read it", note.every((a) => /re-read the note/i.test(a.body)));
  pass("a changed note on a station-less line rings nobody",
    itemNotesAlerts({ ...TICKET, itemName: "Water", station: "" }).length === 0);

  // A correction landing AFTER the EFD receipt went out: the cashier must
  // re-key the EFD, and only an alarm tells her (the editor is usually a
  // waiter, not her).
  const afterPrint = itemEditedAfterPrintAlerts({ ...TICKET, itemName: "Tibs", station: "kitchen" });
  pass("an edit after print rings the cashier, urgently",
    rolesOf(afterPrint).join() === "cashier" && urgentFor(afterPrint, "cashier"));
  pass("an edit after print says to re-key the EFD", afterPrint.every((a) => /re-key/i.test(a.body)));
}

/* ── 4. The guest asking for the bill ─────────────────────────────────────── */
{
  const bill = billRequestAlerts(TICKET);
  pass("a bill request rings waiter and cashier urgently",
    urgentFor(bill, "waiter") && urgentFor(bill, "cashier"));
}

/* ── 4a. Food-ready and bill-request ring ONE waiter, not the team ────────── */
{
  pass("accepted QR order is owned by the accepting waiter", ticketOwner("Sara", "Customer (QR)") === "Sara");
  pass("waiter-sent bill is owned by its sender", ticketOwner(null, "Sara") === "Sara");
  pass("unaccepted QR order has no owner (rings every waiter)", ticketOwner(null, "Customer (QR)") === null);
  pass("empty names have no owner (rings every waiter)", ticketOwner(null, null) === null && ticketOwner("", "") === null);
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
    ...itemNotesAlerts({ ...TICKET, itemName: "Tea", station: "barista" }),
    ...itemEditedAfterPrintAlerts({ ...TICKET, itemName: "Tibs", station: "kitchen" }),
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
  // TICKET carries no `stations`, so the release falls back to every crew:
  // ringing one crew too many is better than serving nobody.
  pass("everyone else still gets it", rolesOf(confirmedAsCashier).join() === "barista,buna,juice,kitchen,waiter");

  const confirmedByWaiter = withoutActor(ticketStatusAlerts("confirmed", TICKET), "waiter");
  pass("a waiter accepting rings every crew and the cashier", rolesOf(confirmedByWaiter).join() === "barista,buna,cashier,juice,kitchen");

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
  pass("station progress rings only the OWNING waiter", /ticketOwner\(/.test(stationRoute) && /sendPushToNamedStaff/.test(stationRoute));
  pass("bill requests ring only the OWNING waiter (+ all cashiers)", /ticketOwner\(/.test(tableStatus) && /sendPushToNamedStaff/.test(tableStatus));
  pass("item removal pushes the station (waiter stays silent)", /itemRemovedAlerts\(/.test(itemsRoute));
  pass("removing a not-yet-started item rings nobody", /wasPending/.test(itemsRoute));
  pass("quantity edits push waiter + station", /itemQuantityAlerts\(/.test(itemsRoute));
  pass("note edits on a STARTED line push its station", /itemNotesAlerts\(/.test(itemsRoute) && /notesChanged && wasStarted/.test(itemsRoute));
  pass("edits to a PRINTED bill push the cashier (EFD re-key)", /itemEditedAfterPrintAlerts\(/.test(itemsRoute) && /isPrintedBill\(ticket\)/.test(itemsRoute));
  pass("more work on a started line reopens it (accepted/done back to pending)", /qtyIncreased \|\| notesChanged/.test(itemsRoute) && /updates\.stationStatus = "pending"/.test(itemsRoute));
  pass("lowering a quantity never reopens the line", /Number\(updates\.quantity\) > before\[0\]\.quantity/.test(itemsRoute));
  pass("cancellation alarms are scoped to the bill's crews", /alertStatus === "cancelled"/.test(ticketsRoute));
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
  pass("waiter phone SPEAKS the table name when food is ready (not the generic bell)",
    /speakTableReady\(tables\)/.test(waiter) && /readyItems\.length > 0/.test(waiter));
  pass("food-ready no longer shares playAlarm with bill requests",
    !/readyItems\.length > 0 \|\| billAsks\.length > 0\) playAlarm/.test(waiter));
  pass("waiter screen alarms when the guest asks for the bill", /billAskedRef/.test(waiter));
  pass("waiter screen announces status moves made by others", /statusMoveLabel/.test(waiter) && /ORDER CANCELLED/.test(waiter));
  pass("waiter screen stays silent for printed/preparing moves", !/printed: `/.test(waiter) && !/preparing: `/.test(waiter));
  pass("waiter screen rings ready/bill only for her OWN tables", /ringsMe\(t\)/.test(waiter) && /ticketOwner/.test(waiter));
  pass("waiter never alarms herself for her own taps", /ownStatusRef/.test(waiter) && /noteOwnStatus\(/.test(waiter));
  pass("waiter can edit a sent item (note/qty/remove) before the crew starts it",
    /startEditItem/.test(waiter) && /saveEditedItem/.test(waiter) && /removeTicketItem/.test(waiter) && /itemEditable/.test(waiter));
  pass("station screen alarms when a line is removed or changed", /itemSigRef/.test(station) && /was REMOVED/.test(station));
  pass("station screen alarms when the whole order disappears", /stop preparing/.test(station));
  pass("cashier reacts to bill requests (no status change involved)", /receiptRequestedAt \? 1 : 0/.test(cashier));
  pass("cashier only sounds for events in her message list", /const loudEvents = newEvents\.filter\(\(t\) => eventMessage\(t\) !== null\)/.test(cashier));
  pass("payment and closing moments are not in that list", !/ready_for_payment: `/.test(cashier) && !/closed: `/.test(cashier) && !/paid: `/.test(cashier) && !/completed: `/.test(cashier));
}

/* ── 8. The release reaches only the crews with work in it ────────────────── */
{
  // Accepting used to wake EVERY crew, so the kitchen was woken for a
  // drinks-only table and the buna makers for every macchiato. The matrix now
  // takes the crews the route found on the ticket.
  const drinksOnly = ticketStatusAlerts("confirmed", { ...TICKET, stations: ["barista"] });
  const bunaOnly = ticketStatusAlerts("confirmed", { ...TICKET, stations: ["buna"] });
  const juiceOnly = ticketStatusAlerts("confirmed", { ...TICKET, stations: ["juice"] });
  const mixed = ticketStatusAlerts("confirmed", { ...TICKET, stations: ["kitchen", "buna"] });
  const unknownCrews = ticketStatusAlerts("confirmed", TICKET);

  pass("a drinks-only order does NOT ring the kitchen", !hasRole(drinksOnly, "kitchen"));
  pass("a drinks-only order does NOT ring the buna makers", !hasRole(drinksOnly, "buna"));
  pass("a drinks-only order does NOT ring the juice maker", !hasRole(drinksOnly, "juice"));
  pass("a drinks-only order still rings the barista, cashier and waiter",
    rolesOf(drinksOnly).join() === "barista,cashier,waiter");
  pass("a traditional-buna order rings ONLY the buna makers",
    rolesOf(bunaOnly).join() === "buna,cashier,waiter");
  pass("the buna makers' release says it is traditional buna",
    bunaOnly.some((a) => a.roles.includes("buna") && /traditional buna/.test(a.body)));
  pass("a juices-only order rings ONLY the juice maker (+ cashier and waiter)",
    rolesOf(juiceOnly).join() === "cashier,juice,waiter");
  pass("a mixed order rings exactly the two crews involved",
    rolesOf(mixed).join() === "buna,cashier,kitchen,waiter");
  pass("every crew alert is urgent and has its own tag",
    mixed.filter((a) => a.urgent).every((a) => a.repeat === 0) &&
    new Set(mixed.map((a) => a.tag)).size === mixed.length);
  pass("a caller that names no crews falls back to all of them (never nobody)",
    hasRole(unknownCrews, "kitchen") && hasRole(unknownCrews, "barista") && hasRole(unknownCrews, "buna") && hasRole(unknownCrews, "juice"));

  // A buna line taken off the bill, or corrected, belongs to the buna makers.
  const bunaRemoved = itemRemovedAlerts({ ...TICKET, itemName: "Jebena Buna", station: "buna" });
  const bunaQty = itemQuantityAlerts({ ...TICKET, itemName: "Jebena Buna", station: "buna", fromQuantity: 1, toQuantity: 3 });
  pass("a removed buna line rings the buna makers (not the barista)",
    rolesOf(bunaRemoved).join() === "buna" && !hasRole(bunaRemoved, "barista"));
  pass("a corrected buna quantity rings the buna makers and the waiter",
    rolesOf(bunaQty).join() === "buna,waiter");

  // A juice line taken off the bill, or corrected, belongs to the juice maker.
  const juiceRemoved = itemRemovedAlerts({ ...TICKET, itemName: "Mango Juice", station: "juice" });
  const juiceQty = itemQuantityAlerts({ ...TICKET, itemName: "Avocado Juice", station: "juice", fromQuantity: 1, toQuantity: 2 });
  pass("a removed juice line rings the juice maker (not the barista)",
    rolesOf(juiceRemoved).join() === "juice" && !hasRole(juiceRemoved, "barista"));
  pass("a corrected juice quantity rings the juice maker and the waiter",
    rolesOf(juiceQty).join() === "juice,waiter");

  // Cancelling a drinks-only bill must not wake the kitchen either — but an
  // unknown crew still falls back to ringing everybody, never nobody.
  const cancelDrinks = ticketStatusAlerts("cancelled", { ...TICKET, stations: ["barista"] });
  const cancelUnknown = ticketStatusAlerts("cancelled", TICKET);
  pass("cancelling a drinks-only bill rings ONLY the barista",
    rolesOf(cancelDrinks).join() === "barista");
  pass("a scoped cancellation still says what to do", cancelDrinks.every((a) => /stop preparing/i.test(a.body)));
  pass("a cancellation with unknown crews still rings all four",
    rolesOf(cancelUnknown).join() === "barista,buna,juice,kitchen");

  // The routes must actually hand the crews over, and keep the four apart.
  const stationsLib = read("src/lib/stations.ts");
  const tickets = read("src/app/api/tickets/route.ts");
  pass("the station vocabulary holds all four crews", /export type StationName = "kitchen" \| "barista" \| "buna" \| "juice"/.test(stationsLib));
  pass("a flagged item goes to the buna station whatever its category", /if \(isBunaItem\) return "buna"/.test(stationsLib));
  pass("the order route uses that rule (buna flag + per-item override + category routing)", /stationForOrder\(\s*routing,\s*catSlug,\s*bunaById\.get/.test(tickets) && /overrideById\.get/.test(tickets));
  pass("the instant-release push keeps every crew's lane apart (per-station titles)",
    /single === "buna" \? "🫖 New buna"/.test(tickets) &&
    /single === "juice" \? "🧃 New juices"/.test(tickets) &&
    /single === "barista" \? "☕ New drinks"/.test(tickets) &&
    /single === "kitchen" \? "👨‍🍳 New items to cook"/.test(tickets));
  pass("food ready still finds its owner by NAME, whatever role they hold",
    /\.where\(eq\(pushSubscriptions\.name, name\)\)/.test(read("src/lib/push.ts")));
}

/* ── 9. A cleared table is not an alarm for a crew that already finished ──── */
{
  const station = read("src/components/rms/StationApp.tsx");
  pass("the station screen remembers what work was still unfinished",
    /prevOpenWork/.test(station) && /stationStatus !== "done"/.test(station));
  pass("a bill closed with everything DONE only updates the screen",
    /if \(\(prevOpenWork\.get\(id\) \|\| 0\) > 0\) gone\.push\(name\);\s*\n\s*else closedQuiet\.push\(name\);/.test(station));
  pass("a bill closed mid-preparation still alarms the crew", /prevOpenWork\.get\(id\) \|\| 0\) > 0/.test(station));
  pass("the silent close never plays a sound or a notification",
    !/closedQuiet[\s\S]{0,200}playAlarm/.test(station) && !/closedQuiet[\s\S]{0,300}triggerDesktopNotification/.test(station));
}

/* ── 10. Off duty: a staff member who switched off hears nothing at home ─── */
{
  const push = read("src/lib/push.ts");
  const login = read("src/app/api/staff/login/route.ts");
  const chip = read("src/components/rms/PocketAlertsChip.tsx");
  const switchRoute = read("src/app/api/staff/notifications/route.ts");
  const testRoute = read("src/app/api/push/test/route.ts");
  const staffApi = read("src/app/api/staff/route.ts");
  const staffTab = read("src/components/rms/StaffTab.tsx");

  pass("a push never reaches a person who switched off for the day",
    /dropMutedSubs/.test(push) && /notificationsEnabled, false/.test(push) && /return !n \|\| !off\.has\(n\)/.test(push));
  pass("the mute fails OPEN (a database hiccup can never silence the cafe)",
    /muted\.length === 0\) return subs;/.test(push) && /catch \{\s*\n\s*\/\/ Never let this switch become a silence outage/.test(push));
  pass("an unnamed device is never muted (we cannot know whose it is)",
    /A device we cannot attribute to a person can never be muted/.test(push));
  pass("an off-duty owner's events still reach whoever is on shift (role fallback)",
    /owner\[0\]\.enabled === false/.test(push) && /enabled === false\) \{\s*\n\s*return sendPushToRoles\(\[role\], payload\);/.test(push));
  pass("signing back in switches the phone back on (a shift never starts silent)",
    /notificationsEnabled: true/.test(login));
  pass("the switch is the person's own (session-guarded, per staff id, strict boolean)",
    /requireStaff\(\)/.test(switchRoute) && /eq\(staffUsers\.id, staff\.staffId\)/.test(switchRoute) && /typeof body\?\.notificationsEnabled !== "boolean"/.test(switchRoute));
  pass("every staff app offers the off-duty switch",
    /Off duty: silence my phone/.test(chip) && /Back on duty: ring my phone/.test(chip) && /notificationsEnabled/.test(chip));
  pass("the chip tells an off-duty person the truth without crying wolf",
    /state === "offduty"\s*\n\s*\? "bg-amber-500\/15/.test(chip) && /animate-pulse/.test(chip) && !/offduty"[^"]*animate-pulse/.test(chip));
  pass("a test ring while off duty explains itself instead of looking broken",
    /Your alerts are switched OFF \(off duty\)/.test(testRoute));
  pass("the owner can see whose alerts are off (admin staff list)",
    /alertsOff/.test(staffApi) && /Off duty \(alerts silent\)/.test(staffTab));
}

if (failures.length > 0) {
  console.error("\n❌ ROLE-ALERT COVERAGE TEST FAILED\n");  for (const f of failures) console.error("  • " + f);
  process.exit(1);
}
console.log("\n✅ Role-alert coverage test PASSED");
console.log("   • every ticket status, every station action, every item change and every");
console.log("     bill request now wakes the roles that must react");
console.log("   • every event rings EXACTLY ONCE (repeat 0); the only repeat left is");
console.log("     the shared CUSTOMER_ALERT_RING burst, whose quick rings are one");
console.log("     ~3 second alarm, not repeats");
console.log("   • the person who performed the action is never rung by their own tap");
console.log("   • a staff member who tapped OFF DUTY hears nothing at home, and their");
console.log("     next PIN sign-in wakes their phone again");
