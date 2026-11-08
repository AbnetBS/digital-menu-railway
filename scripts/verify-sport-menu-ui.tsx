/**
 * UI smoke test — THE SPORT MENU sheet (owner, 2026-11-07).
 *
 * The static guard (verify-sport-menu.mjs) proves the wiring and the pricing
 * guard proves the money rules. This file MOUNTS the real SportMenuSheet in
 * jsdom with a mocked server and clicks through what the owner and the waiter
 * actually do:
 *
 *   1. The sheet lists every menu category to add and reports the state
 *      ("Sport prices are ON", "2 categories added • 3 items priced").
 *   2. The owner adds a category -> POST add_category, and the category's items
 *      appear as "from <menu price> to <typed price>" with a price box.
 *   3. He types a match-day price and saves -> POST set_category_prices carries
 *      { menuItemId, regularPrice, sportPrice } for each typed item.
 *   4. Switching off -> POST set_active false (and the list is not deleted).
 *   5. A waiter's phone (canEdit false) sees NO editor and NO switch, only the
 *      read-only list and "Ask the owner…".
 *   6. "Use sport prices" calls onUsePrices with the catalogue (the ordering
 *      screen's switch), and never writes anything to the server.
 *
 * Mocked fetch, jsdom, no database. Run: npx tsx scripts/verify-sport-menu-ui.tsx
 * (wired into `npm test`)
 */
import { JSDOM } from "jsdom";
import { ok, strictEqual } from "node:assert";

