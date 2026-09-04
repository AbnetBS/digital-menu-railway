#!/usr/bin/env tsx
/**
 * Render-level smoke test for the guest's receipt button
 * (`src/components/rms/OrderStatus.tsx`) — the piece of the guest flow that
 * static source inspection cannot prove: it is real React that a phone will
 * run, so this actually mounts it in jsdom, feeds it the payload shape that
 * `/api/table-status` returns, and CLICKS through the whole flow:
 *
 *   no order → nothing rendered · order appears → ONE receipt button (no pill,
 *   no panel, no progress bar) → tap → POST /api/table-status with only the
 *   table id → disabled with "Sending…" while in flight (a double-tap cannot
 *   send twice) → replaced by the confirmation with the time → the button
 *   never comes back (more polls, refreshKey bumps) → paid/cancelled bills
 *   show nothing → a drinks-only bill still gets the button → no table id
 *   never polls → a 500 from the endpoint is swallowed and the next poll
 *   recovers.
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

/** Once set, the bill carries the stamp — like the server after a real POST. */
let billRequestedAt: string | null = null;

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
      receiptRequestedAt: billRequestedAt,
      phase: "preparing",
      lines: [
        { name: "Beyaynet", quantity: 2, notes: "", station: "kitchen", stationStatus: "done" },
        { name: "Soup", quantity: 1, notes: "No pepper", station: "kitchen", stationStatus: "pending" },
        { name: "Macchiato", quantity: 2, notes: "", station: "barista", stationStatus: "pending" },
      ],
      ...over,
    },
  };
}

type Mode = "ok" | "drinks" | "empty" | "fail" | "hold-post";
let mode: Mode = "ok";
/** Resolves the POST that the "hold-post" mode is keeping in flight. */
let releasePost: ((r: { ok: boolean; status: number; json: () => Promise<unknown> }) => void) | null = null;

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const fakeFetch = async (url: string, init?: RequestInit) => {
  calls.push({ url: String(url), init });
  if (mode === "fail") return { ok: false, status: 500, json: async () => ({}) };
  if (mode === "empty") return ok({ tableId: 5, ticket: null });
  if (mode === "drinks") {
    return ok(
      payload({
        phase: "drinks_only",
        lines: [{ name: "Macchiato", quantity: 2, notes: "", station: "barista", stationStatus: "pending" }],
      })
    );
  }
  if (mode === "hold-post" && init?.method === "POST") {
    // The guest tapped and the network is slow: hold the response so the test
    // can look at the button WHILE the request is in flight.
    return new Promise((resolve) => {
      releasePost = resolve;
    });
  }
  // A POST is the guest asking for the bill → the stamp is applied and every
  // later poll answers with it (idempotent, like the server).
  if (init?.method === "POST") {
    billRequestedAt = new Date().toISOString();
    return ok(payload());
  }
  return ok(payload());
};

(dom.window as unknown as { fetch: unknown }).fetch = fakeFetch;
g.fetch = fakeFetch;

