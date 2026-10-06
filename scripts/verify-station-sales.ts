#!/usr/bin/env tsx
/**
 * Regression guard: the crew's "ITEMS SOLD" tab on the kitchen, barista and
 * juice screens (owner, Sept 2026: "when they click it it shows 0,0").
 *
 * The first version of the tab could only ever answer zero:
 *
 *   1. TODAY'S WINDOW WAS EMPTY. It ran from `etStartOfDaysAgo(0)` to
 *      `etStartOfDaysAgo(-1)`, and that helper clamps a negative day count to
 *      zero — so the window started and ended at the SAME instant. "Last 7
 *      Days" used the same `-1` as its end and silently dropped today too.
 *   2. "COMBINED" MEANT NOTHING ON A NORMAL SHIFT. It counted only lines this
 *      person accepted AND somebody else finished, so a station with one person
 *      on duty always read zero. It has since been REMOVED outright (see §2):
 *      the same person accepts and finishes every line, so the union could only
 *      repeat the Accepted pile.
 *
 * This guard pins the fixes: periods are Ethiopian calendar DAY KEYS (a window
 * can never be zero-width, a rolling window always ends today), the TWO piles
 * are accepted / done (a line the same person both accepted and finished is
 * counted once in each), the figures are grouped per menu category, and removed
 * lines, cancelled bills and other people's taps never count.
 *
 * Part runtime (the pure builder in src/lib/station-sales.ts is exercised with
 * fixtures, no database), part static source inspection of the API route and
 * the crew screen.
 * Run with: npx tsx scripts/verify-station-sales.ts   (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildStationSales,
  categoryLabel,
  formatDayKey,
  isCrewName,
  isSalesPeriod,
  lineAttribution,
  salesDayKeys,
  salesPeriodCutoff,
  salesPeriodOf,
  salesPeriodRange,
  salesRangeText,
  SALES_MODES,
  SALES_MODE_LABELS,
  SALES_PERIODS,
  SALES_PERIOD_LABELS,
  SALES_PERIOD_LENGTH_DAYS,
  SALES_PERIOD_START_DAYS_AGO,
  type SalesMode,
  type SalesPeriod,
  type StationSalesItemRow,
} from "../src/lib/station-sales";
import { mergeCategoryRouting, stationForOrder } from "../src/lib/stations";
import { DEFAULT_CATEGORY_ROUTING } from "../src/lib/initial-data";
import {
  DEFAULT_STATION_SALES_VISIBILITY,
  isStationSalesVisible,
  parseStationSalesVisibility,
  STATION_SALES_STATIONS,
  STATION_SALES_VISIBILITY_KEY,
} from "../src/lib/station-sales-visibility";
import { etDayKey, etStartOfDaysAgo } from "../src/lib/timezone";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

let failures = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
  if (!cond) failures++;
};

const route = read("src/app/api/station-sales/route.ts");
const ui = read("src/components/rms/StationApp.tsx");
const lib = read("src/lib/station-sales.ts");

/* ─── FIXTURES ────────────────────────────────────────────────────────────── */

/** An Ethiopian-clock instant `daysAgo` days back, at hour:minute EAT. */
const eat = (daysAgo: number, hour: number, minute = 0) =>
  new Date(etStartOfDaysAgo(daysAgo).getTime() + (hour * 60 + minute) * 60_000);

let nextId = 1;
const I = (o: Partial<StationSalesItemRow> = {}): StationSalesItemRow => ({
  id: nextId++,
  ticketId: 1,
  name: "Macchiato",
  category: "hot-drinks",
  price: 60,
  quantity: 1,
  removed: false,
  ticketStatus: "printed",
  ticketPrintedAt: eat(0, 12),
  ticketSaleAt: eat(0, 12),
  createdAt: eat(0, 11),
  stationStatus: "done",
  stationStatusBy: null,
  stationStatusAt: null,
  stationAcceptedBy: null,
  stationAcceptedAt: null,
  stationDoneBy: null,
  stationDoneAt: null,
  ...o,
});

const CATEGORY_NAMES = { "hot-drinks": "Hot Drinks", juices: "Fresh Juices", foods: "Foods" };
const build = (period: SalesPeriod, rows: StationSalesItemRow[], staff: string | null = "Abnet") =>
  buildStationSales({ period, station: "barista", staff, rows, categoryNames: CATEGORY_NAMES });
const pile = (period: SalesPeriod, rows: StationSalesItemRow[], mode: SalesMode, staff: string | null = "Abnet") =>
  build(period, rows, staff).modes[mode];

