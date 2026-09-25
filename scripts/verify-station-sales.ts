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
 *      on duty always read zero.
 *
 * This guard pins the fixes: periods are Ethiopian calendar DAY KEYS (a window
 * can never be zero-width, a rolling window always ends today), the three piles
 * are accepted / done / their union counted once, the figures are grouped per
 * menu category, and removed lines, cancelled bills and other people's taps
 * never count.
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

/* ── 2. THE THREE PILES: accepted, done, combined ─────────────────────────── */
{
  const rows = [
    // Accepted AND finished by Abnet today.
    I({ id: 101, ticketId: 7, name: "Macchiato", quantity: 2, price: 60, stationAcceptedBy: "Abnet", stationAcceptedAt: eat(0, 9), stationDoneBy: "Abnet", stationDoneAt: eat(0, 9, 10) }),
    // Accepted by Abnet, finished by somebody else (the only thing the OLD
    // "combined" tab counted — it must still be there, inside the union).
    I({ id: 102, ticketId: 7, name: "Tea", quantity: 1, price: 40, stationAcceptedBy: "Abnet", stationAcceptedAt: eat(0, 10), stationDoneBy: "Mitke", stationDoneAt: eat(0, 10, 20) }),
    // Finished by Abnet, although a colleague had accepted it.
    I({ id: 103, ticketId: 8, name: "Buna", quantity: 3, price: 50, stationAcceptedBy: "Mitke", stationAcceptedAt: eat(0, 11), stationDoneBy: "Abnet", stationDoneAt: eat(0, 11, 30) }),
    // A colleague's line, start to finish: never Abnet's.
    I({ id: 104, ticketId: 9, name: "Macchiato", quantity: 5, price: 60, stationAcceptedBy: "Mitke", stationAcceptedAt: eat(0, 12), stationDoneBy: "Mitke", stationDoneAt: eat(0, 12, 5) }),
  ];
  const accepted = pile("today", rows, "accepted");
  const done = pile("today", rows, "done");
  const combined = pile("today", rows, "combined");

  pass("RUNTIME: ACCEPTED counts only the lines this person tapped Accept on",
    accepted.lines === 2 && accepted.quantity === 3 && accepted.amount === 2 * 60 + 1 * 40,
    JSON.stringify({ lines: accepted.lines, quantity: accepted.quantity, amount: accepted.amount }));
  pass("RUNTIME: DONE counts only the lines this person tapped Done on",
    done.lines === 2 && done.quantity === 5 && done.amount === 2 * 60 + 3 * 50,
    JSON.stringify({ lines: done.lines, quantity: done.quantity, amount: done.amount }));
  pass("RUNTIME: COMBINED is every line the person touched, each counted ONCE (not accepted + done)",
    combined.lines === 3 && combined.quantity === 6 && combined.amount === 2 * 60 + 1 * 40 + 3 * 50,
    JSON.stringify({ lines: combined.lines, quantity: combined.quantity, amount: combined.amount }));
  pass("RUNTIME: COMBINED is never zero when the person worked (the old rule was)", combined.lines > 0);
  pass("RUNTIME: COMBINED still contains 'accepted by me, finished by a colleague'",
    combined.items.some((i) => i.name === "Tea" && i.quantity === 1));
  pass("RUNTIME: a colleague's line from start to finish is in nobody else's pile",
    !combined.items.some((i) => i.quantity === 5) && !accepted.items.some((i) => i.name === "Buna"));
  pass("RUNTIME: bills are counted once per pile, however many lines they carried",
    accepted.bills === 1 && done.bills === 2 && combined.bills === 2,
    JSON.stringify({ a: accepted.bills, d: done.bills, c: combined.bills }));
  pass("RUNTIME: all three piles are always present in the report",
    SALES_MODES.every((m) => build("today", rows).modes[m]) && SALES_MODES.length === 3);
  pass("RUNTIME: an empty day reads as a real zero, not as a broken payload",
    pile("today", [], "combined").quantity === 0 && pile("today", [], "combined").categories.length === 0);

  // Attribution helpers used above.
  pass("attribution: the accept and the done step are kept separately",
    lineAttribution(I({ stationAcceptedBy: "Abnet", stationAcceptedAt: eat(0, 9), stationDoneBy: "Mitke", stationDoneAt: eat(0, 10) })).doneBy === "Mitke");
  pass("attribution: a placeholder name is never a member of the crew",
    !isCrewName("admin") && !isCrewName("(cashier)") && !isCrewName("Customer (QR)") && isCrewName("Abnet"));
  pass("RUNTIME: a line an ADMIN finished on the crew's behalf is not their sale",
    pile("today", [I({ stationAcceptedBy: "Abnet", stationAcceptedAt: eat(0, 9), stationDoneBy: "admin", stationDoneAt: eat(0, 9, 30) })], "done").lines === 0 &&
    pile("today", [I({ stationAcceptedBy: "Abnet", stationAcceptedAt: eat(0, 9), stationDoneBy: "admin", stationDoneAt: eat(0, 9, 30) })], "combined").lines === 1);
  pass("RUNTIME: the whole-crew view (an owner asking for a station) counts every real person once",
    pile("today", rows, "combined", null).lines === 4 && pile("today", rows, "combined", null).quantity === 11);
}

