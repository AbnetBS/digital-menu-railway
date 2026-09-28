#!/usr/bin/env node
/**
 * Regression test — "THE PRINT SERVES THE FOOD" (owner's decision, Sept 2026).
 *
 * The owner walked into the cafe and found YESTERDAY's printed orders still
 * sitting on the juice / barista / kitchen dashboards: the cashier had tapped
 * ✓ PRINTED (which at Fana means the food is done and served) but only the
 * BUNA lane was cleared by that tap. Kitchen, barista and juice lines stayed
 * on their boards until a crew member remembered to tap Done on every single
 * line — and when nobody did, the items sat there for days.
 *
 * This test pins the fix, on every side of it:
 *   1. WRITE SIDE (tickets PUT): the print stamps every RELEASED, unfinished
 *      line on the bill done — in the cashier's name, for the audit trail.
 *      HELD guest additions are skipped (the crews never received them; when
 *      the staff confirm them later that is real new work).
 *   2. SELF-CLOSE: a dine-in bill whose table the print freed closes itself
 *      right there when every line is finished (same rule the crews' last
 *      Done tap already followed) — so a printed bill can never linger "open"
 *      on anyone's board. Outdoor/group bills stay open for their rounds.
 *   3. READ SIDE (station-items GET): a line finished on or before the last
 *      print is invisible on every station's live list; pending work and
 *      lines finished after the print (receipt #2 still pending) stay.
 *   4. NO FALSE ALARM (StationApp): a card that leaves the list because the
 *      cashier printed is GOOD news — the station screen reads the
 *      ?printCleared=1 feed and answers with a quiet ✓ toast, never the
 *      "stop preparing" alarm (and never a "was REMOVED" alarm either).
 *   5. CASHIER (outdoorReady): a line that was on the printed receipt counts
 *      as ready for "Mark delivered", so an outdoor order is deliverable the
 *      moment it is printed even if no crew member ever tapped Done.
 *   6. ONE-TIME BACKFILL (migrate.ts): bills printed BEFORE this rule existed
 *      get their printed lines stamped done at deploy time, so yesterday's
 *      stuck orders leave the dashboards without anyone tapping anything.
 *
 * Run with: node scripts/verify-print-clears-stations.mjs  (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const ticketsApi = read("src/app/api/tickets/route.ts");
const stationsApi = read("src/app/api/station-items/route.ts");
const stationApp = read("src/components/rms/StationApp.tsx");
const cashier = read("src/components/rms/CashierDashboard.tsx");
const orderRelease = read("src/lib/order-release.ts");
const migrate = read("src/db/migrate.ts");
const schema = read("src/db/schema.ts");

const failures = [];
function pass(name, cond) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures.push(name);
}

/* ── 1. WRITE SIDE: the print finishes the released lines ─────────────────── */
{
  const printHalf = ticketsApi.split("export async function PUT")[1] || "";
  pass(
    "the print stamps every released, unfinished line done (all four stations)",
    printHalf.includes('body.status === "printed"') &&
      !printHalf.includes('eq(ticketItems.stationName, "buna")') &&
      printHalf.includes("stationDoneBy: finishedBy") &&
      printHalf.includes("stationDoneAt: finishedAt")
  );
  pass(
    "held guest additions are NOT finished by the print (crews never saw them)",
    printHalf.includes("COALESCE(${ticketItems.released}, true) = true")
  );
  pass(
    "the crew's own Done stamps are preserved (already-done lines are skipped)",
    printHalf.includes("COALESCE(${ticketItems.stationStatus}, '') <> 'done'")
  );
}

/* ── 2. SELF-CLOSE at print time (dine-in whose table the print freed) ────── */
{
  const printHalf = ticketsApi.split("export async function PUT")[1] || "";
  pass(
    "a printed dine-in bill closes itself the moment every line is finished",
    printHalf.includes("isTableReleased(rows[0])") &&
      printHalf.includes("allLinesFinished(after)") &&
      printHalf.includes('status: "closed"')
  );
  pass(
    "the self-close is scoped to the bill the print just stamped (printed status only)",
    /eq\(tickets\.id, rows\[0\]\.id\), eq\(tickets\.status, "printed"\)/.test(printHalf)
  );
  pass(
    "outdoor/group bills are exempt from the print self-close (rounds continue)",
    orderRelease.includes('String(ticket.orderType || "dine_in") === "outdoor"') &&
      orderRelease.includes("return false;")
  );
}