/* ── 1. THE PERIOD WINDOWS (the bug that made the tab read 0,0) ───────────── */
{
  pass("every period is a list of Ethiopian calendar days, never a zero-width window",
    SALES_PERIODS.every((p) => salesDayKeys(p).length === SALES_PERIOD_LENGTH_DAYS[p]),
    SALES_PERIODS.map((p) => `${p}=${salesDayKeys(p).length}`).join(" "));
  pass("today is exactly one day key: today's", salesDayKeys("today").length === 1 && salesDayKeys("today")[0] === etDayKey(new Date()));
  pass("a rolling window ALWAYS ends with today (the old `-1` end dropped it)",
    salesDayKeys("week")[salesDayKeys("week").length - 1] === etDayKey(new Date()) &&
    salesDayKeys("month")[salesDayKeys("month").length - 1] === etDayKey(new Date()));
  pass("Last 7 Days = today + the 6 days before it", salesDayKeys("week").length === 7 && salesDayKeys("week")[0] === etDayKey(eat(6, 12)));
  pass("Last 30 Days = today + the 29 days before it", salesDayKeys("month").length === 30 && salesDayKeys("month")[0] === etDayKey(eat(29, 12)));
  pass("yesterday and the day before are their own single days",
    salesDayKeys("yesterday")[0] === etDayKey(eat(1, 12)) && salesDayKeys("dayBefore")[0] === etDayKey(eat(2, 12)));
  pass("the day keys never overlap between two different single days",
    !salesDayKeys("today").some((k) => salesDayKeys("yesterday").includes(k)) &&
    !salesDayKeys("yesterday").some((k) => salesDayKeys("dayBefore").includes(k)));
  pass("the SQL cutoff is EAT midnight of the oldest day of the window",
    salesPeriodCutoff("today").getTime() === etStartOfDaysAgo(0).getTime() &&
    salesPeriodCutoff("week").getTime() === etStartOfDaysAgo(6).getTime() &&
    salesPeriodCutoff("month").getTime() === etStartOfDaysAgo(SALES_PERIOD_START_DAYS_AGO.month).getTime());
  pass("an unknown period falls back to today", salesPeriodOf("nonsense") === "today" && salesPeriodOf(null) === "today" && isSalesPeriod("week") && !isSalesPeriod("weekend"));
  pass("the report says which exact dates it covers",
    salesPeriodRange("today").from === salesPeriodRange("today").to && salesPeriodRange("week").days === 7);
  pass("a single day prints as one date, a window as a range",
    formatDayKey("2026-09-25") === "25 Sep 2026" &&
    salesRangeText(salesPeriodRange("today")) === formatDayKey(etDayKey(new Date())) &&
    salesRangeText(salesPeriodRange("week")).includes("–"));

  // THE ACTUAL REGRESSION: taps made today are counted today.
  const todayRows = [
    I({ name: "Macchiato", quantity: 2, stationAcceptedBy: "Abnet", stationAcceptedAt: eat(0, 9, 5), stationDoneBy: "Abnet", stationDoneAt: eat(0, 9, 12) }),
    I({ name: "Tea", quantity: 1, stationAcceptedBy: "Abnet", stationAcceptedAt: eat(0, 23, 55), stationDoneBy: "Abnet", stationDoneAt: eat(0, 23, 58) }),
  ];
  pass("RUNTIME: a tap made today is counted today (this is what used to read 0)",
    pile("today", todayRows, "done").quantity === 3 && pile("today", todayRows, "accepted").quantity === 3);
  pass("RUNTIME: the first and the last minute of the Ethiopian day both count",
    pile("today", [I({ stationDoneBy: "Abnet", stationDoneAt: eat(0, 0, 1), stationAcceptedBy: null })], "done").lines === 1 &&
    pile("today", [I({ stationDoneBy: "Abnet", stationDoneAt: eat(0, 23, 59), stationAcceptedBy: null })], "done").lines === 1);
  pass("RUNTIME: yesterday's tap is not in today's pile (and is in yesterday's)",
    pile("today", [I({ stationDoneBy: "Abnet", stationDoneAt: eat(1, 23, 59), stationAcceptedBy: null })], "done").lines === 0 &&
    pile("yesterday", [I({ stationDoneBy: "Abnet", stationDoneAt: eat(1, 23, 59), stationAcceptedBy: null })], "done").lines === 1);
  pass("RUNTIME: today's tap is inside Last 7 Days and Last 30 Days",
    pile("week", todayRows, "done").quantity === 3 && pile("month", todayRows, "done").quantity === 3);
  pass("RUNTIME: a tap from 8 days ago is out of Last 7 Days but inside Last 30 Days",
    pile("week", [I({ stationDoneBy: "Abnet", stationDoneAt: eat(8, 10), stationAcceptedBy: null })], "done").lines === 0 &&
    pile("month", [I({ stationDoneBy: "Abnet", stationDoneAt: eat(8, 10), stationAcceptedBy: null })], "done").lines === 1);
  pass("RUNTIME: an order sent before midnight and finished after it lands on the day it was FINISHED",
    pile("today", [I({ stationAcceptedBy: "Abnet", stationAcceptedAt: eat(1, 23, 50), stationDoneBy: "Abnet", stationDoneAt: eat(0, 0, 10) })], "done").lines === 1 &&
    pile("today", [I({ stationAcceptedBy: "Abnet", stationAcceptedAt: eat(1, 23, 50), stationDoneBy: "Abnet", stationDoneAt: eat(0, 0, 10) })], "accepted").lines === 0 &&
    pile("yesterday", [I({ stationAcceptedBy: "Abnet", stationAcceptedAt: eat(1, 23, 50), stationDoneBy: "Abnet", stationDoneAt: eat(0, 0, 10) })], "accepted").lines === 1);
}

