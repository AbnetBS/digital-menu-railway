#!/usr/bin/env tsx
/**
 * Render-level smoke test for the guest's live order status UI
 * (`src/components/rms/OrderStatus.tsx`) — the one piece of Group 8 that static
 * source inspection cannot prove: it is brand-new React that a real phone will
 * run, so this actually mounts it in jsdom, feeds it the payload shape that
 * `/api/table-status` returns, and CLICKS through the whole flow:
 *
 *   no order → nothing rendered · order appears → pill + banner + progress bar
 *   → panel opens → dishes/notes/states/total → "bring us the bill" → POST with
 *   only the table id → confirmation + review shortcut → callback into the menu
 *   → drinks-only bill shows no progress bar → no table id never polls
 *   → a 500 from the endpoint is swallowed and the next poll recovers.
 *
 * Requires the `jsdom` devDependency (no browser, no database, no server).
 * Run with: npx tsx scripts/verify-order-status-ui.tsx   (wired into `npm test`)
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "https://fana.test/menu?table=5",
  pretendToBeVisual: true,
});

const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
// Node 22 exposes a getter-only global navigator — redefine instead of assign.
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

/** Every network call the component makes, in order. */
const calls: Array<{ url: string; init?: RequestInit }> = [];

/** Exactly the shape `GET/POST /api/table-status` answers with. */
function payload(over: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    tableId: 5,
    ticket: {
      id: 77,
      orderNumber: "A-12",
      status: "open",
      paymentStatus: "unpaid",
      totalAmount: 240,
      createdAt: new Date(now - 12 * 60_000).toISOString(),
      updatedAt: new Date(now - 60_000).toISOString(),
      closedAt: null,
      receiptRequestedAt: null,
      phase: "preparing",
      kitchen: { lines: 2, units: 3, pending: 1, accepted: 1, done: 1, state: "preparing" },
      barista: { lines: 1, units: 2, pending: 2, accepted: 0, done: 0, state: "queued" },
      lines: [
        { name: "Beyaynet", quantity: 2, notes: "", station: "kitchen", stationStatus: "done" },
        { name: "Soup", quantity: 1, notes: "No pepper", station: "kitchen", stationStatus: "pending" },
        { name: "Macchiato", quantity: 2, notes: "", station: "barista", stationStatus: "pending" },
      ],
      ...over,
    },
  };
}

type Mode = "ok" | "served" | "drinks" | "empty" | "fail";
let mode: Mode = "ok";

/** Kitchen finished every food unit → the guest has been served. */
const SERVED = {
  phase: "ready",
  kitchen: { lines: 2, units: 3, pending: 0, accepted: 0, done: 3, state: "ready" },
};

const fakeFetch = async (url: string, init?: RequestInit) => {
  calls.push({ url: String(url), init });
  if (mode === "fail") return { ok: false, status: 500, json: async () => ({}) };
  if (mode === "empty") return { ok: true, status: 200, json: async () => ({ tableId: 5, ticket: null }) };
  if (mode === "drinks") {
    return {
      ok: true,
      status: 200,
      json: async () =>
        payload({
          phase: "drinks_only",
          kitchen: { lines: 0, units: 0, pending: 0, accepted: 0, done: 0, state: "idle" },
          lines: [{ name: "Macchiato", quantity: 2, notes: "", station: "barista", stationStatus: "pending" }],
        }),
    };
  }
  if (mode === "served") {
    return {
      ok: true,
      status: 200,
      json: async () =>
        payload(init?.method === "POST" ? { ...SERVED, receiptRequestedAt: new Date().toISOString() } : SERVED),
    };
  }
  // A POST is the guest asking for the bill → answer with the stamp applied.
  if (init?.method === "POST") {
    return { ok: true, status: 200, json: async () => payload({ receiptRequestedAt: new Date().toISOString() }) };
  }
  return { ok: true, status: 200, json: async () => payload() };
};

(dom.window as unknown as { fetch: unknown }).fetch = fakeFetch;
g.fetch = fakeFetch;