/* ── 3. GROUPED BY MENU CATEGORY (what the crew asked to see) ─────────────── */
{
  const rows = [
    I({ name: "Macchiato", category: "hot-drinks", quantity: 2, price: 60, stationDoneBy: "Abnet", stationDoneAt: eat(0, 9) }),
    I({ name: "Tea", category: "hot-drinks", quantity: 1, price: 40, stationDoneBy: "Abnet", stationDoneAt: eat(0, 9, 5) }),
    I({ name: "Mango Juice", category: "juices", quantity: 4, price: 120, stationDoneBy: "Abnet", stationDoneAt: eat(0, 10) }),
    I({ name: "Buna", category: "", quantity: 1, price: 50, stationDoneBy: "Abnet", stationDoneAt: eat(0, 11) }),
  ];
  const combined = pile("today", rows, "combined");
  pass("RUNTIME: lines are grouped per menu category with a subtotal per category",
    combined.categories.length === 3 &&
    combined.categories.find((c) => c.category === "Hot Drinks")?.quantity === 3 &&
    combined.categories.find((c) => c.category === "Hot Drinks")?.amount === 2 * 60 + 40 &&
    combined.categories.find((c) => c.category === "Fresh Juices")?.quantity === 4);
  pass("RUNTIME: the owner's category NAME is shown, not the stored slug",
    categoryLabel("hot-drinks", CATEGORY_NAMES) === "Hot Drinks" && categoryLabel("juices", CATEGORY_NAMES) === "Fresh Juices");
  pass("RUNTIME: an unknown or empty slug still gets a readable pile",
    categoryLabel("", CATEGORY_NAMES) === "General" && categoryLabel("specials", CATEGORY_NAMES) === "specials" &&
    combined.categories.some((c) => c.category === "General"));
  pass("RUNTIME: the same item on two bills folds into one line with both bills counted",
    pile("today", [
      I({ ticketId: 1, name: "Macchiato", quantity: 2, stationDoneBy: "Abnet", stationDoneAt: eat(0, 9) }),
      I({ ticketId: 2, name: "Macchiato", quantity: 3, stationDoneBy: "Abnet", stationDoneAt: eat(0, 10) }),
    ], "combined").items.length === 1 &&
    pile("today", [
      I({ ticketId: 1, name: "Macchiato", quantity: 2, stationDoneBy: "Abnet", stationDoneAt: eat(0, 9) }),
      I({ ticketId: 2, name: "Macchiato", quantity: 3, stationDoneBy: "Abnet", stationDoneAt: eat(0, 10) }),
    ], "combined").items[0].quantity === 5 &&
    pile("today", [
      I({ ticketId: 1, name: "Macchiato", quantity: 2, stationDoneBy: "Abnet", stationDoneAt: eat(0, 9) }),
      I({ ticketId: 2, name: "Macchiato", quantity: 3, stationDoneBy: "Abnet", stationDoneAt: eat(0, 10) }),
    ], "combined").items[0].bills === 2);
  pass("RUNTIME: the busiest category comes first, the busiest item inside it too",
    combined.categories[0].category === "Fresh Juices" &&
    combined.categories.find((c) => c.category === "Hot Drinks")?.items[0].name === "Macchiato");
  pass("RUNTIME: the pile totals are the sum of their categories",
    combined.quantity === combined.categories.reduce((n, c) => n + c.quantity, 0) &&
    combined.amount === combined.categories.reduce((n, c) => n + c.amount, 0) &&
    combined.lines === combined.categories.reduce((n, c) => n + c.lines, 0));
}

/* ── 4. WHAT NEVER COUNTS AS SOLD ─────────────────────────────────────────── */
{
  const base = { stationAcceptedBy: "Abnet", stationAcceptedAt: eat(0, 9), stationDoneBy: "Abnet", stationDoneAt: eat(0, 9, 20) };
  pass("RUNTIME: a line the cashier removed is never a sale", pile("today", [I({ ...base, removed: true })], "combined").lines === 0);
  pass("RUNTIME: a CANCELLED order is never a sale", pile("today", [I({ ...base, ticketStatus: "cancelled" })], "combined").lines === 0);
  pass("RUNTIME: a paid, printed or still-open bill all count the same",
    ["paid", "printed", "confirmed", "closed", null].every((s) => pile("today", [I({ ...base, ticketStatus: s })], "combined").lines === 1));
  pass("RUNTIME: a line nobody tapped is not a sale", pile("today", [I({ name: "Tea" })], "combined").lines === 0);
  pass("RUNTIME: a tap outside the chosen date is not in it",
    pile("yesterday", [I({ ...base })], "combined").lines === 0 && pile("today", [I({ ...base })], "combined").lines === 1);
  pass("RUNTIME: zero and missing quantities/prices can never produce NaN",
    Number.isFinite(pile("today", [I({ ...base, quantity: null, price: null })], "combined").amount) &&
    pile("today", [I({ ...base, quantity: null, price: null })], "combined").quantity === 0);
  // Legacy rows: stamped before station_accepted_* / station_done_* existed.
  pass("RUNTIME: an older line that only knows its LAST tap is still counted (done)",
    pile("today", [I({ stationStatus: "done", stationStatusBy: "Abnet", stationStatusAt: eat(0, 8), stationDoneBy: null, stationDoneAt: null })], "done").lines === 1);
  pass("RUNTIME: an older line that only knows its LAST tap is still counted (accepted)",
    pile("today", [I({ stationStatus: "accepted", stationStatusBy: "Abnet", stationStatusAt: eat(0, 8), stationAcceptedBy: null, stationAcceptedAt: null })], "accepted").lines === 1);
  pass("RUNTIME: a legacy line is never counted twice in combined",
    pile("today", [I({ stationStatus: "done", stationStatusBy: "Abnet", stationStatusAt: eat(0, 8) })], "combined").lines === 1);
}

