#!/usr/bin/env tsx
/**
 * Regression test — "CASHIER PRINT WITHOUT DONE" (owner's request, Oct 2026).
 *
 * The baristas, kitchen and juice crews kept forgetting to tap Done, so the
 * cashier could not tap ✓ PRINTED. The admin now has one switch per crew, under
 * Station Sales Visibility:
 *
 *   OFF (default) → the crew must tap Done on every line before ✓ PRINTED
 *                   (the rule that already existed, unchanged);
 *   ON            → the cashier may tap ✓ PRINTED even if that crew never
 *                   tapped Done. Nothing else changes.
 *
 * This test pins, on every side:
 *   1. THE RULE (pure): defaults are OFF, malformed values never open the gate,
 *      only the crews switched ON are skipped, buna is never part of it.
 *   2. THE SERVER: the tickets PUT reads the switch, gates only the crews that
 *      are OFF, and keeps the other checks (buna, held lines, done lines).
 *   3. THE ADMIN SCREEN: the section sits right below Station Sales Visibility,
 *      shows one switch per crew, saves through /api/settings, and defaults OFF.
 *
 * Run with: npx tsx scripts/verify-station-print-without-done.ts  (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PRINT_WITHOUT_DONE,
  PRINT_WITHOUT_DONE_KEY,
  PRINT_WITHOUT_DONE_STATIONS,
  crewsPrintMaySkip,
  parsePrintWithoutDone,
} from "../src/lib/station-print-without-done";
import { stationOf } from "../src/lib/stations";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

let failures = 0;
const pass = (name: string, cond: boolean) => {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures++;
};

/* ── 1. THE RULE ──────────────────────────────────────────────────────────── */
{
  pass("the setting key is stable and named for the switch", PRINT_WITHOUT_DONE_KEY === "station_print_without_done");
  pass(
    "the switch covers the three crews the admin shows (barista, kitchen, juice), never buna",
    PRINT_WITHOUT_DONE_STATIONS.length === 3 &&
      ["barista", "kitchen", "juice"].every((s) => (PRINT_WITHOUT_DONE_STATIONS as readonly string[]).includes(s)) &&
      !(PRINT_WITHOUT_DONE_STATIONS as readonly string[]).includes("buna")
  );
  pass(
    "every crew defaults to OFF (the stations must tap Done, as before)",
    PRINT_WITHOUT_DONE_STATIONS.every((s) => DEFAULT_PRINT_WITHOUT_DONE[s] === false)
  );
  pass("a missing setting means no crew may be skipped", crewsPrintMaySkip(undefined).size === 0);
  pass("a blank setting means no crew may be skipped", crewsPrintMaySkip("").size === 0);
  pass("a malformed setting means no crew may be skipped", crewsPrintMaySkip("not json").size === 0);
  pass("a non-object setting means no crew may be skipped", crewsPrintMaySkip("[true]").size === 0 && crewsPrintMaySkip("42").size === 0);
  pass(
    "a non-boolean switch value is treated as OFF (\"yes\", 1 and null never open the gate)",
    crewsPrintMaySkip({ barista: "yes", kitchen: 1, juice: null }).size === 0
  );
  pass(
    "turning ON only the barista skips only the barista",
    (() => {
      const crews = crewsPrintMaySkip(JSON.stringify({ barista: true, kitchen: false, juice: false }));
      return crews.size === 1 && crews.has("barista") && !crews.has("kitchen") && !crews.has("juice");
    })()
  );
  pass(
    "turning ON kitchen and juice skips exactly those two, and buna can never be in the set",
    (() => {
      const crews = crewsPrintMaySkip({ barista: false, kitchen: true, juice: true, buna: true });
      return crews.size === 2 && crews.has("kitchen") && crews.has("juice") && !crews.has("buna");
    })()
  );
  pass(
    "a parsed object always has all three crews, so the screen never shows a missing switch",
    (() => {
      const parsed = parsePrintWithoutDone({ barista: true });
      return parsed.barista === true && parsed.kitchen === false && parsed.juice === false;
    })()
  );
  pass(
    "an unset station (no name) is the kitchen, so a kitchen switch also covers old unnamed lines",
    crewsPrintMaySkip({ kitchen: true }).has(stationOf(null)) && crewsPrintMaySkip({ kitchen: true }).has(stationOf(""))
  );
}

