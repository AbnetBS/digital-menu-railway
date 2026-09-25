#!/usr/bin/env tsx
/**
 * Render-level test for the SHIFT REPORT panel (owner, Sept 2026), on a real
 * mounted component with the server answer built by the real
 * buildShiftReport():
 *
 *   1. The header (title, explanation, SHIFT / ROLE / DATE filters) is NOT
 *      sticky: it scrolls away with the list, and a small floating X shows up
 *      once it is gone, so closing is always one tap away.
 *   2. Tapping an order opens its details in a popup rendered into <body>,
 *      centred on the visible screen; the list behind is frozen (no scroll,
 *      no jump), and X / backdrop / Esc close it, landing on the same spot
 *      with focus back on the card.
 *   3. A waiter's own order shows "Sent by yeshi" instead of "ACCEPTED BY
 *      n/a", and "Legacy ... backfill" never reaches the screen.
 *   4. Print: a black-on-white sheet with the letterhead, the selection and
 *      its real dates, printed time, Totals per person (+ shift totals), the
 *      Need a look orders with their tags, the opened person's orders, and
 *      the Prepared by / Checked by lines; only that sheet prints.
 *   5. English ⇄ አማርኛ: the switch changes every fixed label, keeps names,
 *      order numbers, prices and "ETB", and is remembered on the device.
 *
 * Run with: npx tsx scripts/verify-shift-report-ui.tsx   (wired into `npm test`)
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html lang='en'><body><div id='root'></div></body></html>", {
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
g.CustomEvent = dom.window.CustomEvent;
g.MouseEvent = dom.window.MouseEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.localStorage = dom.window.localStorage;
g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.IS_REACT_ACT_ENVIRONMENT = true;

let printCalls = 0;
(dom.window as unknown as { print: () => void }).print = () => {
  printCalls++;
};

async function main() {
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { buildShiftReport } = await import("../src/lib/shift-report");
  const { etDayKey } = await import("../src/lib/timezone");
  const ShiftReport = (await import("../src/components/rms/ShiftReport")).default;
  type Row = Parameters<typeof buildShiftReport>[0];

  /* ── fixtures: a normal day, plus yeshi's own order (Table 8 #FANA-2431) ── */
  const at = (hhmm: string) => new Date(`${new Date().toISOString().slice(0, 10)}T${hhmm}:00+03:00`);
  const day = etDayKey(at("10:00"))!;
  const T = (id: number, o: Partial<Row["tickets"][number]>): Row["tickets"][number] => ({
    id, tableName: `Table ${id}`, orderNumber: `FANA-${2420 + id}`, orderType: "dine_in", status: "printed",
    totalAmount: 1250, serviceNote: null, createdBy: null, confirmedBy: null, confirmedAt: null,
    printedBy: null, printedAt: null, closedBy: null, closedAt: null, verifiedBy: null, verifiedAt: null,
    createdAt: at("09:00"), ...o,
  });
  const tickets = [
    T(1, { confirmedBy: "Abel", confirmedAt: at("09:10"), printedBy: "Sara", printedAt: at("09:20") }),
    T(3, { confirmedBy: "Abel", confirmedAt: at("13:55"), closedBy: "Alem", closedAt: at("15:30"), status: "closed", printedBy: "Sara", printedAt: at("13:58") }),
    T(5, { confirmedBy: "Alem", confirmedAt: at("17:00") }), // never printed → Need a look
    T(8, { tableName: "Table 8", orderNumber: "FANA-2431", createdBy: "yeshi", printedBy: "Sara", printedAt: at("10:05"), totalAmount: 480 }),
  ];
  const items = [8, 1, 3, 5].map((ticketId, i) => ({
    id: 100 + i, ticketId, name: i === 0 ? "Macchiato" : `Item ${i}`, price: 240, quantity: 2, notes: null, removed: false,
    stationName: "barista", stationStatus: "done", stationStatusBy: null, stationStatusAt: null,
    stationAcceptedBy: null, stationAcceptedAt: null, stationDoneBy: "Mitke", stationDoneAt: at("10:03"), createdAt: at("10:00"),
  }));
  const events: Row["events"] = [
    { ticketId: 8, eventType: "ticket_created", actorName: "yeshi", actorRole: "waiter", toValue: null, details: "New staff order created", createdAt: at("10:00") },
    { ticketId: 8, eventType: "ticket_sent", actorName: "yeshi", actorRole: "waiter", toValue: null, details: "Waiter sent a new order to the stations", createdAt: at("10:00") },
    { ticketId: 8, eventType: "status_changed", actorName: "Sara", actorRole: "cashier", toValue: "printed", details: "Legacy print backfill", createdAt: at("10:05") },
  ];
  const submissions: Row["submissions"] = [{ ticketId: 8, source: "staff", waiterName: "yeshi", lines: 1, createdAt: at("10:00") }];
  const staffRoles = { Abel: "waiter", Alem: "waiter", yeshi: "waiter", Sara: "cashier", Mitke: "barista" };

  const calls: string[] = [];
  const fakeFetch = async (url: string) => {
    const u = String(url);
    calls.push(u);
    const q = new URL(u, "https://fana.test").searchParams;
    const role = (q.get("role") || "waiter") as Row["role"];
    const date = (q.get("date") || "today") as Row["date"];
    const report = buildShiftReport({ role, date, dayKeys: [day], tickets, items, events, submissions, staffRoles });
    const body = { ...report, dayKeys: [day], staff: [] };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  };
  (dom.window as unknown as { fetch: unknown }).fetch = fakeFetch;
  g.fetch = fakeFetch;

  let failures = 0;
  const pass = (name: string, cond: boolean, extra = "") => {
    console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
    if (!cond) failures++;
  };
  const doc = dom.window.document;
  const $ = <E extends Element = HTMLElement>(sel: string) => doc.querySelector(sel) as E | null;
  const squash = (s: string | null | undefined) => String(s || "").replace(/\s+/g, " ").trim();
  const flush = async (ms = 30) => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  };
  const click = async (el: Element | null | undefined) => {
    if (!el) throw new Error("nothing to click");
    await act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  };
  const key = async (k: string) => {
    await act(async () => {
      doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true }));
    });
  };
  const buttonWith = (scope: ParentNode, re: RegExp) =>
    [...scope.querySelectorAll("button")].find((b) => re.test(squash(b.textContent))) ?? null;

  let closed = 0;
  const host = doc.getElementById("root")!;
  const root = createRoot(host);
  doc.body.style.overflow = "";
  await act(async () => {
    root.render(React.createElement(ShiftReport, { onClose: () => closed++, logoUrl: "/brand-logo.png" }));
  });
  await flush();

  const panel = $('[data-shift-report="panel"]')!;
  const header = $('[data-shift-report="header"]')!;
  const scroller = $(".shift-report-scroller")!;
  pass("the panel and its data load", !!panel && !!header && calls.includes("/api/reports/shifts?role=waiter&date=today"));

  /* ── 1. the header scrolls away; a small X stays reachable ──────────────── */
  pass("the header is NOT sticky or fixed", !/\b(sticky|fixed)\b/.test(header.className), header.className);
  pass("the header scrolls WITH the list (it is inside the scrolling layer)", scroller.contains(header));
  pass("nothing inside the panel is pinned", panel.querySelectorAll(".sticky, [class*='sticky']").length === 0);
  pass("the dark backdrop itself does not scroll (only the inner layer does)", !/overflow-y-auto/.test(panel.className) && /overflow-y-auto/.test(scroller.className));
  pass("the header keeps its own close X", !!header.querySelector('[aria-label="Close shift report"]'));
  pass("no floating X while the header is on screen", !$('[data-shift-report="floating-close"]'));
  Object.defineProperty(scroller, "scrollTop", { value: 640, writable: true, configurable: true });
  await act(async () => {
    scroller.dispatchEvent(new dom.window.Event("scroll"));
  });
  const floating = $('[data-shift-report="floating-close"]');
  pass("after scrolling down a small floating X appears", !!floating && floating.getAttribute("aria-label") === "Close shift report");
  pass("the floating X sits outside the scrolling layer (always visible)", !!floating && !scroller.contains(floating) && panel.contains(floating));
  await click(floating);
  pass("the floating X closes the panel", closed === 1);

  /* ── 2 + 3. the order popup ─────────────────────────────────────────────── */
  await click(buttonWith(panel, /^\d+\.\s*yeshi/));
  const card8 = $('[data-shift-order="8"]')!;
  pass("opening yeshi's list shows Table 8", !!card8 && /Table 8/.test(card8.textContent || ""));
  pass("the card names the order number", /#FANA-2431/.test(card8.textContent || ""));
  await click(card8);
  const popup = $('[data-shift-report="order-popup"]');
  const backdrop = $('[data-shift-report="order-backdrop"]');
  pass("tapping the card opens the details popup", !!popup && popup.getAttribute("role") === "dialog" && popup.getAttribute("aria-modal") === "true");
  pass("the popup is rendered into <body>, outside the scrolling list", !!backdrop && backdrop.parentElement === doc.body && !panel.contains(backdrop));
  pass(
    "the popup is centred on the visible screen",
    !!backdrop && ["fixed", "inset-0", "flex", "items-center", "justify-center"].every((c) => backdrop.classList.contains(c))
  );
  pass("a long popup scrolls inside itself (max 90% of the screen)", !!popup && popup.classList.contains("overflow-y-auto") && popup.classList.contains("shift-popup-card") && /\.shift-popup-card\s*\{\s*max-height:\s*90vh;\s*max-height:\s*90dvh;/.test(doc.head.textContent + (panel.querySelector("style")?.textContent || "")));
  pass("the list behind is frozen while the popup is open", scroller.style.overflow === "hidden");
  pass("the page behind the panel never scrolls", doc.body.style.overflow === "hidden");
  const ptext = squash(popup?.textContent);
  pass("a waiter's own order says Sent by yeshi (not ACCEPTED BY n/a)", /Sent by\s*yeshi/.test(ptext) && !/Accepted by\s*n\/a/i.test(ptext), ptext.slice(0, 300));
  pass("the popup keeps Table 8, #FANA-2431 and the ETB total", /Table 8/.test(ptext) && /#FANA-2431/.test(ptext) && /480 ETB/.test(ptext));
  pass("\"Legacy ... backfill\" is not shown, plain words instead", !/legacy|backfill/i.test(ptext) && /Printed \(EFD\)/.test(ptext), ptext);
  pass("focus moves into the popup (its close button)", doc.activeElement === popup?.querySelector('[data-shift-report="order-close"]'));
  await click(popup?.querySelector("p"));
  pass("a tap INSIDE the popup does not close it", !!$('[data-shift-report="order-popup"]'));
  await click(backdrop);
  await flush();
  pass("a tap on the dark backdrop closes it", !$('[data-shift-report="order-popup"]'));
  pass("the list is scrollable again, at the SAME place", scroller.style.overflow === "" && scroller.scrollTop === 640);
  pass("focus returns to the card that opened it", doc.activeElement === $('[data-shift-order="8"]'));
  await click($('[data-shift-order="8"]'));
  await key("Escape");
  pass("Esc closes the popup first (the panel stays open)", !$('[data-shift-report="order-popup"]') && closed === 1);
  await click($('[data-shift-order="8"]'));
  await click($('[data-shift-report="order-close"]'));
  pass("the popup's X closes it", !$('[data-shift-report="order-popup"]'));
  await key("Escape");
  pass("Esc with no popup closes the panel", closed === 2);

  /* ── 4. print ───────────────────────────────────────────────────────────── */
  const sheet = () => doc.getElementById("fana-shift-print");
  const stext = () => squash(sheet()?.textContent);
  const css = panel.querySelector("style")?.textContent || "";
  pass("the print sheet is a direct child of <body>", sheet()?.parentElement === doc.body);
  pass("while the panel is open, print shows ONLY the sheet", doc.documentElement.classList.contains("fana-shift-open") && /@media print/.test(css) && css.includes("html.fana-shift-open body > *:not(#fana-shift-print) { display: none !important; }"));
  pass("the sheet is hidden on screen", /\.shift-print-sheet \{ display: none; \}/.test(css) && !!sheet()?.classList.contains("print-only"));
  pass("long lists continue across pages (table headers repeat, rows never split)", /thead \{ display: table-header-group; \}/.test(css) && /break-inside: avoid/.test(css));
  pass("black on white on paper", /color: #000 !important/.test(css) && /background: #fff !important/.test(css));
  pass("letterhead: logo + cafe name in English and Amharic", sheet()?.querySelector("img")?.getAttribute("src") === "/brand-logo.png" && /Fana Cafe and Restaurant PLC/.test(stext()) && /ፋና ካፌ እና ሬስቶራንት/.test(stext()));
  pass("the selection is printed (shift, role, date)", /Shift Report \(Waiter\)/.test(stext()) && /Shift: All • Role: Waiter • Date: Today/.test(stext()));
  pass("the real dates covered and the printed time", /Days covered: \d{2} \w{3} \d{4}/.test(stext()) && /Printed: \S+/.test(stext()));
  const heads = [...(sheet()?.querySelectorAll("table")[0]?.querySelectorAll("th") || [])].map((th) => squash(th.textContent));
  pass("Totals per person table (Name, Role, Shift, Orders, Total)", /Totals per person/.test(stext()) && heads.join("|") === "#|Name|Role|Shift|Orders|Total", heads.join("|"));
  const firstRow = [...(sheet()?.querySelectorAll("table")[0]?.querySelectorAll("tbody tr")[0]?.querySelectorAll("td") || [])].map((td) => squash(td.textContent));
  pass("one line per person per shift: Abel • Waiter • Morning • 2 • 2,500 ETB", firstRow.join("|") === "1|Abel|Waiter|Morning|2|2,500 ETB", firstRow.join("|"));
  pass("a total per shift", /Morning total/.test(stext()) && /Afternoon total/.test(stext()) && /Combined total/.test(stext()));
  pass("Need a look orders with their warning tags", /Need a look \(\d+\)/.test(stext()) && /Table 5 • #FANA-2425/.test(stext()) && /⚠ Never printed \(not on the EFD\)/.test(stext()), stext().slice(stext().indexOf("Need a look ("), stext().indexOf("Need a look (") + 400));
  pass("Prepared by and Checked by sign lines", /Prepared by: \.+/.test(stext()) && /Checked by: \.+/.test(stext()) && /Name and signature/.test(stext()));
  pass("no buttons on the paper", (sheet()?.querySelectorAll("button, select, input").length || 0) === 0);
  pass("the opened person's orders are printed", /Orders of yeshi • Morning/.test(stext()) && /Table 8 • #FANA-2431/.test(stext()) && /Sent by yeshi/.test(stext()));
  await click(buttonWith(header, /^Print$/));
  pass("the Print button opens the browser print", printCalls === 1);
  await click(buttonWith(header, /^Afternoon$/));
  pass("the paper follows the selected shift", /Shift: Afternoon/.test(stext()) && !/Morning total/.test(stext()) && /Afternoon total/.test(stext()));
  pass("a closed person list (other shift) is not printed", !/Orders of yeshi/.test(stext()));
  await click(buttonWith(header, /^All$/));

  /* ── 5. English ⇄ አማርኛ ─────────────────────────────────────────────────── */
  const toggle = $("[data-staff-lang-toggle]");
  pass("the language switch is in the header", !!toggle && header.contains(toggle) && /አማርኛ/.test(toggle.textContent || ""));
  await click(toggle);
  await flush();
  const amText = squash(panel.textContent);
  pass("the choice is saved on this device", dom.window.localStorage.getItem("fana_staff_lang") === "am");
  pass("<html lang> follows the staff language", doc.documentElement.lang === "am");
  pass("title and filters switch to Amharic", /የፈረቃ ሪፖርት/.test(amText) && /ሁሉም/.test(amText) && /ጠዋት/.test(amText) && /ከሰዓት/.test(amText) && /የጋራ/.test(amText) && /ዛሬ/.test(amText));
  const englishLeft = ["Shift Report", "Morning", "Afternoon", "Combined", "Need a look", "Totals per person", "Accepted by", "Total", "Print", "Orders", "Today", "Yesterday", "Waiter", "Refresh"].filter((w) =>
    new RegExp(`\\b${w}\\b`).test(amText.replace(/Table \d+/g, ""))
  );
  pass("no English fixed label is left in Amharic mode", englishLeft.length === 0, englishLeft.join(", "));
  pass("names, table names and ETB stay as they are", /yeshi/.test(amText) && /Table 8/.test(amText) && /ETB/.test(amText) && !/ብር/.test(amText));
  pass("the button now offers English", /English/.test($("[data-staff-lang-toggle]")?.textContent || ""));
  await click($('[data-shift-order="8"]'));
  const amPopup = squash($('[data-shift-report="order-popup"]')?.textContent);
  pass("the popup reads Amharic: የላከው yeshi, #FANA-2431, 480 ETB", /የላከው/.test(amPopup) && /yeshi/.test(amPopup) && /#FANA-2431/.test(amPopup) && /480 ETB/.test(amPopup), amPopup.slice(0, 300));
  pass("the popup timeline is Amharic too", /ታትሟል \(EFD\)/.test(amPopup) && /ትዕዛዝ ተፈጥሯል|አዲስ የሰራተኛ ትዕዛዝ ተፈጥሯል/.test(amPopup), amPopup);
  await key("Escape");
  pass("the warning tag is Amharic", /አልታተመም \(EFD ላይ የለም\)/.test(stext()));
  pass("the paper prints in Amharic with the same letterhead", /ያዘጋጀው/.test(stext()) && /ያረጋገጠው/.test(stext()) && /Fana Cafe and Restaurant PLC/.test(stext()) && /የእያንዳንዱ ሰው ድምር/.test(stext()));
  await click($("[data-staff-lang-toggle]"));
  await flush();
  pass("switching back gives English again", /Shift Report/.test(squash(panel.textContent)) && dom.window.localStorage.getItem("fana_staff_lang") === "en" && doc.documentElement.lang === "en");
  pass("no em-dash anywhere on screen or paper", !/—/.test(doc.body.textContent || ""));

  await act(async () => root.unmount());
  pass("closing the panel releases the page (scroll and print go back to normal)", !doc.documentElement.classList.contains("fana-shift-open") && doc.body.style.overflow === "" && !sheet());

  console.log(failures === 0 ? "\n✅ Shift Report UI test PASSED" : `\n❌ ${failures} Shift Report UI assertions FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