/* ── 5. THE API ROUTE ─────────────────────────────────────────────────────── */
{
  pass("the route asks the pure builder for the figures (no counting of its own)",
    /buildStationSales\(\{ period, station, staff: person, rows, categoryNames \}\)/.test(route));
  pass("the route never builds a day window from a negative day count (the 0,0 bug)",
    !/etStartOfDaysAgo\(\s*-/.test(route) && !/etStartOfDaysAgo\(\s*-/.test(lib));
  pass("the route takes the period from the shared list and defaults to today",
    /salesPeriodOf\(params\.get\("period"\)\)/.test(route));
  pass("the route reads one bounded window, not the whole ticket_items table",
    /salesPeriodCutoff\(period\)/.test(route) && /gte\(ticketItems\.stationAcceptedAt, cutoff\)/.test(route));
  pass("the route also picks up lines that only carry the LAST-tap stamp",
    /gte\(ticketItems\.stationStatusAt, cutoff\)/.test(route));
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
  pass("the screen builds its three tabs from the shared mode list",
    /SALES_MODES\.map/.test(ui) && /SALES_MODE_LABELS\[m\]/.test(ui));
  pass("every date button reloads that period", /onClick=\{\(\) => loadSales\(p\)\}/.test(ui));
  pass("the three tabs switch the pile without another request", /onClick=\{\(\) => setSalesMode\(m\)\}/.test(ui));
  pass("the screen reads the report's piles, not the old flat record",
    /sales\?\.modes\?\.\[salesMode\]/.test(ui) && !/sales\[salesMode\]/.test(ui));
  pass("the figures are listed per category on the screen", /salesPile\.categories\.map/.test(ui));
  pass("the screen prints the dates the figures cover", /salesRangeText\(sales\.range\)/.test(ui) && /Covers: \{rangeText\}/.test(ui));
  pass("money goes through the staff money helper (ETB is never translated)", /staffEtb\(/.test(ui));
  pass("a failed load says so instead of showing zeros",
    /Could not load your sales/.test(ui) && /salesError/.test(ui));
  pass("an expired session sends the crew back to the login screen",
    /r\.status === 401/.test(ui) && /expireSession\(\)/.test(ui));
  pass("the closed screen's tile already carries today's own count",
    /todayUnits/.test(ui) && /refreshTodayUnits\(\)/.test(ui));
  pass("the tile number follows an Accept/Done tap", /load\(\);\s*\n\s*\/\/ The tap the crew just made[\s\S]{0,200}void refreshTodayUnits\(\);/.test(ui));
  pass("the empty day still reads as an explained empty list", /No items for this selection\./.test(ui));
  pass("the old zero-only sales shape is gone from the screen",
    !/Record<string, Array<\{name: string; quantity: number; amount: number; bills: number\}>>/.test(ui));
  pass("the disabled 'Today's History' panel the tab replaced is gone",
    !/\{false && showHistory/.test(ui) && !/showHistory/.test(ui));
  pass("the labels the crew taps come from the dictionary (English and Amharic)",
    ["Today", "Yesterday", "Day Before Yesterday", "Last 7 Days", "Last 30 Days", "Accepted", "Done", "Combined"]
      .every((w) => new RegExp(`^  "${w}":`, "m").test(read("src/lib/staff-dictionary.ts"))));
  pass("the mode labels and the period labels are the dictionary's own words",
    Object.values(SALES_MODE_LABELS).every((l) => ["Accepted", "Done", "Combined"].includes(l)) &&
    Object.values(SALES_PERIOD_LABELS).every((l) => ["Today", "Yesterday", "Day Before Yesterday", "Last 7 Days", "Last 30 Days"].includes(l)));
  pass("all three station screens render this one component",
    ["kitchen", "barista", "juice"].every((s) => read(`src/app/(internal)/${s}/page.tsx`).includes("StationApp")));
}

if (failures > 0) {
  console.error(`\n❌ ${failures} station-sales check(s) failed`);
  process.exit(1);
}
console.log("\n✅ station sales checks passed");
