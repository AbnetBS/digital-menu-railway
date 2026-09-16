/**
 * UI smoke test — MATCH DAY composer (owner's decision, Sept 2026).
 *
 * The static guard (verify-match-day.mjs) proves the wiring; this file MOUNTS
 * the real MatchDayComposer in jsdom with a mocked server and CLICKS through
 * the flow a waiter actually performs on a football night:
 *
 *   1. It loads the menu and today's open match bills (and ONLY match bills:
 *      a regular outdoor delivery bill must never show up as a target).
 *   2. A new group: pick a spot chip, add an item, type a per-item note, send
 *      → POST source "staff" + orderType "outdoor" + outdoorLabel
 *      "MATCH • <spot>" + idempotency key + items with notes.
 *   3. Another round: tap the open bill chip, add an item, send → the POST
 *      carries targetTicketId and the bill's own label, and the toast says
 *      the round was added to that bill.
 *
 * Mocked fetch, jsdom, no database. Run: npx tsx scripts/verify-match-day-ui.tsx
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
    { id: 901, orderType: "outdoor", tableName: "MATCH • Screen front", status: "confirmed", totalAmount: 440 },
    { id: 902, orderType: "outdoor", tableName: "OUTDOOR • Delivery", status: "confirmed", totalAmount: 100 },
  ];

  const posts: any[] = [];
  (globalThis as any).fetch = async (url: string, init?: any) => {
    if (String(url).includes("/api/menu")) return { ok: true, json: async () => menu } as any;
    if (String(url).includes("/api/categories")) return { ok: true, json: async () => categories } as any;
    if (String(url).includes("/api/tickets?active=1")) return { ok: true, json: async () => activeTickets } as any;
    if (String(url).includes("/api/tickets") && init?.method === "POST") {
      const payload = JSON.parse(init.body);
      posts.push(payload);
      // the real route answers merged: true exactly when the POST carried a target
      return { ok: true, json: async () => ({ id: 999, merged: !!payload.targetTicketId }) } as any;
    }
    return { ok: false, status: 404, json: async () => ({}) } as any;
  };

  const { createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { default: MatchDayComposer } = await import("../src/components/rms/MatchDayComposer");

  const root = createRoot(document.getElementById("app")!);
  let sent: string | null = null;

  const text = () => document.body.textContent || "";
  const button = (matcher: (b: HTMLButtonElement) => boolean) =>
    Array.from(document.querySelectorAll("button")).find(matcher) as HTMLButtonElement;
  const click = async (matcher: (b: HTMLButtonElement) => boolean) => {
    const btn = button(matcher);
    ok(btn, "button found: " + matcher);
    await act(async () => {
      btn.click();
    });
  };

  await act(async () => {
    root.render(
      createElement(MatchDayComposer, {
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
  ok(/Match Day Order/.test(text()), "title renders");
  ok(/Screen front/.test(text()) && /440/.test(text()), "the open match bill chip shows with its total");
  ok(!/Delivery/.test(text()), "a regular outdoor bill is NOT offered as a match bill");
  ok(/Screen left/.test(text()) && /By the door/.test(text()), "the spot chips render");
  ok(/Doro Wot/.test(text()), "the menu grid renders");

  /* ── 2. a new group: spot chip + item + per-item note ── */
  await click((b) => (b.textContent || "") === "Screen left");
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

  await click((b) => /Send Match Order/.test(b.textContent || ""));

  strictEqual(posts.length, 1, "exactly one POST for the new group");
  strictEqual(posts[0].source, "staff", "sent as staff");
  strictEqual(posts[0].orderType, "outdoor", "rides the outdoor flow");
  strictEqual(posts[0].outdoorLabel, "MATCH • Screen left", "labeled with the spot");
  strictEqual(posts[0].waiterName, "Selam", "carries the waiter's name");
  ok(posts[0].idempotencyKey, "carries an idempotency key");
  ok(posts[0].items.length === 1 && posts[0].items[0].notes === "extra spicy", "items carry the per-item note");
  ok(/Match order sent • MATCH • Screen left/.test(String(sent)), "the toast names the new bill");

  /* ── 3. another round on the open bill ── */
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30)); // let the post-send re-fetch land
  });
  await click((b) => (b.textContent || "").includes("Screen front"));
  ok(/Adding another round to/.test(text()), "the round banner shows the target bill");

  await click((b) => (b.textContent || "").includes("Popcorn"));
  await click((b) => /Add to MATCH/.test(b.textContent || ""));

  strictEqual(posts.length, 2, "exactly one POST for the round");
  strictEqual(posts[1].targetTicketId, 901, "targets the open bill's id");
  strictEqual(posts[1].outdoorLabel, "MATCH • Screen front", "keeps the bill's own label");
  ok(/Added to MATCH • Screen front/.test(String(sent)), "the toast says the round joined the bill");

  root.unmount();
  console.log("✅ Match Day composer UI smoke PASSED");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
