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
 *   7. GROUP 11 release gate: stations only see items the cashier released —
 *      a waiter's order reaches the crew when she taps ✓ PRINTED, additions
 *      wait for the re-print.
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
 * count HER action (the print): every bill with printedAt TODAY, any status,
 * newest print first. A cleared bill STAYS in the list; yesterday's never
 * pollute it. The cashier loads exactly this endpoint in print-queue mode. */
{
  pass("?printedToday=1 endpoint exists", /printedTodayOnly/.test(tickets));
  pass("printedToday filters by printedAt >= start of today (old bills never pollute)", /startOfToday\.setHours\(0, 0, 0, 0\)/.test(tickets) && /gte\(tickets\.printedAt, startOfToday\)/.test(tickets));
  pass("printedToday takes any status (printed AND later closed stay)", /isNotNull\(tickets\.printedAt\)/.test(tickets));
  pass("printedToday is ordered by the print stamp, newest first", /orderBy\(desc\(tickets\.printedAt\)\)/.test(tickets));
  pass("printedToday cards carry items (cards expand to the full bill)", /const needItems = !paidOnly && !finishedOnly/.test(tickets));
  pass("cashier loads Printed Today from the print endpoint in print-queue mode", /\/api\/tickets\?printedToday=1/.test(cashier));
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
 * not-yet-printed items (same cutoff as the release gate: item.createdAt >
 * printedAt), labeled as an addition to an existing bill; the full bill is one
 * tap away for context. After her ✓ PRINTED the same-status PUT refreshes
 * printedAt (idempotent), the card leaves the queue, the items merge into the
 * existing bill and the Group 11 gate releases them. Closed bills can never
 * receive additions (one-active-per-table + closed terminal). */
{
  pass("additions counted from order_submissions AFTER the last print", /unprintedSubmissions/.test(tickets) && /gt\(orderSubmissions\.createdAt, tickets\.printedAt\)/.test(tickets));
  pass("submissions-count failure degrades gracefully (old DBs keep working)", /unprintedByTicket\.get\(\(t as \{ id: number \}\)\.id\) \|\| 0/.test(tickets));
  pass("cashier derives the new items with the SAME cutoff the release gate uses (createdAt > printedAt)", /isNewUnprinted/.test(cashier) && /new Date\(item\.createdAt\)\.getTime\(\) > new Date\(item\.printedAt|new Date\(i\.createdAt\)\.getTime\(\) > new Date\(/.test(cashier));
  pass("additions queue card labels the new items count ('NEW item(s) on existing bill')", /NEW item/.test(cashier) && /on existing bill/.test(cashier));
  pass("additions card defaults to ONLY the new items, with a total of just those", /newItemsOf/.test(cashier) && /newTotal/.test(cashier) && /new items only/.test(cashier));
  pass("additions card can expand to the full bill for context (new items highlighted)", /toggleFullBill/.test(cashier) && /View full bill for context/.test(cashier));
  pass("the print action is still the one idempotent same-status printed PUT", /markPrinted/.test(cashier) && /status: "printed", printedBy: staffName/.test(cashier));
  pass("merge into the existing bill: a closed bill cannot receive additions (one-active-per-table)", /notInArray\(tickets\.status, \[\.\.\.INACTIVE_TICKET_STATUSES\]\)/.test(tickets));
  pass("printed bill with additions is still open (station/active lists) until cleared", /printed: \["closed", "cancelled"\]/.test(tickets));
}

/* ── 4. Cashier screen: one click per order ───────────────────────────────── */
{
  pass("mode comes from the owner setting (default: print-queue)", /cashier_mode/.test(cashier) && /printQueueMode/.test(cashier));
  pass("✓ PRINTED sends the printed transition with the cashier's name", /markPrinted/.test(cashier) && /status: "printed", printedBy: staffName/.test(cashier));
  pass("the queue = confirmed orders + printed bills with additions", /t\.status === "confirmed"/.test(cashier) && /isAdditionCard/.test(cashier) && /t\.status === "printed" && \(t\.unprintedSubmissions \|\| 0\) > 0/.test(cashier));
  pass("additions are flagged clearly (no 'key everything again' wording)", /NEW item.*on existing bill/.test(cashier) && !/ADDED — PRINT AGAIN/.test(cashier));
  pass("queue header keeps her one-click workflow instruction", /key into EFD → print → tap ✓/.test(cashier));
  pass("unverified QR orders are NOT printable (waiter strip + confirm fallback)", /Waiting for waiter confirmation/.test(cashier) && /✓ Confirm myself/.test(cashier));
  pass("problem path exists (remove item / cancel order)", /toggleProblem/.test(cashier) && /Cancel whole order/.test(cashier));
  pass("full-payment screens (Mark PAID) only render in full mode", /printQueueMode \?/.test(cashier) && /\{!printQueueMode && \(/.test(cashier) && /Mark PAID & Release Table/.test(cashier));
  pass("history uses the printed-today endpoint in print-queue mode", cashier.includes('modeRef.current ? "/api/tickets?printedToday=1" : "/api/tickets?paid=1&limit=12"'));
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

/* ── 7. THE RELEASE RULE (replaces the old print gate) ───────────────────── */
/* Owner's decision, Sept 2026: ACCEPTANCE releases the food, not the print.
 * One tap by the waiter (or the cashier on a QR order) reaches the kitchen,
 * the barista and the cashier in the same second. The cashier still keys the
 * bill into the EFD and prints it, but nobody is waiting for that tap, and
 * neither the waiter nor the cashier has an extra button to press. */
{
  pass("the crew sees an order as soon as it is ACCEPTED (confirmed)", /notInArray\(tickets\.status, \["paid", "cancelled", "closed", "pending_waiter"\]\)/.test(stationsApi));
  pass("orders nobody accepted yet stay off the crew's list", /"pending_waiter"/.test(stationsApi));
  pass("every live item on an accepted bill is released (no print cutoff)", /const releasedItems = \(_status: string, _printedAt: Date \| string \| null, items: any\[\]\) => items/.test(stationsApi));
  pass("a ticket with zero released items disappears from the station list", /\.filter\(\(t\) => t\.items\.length > 0\)/.test(stationsApi));
  pass("accepting rings kitchen + barista + cashier together", /case "confirmed"/.test(alerts) && /roles: STATION_ROLES/.test(alerts) && /New order to cook/.test(alerts));
  pass("the waiter's button says where the order goes", /Accept & Send → Kitchen, Barista & Cashier/.test(waiter));
  pass("the cashier's one click is just the print record now", /✓ PRINTED/.test(cashier) && !/✓ PRINTED & SEND/.test(cashier));
  pass("items added to an accepted bill reach the crew immediately", /New items to cook/.test(tickets) && /fana-station-add-/.test(tickets));
  pass("a print (or re-print) never re-rings a crew already cooking", !/body\.status === "printed" \|\| \(body\.status === "preparing"/.test(tickets));
  pass("the cashier still records the EFD print (audit + daily count)", /body\.status === "printed"/.test(tickets) && /updates\.printedAt = new Date\(\)/.test(tickets));
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
console.log("   • ACCEPTANCE releases the food: one waiter tap reaches kitchen, barista");
console.log("     and cashier at once; the print stays an EFD record, not a gate");
