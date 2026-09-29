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
 *   1. WRITE SIDE (tickets PUT): the print is REFUSED while any released,
 *      visible kitchen / barista / juice line is not Done ("the stations must
 *      accept and done for the printed button to work", owner 29 Sept 2026),
 *      and when it does go out it finishes the BUNA lane only — the buna
 *      makers have no Accept/Done buttons, so the receipt is what clears
 *      their line. HELD guest additions are skipped on both sides (the crews
 *      never received them; when staff confirm them later that is new work).
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
 *   7. THE DONE TAP FREES THE BOARD (owner's request, Sept 2026): an item the
 *      crew marks Done leaves the dashboard at once (it used to linger
 *      crossed-out all day); the alarms still watch the full server list.
 *   8. THE ADMIN REPORT KEEPS THE TRUTH (owner's request, Sept 2026): every
 *      dish in the admin order history is badged — "Done by <crew name>",
 *      "cleared by cashier print • crew did not click Done", or "crew never
 *      clicked Done" — because the print clears the boards but must never
 *      hide WHO actually finished the food.
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

/* ── 1. WRITE SIDE: the stations finish the food, the print only buna ─────── */
{
  const printHalf = ticketsApi.split("export async function PUT")[1] || "";
  pass(
    "THE GATE: the print is refused (409) while a visible non-buna line is not Done",
    printHalf.includes('body.status === "printed"') &&
      printHalf.includes("must tap Done first") &&
      printHalf.includes("status: 409") &&
      printHalf.includes("COALESCE(${ticketItems.stationStatus}, '') <> 'done'") &&
      printHalf.includes("trim(coalesce(${ticketItems.stationName}, '')) <> 'buna'")
  );
  pass(
    "the refusal names the crew and the open lines, and reports them as data too",
    printHalf.includes("STATION_LABELS[station]") && printHalf.includes("openLines: openLines.length") &&
      printHalf.includes("stations: crews")
  );
  pass(
    "the print stamps the BUNA lane done, and ONLY the buna lane",
    printHalf.includes('eq(ticketItems.stationName, "buna")') &&
      printHalf.includes('stationDoneBy: "cashier print"') &&
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
  pass(
    "the print marker is NOT a person's name, so the admin report can tell a crew Done tap from a print-clear",
    printHalf.includes('stationStatusBy: "cashier print"') && printHalf.includes("cashier print")
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
  // The version only ever moves FORWARD (a later release may bump it again,
  // e.g. for another backfill), so the guard asks for the format and for a
  // stamp at least as new as the one that shipped this sweep.
  const schemaVersion = /const SCHEMA_VERSION = "([^"]+)"/.exec(migrate)?.[1] || "";
  pass(
    "schema version was bumped so existing databases run the sweep once",
    /^\d{4}-\d{2}-\d{2}-\d+$/.test(schemaVersion) && schemaVersion >= "2026-09-28-1"
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

/* ── 8. THE DONE TAP FREES THE BOARD (owner's request, Sept 2026) ─────────── */
{
  /* OWNER'S DECISION (29 Sept 2026), superseding "frees the board at once":
   * "make it stay for 3 min before it disappears after it clicked done" — the
   * kitchen, barista and juice crews asked to keep the line in front of them
   * for a moment. The board therefore keeps a line THIS SCREEN finished for
   * three minutes, struck through with its countdown; a print-cleared line
   * never reaches this board at all (it is filtered out server-side). */
  pass(
    "an item the crew marks Done stays on the station dashboard for 3 minutes, then leaves",
    stationApp.includes("const DONE_LINGER_MS = 3 * 60 * 1000;") &&
      stationApp.includes('(i.stationStatus !== "done" || doneLingerLeft(i) > 0)') &&
      stationApp.includes(".filter((t) => t.boardItems.length > 0)")
  );
  pass(
    "the three minutes come from the server's own Done stamp (a reload shows the same countdown)",
    stationApp.includes("item.stationStatusAt ? Date.parse(item.stationStatusAt) : NaN") &&
      stationApp.includes("at + DONE_LINGER_MS - now")
  );
  pass(
    "a print-cleared line can never be resurrected by the linger (it is not in the payload)",
    stationApp.includes("doneLingerLeft") && stationsApi.includes("isLineServedByPrint")
  );
  pass(
    "the alarms still watch the FULL server list, so a real removal can never hide behind the board filter",
    stationApp.includes("itemSigRef.current.get(i.id)") && stationApp.includes("nowTicketIds.has(seen.ticketId)")
  );
  pass(
    "a table whose last open line is finished leaves the board with a quiet ✓ toast",
    stationApp.includes("justFinishedAll") && stationApp.includes("✓ {tableName}: all your items are done")
  );
}

/* ── 9. THE ADMIN REPORT SHOWS WHAT THE CREW ACTUALLY CLICKED ────────────── */
{
  const historyTab = read("src/components/rms/OrderHistoryTab.tsx");
  const types = read("src/types/index.ts");
  const dictionary = read("src/lib/staff-dictionary.ts");
  pass(
    "the admin order history badges each dish: crew Done tap vs cashier print vs never clicked",
    historyTab.includes("doneBadgeOf") &&
      historyTab.includes('const DONE_BY_PRINT = "cashier print"') &&
      historyTab.includes("crew never clicked Done") &&
      historyTab.includes("crew did not click Done")
  );
  pass(
    "a crew Done tap keeps the crew member's name even after the bill is printed",
    historyTab.includes("✓ Done by {name}") && !historyTab.includes("overwrite")
  );
  pass(
    "the buna lane counts as print-cleared (its crews cannot tap Done)",
    historyTab.includes('r.stationName !== "buna"')
  );
  pass(
    "the per-line audit fields are typed for the admin screen",
    types.includes("stationDoneBy?: string | null") && types.includes("stationDoneAt?: string | null")
  );
  pass(
    "the new badges and the board toast are translated for the staff screens",
    dictionary.includes('"🖨 cleared by cashier print • crew did not click Done"') &&
      dictionary.includes('"⚠ crew never clicked Done"') &&
      dictionary.includes('"✓ {tableName}: all your items are done"')
  );
}

console.log(
  failures.length === 0
    ? "\n✅ PRINT-CLEARS-STATIONS REGRESSION TEST PASSED"
    : `\n❌ PRINT-CLEARS-STATIONS REGRESSION TEST FAILED (${failures.length})`
);
process.exit(failures.length === 0 ? 0 : 1);