/* ── 2. THE TWO PILES: accepted, done (combined is gone) ───────────────── */
/* The owner, 29 Sept 2026: "the combined option now will be removed because
 * their actions will be done only by them, accept and done by the same person".
 * Whoever accepts a line is the only one who may finish it, so the union of the
 * two piles could only ever repeat the Accepted pile — a third number that
 * said nothing. Two piles, each counted once: a line the same person both
 * accepted and finished is in BOTH. */
{
  const rows = [
    // Accepted AND finished by Abnet today — the line both piles hold.
    I({ id: 101, ticketId: 7, name: "Macchiato", quantity: 2, price: 60, stationAcceptedBy: "Abnet", stationAcceptedAt: eat(0, 9), stationDoneBy: "Abnet", stationDoneAt: eat(0, 9, 10) }),
    // Accepted by Abnet and NOT finished yet: an open line still on her board,
    // and exactly the kind of line that now blocks the cashier's ✓ PRINTED.
    I({ id: 102, ticketId: 7, name: "Tea", quantity: 1, price: 40, stationAcceptedBy: "Abnet", stationAcceptedAt: eat(0, 10) }),
    // Finished by Abnet although a colleague had accepted it (an audit row):
    // Done has it, Accepted does not.
    I({ id: 103, ticketId: 8, name: "Buna", quantity: 3, price: 50, stationAcceptedBy: "Mitke", stationAcceptedAt: eat(0, 11), stationDoneBy: "Abnet", stationDoneAt: eat(0, 11, 30) }),
    // A colleague's line, start to finish: never Abnet's.
    I({ id: 104, ticketId: 9, name: "Macchiato", quantity: 5, price: 60, stationAcceptedBy: "Mitke", stationAcceptedAt: eat(0, 12), stationDoneBy: "Mitke", stationDoneAt: eat(0, 12, 5) }),
  ];
  const accepted = pile("today", rows, "accepted");
  const done = pile("today", rows, "done");

  pass("RUNTIME: ACCEPTED counts only the lines this person tapped Accept on",
    accepted.lines === 2 && accepted.quantity === 3 && accepted.amount === 2 * 60 + 1 * 40,
    JSON.stringify({ lines: accepted.lines, quantity: accepted.quantity, amount: accepted.amount }));
  pass("RUNTIME: DONE counts only the lines this person tapped Done on",
    done.lines === 2 && done.quantity === 5 && done.amount === 2 * 60 + 3 * 50,
    JSON.stringify({ lines: done.lines, quantity: done.quantity, amount: done.amount }));
  pass("RUNTIME: a line accepted AND finished by the same person is in both piles, counted once in each",
    accepted.items.some((i) => i.name === "Macchiato" && i.quantity === 2) &&
    done.items.some((i) => i.name === "Macchiato" && i.quantity === 2));
  pass("RUNTIME: an accepted-but-unfinished line is in Accepted and NEVER in Done",
    accepted.items.some((i) => i.name === "Tea" && i.quantity === 1) &&
    !done.items.some((i) => i.name === "Tea"));
  pass("RUNTIME: there are exactly TWO piles and combined is GONE",
    SALES_MODES.length === 2 && SALES_MODES.includes("accepted") && SALES_MODES.includes("done") &&
    Object.keys(SALES_MODE_LABELS).length === 2 &&
    !Object.prototype.hasOwnProperty.call(build("today", rows).modes, "combined"));
  pass("RUNTIME: a colleague's line from start to finish is in nobody else's pile",
    !done.items.some((i) => i.quantity === 5) && !accepted.items.some((i) => i.name === "Buna"));
  pass("RUNTIME: bills are counted once per pile, however many lines they carried",
    accepted.bills === 1 && done.bills === 2,
    JSON.stringify({ a: accepted.bills, d: done.bills }));
  pass("RUNTIME: both piles are always present in the report",
    SALES_MODES.every((m) => build("today", rows).modes[m]));
  pass("RUNTIME: an empty day reads as a real zero, not as a broken payload",
    pile("today", [], "done").quantity === 0 && pile("today", [], "done").categories.length === 0);

  // Attribution helpers used above.
  pass("attribution: the accept and the done step are kept separately",
    lineAttribution(I({ stationAcceptedBy: "Abnet", stationAcceptedAt: eat(0, 9), stationDoneBy: "Mitke", stationDoneAt: eat(0, 10) })).doneBy === "Mitke");
  pass("attribution: a placeholder name is never a member of the crew",
    !isCrewName("admin") && !isCrewName("(cashier)") && !isCrewName("Customer (QR)") && isCrewName("Abnet"));
  pass("RUNTIME: a line an ADMIN finished on the crew's behalf is not their sale",
    pile("today", [I({ stationAcceptedBy: "Abnet", stationAcceptedAt: eat(0, 9), stationDoneBy: "admin", stationDoneAt: eat(0, 9, 30) })], "done").lines === 0 &&
    pile("today", [I({ stationAcceptedBy: "Abnet", stationAcceptedAt: eat(0, 9), stationDoneBy: "admin", stationDoneAt: eat(0, 9, 30) })], "accepted").lines === 1);
  pass("RUNTIME: the whole-crew view (an owner asking for a station) counts every real person once",
    pile("today", rows, "done", null).lines === 3 && pile("today", rows, "done", null).quantity === 10 &&
    pile("today", rows, "accepted", null).lines === 4 && pile("today", rows, "accepted", null).quantity === 11);
}

