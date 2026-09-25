#!/usr/bin/env tsx
/**
 * Render-level smoke test for the crew's "ITEMS SOLD" tab
 * (`src/components/rms/StationApp.tsx` — the kitchen, barista and juice
 * screens), proved on a real mounted component instead of by reading source.
 *
 * The owner's report was: "when they click it it shows 0,0". This guard mounts
 * the screen with a logged-in cook, a fake server that answers
 * /api/station-sales with the REAL pure builder (src/lib/station-sales.ts), and
 * then checks what the crew actually reads:
 *
 *   1. the tile on the live screen already carries today's own unit count;
 *   2. tapping it opens a panel with real figures — units, ETB, bills, the
 *      dates covered, the menu CATEGORIES with their subtotals and items;
 *   3. the five DATE buttons re-fetch their own period and change the figures;
 *   4. the three ACCEPTED / DONE / COMBINED tabs switch piles without another
 *      request, and Combined is the union (never the old "someone else
 *      finished it" rule that always read zero);
 *   5. a failed load says so, and an expired session returns to the login
 *      screen, instead of leaving a panel full of zeros.
 *
 * Requires the `jsdom` devDependency (no browser, no database, no server).
 * Run with: npx tsx scripts/verify-station-sales-ui.tsx   (wired into `npm test`)
 */
import { JSDOM } from "jsdom";
import { buildStationSales, salesPeriodOf, type SalesPeriod, type StationSalesItemRow } from "../src/lib/station-sales";
import { etStartOfDaysAgo } from "../src/lib/timezone";

const STATION = "kitchen";
const COOK = "Abnet";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: `https://fana.test/${STATION}`,
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
// `next/link` (imported by the screen for its "back to the public website"
// link) touches `self` at module scope — jsdom's window is the browser here.
g.self = dom.window;
Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.CustomEvent = dom.window.CustomEvent;
g.localStorage = dom.window.localStorage;
g.sessionStorage = dom.window.sessionStorage;
g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.IS_REACT_ACT_ENVIRONMENT = true;

// A restored crew session, so the screen mounts straight into the live list.
dom.window.sessionStorage.setItem(`fana_${STATION}`, JSON.stringify({ id: 3, name: COOK, role: STATION }));

/* ── the mocked server ─────────────────────────────────────────────────────── */

/** An Ethiopian-clock instant `daysAgo` days back, at hour:minute EAT. */
const eat = (daysAgo: number, hour: number, minute = 0) =>
  new Date(etStartOfDaysAgo(daysAgo).getTime() + (hour * 60 + minute) * 60_000);

/**
 * The cook's real week of taps: today and yesterday carry work, the day before
 * yesterday carries a little, and every line knows its menu category.
 */
const SALES_ROWS: StationSalesItemRow[] = [
  { id: 11, ticketId: 501, name: "Kitfo", category: "foods", price: 320, quantity: 2, removed: false, ticketStatus: "printed", stationStatus: "done", stationAcceptedBy: COOK, stationAcceptedAt: eat(0, 9, 5), stationDoneBy: COOK, stationDoneAt: eat(0, 9, 25), stationStatusBy: null, stationStatusAt: null },
  { id: 12, ticketId: 501, name: "Firfir", category: "foods", price: 180, quantity: 1, removed: false, ticketStatus: "printed", stationStatus: "done", stationAcceptedBy: COOK, stationAcceptedAt: eat(0, 9, 6), stationDoneBy: "Mitke", stationDoneAt: eat(0, 9, 40), stationStatusBy: null, stationStatusAt: null },
  { id: 13, ticketId: 502, name: "Pastry", category: "pastries", price: 90, quantity: 3, removed: false, ticketStatus: "closed", stationStatus: "done", stationAcceptedBy: "Mitke", stationAcceptedAt: eat(0, 11), stationDoneBy: COOK, stationDoneAt: eat(0, 11, 20), stationStatusBy: null, stationStatusAt: null },
  { id: 14, ticketId: 503, name: "Kitfo", category: "foods", price: 320, quantity: 1, removed: false, ticketStatus: "paid", stationStatus: "done", stationAcceptedBy: COOK, stationAcceptedAt: eat(1, 13), stationDoneBy: COOK, stationDoneAt: eat(1, 13, 30), stationStatusBy: null, stationStatusAt: null },
  { id: 15, ticketId: 504, name: "Burger", category: "foods", price: 250, quantity: 4, removed: false, ticketStatus: "paid", stationStatus: "done", stationAcceptedBy: COOK, stationAcceptedAt: eat(2, 12), stationDoneBy: COOK, stationDoneAt: eat(2, 12, 45), stationStatusBy: null, stationStatusAt: null },
  // A cancelled order and a removed line: never a sale, whatever was tapped.
  { id: 16, ticketId: 505, name: "Pizza", category: "foods", price: 400, quantity: 9, removed: false, ticketStatus: "cancelled", stationStatus: "done", stationAcceptedBy: COOK, stationAcceptedAt: eat(0, 12), stationDoneBy: COOK, stationDoneAt: eat(0, 12, 30), stationStatusBy: null, stationStatusAt: null },
  { id: 17, ticketId: 506, name: "Soup", category: "foods", price: 120, quantity: 7, removed: true, ticketStatus: "printed", stationStatus: "done", stationAcceptedBy: COOK, stationAcceptedAt: eat(0, 12, 10), stationDoneBy: COOK, stationDoneAt: eat(0, 12, 50), stationStatusBy: null, stationStatusAt: null },
];
const CATEGORY_NAMES = { foods: "Foods", pastries: "Pastries" };