async function main() {
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { OrderStatusProvider, RequestReceiptButton } = await import(
    "../src/components/rms/OrderStatus"
  );
  type Root = ReturnType<typeof createRoot>;

  let failures = 0;
  const pass = (name: string, cond: boolean) => {
    console.log(`${cond ? "✅" : "❌"} ${name}`);
    if (!cond) failures++;
  };

  const host = dom.window.document.getElementById("root")!;
  const text = () => `${host.textContent || ""}`;
  const byText = (needle: string, scope: HTMLElement = host) =>
    [...scope.querySelectorAll("button")].find((b) => (b.textContent || "").includes(needle)) ?? null;

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

  /** (Re)mount the receipt button for one table. */
  const mount = (root: Root, tableId: number, refreshKey: number) =>
    act(async () => {
      root.render(
        React.createElement(
          OrderStatusProvider,
          { tableId, refreshKey },
          React.createElement(RequestReceiptButton)
        )
      );
    });

  const root = createRoot(host);

  // ── 1. no ticket → nothing is rendered at all ────────────────────────────
  mode = "empty";
  await mount(root, 5, 0);
  await flush();
  pass("no order → nothing is rendered (no button, no card)", host.querySelectorAll("button").length === 0);
  pass("GET was scoped to the table", calls.some((c) => c.url === "/api/table-status?table=5"));

  // ── 2. a real bill appears → exactly ONE receipt button ──────────────────
  mode = "ok";
  calls.length = 0;
  await mount(root, 5, 1);
  await flush();
  pass("a refreshKey bump refetches immediately (no 12s wait after ordering)", calls.length >= 1);
  pass("the receipt button appears once the table has an order", byText("Request the bill") !== null);
  pass("it carries the receipt icon, not a status chip", host.querySelector("button svg") !== null);
  pass("no status pill", !/Order Status/.test(text()));
  pass("no progress bar or timeline anywhere", host.querySelectorAll('[role="dialog"], div[style*="width"]').length === 0);
  pass("no dish list", !/Beyaynet/.test(text()));
  pass("no phase words", !/being prepared|Your food is/.test(text()));

  // ── 3. tap it → POST with only the table id, disabled while sending ──────
  mode = "hold-post";
  calls.length = 0;
  await click(byText("Request the bill"));
  await flush(0);
  pass("a POST went to /api/table-status", calls.some((c) => c.url === "/api/table-status" && c.init?.method === "POST"));
  pass("the POST body carries only the table id", calls.find((c) => c.init?.method === "POST")?.init?.body === JSON.stringify({ table: 5 }));
  const sending = byText("Sending");
  pass("while sending, the button is disabled and says so", sending !== null && (sending as HTMLButtonElement).disabled === true);
  await click(sending);
  await flush(0);
  pass("a double-tap cannot send the request twice", calls.filter((c) => c.init?.method === "POST").length === 1);

  // ── 4. the answer → confirmation replaces the button ─────────────────────
  await act(async () => {
    billRequestedAt = new Date().toISOString();
    releasePost?.(ok(payload()));
    await new Promise((r) => setTimeout(r, 20));
  });
  await flush();
  pass("the button is replaced by the confirmation", byText("Request the bill") === null && byText("Sending") === null && /Bill requested/.test(text()));
  pass("the request time is shown", /Requested at \d{2}:\d{2}/.test(text()));

  // ── 5. it never appears twice ────────────────────────────────────────────
  calls.length = 0;
  await mount(root, 5, 7); // a later poll / refreshKey bump with the same bill
  await flush();
  pass("later polls keep the confirmation — the button never comes back", calls.length >= 1 && byText("Request the bill") === null && /Bill requested/.test(text()));

  // ── 6. paid or cancelled → nothing at all ────────────────────────────────
  await act(async () => root.unmount());
  const paidModeFetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (init?.method === "POST") return ok(payload({ receiptRequestedAt: new Date().toISOString() }));
    return ok(payload({ phase: "paid", status: "paid", paymentStatus: "paid_cash", receiptRequestedAt: null }));
  };
  (dom.window as unknown as { fetch: unknown }).fetch = paidModeFetch;
  g.fetch = paidModeFetch;
  const hostPaid = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(hostPaid);
  const rootPaid = createRoot(hostPaid);
  const paidText = () => `${hostPaid.textContent || ""}`;
  await mount(rootPaid, 5, 0);
  await flush();
  pass("a PAID bill shows no receipt button and no confirmation ask", hostPaid.querySelectorAll("button").length === 0 && !/Request the bill/.test(paidText()));

  await act(async () => rootPaid.unmount());
  const cancelledFetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return ok(payload({ phase: "cancelled", status: "cancelled", receiptRequestedAt: null }));
  };
  (dom.window as unknown as { fetch: unknown }).fetch = cancelledFetch;
  g.fetch = cancelledFetch;
  const hostCancelled = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(hostCancelled);
  const rootCancelled = createRoot(hostCancelled);
  await mount(rootCancelled, 5, 0);
  await flush();
  pass("a CANCELLED order shows no receipt button either", rootCancelled && hostCancelled.querySelectorAll("button").length === 0);
  await act(async () => rootCancelled.unmount());

  // restore the normal fetch for the remaining cases
  billRequestedAt = null;
  (dom.window as unknown as { fetch: unknown }).fetch = fakeFetch;
  g.fetch = fakeFetch;

  // ── 7. drinks-only bill: the button is there (nothing to cook first) ─────
  mode = "drinks";
  const host3 = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host3);
  const root3 = createRoot(host3);
  await mount(root3, 5, 12);
  await flush();
  pass("a drinks-only table also gets the receipt button", byText("Request the bill", host3) !== null);

  // ── 8. no table / failing endpoint must never break the menu ─────────────
  await act(async () => root3.unmount());
  mode = "fail";
  calls.length = 0;
  const host2 = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host2);
  const root2 = createRoot(host2);

  await mount(root2, 0, 3);
  await flush();
  pass("a QR with no table never polls", calls.length === 0 && host2.querySelectorAll("button").length === 0);

  await mount(root2, 5, 4);
  await flush();
  pass("a 500 from the endpoint is swallowed (no button, no crash)", calls.length >= 1 && host2.querySelectorAll("button").length === 0);

  mode = "ok";
  await mount(root2, 5, 5);
  await flush();
  pass("the next successful poll brings the receipt button back", byText("Request the bill", host2) !== null);

  await act(async () => root2.unmount());

  console.log(
    failures === 0
      ? "\n✅ Guest receipt-button UI smoke test PASSED"
      : `\n❌ ${failures} UI smoke assertions FAILED`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
