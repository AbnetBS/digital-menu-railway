#!/usr/bin/env tsx
/**
 * Render-level guard for THE WAITER'S SEND, on the page she tapped it on
 * (owner's decision, 30 Sept 2026).
 *
 * WHAT HE ASKED FOR, in his words: "when they add items and click send make it
 * to take them to the tables view so that it become fast but they said it makes
 * them slow so now what i want you to change is that when the waiter click send
 * it says on that page like they can see the item on waiting they can edit
 * cancel and other related also below the list there is the timer which count
 * the time it will be sent then in the right side of the counter there will be
 * send now button then below the 2 cancel whole order button to cancel the
 * whole order ... then they can click back and go to see the tables".
 *
 * This mounts the REAL waiter app in jsdom against a fake server (no browser,
 * no database) and walks the whole flow:
 *
 *   1. login → the tables grid → open a table → add a dish;
 *   2. SEND keeps her on that page: the item is still listed and editable, and
 *      under it sit the countdown, SEND NOW on its right and CANCEL WHOLE ORDER
 *      below the two;
 *   3. CANCEL WHOLE ORDER deletes the saved order on the server and clears the
 *      list, and nothing was ever sent to the kitchen;
 *   4. SEND NOW posts the order at once and only then takes her to the grid;
 *   5. the phone's Back button walks her out one screen at a time
 *      (order → tables), never straight out of the app.
 *
 * Run with: npx tsx scripts/verify-waiter-send-ui.tsx   (wired into `npm test`)
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "https://fana.test/waiter",
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
for (const key of ["HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "localStorage", "sessionStorage"]) {
  g[key] = (dom.window as unknown as Record<string, unknown>)[key];
}
g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.IS_REACT_ACT_ENVIRONMENT = true;

/* ── the fake server: the exact shapes the waiter app reads ─────────────── */

const calls: Array<{ url: string; method: string; body?: unknown }> = [];
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const TABLES = [
  { id: 1, name: "Table 1", status: "available", activeTicketId: null, capacity: 4 },
  { id: 2, name: "Table 2", status: "available", activeTicketId: null, capacity: 4 },
];
const MENU = [
  { id: 11, name: "Cappuccino", category: "coffee", price: 90, isAvailable: true, imageUrl: "" },
  { id: 12, name: "Chicken Shawarma", category: "food", price: 220, isAvailable: true, imageUrl: "" },
];
let sentTickets = 0;
let deferredDeleted: string[] = [];

const fakeFetch = async (url: string, init?: RequestInit) => {
  const u = String(url);
  const method = init?.method || "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ url: u, method, body });

  if (u.startsWith("/api/staff?public=1")) return ok([{ id: 1, name: "Samuel", role: "waiter" }]);
  if (u === "/api/settings") return ok({ waiter_send_hold_seconds: "60", cashier_mode: "print-queue", receipt_enabled: "true" });
  if (u === "/api/staff/login") return ok({ success: true, staff: { id: 1, name: "Samuel", role: "waiter" } });
  if (u.startsWith("/api/tables")) return ok(TABLES);
  if (u.startsWith("/api/tickets?active=1")) return ok([]);
  if (u.startsWith("/api/tickets?id=")) return ok([]);
  if (u.startsWith("/api/menu")) return ok(MENU);
  if (u.startsWith("/api/categories")) return ok([{ slug: "all", name: "All" }, { slug: "coffee", name: "Coffee" }, { slug: "food", name: "Food" }]);
  if (u === "/api/tickets" && method === "POST") {
    sentTickets += 1;
    return ok({ id: 500 + sentTickets, tableName: "Table 1", merged: false });
  }
  if (u.startsWith("/api/tickets/deferred") && method === "DELETE") {
    deferredDeleted.push(u.split("idempotencyKey=")[1] || "");
    return ok({ cancelled: true });
  }
  if (u.startsWith("/api/tickets/deferred")) return ok({ dueAt: new Date(Date.now() + 60_000).toISOString() });
  return ok({});
};
(dom.window as unknown as { fetch: unknown }).fetch = fakeFetch;
g.fetch = fakeFetch;