/* ── 3. READ SIDE: served lines leave every station's live list ───────────── */
{
  pass(
    "the pure rule lives in order-release (one truth for API + screens + tests)",
    orderRelease.includes("export function isLineServedByPrint") &&
      orderRelease.includes("doneMs <= printedMs")
  );
  pass(
    "every station's live list hides lines served by the print",
    stationsApi.includes("isLineServedByPrint(it, printedTicket)")
  );
  pass(
    "pending/accepted lines and lines finished after the print stay visible (isLineServedByPrint returns false for them)",
    orderRelease.includes('String(line.stationStatus || "") !== "done"') &&
      orderRelease.includes("return false;")
  );
  pass(
    "the buna lane stays read-only: its DONE lines never show at all",
    stationsApi.includes('station === "buna" && it.stationStatus === "done"')
  );
  pass(
    "history (?history=1) is untouched — the crew's paper stack keeps every line",
    stationsApi.includes("const items = releasedItems") || stationsApi.includes("releasedItems(t.confirmedAt, t.printedAt, items)")
  );
}

/* ── 4. NO FALSE ALARM on the station screen ──────────────────────────────── */
{
  pass(
    "the station screen reads the print-cleared feed every load",
    stationApp.includes("printCleared=1") && stationApp.includes("printClearedIds")
  );
  pass(
    "a line that left because of a print is NOT reported as REMOVED",
    stationApp.includes("nowTicketIds.has(seen.ticketId) && !printClearedIds.has(seen.ticketId)")
  );
  pass(
    "a ticket that left because of a print gets the quiet ✓ toast, never the stop-work alarm",
    stationApp.includes("printClearedQuiet") &&
      stationApp.includes("printClearedIds.has(id)") &&
      stationApp.includes("printed & served • cleared from your list")
  );
  pass(
    "the quiet toast is translated for the staff screens",
    read("src/lib/staff-dictionary.ts").includes('"✓ {tableName}: printed & served • cleared from your list"')
  );
}

/* ── 5. CASHIER: an outdoor order is deliverable the moment it is printed ─── */
{
  const readyFn = cashier.split("const outdoorReady = (t: Ticket) =>")[1] || "";
  pass(
    "outdoorReady counts a printed-receipt line as ready for every station (not just buna)",
    readyFn.length > 0 &&
      !cashier.includes('item.stationName === "buna"') &&
      /createdMs <= printedMs/.test(readyFn.split("\n  };")[0])
  );
  pass(
    "a HELD guest addition does not make an outdoor order ready (the crews never got it)",
    /if \(item\.released === false\) return false;/.test(cashier)
  );
}

/* ── 6. ONE-TIME BACKFILL: yesterday's stuck orders leave at deploy ───────── */
{
  const sweep = migrate.split("PRINT SERVES THE FOOD backfill")[1] || "";
  pass(
    "the migration finishes released, non-removed, un-done lines of printed bills",
    sweep.includes("COALESCE(ti.released, true) = true") &&
      sweep.includes("COALESCE(ti.removed, false) = false") &&
      sweep.includes("COALESCE(ti.station_status, 'pending') <> 'done'")
  );
  pass(
    "the sweep only touches lines that were on the printed receipt (unprinted additions stay live work)",
    sweep.includes("ti.created_at <= t.printed_at")
  );
  pass(
    "the sweep stamps the print itself as the finisher (honest audit, no fake crew name)",
    sweep.includes("'cashier print'") && sweep.includes("COALESCE(t.printed_at, now())")
  );
  pass(
    "schema version was bumped so existing databases run the sweep once",
    migrate.includes('const SCHEMA_VERSION = "2026-09-28-1"')
  );
  pass(
    "the schema documents the decision next to printed_at",
    schema.includes("THE PRINT SERVES THE FOOD")
  );
}

/* ── 7. REALTIME: every screen learns about the print the same second ────── */
{
  const putHalf = ticketsApi.split("export async function PUT")[1] || "";
  pass(
    "the print still publishes the orders channel (stations refresh instantly)",
    putHalf.includes("publish(CHANNELS.orders)")
  );
}

console.log(
  failures.length === 0
    ? "\n✅ PRINT-CLEARS-STATIONS REGRESSION TEST PASSED"
    : `\n❌ PRINT-CLEARS-STATIONS REGRESSION TEST FAILED (${failures.length})`
);
process.exit(failures.length === 0 ? 0 : 1);