/* ── 3. GROUPED BY MENU CATEGORY (what the crew asked to see) ─────────────── */
{
  const rows = [
    I({ name: "Macchiato", category: "hot-drinks", quantity: 2, price: 60, stationDoneBy: "Abnet", stationDoneAt: eat(0, 9) }),
    I({ name: "Tea", category: "hot-drinks", quantity: 1, price: 40, stationDoneBy: "Abnet", stationDoneAt: eat(0, 9, 5) }),
    I({ name: "Mango Juice", category: "juices", quantity: 4, price: 120, stationDoneBy: "Abnet", stationDoneAt: eat(0, 10) }),
    I({ name: "Buna", category: "", quantity: 1, price: 50, stationDoneBy: "Abnet", stationDoneAt: eat(0, 11) }),
  ];
  const done = pile("today", rows, "done");
  pass("RUNTIME: lines are grouped per menu category with a subtotal per category",
    done.categories.length === 3 &&
    done.categories.find((c) => c.category === "Hot Drinks")?.quantity === 3 &&
    done.categories.find((c) => c.category === "Hot Drinks")?.amount === 2 * 60 + 40 &&
    done.categories.find((c) => c.category === "Fresh Juices")?.quantity === 4);
  pass("RUNTIME: the owner's category NAME is shown, not the stored slug",
    categoryLabel("hot-drinks", CATEGORY_NAMES) === "Hot Drinks" && categoryLabel("juices", CATEGORY_NAMES) === "Fresh Juices");
  pass("RUNTIME: an unknown or empty slug still gets a readable pile",
    categoryLabel("", CATEGORY_NAMES) === "General" && categoryLabel("specials", CATEGORY_NAMES) === "specials" &&
    done.categories.some((c) => c.category === "General"));
  pass("RUNTIME: the same item on two bills folds into one line with both bills counted",
    pile("today", [
      I({ ticketId: 1, name: "Macchiato", quantity: 2, stationDoneBy: "Abnet", stationDoneAt: eat(0, 9) }),
      I({ ticketId: 2, name: "Macchiato", quantity: 3, stationDoneBy: "Abnet", stationDoneAt: eat(0, 10) }),
    ], "done").items.length === 1 &&
    pile("today", [
      I({ ticketId: 1, name: "Macchiato", quantity: 2, stationDoneBy: "Abnet", stationDoneAt: eat(0, 9) }),
      I({ ticketId: 2, name: "Macchiato", quantity: 3, stationDoneBy: "Abnet", stationDoneAt: eat(0, 10) }),
    ], "done").items[0].quantity === 5 &&
    pile("today", [
      I({ ticketId: 1, name: "Macchiato", quantity: 2, stationDoneBy: "Abnet", stationDoneAt: eat(0, 9) }),
      I({ ticketId: 2, name: "Macchiato", quantity: 3, stationDoneBy: "Abnet", stationDoneAt: eat(0, 10) }),
    ], "done").items[0].bills === 2);
  pass("RUNTIME: the busiest category comes first, the busiest item inside it too",
    done.categories[0].category === "Fresh Juices" &&
    done.categories.find((c) => c.category === "Hot Drinks")?.items[0].name === "Macchiato");
  pass("RUNTIME: the pile totals are the sum of their categories",
    done.quantity === done.categories.reduce((n, c) => n + c.quantity, 0) &&
    done.amount === done.categories.reduce((n, c) => n + c.amount, 0) &&
    done.lines === done.categories.reduce((n, c) => n + c.lines, 0));
}