/** One open ticket with a pending line, so the live list is not empty. */
const LIVE_TICKETS = [
  {
    id: 601,
    tableName: "TABLE 4",
    orderNumber: "FANA-61",
    orderType: "dine_in",
    serviceNote: null,
    status: "confirmed",
    createdBy: "Abel",
    confirmedBy: "Abel",
    createdAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    receiptRequestedAt: null,
    items: [
      {
        id: 21, ticketId: 601, name: "Kitfo", category: "foods", quantity: 1, notes: null,
        stationStatus: "pending", stationStatusBy: null, stationStatusAt: null,
        createdAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
      },
    ],
  },
];

const calls: string[] = [];
let salesFails = false;
let sessionDead = false;

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const fakeFetch = async (url: string) => {
  const u = String(url);
  calls.push(u);
  if (sessionDead) return { ok: false, status: 401, json: async () => ({ error: "Unauthorized" }) };
  if (u.startsWith("/api/station-sales")) {
    if (salesFails) return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
    const period = salesPeriodOf(new URL(u, "https://fana.test").searchParams.get("period")) as SalesPeriod;
    return ok(buildStationSales({ period, station: STATION, staff: COOK, rows: SALES_ROWS, categoryNames: CATEGORY_NAMES }));
  }
  if (u.startsWith("/api/station-items")) return ok(u.includes("history=1") ? [] : LIVE_TICKETS);
  if (u.startsWith("/api/staff")) return ok([{ id: 3, name: COOK, role: STATION }]);
  if (u.startsWith("/api/staff/notifications")) return ok({ enabled: true });
  return ok({});
};
(dom.window as unknown as { fetch: unknown }).fetch = fakeFetch;
g.fetch = fakeFetch;