/* ── 2. THE SERVER: tickets PUT ───────────────────────────────────────────── */
{
  const ticketsApi = read("src/app/api/tickets/route.ts");
  const putHalf = ticketsApi.split("export async function PUT")[1] || "";
  pass(
    "the print gate reads the switch from site_settings (and falls back to OFF if unreadable)",
    putHalf.includes("eq(siteSettings.key, PRINT_WITHOUT_DONE_KEY)") &&
      putHalf.includes("crewsPrintMaySkip(switchRows[0]?.value)") &&
      putHalf.includes("unreadable setting")
  );
  pass(
    "the gate drops only the lines of crews switched ON, and keeps every other open line",
    putHalf.includes(".filter((l) => !printWithoutDoneCrews.has(stationOf(l.stationName)))")
  );
  pass(
    "the gate still excludes buna, held guest additions and already-done lines (the old rule)",
    putHalf.includes("trim(coalesce(${ticketItems.stationName}, '')) <> 'buna'") &&
      putHalf.includes("COALESCE(${ticketItems.released}, true) = true") &&
      putHalf.includes("COALESCE(${ticketItems.stationStatus}, '') <> 'done'")
  );
}

/* ── 3. THE ADMIN SCREEN ──────────────────────────────────────────────────── */
{
  const tab = read("src/components/rms/StationsTab.tsx");
  const salesAt = tab.indexOf("STATION SALES VISIBILITY");
  const printAt = tab.indexOf("CASHIER PRINT WITHOUT DONE");
  const holdAt = tab.indexOf("── THE WAITER'S SEND HOLD", printAt);
  pass(
    "the new section sits directly below Station Sales Visibility, above the waiter send hold",
    salesAt > 0 && printAt > salesAt && holdAt > printAt
  );
  pass(
    "the section shows one switch per crew, default OFF, with the key the server reads",
    tab.includes("PRINT_WITHOUT_DONE_STATIONS.map") &&
      tab.includes("DEFAULT_PRINT_WITHOUT_DONE") &&
      tab.includes("[PRINT_WITHOUT_DONE_KEY]: JSON.stringify(next)") &&
      tab.includes("setPrintWithoutDone(parsePrintWithoutDone(s[PRINT_WITHOUT_DONE_KEY]))")
  );
  pass(
    "each switch is an accessible on/off control",
    tab.includes('role="switch"') && tab.includes("aria-checked={allowed}") && tab.includes("{allowed ? L(\"ON\") : L(\"OFF\")}")
  );
  pass(
    "the switch is saved immediately and rolls back if the save fails",
    tab.includes("const togglePrintWithoutDone") && tab.includes("setPrintWithoutDone(previous)")
  );
  pass(
    "the Save Station Settings button also carries the switch (no value is lost on save)",
    tab.includes("[PRINT_WITHOUT_DONE_KEY]: JSON.stringify(printWithoutDone)")
  );
  pass(
    "the switch never hides the sales panel or the send hold (those sections are unchanged)",
    tab.includes("station_sales_visibility: JSON.stringify(salesVisibility)") &&
      tab.includes("waiter_send_hold_seconds: String(holdSeconds)")
  );
}

console.log(
  failures === 0
    ? "\n✅ CASHIER PRINT WITHOUT DONE TEST PASSED"
    : `\n❌ CASHIER PRINT WITHOUT DONE TEST FAILED (${failures})`
);
process.exit(failures === 0 ? 0 : 1);