/* ── 4. WHAT NEVER COUNTS AS SOLD ─────────────────────────────────────────── */
{
  const base = { stationAcceptedBy: "Abnet", stationAcceptedAt: eat(0, 9), stationDoneBy: "Abnet", stationDoneAt: eat(0, 9, 20) };
  pass("RUNTIME: a line the cashier removed is never a sale", pile("today", [I({ ...base, removed: true })], "done").lines === 0);
  pass("RUNTIME: a CANCELLED order is never a sale", pile("today", [I({ ...base, ticketStatus: "cancelled" })], "done").lines === 0);
  pass("RUNTIME: printed, closed and paid EFD bills count; non-sale statuses do not",
    ["paid", "printed", "closed"].every((s) => pile("today", [I({ ...base, ticketStatus: s })], "done").lines === 1) &&
    ["confirmed", null].every((s) => pile("today", [I({ ...base, ticketStatus: s })], "done").lines === 0));
  pass("RUNTIME: a printed status without an actual print stamp is not a sale",
    pile("today", [I({ ...base, ticketStatus: "printed", ticketPrintedAt: null })], "done").lines === 0);
  const fullModePaid = buildStationSales({
    period: "today", station: "barista", staff: "Abnet", categoryNames: CATEGORY_NAMES,
    printQueueMode: false, rows: [I({ ...base, ticketStatus: "paid", ticketPrintedAt: null })],
  });
  pass("RUNTIME: full-payment mode still counts a paid line without an EFD print", fullModePaid.modes.done.lines === 1);
  pass("RUNTIME: a line nobody tapped is not a sale", pile("today", [I({ name: "Tea" })], "done").lines === 0);
  pass("RUNTIME: a tap outside the chosen date is not in it",
    pile("yesterday", [I({ ...base })], "done").lines === 0 && pile("today", [I({ ...base })], "done").lines === 1);
  pass("RUNTIME: zero and missing quantities/prices can never produce NaN",
    Number.isFinite(pile("today", [I({ ...base, quantity: null, price: null })], "done").amount) &&
    pile("today", [I({ ...base, quantity: null, price: null })], "done").quantity === 0);
  // Legacy rows: stamped before station_accepted_* / station_done_* existed.
  pass("RUNTIME: an older line that only knows its LAST tap is still counted (done)",
    pile("today", [I({ stationStatus: "done", stationStatusBy: "Abnet", stationStatusAt: eat(0, 8), stationDoneBy: null, stationDoneAt: null })], "done").lines === 1);
  pass("RUNTIME: an older line that only knows its LAST tap is still counted (accepted)",
    pile("today", [I({ stationStatus: "accepted", stationStatusBy: "Abnet", stationStatusAt: eat(0, 8), stationAcceptedBy: null, stationAcceptedAt: null })], "accepted").lines === 1);
  pass("RUNTIME: a legacy line is never counted twice in Done",
    pile("today", [I({ stationStatus: "done", stationStatusBy: "Abnet", stationStatusAt: eat(0, 8) })], "done").lines === 1);
}

/* ── 5. INCREMENTAL EFD RECEIPTS ─────────────────────────────────────────── */
{
  const merged = I({
    id: 700, ticketId: 700, name: "Macchiato", price: 60, quantity: 2,
    createdAt: eat(1, 21), ticketStatus: "printed", ticketPrintedAt: eat(0, 10), ticketSaleAt: eat(0, 10),
    ticketPrintEvents: [eat(1, 22), eat(0, 10)],
    ticketQuantityEvents: [{ itemId: 700, eventType: "item_quantity_changed", fromValue: "1", toValue: "2", createdAt: eat(0, 9, 30) }],
  });
  const today = buildStationSales({ period: "today", station: "barista", staff: null, rows: [merged], categoryNames: CATEGORY_NAMES });
  const yesterday = buildStationSales({ period: "yesterday", station: "barista", staff: null, rows: [merged], categoryNames: CATEGORY_NAMES });
  pass("RUNTIME: a merged top-up on receipt #2 counts only the new quantity today",
    today.printed.quantity === 1 && today.printed.amount === 60 && today.printed.bills === 1);
  pass("RUNTIME: receipt #1 remains on yesterday, not duplicated onto receipt #2",
    yesterday.printed.quantity === 1 && yesterday.printed.amount === 60);
}