// The realtime stream: present, quiet (the app must not need it to work).
class FakeEventSource {
  readyState = 1;
  onmessage: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  close() {
    this.readyState = 2;
  }
}
(dom.window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
g.EventSource = FakeEventSource;

async function main() {
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const WaiterApp = (await import("../src/components/rms/WaiterApp")).default;

  let failures = 0;
  const pass = (name: string, cond: boolean, extra = "") => {
    console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
    if (!cond) failures++;
  };

  const host = dom.window.document.getElementById("root")!;
  const text = () => (host.textContent || "").replace(/\s+/g, " ");
  const buttonsByText = (needle: string) =>
    [...host.querySelectorAll("button")].filter((b) => (b.textContent || "").includes(needle));
  const tilesByText = (needle: string) =>
    [...host.querySelectorAll<HTMLElement>("[role='button']")].filter((el) => (el.textContent || "").includes(needle));
  const settle = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  const click = async (el: Element | undefined) => {
    if (!el) throw new Error("nothing to click");
    await act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  const setValue = async (el: Element, value: string) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  const back = async () => {
    await act(async () => {
      dom.window.history.back();
      await new Promise((r) => setTimeout(r, 40));
    });
  };
  const postedTickets = () => calls.filter((c) => c.url === "/api/tickets" && c.method === "POST").length;

  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(WaiterApp));
    await new Promise((r) => setTimeout(r, 0));
  });

  /* ── 1. login → tables → a table → one dish ───────────────────────────── */
  pass("the waiter starts on her login screen", text().includes("Waiter Login"));
  const select = host.querySelector("select")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, "Samuel");
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  await setValue(host.querySelector("input[type='password']")!, "1234");
  await click(buttonsByText("Login as Waiter")[0]);
  await settle();
  pass("she lands on the tables grid", text().includes("Table 1") && text().includes("Table 2"));

  await click(tilesByText("Table 1")[0]);
  await settle();
  pass("opening a green table starts a new order on that table", text().includes("New order"));

  await click(tilesByText("Cappuccino")[0]);
  await settle();
  pass("the dish lands in the list she is about to send",
    text().includes("About to send • 1 item(s)") && buttonsByText("Send Order").length === 1);

  /* ── 2. SEND keeps her ON THE PAGE, with the three controls ───────────── */
  await click(buttonsByText("Send Order")[0]);
  await settle();

  pass("SEND does NOT throw her back to the tables grid (the waiters' complaint)",
    text().includes("New order") && text().includes("Cappuccino") && !text().includes("Tap a green table"));
  pass("the waiting list is labelled, and the dish is still on it",
    text().includes("⏳ Waiting to send • 1 item(s)") && text().includes("Cappuccino"));
  pass("under the list: the COUNTDOWN of the time left (1:00 for the default hold)",
    text().includes("Sends in") && /1:00/.test(text()));
  pass("on the right of the countdown: SEND NOW", buttonsByText("Send now").length === 1);
  pass("below the two: CANCEL WHOLE ORDER", buttonsByText("Cancel whole order").length === 1);
  pass("the items stay editable while it counts (quantity, note, remove)",
    !!host.querySelector("input[placeholder*='No Sugar']") && text().includes("Edit the items above until it runs out"));
  pass("the order was saved on the server, waiting for its moment",
    calls.some((c) => c.url === "/api/tickets/deferred" && c.method === "POST"));
  pass("nothing reached the kitchen yet", postedTickets() === 0);

  /* ── 3. CANCEL WHOLE ORDER ────────────────────────────────────────────── */
  await click(buttonsByText("Cancel whole order")[0]);
  await settle();
  pass("CANCELLING deletes the saved order on the server", deferredDeleted.length === 1);
  // "Cappuccino" is also on the menu grid, so the check is the SHEET itself:
  // no waiting list, no Send Order button, and the table's page still open.
  pass("...and clears the waiting list, so she can start over on the same table",
    !text().includes("Waiting to send") && buttonsByText("Send Order").length === 0
      && buttonsByText("Cancel whole order").length === 0 && text().includes("New order"));
  pass("nothing was ever sent to the kitchen", postedTickets() === 0);

  /* ── 4. SEND NOW posts at once, and only then takes her to the grid ───── */
  await click(tilesByText("Cappuccino")[0]);
  await click(buttonsByText("Send Order")[0]);
  await settle();
  await click(buttonsByText("Send now")[0]);
  await settle();
  pass("SEND NOW posts the order straight away", postedTickets() === 1);
  pass("and only then takes her back to the tables grid", text().includes("Tap a green table"));

  /* ── 5. the countdown sends by itself when it reaches zero ─────────────
     The owner's rule is that the order leaves without her touching it again,
     so the clock is what posts it. The fake clock jumps the hold's 60 seconds
     in one step and the app's own 1-second ticker does the rest. */
  await click(tilesByText("Table 1")[0]);
  await settle();
  await click(tilesByText("Chicken Shawarma")[0]);
  await settle();
  await click(buttonsByText("Send Order")[0]);
  await settle();
  const realNow = Date.now;
  const later = realNow() + 61_000;
  Date.now = () => later;
  try {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1400));
    });
  } finally {
    Date.now = realNow;
  }
  await settle();
  pass("when the countdown reaches zero the order sends BY ITSELF", postedTickets() === 2);
  pass("...and only then does she land back on the tables grid", text().includes("Tap a green table"));

  /* ── 6. the phone's Back button walks out one screen at a time ────────── */
  await click(tilesByText("Table 2")[0]);
  await settle();
  pass("she can open another table", text().includes("New order"));
  await back();
  pass("Back #1 takes her to ALL THE TABLES (not to the browser)",
    text().includes("Table 1") && text().includes("Table 2") && !text().includes("New order"));
  await back();
  pass("Back #2 takes her to the login screen (one step, not straight out)",
    text().includes("Waiter Login") && dom.window.location.pathname === "/waiter");

  await act(async () => root.unmount());

  if (failures > 0) {
    console.error(`\n❌ ${failures} waiter-send check(s) failed\n`);
    process.exit(1);
  }
  console.log("\n✅ The waiter's send, on the page she tapped it on");
  console.log("   • Send keeps the items, the countdown, Send now and Cancel whole order");
  console.log("   • Cancel whole order deletes the saved order; Send now posts at once");
  console.log("   • Back walks order → tables → login, one screen per press");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
