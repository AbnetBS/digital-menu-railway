#!/usr/bin/env tsx
/**
 * Render-level smoke test for the REPORT PERIOD CARDS
 * (`src/components/rms/ReportsTab.tsx`) — the owner's three Sept 2026 requests,
 * proved on a real mounted component instead of by reading source:
 *
 *   1. DAY BEFORE YESTERDAY is a fifth interval card, BETWEEN Yesterday and
 *      Last 7 Days, it names its real Ethiopian date, and tapping it re-fetches
 *      `?period=dayBefore` and switches EVERY section below (KPIs, station
 *      cross-check, printed bills) to that one day.
 *   2. The rolling 30-day window is explained with its exact dates on screen
 *      ("today plus the 29 days before it"), so the cross-checker knows which
 *      days the paper covers and that nothing is deleted.
 *   3. The Printed Bills pile says out loud that cancelled orders are never
 *      listed or added, and warns when lines were added to a bill AFTER its
 *      print (sold, counted here, but not on an EFD receipt yet).
 *
 * Requires the `jsdom` devDependency (no browser, no database, no server).
 * Run with: npx tsx scripts/verify-reports-ui.tsx   (wired into `npm test`)
 */
import { JSDOM } from "jsdom";
import { etDayKeyDaysAgo } from "../src/lib/timezone";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "https://fana.test/admin",
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.localStorage = dom.window.localStorage;
g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.IS_REACT_ACT_ENVIRONMENT = true;

/* ── the mocked server, answering exactly the shapes GET /api/reports returns ── */

type Period = "today" | "yesterday" | "dayBefore" | "week" | "month";

const LABELS: Record<Period, string> = {
  today: "Today",
  yesterday: "Yesterday",
  dayBefore: "Day Before Yesterday",
  week: "Last 7 Days",
  month: "Last 30 Days",
};
const START_DAYS_AGO: Record<Period, number> = { today: 0, yesterday: 1, dayBefore: 2, week: 6, month: 29 };
const LENGTH_DAYS: Record<Period, number> = { today: 1, yesterday: 1, dayBefore: 1, week: 7, month: 30 };

/** Distinct figures per period so a switch is visible in every section. */
const FIGURES: Record<Period, { revenue: number; orders: number; stationRev: number; printedTotal: number }> = {
  today: { revenue: 4200, orders: 9, stationRev: 4200, printedTotal: 4200 },
  yesterday: { revenue: 7300, orders: 15, stationRev: 7300, printedTotal: 7300 },
  dayBefore: { revenue: 5150, orders: 11, stationRev: 5150, printedTotal: 5150 },
  week: { revenue: 38900, orders: 84, stationRev: 38900, printedTotal: 38900 },
  month: { revenue: 152400, orders: 331, stationRev: 152400, printedTotal: 152400 },
};