/* ── 6. ADMIN-CONTROLLED STATION-SALES VISIBILITY ────────────────────────── */
{
  const allVisible = parseStationSalesVisibility(undefined);
  const hiddenKitchen = parseStationSalesVisibility(JSON.stringify({ kitchen: false }));
  pass("sales views default ON for all three stations and malformed settings stay safe",
    STATION_SALES_STATIONS.every((station) => DEFAULT_STATION_SALES_VISIBILITY[station] && allVisible[station]) &&
    STATION_SALES_STATIONS.every((station) => parseStationSalesVisibility("not json")[station]));
  pass("an admin can hide one station without changing the others",
    !hiddenKitchen.kitchen && hiddenKitchen.barista && hiddenKitchen.juice &&
    !isStationSalesVisible(hiddenKitchen, "kitchen") && isStationSalesVisible(hiddenKitchen, "barista"));
  pass("turning a hidden station back on restores its view",
    isStationSalesVisible({ ...hiddenKitchen, kitchen: true }, "kitchen"));

  const stationsTab = read("src/components/rms/StationsTab.tsx");
  const stationApp = read("src/components/rms/StationApp.tsx");
  pass("the Stations tab exposes persistent ON/OFF switches for Barista, Kitchen, and Juice",
    STATION_SALES_STATIONS.length === 3 && stationsTab.includes("STATION_SALES_STATIONS.map") &&
    ["Barista", "Kitchen", "Juice"].every((label) => stationsTab.includes(`"${label}"`)) &&
    stationsTab.includes("role=\"switch\"") && stationsTab.includes("aria-checked={enabled}") &&
    stationsTab.includes("station_sales_visibility: JSON.stringify(next)"));
  pass("the saved setting uses one key and switching OFF is explicitly non-destructive",
    STATION_SALES_VISIBILITY_KEY === "station_sales_visibility" &&
    /does not affect admin reports or order work/.test(stationsTab) && /OFF hides the Items sold button/.test(stationsTab));
  pass("a hidden crew panel disappears, and a later ON response restores access",
    /data\?\.code === "STATION_SALES_HIDDEN"/.test(stationApp) &&
    /setSalesVisible\(false\)/.test(stationApp) && /setSalesVisible\(true\)/.test(stationApp) &&
    /showSales && salesVisible/.test(stationApp) && /salesRefresh = setInterval/.test(stationApp));
}