/** The screen opens an SSE stream; a stub keeps the watchdog quiet. */
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = 1;
  onmessage: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {}
  close() { this.readyState = 2; }
  addEventListener() {}
  removeEventListener() {}
}
(dom.window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
g.EventSource = FakeEventSource;

async function main() {
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const StationApp = (await import("../src/components/rms/StationApp")).default;

  let failures = 0;
  const pass = (name: string, cond: boolean, extra = "") => {
    console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
    if (!cond) failures++;
  };

  const host = dom.window.document.getElementById("root")!;
  const text = () => (host.textContent || "").replace(/\s+/g, " ");
  const buttons = () => [...host.querySelectorAll("button")];
  const buttonByText = (needle: string) => buttons().find((b) => (b.textContent || "").includes(needle)) ?? null;
  /** A DATE button reads exactly as its label (the tile also says "Today"). */
  const dateButton = (label: string) =>
    buttons().find((b) => (b.textContent || "").replace(/\s+/g, " ").trim() === label) ?? null;
  /** A PILE tab reads as its label followed by its own unit count. */
  const modeButton = (label: string) =>
    buttons().find((b) => (b.textContent || "").replace(/\s+/g, " ").trim().startsWith(label)) ?? null;

  const flush = async (ms = 40) => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  };
  const click = async (el: Element | null) => {
    if (!el) throw new Error("nothing to click");
    await act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flush();
  };

  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(StationApp, { station: STATION }));
  });
  await flush();

  /* ── 1. the live screen: the tile already knows today ───────────────────── */
  pass("the crew is logged in and sees the live list", text().includes("TABLE 4") && text().includes("Kitfo"));
  const tile = buttonByText("Items sold");
  pass("the 'Items sold' tile is a button the crew can open", !!tile);
  // Today: 2 Kitfo + 1 Firfir accepted, 3 Pastry finished = 6 units combined.
  pass("the tile carries today's own unit count before anyone opens it", (tile?.textContent || "").includes("6"), tile?.textContent || "");
  pass("the tile says which day that number is", /Today/.test(tile?.textContent || ""));

  /* ── 2. opening the tab: real figures, per category ─────────────────────── */
  calls.length = 0;
  await click(tile);
  pass("opening the tab asks the server for today's figures", calls.some((c) => c.startsWith("/api/station-sales?period=today")), calls.join(" "));
  pass("the panel shows the person whose sales these are", text().includes(`Items sold • ${COOK}`));
  pass("the panel shows the units and the money (never a bare 0)", text().includes("6") && text().includes("ETB"));
  pass("the panel does NOT read '0 items • 0 ETB' on a day that had work", !/0 items • 0 ETB/.test(text()));
  pass("the figures are grouped by menu category", text().includes("Foods") && text().includes("Pastries"));
  pass("each category carries its items and their quantities", text().includes("Kitfo") && text().includes("Firfir") && text().includes("Pastry") && /×2/.test(text()));
  pass("the money is the real price × quantity of what was counted (2 Kitfo + 1 Firfir + 3 Pastry)",
    text().includes("1,090 ETB"), text().slice(0, 400));
  pass("a cancelled order and a removed line are not in the pile", !text().includes("Pizza") && !text().includes("Soup"));
  pass("the panel names how many bills the figures came from", text().includes("2 bill(s)"), text().slice(0, 300));
  pass("the panel prints the dates it covers", /Covers:/.test(text()));
  pass("the five date buttons are there", ["Today", "Yesterday", "Day Before Yesterday", "Last 7 Days", "Last 30 Days"].every((l) => !!dateButton(l)));
  pass("the three pile tabs are there", ["Accepted", "Done", "Combined"].every((l) => !!modeButton(l)));
  pass("the counting rule is explained to the crew", /Combined every line you touched, counted once/.test(text()));

  /* ── 3. the three tabs: accepted / done / combined ──────────────────────── */
  calls.length = 0;
  await click(modeButton("Accepted"));
  pass("the Accepted tab counts the lines the cook accepted today (2 Kitfo + 1 Firfir = 3)",
    text().includes("3") && !text().includes("Pastry"), text().slice(0, 300));
  pass("switching a pile needs no new request", calls.filter((c) => c.startsWith("/api/station-sales")).length === 0, calls.join(" "));
  await click(modeButton("Done"));
  pass("the Done tab counts what the cook finished today (2 Kitfo + 3 Pastry = 5)",
    text().includes("5") && text().includes("Pastries") && !text().includes("Firfir"), text().slice(0, 300));
  await click(modeButton("Combined"));
  pass("Combined is the union of both, each line counted once (6 units, 3 lines)",
    text().includes("6") && text().includes("Firfir") && text().includes("Pastry"), text().slice(0, 300));

  /* ── 4. the date buttons ────────────────────────────────────────────────── */
  calls.length = 0;
  await click(dateButton("Yesterday"));
  pass("tapping Yesterday re-fetches that period", calls.some((c) => c.startsWith("/api/station-sales?period=yesterday")), calls.join(" "));
  pass("yesterday shows its own figures (1 Kitfo, not today's six)", text().includes("320 ETB") && !text().includes("Firfir"), text().slice(0, 300));
  calls.length = 0;
  await click(dateButton("Last 7 Days"));
  pass("tapping Last 7 Days re-fetches the rolling window", calls.some((c) => c.startsWith("/api/station-sales?period=week")), calls.join(" "));
  pass("the rolling window includes TODAY as well as the days before it",
    text().includes("Firfir") && text().includes("Burger"), text().slice(0, 300));
  await click(dateButton("Day Before Yesterday"));
  pass("the day before yesterday is its own single day", text().includes("Burger") && !text().includes("Firfir"), text().slice(0, 300));
  await click(dateButton("Today"));
  pass("back to today, the figures return", text().includes("Firfir") && text().includes("6"));

  /* ── 5. the crew's own language (English ⇄ አማርኛ on the same panel) ──────── */
  {
    const { setStaffLang } = await import("../src/lib/staff-i18n");
    await act(async () => {
      setStaffLang("am");
    });
    await flush();
    pass("a device that chose Amharic reads the whole panel in Amharic",
      text().includes("የተሸጡ እቃዎች") && text().includes("ዛሬ") && text().includes("በጋራ"), text().slice(0, 300));
    pass("the counting rule is explained in Amharic too", /አንድ ጊዜ ብቻ ይቆጥራል/.test(text()));
    pass("money keeps its Latin digits and its ETB in Amharic", /1,090 ETB/.test(text()));
    pass("menu data (item and category names) is never machine-translated",
      text().includes("Kitfo") && text().includes("Foods"));
    await act(async () => {
      setStaffLang("en");
    });
    await flush();
    pass("switching back gives English again", text().includes("Items sold") && text().includes("Combined"));
  }

  /* ── 6. failures are explained, never shown as zeros ────────────────────── */
  salesFails = true;
  calls.length = 0;
  await click(dateButton("Yesterday"));
  pass("a failed load tells the crew to refresh instead of showing an empty pile",
    /Could not load your sales/.test(text()), text().slice(0, 300));
  salesFails = false;
  await click(dateButton("Yesterday"));
  pass("refreshing after a failure brings the figures back", text().includes("320 ETB"));

  sessionDead = true;
  await click(dateButton("Day Before Yesterday"));
  pass("an expired session closes the panel and returns to the login screen",
    /Login/i.test(text()) && !/Items sold •/.test(text()), text().slice(0, 200));

  await act(async () => {
    root.unmount();
  });

  if (failures > 0) {
    console.error(`\n❌ ${failures} station-sales UI check(s) failed`);
    process.exit(1);
  }
  console.log("\n✅ station sales UI checks passed");
}

void main();
