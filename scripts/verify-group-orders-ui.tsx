/**
 * UI smoke test — GROUP ORDERS composer (owner's decision, Sept 2026).
 *
 * The static guard (verify-group-orders.mjs) proves the wiring; this file
 * MOUNTS the real GroupComposer in jsdom with a mocked server and CLICKS
 * through the flow a waiter actually performs on a busy night:
 *
 *   1. It loads the menu, the predicted next number and today's open group
 *      bills (and ONLY group bills: a regular outdoor delivery bill must
 *      never show up as a round target).
 *   2. A new group: the composer announces the number the server will stamp
 *      ("GROUP 8"), the waiter adds an item with a per-item note, sends →
 *      POST source "staff" + orderType "outdoor" + groupOrder true + an
 *      idempotency key + items with notes, and the toast reports the
 *      SERVER-stamped number from the response.
 *   3. Another round: tap the open group, add an item, send → the POST
 *      carries targetTicketId, and the toast says the round joined that bill.
 *
 * Mocked fetch, jsdom, no database. Run: npx tsx scripts/verify-group-orders-ui.tsx
 * (wired into `npm test`)
 */
import { JSDOM } from "jsdom";
import { strictEqual, ok } from "node:assert";

const dom = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle;
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).alert = () => {};

async function main() {
  /* ── the mocked server state, exactly the shapes the real API returns ── */
  const menu = [
    { id: 1, name: "Doro Wot", category: "Main", price: 350, isAvailable: true },
    { id: 2, name: "Popcorn", category: "Snack", price: 60, isAvailable: true },
    { id: 3, name: "Cold Beer", category: "Drink", price: 90, isAvailable: true },
  ];
  const categories = [{ id: 1, name: "Main" }, { id: 2, name: "Snack" }, { id: 3, name: "Drink" }];
  const activeTickets = [
    { id: 901, orderType: "outdoor", tableName: "GROUP 3", status: "confirmed", totalAmount: 440 },
    { id: 902, orderType: "outdoor", tableName: "OUTDOOR • Delivery", status: "confirmed", totalAmount: 100 },
  ];

  const posts: any[] = [];
  (globalThis as any).fetch = async (url: string, init?: any) => {
    if (String(url).includes("/api/menu")) return { ok: true, json: async () => menu } as any;
    if (String(url).includes("/api/categories")) return { ok: true, json: async () => categories } as any;
    if (String(url).includes("/api/tickets?nextGroup=1")) return { ok: true, json: async () => ({ nextGroup: 8 }) } as any;
    if (String(url).includes("/api/tickets?active=1")) return { ok: true, json: async () => activeTickets } as any;
    if (String(url).includes("/api/tickets") && init?.method === "POST") {
      const payload = JSON.parse(init.body);
      posts.push(payload);
      // the real route stamps the number server-side and answers merged: true
      // exactly when the POST carried a target
      return {
        ok: true,
        json: async () =>
          payload.targetTicketId
            ? { id: 901, tableName: "GROUP 3", merged: true }
            : { id: 999, tableName: "GROUP 8", merged: false },
      } as any;
    }
    return { ok: false, status: 404, json: async () => ({}) } as any;
  };

  const { createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { default: GroupComposer } = await import("../src/components/rms/GroupComposer");

  const root = createRoot(document.getElementById("app")!);
  let sent: string | null = null;

  const text = () => document.body.textContent || "";
  const button = (matcher: (b: HTMLButtonElement) => boolean) =>
    Array.from(document.querySelectorAll("button")).find(matcher) as HTMLButtonElement;
  const click = async (matcher: (b: HTMLButtonElement) => boolean) => {
    const btn = button(matcher);
    ok(btn, "button found");
    await act(async () => {
      btn.click();
    });
  };

  await act(async () => {
    root.render(
      createElement(GroupComposer, {
        open: true,
        waiterName: "Selam",
        onClose: () => {}, // the modal stays mounted: open is still true
        onSent: (m: string) => {
          sent = m;
        },
      })
    );
  });

  /* ── 1. what loaded ── */
  ok(/Group Orders/.test(text()), "title renders");
  ok(/will be GROUP 8/.test(text()), "the predicted next number is announced");
  ok(/GROUP 3/.test(text()) && /440/.test(text()), "the open group shows with its total");
  ok(!/Delivery/.test(text()), "a regular outdoor bill is NOT offered as a group");
  ok(/Doro Wot/.test(text()), "the menu grid renders");

  /* ── 2. a new group: item + per-item note ── */
  await click((b) => (b.textContent || "").includes("Doro Wot"));

  const noteInput = document.querySelector<HTMLInputElement>("input[placeholder*='note' i]");
  ok(!!noteInput, "the per-item note input exists");
  if (noteInput) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(noteInput, "extra spicy");
      noteInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  }

  await click((b) => /Send Group Order/.test(b.textContent || ""));

  strictEqual(posts.length, 1, "exactly one POST for the new group");
  strictEqual(posts[0].source, "staff", "sent as staff");
  strictEqual(posts[0].orderType, "outdoor", "rides the outdoor flow");
  strictEqual(posts[0].groupOrder, true, "carries the group flag");
  strictEqual(posts[0].waiterName, "Selam", "carries the waiter's name");
  ok(!("targetTicketId" in posts[0]) || posts[0].targetTicketId === undefined, "a new group targets nothing");
  ok(posts[0].idempotencyKey, "carries an idempotency key");
  ok(posts[0].items.length === 1 && posts[0].items[0].notes === "extra spicy", "items carry the per-item note");
  ok(/GROUP 8 created • sent to the stations/.test(String(sent)), "the toast reports the server-stamped number");

  /* ── 3. another round on the open group ── */
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30)); // let the post-send re-fetch land
  });
  await click((b) => (b.textContent || "").startsWith("GROUP 3"));
  ok(/another round on the same bill/.test(text()), "the summary shows the round target");

  await click((b) => (b.textContent || "").includes("Popcorn"));
  await click((b) => /Add to GROUP 3/.test(b.textContent || ""));

  strictEqual(posts.length, 2, "exactly one POST for the round");
  strictEqual(posts[1].targetTicketId, 901, "targets the open group's id");
  strictEqual(posts[1].groupOrder, true, "the round also carries the group flag");
  ok(!("outdoorLabel" in posts[1]), "the client never sends a label; the server owns it");
  ok(/Added to GROUP 3/.test(String(sent)), "the toast says the round joined the group");

  root.unmount();
  console.log("✅ Group Orders composer UI smoke PASSED");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