/* ── 7. THE API ROUTE ─────────────────────────────────────────────────────── */
{
  pass("a crew screen also gets the whole lane's activity piles (never a lone zero)",
    /lane = staff\s*\? buildStationSales\(\{ period, station, staff: null, rows: salesRows, categoryNames, printQueueMode \}\)\.modes/.test(route) &&
    /lane \? \{ \.\.\.report, lane \} : report/.test(route));
  pass("the route asks the pure builder for both receipt sales and activity figures",
    /buildStationSales\(\{ period, station, staff: person, rows: salesRows, categoryNames, printQueueMode \}\)/.test(route) &&
    /ticketPrintEvents: printEventsByTicket\.get\(row\.ticketId\)/.test(route) &&
    /ticketQuantityEvents: quantityEventsByTicket\.get\(row\.ticketId\)/.test(route));
  pass("the route never builds a day window from a negative day count (the 0,0 bug)",
    !/etStartOfDaysAgo\(\s*-/.test(route) && !/etStartOfDaysAgo\(\s*-/.test(lib));
  pass("the route takes the period from the shared list and defaults to today",
    /salesPeriodOf\(params\.get\("period"\)\)/.test(route));
  pass("the route reads one bounded window, not the whole ticket_items table",
    /salesPeriodCutoff\(period\)/.test(route) && /gte\(ticketItems\.stationAcceptedAt, cutoff\)/.test(route));
  pass("the route also picks up lines that only carry the LAST-tap stamp",
    /gte\(ticketItems\.stationStatusAt, cutoff\)/.test(route));
  pass("crew visibility is enforced server-side, while admins can still inspect every lane",
    /STATION_SALES_VISIBILITY_KEY/.test(route) && /staff && !isStationSalesVisible\(visibilityRaw, station\)/.test(route));
  pass("a waiter or cashier session has no lane here", /isStationName\(staff\.role\)/.test(route));
  pass("a crew member only ever reads their OWN station and their OWN taps",
    /station = staff\.role;/.test(route) && /person = staff\.name \|\| null/.test(route));
  pass("removed lines are already filtered in SQL", /eq\(ticketItems\.removed, false\)/.test(route));
  pass("the bill's status is read so a cancelled order cannot count as sold",
    /leftJoin\(tickets, eq\(tickets\.id, ticketItems\.ticketId\)\)/.test(route) && /ticketStatus: tickets\.status/.test(route));
  pass("the category names come from the owner's own categories table",
    /from\(categories\)/.test(route) && /categoryNames\[c\.slug\] = c\.name/.test(route));
  pass("an anonymous caller is refused, and a waiter/cashier session is refused too",
    /status: 401/.test(route) && /Station login required/.test(route) && /status: 403/.test(route));
  pass("the answer is never cached (the crew taps all day long)", /"Cache-Control": "no-store"/.test(route));
  pass("a database error is answered as an error, not as an empty report",
    /catch \(error\)/.test(route) && /status: 500/.test(route));
}

/* ── 6. THE CREW SCREEN ───────────────────────────────────────────────────── */
{
  pass("the screen builds its date buttons from the shared period list",
    /SALES_PERIODS\.map/.test(ui) && /SALES_PERIOD_LABELS\[p\]/.test(ui));
  pass("the screen builds EFD, Accepted, and Done views from the shared modes",
    /\["printed", \.\.\.SALES_MODES\]/.test(ui) && /SALES_MODE_LABELS\[view\]/.test(ui));
  pass("every date button reloads that period", /onClick=\{\(\) => loadSales\(p\)\}/.test(ui));
  pass("the three views switch the pile without another request", /onClick=\{\(\) => setSalesView\(view\)\}/.test(ui));
  pass("the screen reads receipt totals or the report's activity piles",
    /sales\?\.printed/.test(ui) && /sales\?\.modes\?\.\[salesView\]/.test(ui));
  pass("the figures are listed per category on the screen", /salesPile\.categories\.map/.test(ui));
  pass("the screen prints the dates the figures cover", /salesRangeText\(sales\.range\)/.test(ui) && /Covers: \{rangeText\}/.test(ui));
  pass("money goes through the staff money helper (ETB is never translated)", /staffEtb\(/.test(ui));
  pass("a failed load says so instead of showing zeros",
    /Could not load your sales/.test(ui) && /salesError/.test(ui));
  pass("an expired session sends the crew back to the login screen",
    /r\.status === 401/.test(ui) && /expireSession\(\)/.test(ui));
  pass("the closed screen's tile already carries today's receipt-backed total",
    /todayUnits/.test(ui) && /report\.printed\?\.quantity/.test(ui) && /refreshTodayUnits\(\)/.test(ui));
  pass("a station tap refreshes the tile without counting unprinted work",
    /todayUnitsLoadRef\.current\(\);/.test(ui) && /report\.printed\?\.quantity/.test(ui));
  pass("the empty day still reads as an explained empty list", /No items for this selection\./.test(ui));
  pass("the old zero-only sales shape is gone from the screen",
    !/Record<string, Array<\{name: string; quantity: number; amount: number; bills: number\}>>/.test(ui));
  pass("the disabled 'Today's History' panel the tab replaced is gone",
    !/\{false && showHistory/.test(ui) && !/showHistory/.test(ui));
  pass("the labels the crew taps come from the dictionary (English and Amharic)",
    ["Today", "Yesterday", "Day Before Yesterday", "Last 7 Days", "Last 30 Days", "Accepted", "Done"]
      .every((w) => new RegExp(`^  "${w}":`, "m").test(read("src/lib/staff-dictionary.ts"))));
  pass("the mode labels and the period labels are the dictionary's own words",
    Object.values(SALES_MODE_LABELS).every((l) => ["Accepted", "Done"].includes(l)) &&
    Object.values(SALES_PERIOD_LABELS).every((l) => ["Today", "Yesterday", "Day Before Yesterday", "Last 7 Days", "Last 30 Days"].includes(l)));
  pass("all three station screens render this one component",
    ["kitchen", "barista", "juice"].every((s) => read(`src/app/(internal)/${s}/page.tsx`).includes("StationApp")));
}

/* ── 7. THE DONE LINGER (owner, 29 Sept 2026) ─────────────────────────────── */
/* "make it stay for 3 min before it disappears after it clicked done" — the
 * kitchen, barista and juice crews. The line stays on the board, struck
 * through with its countdown, and it is the SERVER stamp that counts, so a
 * reload shows the same three minutes and a printed bill still clears the
 * board at once. The buna lane is a different screen; it is not touched. */
{
  const screen = read("src/components/rms/StationApp.tsx");
  pass("the Done tap keeps the line on the board for exactly three minutes",
    /const DONE_LINGER_MS = 3 \* 60 \* 1000;/.test(screen));
  pass("the countdown is read from the server stamp, not from a local guess",
    /const at = item\.stationStatusAt \? Date\.parse\(item\.stationStatusAt\) : NaN;/.test(screen) &&
    /at \+ DONE_LINGER_MS - now/.test(screen));
  pass("only a line this screen finished is kept (a print-cleared line can never linger)",
    /if \(item\.stationStatus !== "done"\) return 0;/.test(screen));
  pass("the board renders it struck through until its minutes are gone",
    /\(i\.stationStatus !== "done" \|\| doneLingerLeft\(i\) > 0\)/.test(screen));
  pass("the badge counts the minutes down (the crew sees how long it stays)",
    /✓ Done • leaves in \{clock\}/.test(screen) && /lingerClock\(doneLingerLeft\(i\)\)/.test(screen));
  pass("the board ticks faster while something lingers, so the line really goes on time",
    /if \(lingeringCount === 0\) return;/.test(screen) && /setInterval\(\(\) => setNow\(Date\.now\(\)\), 5000\)/.test(screen));
  pass("the linger is a SCREEN rule: the counting module and both APIs carry no linger logic",
    !/DONE_LINGER_MS|doneLingerLeft/.test(read("src/lib/station-sales.ts")) &&
    !/DONE_LINGER_MS|doneLingerLeft/.test(read("src/app/api/station-sales/route.ts")) &&
    !/DONE_LINGER_MS|doneLingerLeft/.test(read("src/app/api/station-items/route.ts")));
}

/* ── 8. WHY JUICE COULD STILL READ 0,0: A LOST ROUTING KEY (29 Sept 2026) ── */
/* The owner: "when its for juice the total sale shows 0,0". The taps were
 * fine; the ROUTING was the hole. The order path did `routing = JSON.parse(
 * saved)`, so a saved map that never mentioned a category sent that category
 * to the kitchen fallback — and an older save (from before the juice lane
 * existed, or keyed with the category's stored capitalisation) did exactly
 * that for the fresh juices. Every juice went to the kitchen, the juice
 * maker's board stayed empty and his Items-sold figure could only be 0.
 * The merge below makes that impossible, and it is the SAME merge the Stations
 * tab shows, so the dots on that screen are the truth of where an order goes. */
{
  const merged = mergeCategoryRouting({});
  pass("an empty saved map keeps EVERY built-in default (juice categories included)",
    Object.entries(DEFAULT_CATEGORY_ROUTING).every(([slug, station]) => merged[slug] === station) &&
    merged.juices === "juice" && merged["juices-fresh"] === "juice");

  const remembered = mergeCategoryRouting({ "hot-drinks": "kitchen", pizza: "kitchen" });
  pass("the owner's own choice still wins where he made one",
    remembered["hot-drinks"] === "kitchen" && remembered.pizza === "kitchen");
  pass("a category the saved map FORGOT keeps its default crew, never the kitchen fallback",
    remembered.juices === "juice" && remembered["juices-fresh-punches"] === "juice");

  const shouted = mergeCategoryRouting({ Juices: "juice", "SOFT-DRINKS": "juice" });
  pass("a saved key with different capitalisation still matches (the order path lowercases the slug)",
    shouted.juices === "juice" && shouted["soft-drinks"] === "juice");

  const junk = mergeCategoryRouting({ juices: "buna", coffee: 7, "   ": "juice", barista: null });
  pass("junk values are ignored, never routed anywhere",
    junk.juices === "juice" && junk.coffee === "barista" && junk.barista === undefined &&
    !Object.prototype.hasOwnProperty.call(junk, ""));

  pass("END TO END: an old saved map can no longer send a fresh juice to the kitchen",
    stationForOrder(mergeCategoryRouting({ pizza: "kitchen" }), "juices", false) === "juice" &&
    stationForOrder(mergeCategoryRouting({ Juices: "juice" }), "juices", false) === "juice" &&
    stationForOrder(mergeCategoryRouting({ juices: "barista" }), "juices", false) === "barista");

  const tickets = read("src/app/api/tickets/route.ts");
  pass("the order route MERGES the saved routing over the defaults (never replaces them)",
    /mergeCategoryRouting\(JSON\.parse\(/.test(tickets) && !/routing = JSON\.parse/.test(tickets));
  const stationsTab = read("src/components/rms/StationsTab.tsx");
  pass("the Stations tab shows the same merged truth and names any category with no routing",
    /mergeCategoryRouting\(JSON\.parse/.test(stationsTab) && /const unrouted = categories\.filter/.test(stationsTab) &&
    /have no routing yet/.test(stationsTab));
}

if (failures > 0) {
  console.error(`\n❌ ${failures} station-sales check(s) failed`);
  process.exit(1);
}
console.log("\n✅ station sales checks passed");