async function main() {
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { OrderStatusProvider, OrderStatusFab, OrderStatusBanner } = await import(
    "../src/components/rms/OrderStatus"
  );
  type Root = ReturnType<typeof createRoot>;

  let failures = 0;
  const pass = (name: string, cond: boolean) => {
    console.log(`${cond ? "✅" : "❌"} ${name}`);
    if (!cond) failures++;
  };

  const host = dom.window.document.getElementById("root")!;
  const text = () => `${host.textContent || ""} ${host.innerHTML || ""}`;
  const byText = (needle: string) =>
    [...host.querySelectorAll("button")].find((b) => (b.textContent || "").includes(needle)) ?? null;

  const flush = async (ms = 20) => {
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

  let reviewOpens = 0;
  /** (Re)mount the pill + banner for one table. */
  const mount = (root: Root, tableId: number, refreshKey: number) =>
    act(async () => {
      root.render(
        React.createElement(
          OrderStatusProvider,
          {
            tableId,
            refreshKey,
            onOpenReview: () => {
              reviewOpens++;
            },
          },
          React.createElement(OrderStatusFab),
          React.createElement(OrderStatusBanner)
        )
      );
    });

  const root = createRoot(host);

  // ── 1. no ticket → nothing is rendered at all ────────────────────────────
  mode = "empty";
  await mount(root, 5, 0);
  await flush();
  pass("no order → no pill and no banner", host.querySelectorAll("button").length === 0);
  pass("GET was scoped to the table", calls.some((c) => c.url === "/api/table-status?table=5"));

  // ── 2. a real bill appears ───────────────────────────────────────────────
  mode = "ok";
  calls.length = 0;
  await mount(root, 5, 1);
  await flush();
  pass("a refreshKey bump refetches immediately (no 12s wait after ordering)", calls.length >= 1);
  pass("the pill appears once the table has an order", /Order Status/.test(text()));
  pass("the banner states the phase in one sentence", /Your food is being prepared/.test(text()));
  pass("the banner shows the order number and arrival time", /#A-12/.test(text()) && /Arrived \d{2}:\d{2}/.test(text()));
  const bar = host.querySelector('span[style*="width"]') as HTMLElement | null;
  pass("the kitchen bar reads 50% (1 done + 1 of 2 cooking, of 3 units)", bar?.style.width === "50%");

  // ── 3. open the panel ────────────────────────────────────────────────────
  await click(byText("Order Status"));
  await flush();
  pass("the panel opens as a dialog", host.querySelector('[role="dialog"]') !== null);
  pass("every dish is listed with its quantity", /Beyaynet/.test(text()) && /×2/.test(text()) && /Soup/.test(text()));
  pass("item notes are shown", /No pepper/.test(text()));
  pass("per-line state is labelled", /Ready/.test(text()) && /Queued/.test(text()));
  pass("drinks are listed with a note but get NO progress bar", /2 drinks\/cake/.test(text()));
  pass("the total is shown", /240 ETB/.test(text()));
  pass("arrival time and waiting minutes are shown", /12 min/.test(text()));
  pass("while the food is still cooking there is NO bill button", byText("Request the bill") === null);
  pass("  …the guest is told when it will appear instead", /as soon as your food has arrived/.test(text()));

  // ── 3b. the kitchen finishes → the button appears ────────────────────────
  mode = "served";
  await mount(root, 5, 6);
  await flush();
  pass("the phase follows the kitchen to 'ready'", /Your food is ready/.test(text()));
  pass("the bill button appears only once the food is served", byText("Request the bill") !== null);
  pass("the 'wait for your food' note is gone", !/as soon as your food has arrived/.test(text()));

  // ── 4. ask for the bill ──────────────────────────────────────────────────
  calls.length = 0;
  await click(byText("Request the bill"));
  await flush();
  pass("a POST went to /api/table-status", calls.some((c) => c.url === "/api/table-status" && c.init?.method === "POST"));
  pass("the POST body carries only the table id", calls.find((c) => c.init?.method === "POST")?.init?.body === JSON.stringify({ table: 5 }));
  pass("the button is replaced by a confirmation", byText("Request the bill") === null && /Bill requested/.test(text()));
  pass("the request time is shown", /Requested at \d{2}:\d{2}/.test(text()));
  pass("the review shortcut appears once the bill was requested", byText("Rate your visit") !== null);

  // ── 5. review shortcut ───────────────────────────────────────────────────
  await click(byText("Rate your visit"));
  await flush();
  pass("the review shortcut calls back into the menu", reviewOpens === 1);
  pass("the panel closes again", host.querySelector('[role="dialog"]') === null);

  // ── 6. drinks-only bill: pill yes, progress bar no ───────────────────────
  mode = "drinks";
  await mount(root, 5, 2);
  await flush();
  pass("a drinks-only bill still shows the pill", /Order Status/.test(text()));
  await click(byText("Order Status"));
  await flush();
  pass("  …and offers the bill straight away (there is nothing to cook)", byText("Request the bill") !== null);
  pass("  …with no kitchen progress bar in the panel", host.querySelectorAll('[role="dialog"] span[style*="width"]').length === 0);
  // the panel's close button is icon-only (aria-label, no text)
  await click(host.querySelector('button[aria-label="Close"]'));
  await flush();
  pass("the panel closes from its own close button", host.querySelector('[role="dialog"]') === null);
  pass("  …but no banner and no progress bar", !/on the way/.test(text()) && host.querySelectorAll('span[style*="width"]').length === 0);

  // ── 7. no table / failing endpoint must never break the menu ─────────────
  await act(async () => root.unmount());
  mode = "fail";
  calls.length = 0;
  const host2 = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host2);
  const root2 = createRoot(host2);
  const mount2 = (tableId: number, refreshKey: number) => mount(root2, tableId, refreshKey);

  await mount2(0, 3);
  await flush();
  pass("a QR with no table never polls", calls.length === 0 && host2.querySelectorAll("button").length === 0);

  await mount2(5, 4);
  await flush();
  pass("a 500 from the endpoint is swallowed (no pill, no crash)", calls.length >= 1 && host2.querySelectorAll("button").length === 0);

  mode = "ok";
  await mount2(5, 5);
  await flush();
  pass("the next successful poll brings the pill back", /Order Status/.test(host2.textContent || ""));

  await act(async () => root2.unmount());

  console.log(
    failures === 0
      ? "\n✅ Guest order-status UI smoke test PASSED"
      : `\n❌ ${failures} UI smoke assertions FAILED`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
