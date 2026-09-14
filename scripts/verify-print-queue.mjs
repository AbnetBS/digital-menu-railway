#!/usr/bin/env node
/**
 * Regression test — "Print-queue workflow" (Group 9, Fana's real cafe flow).
 *
 * The cashier's only system job is ONE click per order: she keys the bill into
 * the government EFD/POS on her desktop, the order paper prints, and she taps
 * ✓ PRINTED here. Payments deliberately live in the EFD world — the app tracks
 * the ORDER flow, not the money. Waiters close bills with "Table cleared".
 *
 * Static source inspection verifies that:
 *   1. Ticket state machine: confirmed → printed (cashier) → closed (waiter),
 *      with the classic paid/cancelled terminals still intact.
 *   2. "closed" is treated as FINISHED everywhere an open bill is looked up
 *      (active lists, one-active-per-table merge, station lists, guest status,
 *      and the partial unique index that enforces one bill per table).
 *   3. Additions after a print re-queue the card (unprintedSubmissions).
 *   4. The cashier screen in print-queue mode is one button per order and the
 *      payment screens (Mark PAID etc.) only exist in full-payment mode.
 *   5. The waiter screen frees tables with "Table cleared" and warns when the
 *      crew is still preparing items.
 *   6. The owner can switch modes (cashier_mode setting, default print-queue).
 *   7. INSTANT RELEASE (owner's decision, Sept 2026): the SEND releases the
 *      food, never the print. A waiter's order AND anything added later land
 *      on the crew's lists the same second; the print is EFD audit only.
 *
 * Run with: node scripts/verify-print-queue.mjs  (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const tickets = read("src/app/api/tickets/route.ts");
const schema = read("src/db/schema.ts");
const migrate = read("src/db/migrate.ts");
const tablesApi = read("src/app/api/tables/route.ts");
const stationsApi = read("src/app/api/station-items/route.ts");
const tableStatusApi = read("src/app/api/table-status/route.ts");
const cashier = read("src/components/rms/CashierDashboard.tsx");
const waiter = read("src/components/rms/WaiterApp.tsx");
const station = read("src/components/rms/StationApp.tsx");
const alerts = read("src/lib/alerts.ts");
const admin = read("src/components/AdminPanel.tsx");
const initialData = read("src/lib/initial-data.ts");
const orderLines = read("src/lib/order-lines.ts");

const failures = [];
function pass(name, cond) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures.push(name);
}

/* ── 1. Ticket state machine ──────────────────────────────────────────────── */
{
  pass("cashier print transition exists (confirmed → printed)", /confirmed: \["preparing", "ready_for_payment", "printed", "cancelled"\]/.test(tickets));
  pass("waiter clear transition exists (printed → closed)", /printed: \["closed", "cancelled"\]/.test(tickets));
  pass("classic mid-flow states can also close (mode switch never traps a bill)", /preparing: \["ready_for_payment", "closed", "cancelled"\]/.test(tickets) && /ready_for_payment: \["completed", "closed", "cancelled"\]/.test(tickets));
  pass("closed stamps printed audit columns (printedAt/printedBy)", /body\.status === "printed"/.test(tickets) && /updates\.printedAt = new Date\(\)/.test(tickets) && /updates\.printedBy = /.test(tickets));
  pass("closed stamps who cleared the table (closedBy) + closedAt", /body\.status === "closed"/.test(tickets) && /updates\.closedBy = /.test(tickets) && /body\.status === "closed"\) updates\.closedAt = new Date\(\)/.test(tickets));
  pass("closed is in the shared INACTIVE set and used by the active list + merge lookups", /INACTIVE_TICKET_STATUSES = \["paid", "cancelled", "closed"\]/.test(tickets) && (tickets.match(/notInArray\(tickets\.status, \[\.\.\.INACTIVE_TICKET_STATUSES\]\)\)/g) || []).length >= 3);
  pass("finished history includes closed bills (?finished=1)", /finishedOnly/.test(tickets) && /inArray\(tickets\.status, \["paid", "closed"\]\)/.test(tickets));
}