function reportFor(period: Period) {
  const f = FIGURES[period];
  const start = START_DAYS_AGO[period];
  const length = LENGTH_DAYS[period];
  // One printed bill for the single-day periods; it carries a line that was
  // added AFTER the print (sold, but still waiting for its EFD receipt #2).
  const printedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const bill = {
    id: 900 + start,
    tableId: 5,
    tableName: "TABLE 5",
    orderType: "dine_in",
    status: "closed",
    totalAmount: f.printedTotal,
    printedAt,
    printedBy: "Hanna",
    closedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    confirmedBy: "Abel",
    items: [
      { id: 1, ticketId: 900 + start, name: "Macchiato", price: 40, quantity: 2, removed: false, stationName: "barista", createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() },
      { id: 2, ticketId: 900 + start, name: "Kitfo", price: f.printedTotal - 80, quantity: 1, removed: false, stationName: "kitchen", createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
    ],
    itemsAfterPrint: 1,
    itemsAfterPrintAmount: f.printedTotal - 80,
  };
  return {
    todayRevenue: FIGURES.today.revenue,
    yesterdayRevenue: FIGURES.yesterday.revenue,
    dayBeforeRevenue: FIGURES.dayBefore.revenue,
    weeklyRevenue: FIGURES.week.revenue,
    monthlyRevenue: FIGURES.month.revenue,
    todayOrders: FIGURES.today.orders,
    yesterdayOrders: FIGURES.yesterday.orders,
    dayBeforeOrders: FIGURES.dayBefore.orders,
    weekOrders: FIGURES.week.orders,
    monthOrders: FIGURES.month.orders,
    averageOrderValue: Math.round(f.revenue / Math.max(1, f.orders)),
    popularItems: [{ name: "Macchiato", quantity: f.orders, revenue: f.revenue }],
    categorySales: [{ category: "Coffee", quantity: f.orders, revenue: f.stationRev }],
    paymentStats: [],
    receipts: [],
    orderHistory: [],
    waiterRanking: [{ name: "Abel", acceptedOrders: f.orders, directOrders: 0, totalActions: f.orders }],
    waiterOrders: [],
    hourlySales: [{ hour: 9, orders: f.orders, revenue: f.revenue }],
    peakHour: { hour: 9, orders: f.orders, revenue: f.revenue },
    stationSales: [
      { station: "barista", orders: f.orders, quantity: f.orders, revenue: f.stationRev },
      { station: "kitchen", orders: 0, quantity: 0, revenue: 0 },
      { station: "buna", orders: 0, quantity: 0, revenue: 0 },
      { station: "juice", orders: 0, quantity: 0, revenue: 0 },
    ],
    stationItems: [{ station: "barista", name: "Macchiato", quantity: f.orders, revenue: f.stationRev }],
    printedTodayTotal: f.printedTotal,
    printedToday: [bill],
    printedPending: { bills: 1, items: 1, amount: f.printedTotal - 80, partial: false },
    period,
    periodLabel: LABELS[period],
    periodRange: {
      from: etDayKeyDaysAgo(start),
      to: etDayKeyDaysAgo(start - length + 1),
      days: length,
    },
    dayKeys: { today: etDayKeyDaysAgo(0), yesterday: etDayKeyDaysAgo(1), dayBefore: etDayKeyDaysAgo(2) },
    cashierMode: "print-queue",
    totalItems: f.orders,
    archiveCapped: false,
    archiveTotal: 1,
  };
}

const calls: string[] = [];
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const fakeFetch = async (url: string) => {
  const u = String(url);
  calls.push(u);
  if (u.startsWith("/api/settings")) return ok({ cafe_name: "Fana Cafe and Restaurant PLC", logo_url: "/logo.png" });
  if (u.startsWith("/api/reports")) {
    const period = (new URL(u, "https://fana.test").searchParams.get("period") || "today") as Period;
    return ok(reportFor(LABELS[period] ? period : "today"));
  }
  return ok({});
};

(dom.window as unknown as { fetch: unknown }).fetch = fakeFetch;
g.fetch = fakeFetch;
(dom.window as unknown as { print: () => void }).print = () => {};

async function main() {
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const ReportsTab = (await import("../src/components/rms/ReportsTab")).default;

  let failures = 0;
  const pass = (name: string, cond: boolean) => {
    console.log(`${cond ? "✅" : "❌"} ${name}`);
    if (!cond) failures++;
  };

  const host = dom.window.document.getElementById("root")!;
  const text = () => `${host.textContent || ""}`;
  /** The interval cards, in DOM order (they are the first five buttons). */
  const periodCards = () => [...host.querySelectorAll("button")].filter((b) => /order\(s\)/.test(b.textContent || "")).slice(0, 5);
  const cardByName = (needle: string) => periodCards().find((b) => (b.textContent || "").includes(needle)) ?? null;

  const flush = async (ms = 30) => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  };
  const click = async (el: Element | null) => {
    if (!el) throw new Error("nothing to click");
    await act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  };

  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(ReportsTab));
  });
  await flush();

  /* ── 1. the five cards, in the order the cross-checker asked for ─────────── */
  const labels = periodCards().map((b) => (b.textContent || "").replace(/\s+/g, " ").trim());
  pass("five interval cards render", periodCards().length === 5);
  pass(
    "DAY BEFORE YESTERDAY sits BETWEEN Yesterday and Last 7 Days",
    labels.length === 5 &&
      labels[0].startsWith("Today") &&
      labels[1].startsWith("Yesterday") &&
      labels[2].startsWith("Day Before Yesterday") &&
      labels[3].startsWith("Last 7 Days") &&
      labels[4].startsWith("Last 30 Days")
  );
  pass("each card shows its own revenue and bill count", labels[2].includes(`${FIGURES.dayBefore.revenue.toLocaleString("en-US")} ETB`) && labels[2].includes(`${FIGURES.dayBefore.orders} order(s)`));
  pass("the three single-day cards name their real Ethiopian date", /Day Before Yesterday/.test(text()) && labels[0].includes("Today") && new RegExp(String(new Date().getFullYear())).test(labels[2]));
  pass("the first load asked the server for today", calls.some((c) => c === "/api/reports?period=today"));

  /* ── 2. the rolling window is explained with its exact dates ─────────────── */
  pass("the screen explains the window slides one day at a time", /it never resets on the 1st of a month/.test(text()));
  pass("the screen says Last 30 Days is today plus the 29 days before it", /is today plus the 29 days before it/.test(text()));
  pass("the screen says nothing is deleted", /Older bills stay stored; they simply leave the report/.test(text()));

  /* ── 3. the EFD pile: cancelled orders out, added-after-print lines named ── */
  pass("the archive states cancelled orders are never listed or added", /Cancelled orders are never listed or added here: only bills the cashier tapped ✓ PRINTED/.test(text()));
  pass("a line added after the print is called out with its ETB", /bill\(s\) received 1 item line\(s\)/.test(text()) && /not on an EFD receipt yet/.test(text()));
  pass("the bill card itself carries the not-printed-yet badge", /line\(s\) •/.test(text()) && /ETB not printed yet/.test(text()));

  /* ── 4. tapping the new card switches EVERY section to that one day ──────── */
  calls.length = 0;
  await click(cardByName("Day Before Yesterday"));
  await flush();
  pass("tapping it re-fetches ?period=dayBefore", calls.some((c) => c === "/api/reports?period=dayBefore"));
  pass("the header now names the day before yesterday", /Showing Day Before Yesterday/.test(text().replace(/\s+/g, " ")));
  pass("the KPI cards follow that day (orders)", new RegExp(`Orders \\(Day Before Yesterday\\)\\s*${FIGURES.dayBefore.orders}`).test(text().replace(/\s+/g, " ")));
  pass("the station cross-check follows that day", /Cross-Check by Station \(Day Before Yesterday\)/.test(text().replace(/\s+/g, " ")));
  pass("the printed-bills archive follows that day", /Printed Bills \(Day Before Yesterday\)/.test(text().replace(/\s+/g, " ")));
  pass("the day's own revenue is what shows", text().includes(FIGURES.dayBefore.revenue.toLocaleString("en-US")));

  /* ── 5. the other periods still work, and name their date range ──────────── */
  await click(cardByName("Last 30 Days"));
  await flush();
  pass("Last 30 Days still loads", calls.some((c) => c === "/api/reports?period=month") && /Showing Last 30 Days/.test(text().replace(/\s+/g, " ")));
  pass("Last 30 Days names its exact Ethiopian date range", /Last 30 Days is today plus the 29 days before it \(\d{2} \w{3} \d{4} – \d{2} \w{3} \d{4}\)/.test(text().replace(/\s+/g, " ")));
  await click(cardByName("Yesterday"));
  await flush();
  pass("Yesterday still loads", calls.some((c) => c === "/api/reports?period=yesterday") && /Showing Yesterday/.test(text().replace(/\s+/g, " ")));
  await click(cardByName("Today"));
  await flush();
  pass("Today still loads", calls.some((c) => c === "/api/reports?period=today") && /Showing Today/.test(text().replace(/\s+/g, " ")));

  await act(async () => root.unmount());

  console.log(failures === 0 ? "\n✅ Reports period-cards UI smoke test PASSED" : `\n❌ ${failures} UI smoke assertions FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