const dom = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle;
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** The catalogue the mocked server serves (both prices, owner's view). */
type Item = { id: number; name: string; category: string; isAvailable: boolean; regularPrice: number; sportPrice: number | null; categoryAdded: boolean };

function makeCatalog(categories: string[], prices: Record<number, number>, edition: { canEdit: boolean }) {
  const all = [
    { id: 1, name: "Macchiato", category: "hot-drinks", regularPrice: 60 },
    { id: 2, name: "Tea", category: "hot-drinks", regularPrice: 40 },
    { id: 3, name: "Cola", category: "cold-drinks", regularPrice: 50 },
    { id: 4, name: "Mango Juice", category: "cold-drinks", regularPrice: 80 },
    { id: 5, name: "Croissant", category: "pastry", regularPrice: 120 },
  ];
  const items: Item[] = all.map((item) => ({
    id: item.id,
    name: item.name,
    category: item.category,
    isAvailable: true,
    regularPrice: item.regularPrice,
    sportPrice: prices[item.id] ?? null,
    categoryAdded: categories.includes(item.category),
  }));
  const priceRows = Object.entries(prices).map(([id, sportPrice]) => {
    const item = all.find((entry) => entry.id === Number(id))!;
    return { menuItemId: Number(id), regularPrice: item.regularPrice, sportPrice, category: item.category };
  });
  return {
    menu: {
      id: 1,
      name: "Sport",
      categories,
      prices: priceRows,
      active: true,
      createdAt: null,
      updatedAt: null,
    },
    categories: [
      { id: 1, name: "Hot Drinks", slug: "hot-drinks" },
      { id: 2, name: "Cold Drinks", slug: "cold-drinks" },
      { id: 3, name: "Pastry", slug: "pastry" },
    ],
    items,
    canEdit: edition.canEdit,
  };
}

async function main() {
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: SportMenuSheet } = await import("../src/components/rms/SportMenuSheet");

  const posts: any[] = [];
  let state = { categories: [] as string[], prices: {} as Record<number, number>, canEdit: true };

  (globalThis as any).fetch = async (url: string, init?: any) => {
    if (String(url).includes("/api/sport-menu") && init?.method === "POST") {
      const body = JSON.parse(init.body);
      posts.push(body);
      if (body.action === "add_category") {
        if (!state.categories.includes(body.category)) state.categories = [...state.categories, body.category];
        return {
          ok: true,
          json: async () => ({
            ...makeCatalog(state.categories, state.prices, { canEdit: state.canEdit }),
            message: "Cold Drinks added. Type the match-day price for each item.",
          }),
        } as any;
      }
      if (body.action === "set_category_prices") {
        for (const row of body.rows) state.prices[row.menuItemId] = Number(row.sportPrice);
        return { ok: true, json: async () => ({ ...makeCatalog(state.categories, state.prices, { canEdit: state.canEdit }), message: "Sport menu saved." }) } as any;
      }
      if (body.action === "set_active") {
        return { ok: true, json: async () => ({ ...makeCatalog(state.categories, state.prices, { canEdit: state.canEdit }), message: body.active ? "Sport prices are on." : "Sport prices are off." }) } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    }
    if (String(url).includes("/api/sport-menu")) {
      return { ok: true, json: async () => makeCatalog(state.categories, state.prices, { canEdit: state.canEdit }) } as any;
    }
    return { ok: false, status: 404, json: async () => ({}) } as any;
  };

  const root = createRoot(document.getElementById("app")!);
  const text = () => (document.body.textContent || "").replace(/\s+/g, " ");
  const button = (matcher: (b: HTMLButtonElement) => boolean) =>
    Array.from(document.querySelectorAll("button")).find(matcher) as HTMLButtonElement | undefined;
  const click = async (matcher: (b: HTMLButtonElement) => boolean) => {
    const btn = button(matcher);
    ok(btn, `button found: ${matcher.toString().slice(0, 90)}`);
    await act(async () => {
      btn!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  };
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };

  let usedCatalog: unknown = null;
  await act(async () => {
    root.render(
      createElement(SportMenuSheet, {
        open: true,
        onClose: () => {},
        sportMode: false,
        onUsePrices: (catalog: unknown) => {
          usedCatalog = catalog;
        },
      })
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

  /* ── 1. the sheet loads and speaks plainly ── */
  ok(/Sport menu/.test(text()), "the title renders");
  ok(/Match-day prices for the waiter only/.test(text()), "it says the customer never sees these");
  ok(/Sport prices are ON/.test(text()), "the switch state is stated");
  ok(/No category added yet/.test(text()), "an empty list explains what to do");
  ok(/Add a category/.test(text()), "the owner's add-category row exists");
  ok(/Hot Drinks/.test(text()) && /Cold Drinks/.test(text()) && /Pastry/.test(text()), "all three of the owner's categories are offered");

  /* ── 2. adding a category ── */
  await click((b) => (b.textContent || "").includes("Cold Drinks"));
  strictEqual(posts.length, 1, "one POST for adding the category");
  strictEqual(posts[0].action, "add_category", "the action is add_category");
  strictEqual(posts[0].category, "cold-drinks", "it names the slug, not the label");
  ok(/Cold Drinks added/.test(text()), "the server's message is shown");
  ok(/Cola/.test(text()) && /Mango Juice/.test(text()), "the category's items are listed to price");

  /* ── 3. the owner types a price and saves the category ── */
  const colaBox = Array.from(document.querySelectorAll<HTMLInputElement>("input")).find(
    (input) => (input.getAttribute("aria-label") || "").startsWith("Cola")
  );
  ok(colaBox, "the price box for Cola exists");
  await type(colaBox!, "70");
  ok(/from 50/.test(text()) && /70/.test(text()), "the row reads from 50 to 70");

  await click((b) => /Save Cold Drinks prices/.test(b.textContent || ""));
  const save = posts.find((body) => body.action === "set_category_prices");
  ok(save, "the save POST went out");
  strictEqual(save.rows.length, 1, "only the typed item is saved");
  strictEqual(save.rows[0].menuItemId, 3, "the right menu item");
  strictEqual(save.rows[0].regularPrice, 50, "the normal price travels beside it (from ...)");
  strictEqual(save.rows[0].sportPrice, 70, "the typed match-day price is the number saved");
  strictEqual(save.category, "cold-drinks", "saved against its category");

  /* ── 4. switching off for today ── */
  await click((b) => /Switch off for today/.test(b.textContent || ""));
  const toggle = posts.find((body) => body.action === "set_active");
  ok(toggle, "the switch POST went out");
  strictEqual(toggle.active, false, "it asks for OFF, not for a delete");

  /* ── 5. the waiter uses the list (no write) ── */
  const before = posts.length;
  await click((b) => /Use sport prices/.test(b.textContent || ""));
  strictEqual(posts.length, before, "switching the ordering screen writes nothing");
  ok(usedCatalog && (usedCatalog as any).menu, "the catalogue is handed to the ordering screen");

  root.unmount();

  /* ── 6. a waiter's phone: read-only ── */
  state = { categories: ["cold-drinks"], prices: { 3: 70 }, canEdit: false };
  const root2 = createRoot(document.getElementById("app")!);
  await act(async () => {
    root2.render(createElement(SportMenuSheet, { open: true, onClose: () => {} }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  ok(!/Add a category/.test(text()), "a waiter never sees the add-category row");
  ok(!/Switch off for today/.test(text()), "a waiter cannot switch the list");
  ok(!/Use sport prices/.test(text()), "no ordering switch when the sheet was opened without that role");
  ok(/Cold Drinks/.test(text()), "but he does read the match-day prices");
  root2.unmount();

  console.log("✅ Sport menu sheet UI smoke PASSED");
}

main().catch((error) => {
  console.error(error);
  console.error("❌ Sport menu sheet UI smoke FAILED");
  process.exit(1);
});