/* ── 1b. "Printed Today" fills at PRINT time (not table-clear) ────────────── */
/* The panel is her daily cross-check against the EFD receipt count, so it must
 * count HER action (the print): every bill with printedAt TODAY on the
 * ETHIOPIAN wall clock, newest print first. A cleared bill STAYS in the
 * list; yesterday's never pollute it; CANCELLED bills are excluded (a voided
 * order is not a sale). The cashier loads exactly this endpoint in
 * print-queue mode. */
{
  pass("?printedToday=1 endpoint exists", /printedTodayOnly/.test(tickets));
  pass("printedToday window is the ETHIOPIAN day (old bills never pollute)", /etStartOfToday\(\)/.test(tickets) && /etStartOfCalendarDay\(/.test(tickets) && /gte\(tickets\.printedAt, startOfToday\)/.test(tickets));
  pass("printedToday excludes cancelled bills (a void is not a sale)", /notInArray\(tickets\.status, \["cancelled"\]\)/.test(tickets));
  pass("printedToday keeps printed AND later closed bills", /isNotNull\(tickets\.printedAt\)/.test(tickets));
  pass("printedToday is ordered by the print stamp, newest first", /orderBy\(desc\(tickets\.printedAt\)\)/.test(tickets));
  pass("printedToday cards carry items (cards expand to the full bill)", /const needItems = !paidOnly && !finishedOnly/.test(tickets));
  pass("cashier loads Printed Today from the print endpoint in print-queue mode", /\/api\/tickets\?printedToday=1/.test(cashier));
  pass("cashier also loads Printed Yesterday (?printedDate=) beside Printed Today", /\/api\/tickets\?printedDate=/.test(cashier) && /PRINTED YESTERDAY/.test(cashier) && /PRINTED TODAY/.test(cashier));
  pass("Printed Today card is clickable (opens the bill detail modal)", /setBillModal\(t\)/.test(cashier) && /billModal/.test(cashier));
  pass("cleared bill stays in Printed Today with a cleared state", /CLEARED|cleared/.test(cashier) && /t\.status === "closed"/.test(cashier));
  pass("Printed Today shows the print time and who printed", /printedAt/.test(cashier) && /printedBy/.test(cashier));
  pass("bill with waiting additions is badged and sorted to the top", /sortedPrintedToday/.test(cashier) && /new item waiting/i.test(cashier));
}

/* ── 2. "closed" is finished EVERYWHERE ───────────────────────────────────── */
{
  pass("schema: printed_at / printed_by / closed_by columns declared", /printedAt: timestamp\("printed_at"\)/.test(schema) && /printedBy: varchar\("printed_by"/.test(schema) && /closedBy: varchar\("closed_by"/.test(schema));
  pass("migration: columns self-heal on old databases", /printed_at: \{ type: "timestamp", dropNotNull: true \}/.test(migrate) && /printed_by: \{ type: "text" \}/.test(migrate) && /closed_by: \{ type: "text" \}/.test(migrate));
  pass("migration: one-active-per-table index excludes closed (and is recreated when old)", migrate.includes("NOT IN ('paid','cancelled','closed')") && /pg_indexes/.test(migrate) && /DROP INDEX IF EXISTS tickets_one_active_per_table_idx/.test(migrate));
  pass("migration: duplicate-active repair also treats closed as finished", (migrate.match(/WHERE status NOT IN \('paid','cancelled','closed'\)/g) || []).length >= 2);
  pass("tables board: closed bills free the table, printed shows as in-progress", /notInArray\(tickets\.status, \["paid", "cancelled", "closed"\]\)/.test(tablesApi) && /tk\.status === "preparing" \|\| tk\.status === "printed"/.test(tablesApi));
  pass("station lists drop closed bills (crew stops seeing cleared tables)", /notInArray\(tickets\.status, \["paid", "cancelled", "closed"/.test(stationsApi));
  pass("guest status: closed bills are not 'open' and get the thank-you window", /notInArray\(tickets\.status, \["paid", "cancelled", "closed"\]\)/.test(tableStatusApi) && /inArray\(tickets\.status, \["paid", "closed"\]\)/.test(tableStatusApi));
  pass("guest phase: a closed bill reads as finished (thank-you, not 'preparing')", /status === "paid" \|\| status === "closed"/.test(orderLines));
}

/* ── 3. Additions: ONLY the new items go to her To Print list ─────────────── */
/* When items land on an already-printed (still open) bill, the cashier must
 * NOT re-key the whole bill into the EFD. Her queue card shows ONLY the
 * not-yet-printed items (her EFD-only cutoff: item.createdAt > printedAt),
 * labeled as an addition to an existing bill; the full bill is one tap away
 * for context. The crews ALREADY have these lines (instant release) — after
 * her ✓ PRINTED the same-status PUT just refreshes printedAt (idempotent)
 * and the card leaves the queue. Closed bills can never receive additions
 * (one-active-per-table + closed terminal). */
{
  pass("additions counted from order_submissions AFTER the last print", /unprintedSubmissions/.test(tickets) && /gt\(orderSubmissions\.createdAt, tickets\.printedAt\)/.test(tickets));
  pass("ticket payload splits unprinted additions by source (guest vs waiter)", /unprintedCustomerSubmissions/.test(tickets) && /unprintedStaffSubmissions/.test(tickets) && /groupBy\(orderSubmissions\.ticketId, orderSubmissions\.source\)/.test(tickets));
  pass("submissions-count failure degrades gracefully (old DBs keep working)", /unprintedByTicket\.get\(\(t as \{ id: number \}\)\.id\) \|\| 0/.test(tickets));
  pass("cashier derives new printed-bill work from row time AND same-line quantity growth", /isNewUnprinted/.test(cashier) && /additionLinesRef/.test(cashier) && /NEW on existing line/.test(cashier));
  pass("additions queue card labels the new items count ('NEW item(s) on existing bill')", /NEW item/.test(cashier) && /on existing bill/.test(cashier));
  pass("additions card defaults to ONLY the new items, with a total of just those", /newItemsOf/.test(cashier) && /newTotal/.test(cashier) && /new items only/.test(cashier));
  pass("station cards mark a grown pending line as NEW on the existing item", /newPendingBadges/.test(station) && /NEW \+/.test(station));
  pass("additions card can expand to the full bill for context (new items highlighted)", /toggleFullBill/.test(cashier) && /View full bill for context/.test(cashier));
  pass("the print action is still the one idempotent same-status printed PUT", /markPrinted/.test(cashier) && /status: "printed", printedBy: staffName/.test(cashier));
  pass("merge into the existing bill: a closed bill cannot receive additions (one-active-per-table)", /notInArray\(tickets\.status, \[\.\.\.INACTIVE_TICKET_STATUSES\]\)/.test(tickets));
  pass("printed bill with additions is still open (station/active lists) until cleared", /printed: \["closed", "cancelled"\]/.test(tickets));
}

/* ── 4. Cashier screen: one click per order ───────────────────────────────── */
{
  pass("mode comes from the owner setting (default: print-queue)", /cashier_mode/.test(cashier) && /printQueueMode/.test(cashier));
  pass("✓ PRINTED sends the printed transition with the cashier's name", /markPrinted/.test(cashier) && /status: "printed", printedBy: staffName/.test(cashier));
  pass("the queue = confirmed orders + printed bills with additions", /t\.status === "confirmed"/.test(cashier) && /isAdditionCard/.test(cashier) && /t\.status === "printed" && totalAddsOf\(t\) > 0/.test(cashier));
  pass("additions are flagged clearly (no 'key everything again' wording)", /NEW item.*on existing bill/.test(cashier) && !/ADDED — PRINT AGAIN/.test(cashier));
  pass("staff top-ups are named as waiter work on an EXISTING bill, not a guest emergency", /WAITER ADDED ITEMS/.test(cashier) && /additionSourceLabel/.test(cashier));
  pass("queue header keeps her one-click workflow instruction", /key into EFD → print → tap ✓/.test(cashier));
  pass("unverified QR orders are NOT printable (waiter strip + accept-hold fallback)", /Waiting for waiter confirmation/.test(cashier) && /✓ Accept \(holds it\)/.test(cashier));
  pass("problem path exists (remove item / cancel order)", /toggleProblem/.test(cashier) && /Cancel whole order/.test(cashier));
  pass("full-payment screens (Mark PAID) only render in full mode", /printQueueMode \?/.test(cashier) && /\{!printQueueMode && \(/.test(cashier) && /Mark PAID & Release Table/.test(cashier));
  pass("history uses the print endpoints in print-queue mode (today + yesterday), paid endpoint in full mode", /\/api\/tickets\?printedToday=1/.test(cashier) && /\/api\/tickets\?printedDate=/.test(cashier) && /\/api\/tickets\?paid=1&limit=12/.test(cashier));
}

/* ── 5. Waiter screen: Table cleared is the closing action ────────────────── */
{
  pass("clearTable sends the closed transition with the waiter's name", /clearTable/.test(waiter) && /status: "closed", closedBy: staffName/.test(waiter));
  pass("clearing warns when the crew is still preparing items", /still preparing \$\{cooking\.length\}/.test(waiter) && /stationStatus && i\.stationStatus !== "done"/.test(waiter));
  pass("payment screens are hidden in print-queue mode", /printQueueMode \?/.test(waiter) && /Table Cleared • Free Table/.test(waiter));
  pass("bill header speaks the cafe's language, not the database's", /Sent • cashier will print it in the EFD/.test(waiter) && /Printed • crew is preparing/.test(waiter));
}

/* ── 6. Owner switch ──────────────────────────────────────────────────────── */
{
  pass("default settings ship cashier_mode = print-queue", /cashier_mode: "print-queue"/.test(initialData));
  pass("admin Settings tab can switch the workflow", /Cashier Print-Queue Mode/.test(admin) && /cashier_mode: settingsForm\.cashier_mode === "print-queue" \? "full" : "print-queue"/.test(admin));
}

/* ── 7. INSTANT RELEASE (the SEND releases the food, never the print) ────── */
/* Owner's decision, Sept 2026: one tap by the waiter (or the cashier's
 * CONFIRM & SEND on a held QR order) reaches every crew with lines on the
 * bill AND the cashier in the same second — and food ADDED later to a sent
 * bill lands on the crew's lists the same second too, exactly like the
 * cashier and waiter see it. The cashier still keys every bill into the EFD
 * and prints it, but nobody is waiting for that tap: the print is audit only.
 * A cashier's plain ACCEPT of a QR order only HOLDS the bill (see section 8). */
{
  const postHalf = tickets.split("export async function PUT")[0] || "";
  const putHalf = tickets.split("export async function PUT")[1] || "";
  pass("the crew sees an order as soon as it is ACCEPTED (confirmed)", /notInArray\(tickets\.status, \["paid", "cancelled", "closed", "pending_waiter"\]\)/.test(stationsApi));
  pass("orders nobody accepted yet stay off the crew's list", /"pending_waiter"/.test(stationsApi));
  pass("RELEASE RULE: held = neither stamp (isHeld); a sent bill releases ALL lines",
    /!confirmedAt && !printedAt/.test(stationsApi) &&
    /if \(isHeld\(confirmedAt, printedAt\)\) return \[\];/.test(stationsApi) &&
    /return items;/.test(stationsApi));
  pass("no per-line cutoff survives anywhere (additions never wait for a print)",
    !/releaseCutoff/.test(stationsApi) && !/prevStamp/.test(stationsApi) && !/prevStamp/.test(tickets));
  pass("the gate is bill-level (never looks at line time), so legacy lines stay visible",
    !/createdAt/.test((stationsApi.split("const releasedItems = (")[1] || "").split("};")[0] || ""));
  pass("the acceptance stamp is written and self-heals on old databases", /updates\.confirmedAt = new Date\(\)/.test(tickets) && /confirmedAt: timestamp\("confirmed_at"\)/.test(schema) && /confirmed_at: \{ type: "timestamp", dropNotNull: true \}/.test(migrate));
  pass("a ticket with zero released items disappears from the station list", /\.filter\(\(t\) => t\.items\.length > 0\)/.test(stationsApi));
  pass("accepting rings ONLY the crews with items on the bill, plus the cashier", /case "confirmed"/.test(alerts) && /t\.stations/.test(alerts) && /fana-cook-\$\{t\.id\}-\$\{station\}/.test(alerts) && /New order to cook/.test(alerts));
  pass("the route tells the matrix which crews the bill actually involves", /stations: billStations/.test(tickets) && /crewRows\.map\(\(r\) => stationOf\(r\.stationName\)\)/.test(tickets));
  pass("the waiter's button says where the order goes", /Accept & Send → Stations & Cashier/.test(waiter));
  pass("the cashier's button says plain ✓ PRINTED (the print sends nothing — instant release)",
    /<Printer className="w-5 h-5" \/> ✓ PRINTED/.test(cashier) && !/PRINTED & SEND/.test(cashier));
  pass("her addition card still shows ONLY the new items", /isNewUnprinted/.test(cashier) && /new items only/.test(cashier));
  pass("the print NEVER pushes the crews (EFD audit only — they already have the lines)",
    !/sendPushToRoles\(stations/.test(putHalf) && !/fana-station-/.test(putHalf));
  pass("only the stations with NEW lines in the submission are rung (no idle re-ring)",
    /submissionStations/.test(postHalf) && /newStations\.length > 0/.test(postHalf));
  pass("the crew push fires only for a SENT bill (pending and held bills stay silent)",
    /billSent/.test(postHalf) && /pushed\.status !== "pending_waiter"/.test(postHalf));
  pass("each submission rings as its own event (distinct station tag)", /fana-station-add-\$\{pushed\.id\}/.test(postHalf));
  pass("adding food to a sent bill wakes the crews with new lines (instant release)", /fana-station-add-/.test(postHalf));
  pass("every crew only ever sees its OWN items", /eq\(ticketItems\.stationName, station\)/.test(stationsApi));
  pass("the cashier still records the EFD print (audit + daily count)", /body\.status === "printed"/.test(tickets) && /updates\.printedAt = new Date\(\)/.test(tickets));
}

/* ── 8. QR HOLD FLOW (owner's decision, Sept 2026) ───────────────────────── */
/* A guest keeps adding items from their phone after the cashier accepts the
 * QR order, so her accept must not send food to the crews yet:
 *   accept        = acknowledge (alarms stop on EVERY device, bill held)
 *   CONFIRM & SEND = release the whole bill to the crews; only then does the
 *                    normal ✓ PRINTED step appear on the card
 * A waiter's accept still sends immediately (she verified with the guest in
 * person), and full-payment mode is untouched. */
{
  pass("held = a confirmed bill without a release stamp (confirmedAt)", /heldCards = tickets\.filter\(\(t\) => t\.status === "confirmed" && !t\.confirmedAt/.test(cashier));
  pass("held bills are NOT in the print queue (nothing to key into the EFD yet)", /const toPrint = tickets\.filter\(\(t\) => t\.status === "confirmed" && \(\!\!t\.confirmedAt \|\| \!\!t\.printedAt\)\)/.test(cashier));
  pass("held cards have their own section with the CONFIRM & SEND button", /✓ CONFIRM & SEND/.test(cashier) && /confirmAndSend/.test(cashier));
  pass("CONFIRM & SEND hits the send action with her name", /body: JSON\.stringify\(\{ id: t\.id, send: true, confirmedBy: staffName \|\| "\(cashier\)" \}\)/.test(cashier));
  pass("the route stamps the release on send but NOT on a cashier's plain accept", /const sendRequested = body\.send === true;/.test(tickets) && /holdAfterConfirm/.test(tickets) && /if \(!holdAfterConfirm\) updates\.confirmedAt = new Date\(\);/.test(tickets));
  pass("the send fires the release alerts; a held accept fires nobody", /const releasedBySend = sendRequested && !cur\.confirmedAt && !cur\.printedAt;/.test(tickets) && /alertStatus && !\(alertStatus === "confirmed" && holdAfterConfirm\)/.test(tickets));
  pass("a held bill releases NOTHING to the crews (neither stamp → empty)", /if \(isHeld\(confirmedAt, printedAt\)\) return \[\];/.test(stationsApi));
  pass("staff submissions are SENT at creation (release stamp lands after the items)", /if \(!isCustomer && activeTickets\.length === 0\)/.test(tickets) && /\.set\(\{ confirmedAt: new Date\(\) \}\)/.test(tickets));
  pass("guest additions to a HELD bill tell the cashier, not the crews", /held bill is now/.test(tickets));
  pass("migration backfills pre-hold released bills so in-flight work stays visible", /QR HOLD FLOW backfill/.test(migrate) && /COALESCE\(created_by, ''\) <> 'Customer \(QR\)'/m.test(migrate));
  pass("another device answering dismisses the full-page alarm everywhere", /ANOTHER DEVICE ANSWERED/.test(cashier) && /cur\.ticketId == null/.test(cashier));
  pass("the waiter's bill view tells held from sent", /held until the cashier sends it/.test(waiter));
}

if (failures.length > 0) {
  console.error("\n❌ PRINT-QUEUE REGRESSION TEST FAILED\n");
  for (const f of failures) console.error("  • " + f);
  process.exit(1);
}
console.log("\n✅ Print-queue regression test PASSED");
console.log("   • cashier: key into EFD → print → tap ✓ PRINTED (one click per order)");
console.log("   • waiter: guests leave → clear table → table turns green");
console.log("   • payments stay in the EFD/POS — full mode still available via Settings");
console.log("   • INSTANT RELEASE: one waiter tap (or the cashier's CONFIRM & SEND on");
console.log("     a held QR order) reaches the crews that have items on it (kitchen /");
console.log("     barista / buna / juice) and the cashier at once — and food ADDED");
console.log("     later lands on the crew's lists the same second too");
console.log("   • the print is EFD audit only: it keys receipt #2 for new items but");
console.log("     never gates or re-rings the crews");
