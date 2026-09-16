#!/usr/bin/env tsx
/**
 * Render-level smoke test for THE COFFEE NOTE page
 * (`src/components/rms/CoffeeNotePanel.tsx`) — the owner's held tab for
 * outdoor buna sales. Static inspection cannot prove a phone-sized flow, so
 * this mounts the REAL panel in jsdom, mocks /api/menu + /api/buna-notes +
 * /api/buna-notes/pay exactly as the server answers, and CLICKS through the
 * whole story:
 *
 *   open → menu + notes load · Add New → the form with BUNA as the default
 *   item · +/− steppers move the amount · place note typed · HOLD → POST with
 *   the right body, the numbered row appears with the time and the total ·
 *   a second hold gets the next number · Edit → PUT saves the new amount ·
 *   Delete (confirmed) → DELETE, the row is gone · Paid (confirmed) →
 *   POST /pay, the row leaves the hold list, lands in the collapsed "paid
 *   today" strip with its FANA number, and the dashboard is told to refresh
 *   its history · the Coffee Note badge count follows the held rows.
 *
 * Requires the `jsdom` devDependency (no browser, no database, no server).
 * Run with: npx tsx scripts/verify-coffee-note-ui.tsx   (wired into `npm test`)
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "https://fana.test/cashier",
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

/* ── the mocked server state, exactly the shapes the real API returns ────── */

const MENU = [
  { id: 1, name: "Jebena Buna", category: "coffee", price: 25, isBuna: true, isAvailable: true },
  { id: 2, name: "Macchiato", category: "coffee", price: 40, isBuna: false, isAvailable: true },
];

interface Note {
  id: number;
  seq: number;
  menuItemId: number | null;
  itemName: string;
  unitPrice: number;
  quantity: number;
  placeNote: string | null;
  heldBy: string | null;
  heldAt: string | null;
  paidAt: string | null;
  paidBy: string | null;
  ticketId: number | null;
}

let nextId = 1;
let nextSeq = 1;
let nextTicket = 77;
const notes: Note[] = [];

const nowIso = () => new Date().toISOString();

function notePayload() {
  return {
    held: notes.filter((n) => !n.paidAt).map((n) => ({ ...n })),
    paidToday: notes.filter((n) => n.paidAt).map((n) => ({ ...n })),
  };
}

const calls: Array<{ url: string; init?: RequestInit }> = [];
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const fakeFetch = async (url: string, init?: RequestInit) => {
  calls.push({ url: String(url), init });
  const u = String(url);
  if (u === "/api/menu") return ok(MENU);
  if (u === "/api/buna-notes" && (!init || init.method === undefined || init.method === "GET")) {
    return ok(notePayload());
  }
  if (u === "/api/buna-notes" && init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    // The server default: no pick → the menu's buna item.
    const item = MENU.find((m) => m.id === Number(body.menuItemId)) || MENU.find((m) => m.isBuna)!;
    const note: Note = {
      id: nextId++,
      seq: nextSeq++,
      menuItemId: item.id,
      itemName: item.name,
      unitPrice: item.price,
      quantity: Number(body.quantity) || 1,
      placeNote: body.placeNote || null,
      heldBy: body.heldBy || null,
      heldAt: nowIso(),
      paidAt: null,
      paidBy: null,
      ticketId: null,
    };
    notes.push(note);
    return ok({ note: { ...note } });
  }
  if (u === "/api/buna-notes" && init?.method === "PUT") {
    const body = JSON.parse(String(init.body));
    const note = notes.find((n) => n.id === Number(body.id));
    if (note) {
      if (body.menuItemId != null) {
        const item = MENU.find((m) => m.id === Number(body.menuItemId));
        if (item) {
          note.menuItemId = item.id;
          note.itemName = item.name;
          note.unitPrice = item.price;
        }
      }
      note.quantity = Number(body.quantity) || note.quantity;
      note.placeNote = body.placeNote ?? note.placeNote;
    }
    return ok({ note: { ...note } });
  }
  if (u.startsWith("/api/buna-notes?") && init?.method === "DELETE") {
    const id = Number(new URL(u, "https://fana.test").searchParams.get("id"));
    const idx = notes.findIndex((n) => n.id === id && !n.paidAt);
    if (idx >= 0) notes.splice(idx, 1);
    return ok({ ok: true });
  }
  if (u === "/api/buna-notes/pay" && init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    const note = notes.find((n) => n.id === Number(body.id));
    if (note && !note.paidAt) {
      note.paidAt = nowIso();
      note.paidBy = "Hanna";
      note.ticketId = nextTicket;
    }
    return ok({ ok: true, noteId: body.id, ticketId: nextTicket, orderNumber: `FANA-${nextTicket++}` });
  }
  return ok({});
};

(dom.window as unknown as { fetch: unknown }).fetch = fakeFetch;
g.fetch = fakeFetch;
// Both confirm dialogs (delete + pay) are accepted by the test. The panel
// calls the bare browser global, so it must exist on Node's globalThis too.
g.confirm = () => true;

async function main() {
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const CoffeeNotePanel = (await import("../src/components/rms/CoffeeNotePanel")).default;

  let failures = 0;
  const pass = (name: string, cond: boolean) => {
    console.log(`${cond ? "✅" : "❌"} ${name}`);
    if (!cond) failures++;
  };

  const host = dom.window.document.getElementById("root")!;
  const text = () => `${host.textContent || ""}`;
  const byText = (needle: string) =>
    [...host.querySelectorAll("button")].find((b) => (b.textContent || "").includes(needle)) ?? null;
  const buttonsWith = (needle: string) => [...host.querySelectorAll("button")].filter((b) => (b.textContent || "").includes(needle));
  /** Per-row PAID buttons only (the collapsed strip says "Paid today"). */
  const paidRowButtons = () =>
    [...host.querySelectorAll("button")].filter((b) => (b.textContent || "").includes("Paid") && !(b.textContent || "").includes("today"));
  /** The numbered gold squares at the start of each held row. */
  const seqBadges = () => [...host.querySelectorAll("span.rounded-lg")].map((s) => (s.textContent || "").trim());

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
  const setInput = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };

  let changed: string[] = [];
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(CoffeeNotePanel, {
        open: true,
        cashierName: "Hanna",
        onClose: () => {},
        onChanged: (kind: string) => changed.push(kind),
      })
    );
  });
  await flush();

  // ── 1. open → data loads, empty state ────────────────────────────────────
  pass("opening loads the menu and the notes", calls.some((c) => c.url === "/api/menu") && calls.some((c) => c.url === "/api/buna-notes"));
  pass("the page is the Coffee Note page", /Coffee Note/.test(text()) && /outdoor buna tab/i.test(text()));
  pass("empty hold list explains itself", /No notes on hold/.test(text()) && /Add New/.test(text()));

  // ── 2. Add New → the form, buna as the default ───────────────────────────
  await click(byText("Add New"));
  await flush(0);
  pass("the add form opens with BUNA as the default item", /Jebena Buna • 25 ETB/.test(text()));
  pass("the place (note) input is there", !!host.querySelector("input[placeholder*='Gate, parking']"));
  const plus = [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "One more")!;
  const minus = [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "One less")!;
  pass("the square +/− steppers are there", !!plus && !!minus);
  await click(plus);
  await click(plus);
  await flush(0);
  pass("two taps on + move the amount to 3", /3/.test(host.querySelector("font-serif, span.font-serif")?.textContent || "") || /\b3\b/.test(text()));
  const placeInput = host.querySelector("input[placeholder*='Gate, parking']") as HTMLInputElement;
  await setInput(placeInput, "at the gate");

  // ── 3. HOLD → the numbered row appears ───────────────────────────────────
  calls.length = 0;
  await click(byText("HOLD"));
  await flush();
  const holdPost = calls.find((c) => c.url === "/api/buna-notes" && c.init?.method === "POST");
  pass("HOLD posted the note (no price, no name from the client)", !!holdPost && (() => { const b = JSON.parse(String(holdPost!.init!.body)); return b.quantity === 3 && b.placeNote === "at the gate" && b.heldBy === "Hanna" && b.price === undefined && b.name === undefined; })());
  pass("note #1 appears as a row with item, amount, place and total", /Jebena Buna/.test(text()) && /×3/.test(text()) && /at the gate/.test(text()) && /75 ETB/.test(text()));
  pass("the row shows the time it was added", /held \d{2}:\d{2}/.test(text()));
  pass("the dashboard badge hook was told (held)", changed.includes("held"));

  // ── 4. a second hold gets the next number ────────────────────────────────
  await click(byText("Add New"));
  await flush(0);
  await click(byText("HOLD"));
  await flush();
  pass("a second hold is note #2 (numbers keep counting, newest first)", seqBadges().includes("2") && seqBadges().includes("1") && paidRowButtons().length === 2);

  // ── 5. Edit → PUT with the new amount ────────────────────────────────────
  const editButtons = buttonsWith("Edit");
  await click(editButtons[0]);
  await flush(0);
  const editPlus = [...host.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === "One more");
  await click(editPlus[editPlus.length - 1]);
  await flush(0);
  calls.length = 0;
  await click(byText("Save"));
  await flush();
  const putCall = calls.find((c) => c.url === "/api/buna-notes" && c.init?.method === "PUT");
  pass("saving an edit PUTs the new amount", !!putCall && JSON.parse(String(putCall.init!.body)).quantity === 4);
  pass("the row now shows ×4", /×4/.test(text()));

  // ── 6. Delete (confirmed) → the row is gone ──────────────────────────────
  calls.length = 0;
  const before = paidRowButtons().length;
  await click(buttonsWith("Delete")[before - 1] ?? null); // note #2
  await flush();
  const delCall = calls.find((c) => c.init?.method === "DELETE" && String(c.url).includes("id="));
  pass("delete called DELETE /api/buna-notes?id=", !!delCall);
  pass("one row fewer remains", paidRowButtons().length === before - 1 && !seqBadges().includes("2"));

  // ── 7. Paid (confirmed) → history + the paid-today strip ─────────────────
  calls.length = 0;
  changed = [];
  await click(paidRowButtons()[0] ?? null);
  await flush();
  pass("paying called POST /api/buna-notes/pay", calls.some((c) => c.url === "/api/buna-notes/pay" && c.init?.method === "POST"));
  pass("the hold list is empty again", /No notes on hold/.test(text()));
  pass("the dashboard was told to refresh history (paid)", changed.includes("paid"));
  await click([...host.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Paid today")) ?? null);
  await flush(0);
  pass("the paid note sits in the paid-today strip with its FANA number", /Jebena Buna ×4/.test(text()) && /FANA-77/.test(text()));

  await act(async () => root.unmount());

  console.log(
    failures === 0
      ? "\n✅ Coffee Note UI smoke test PASSED"
      : `\n❌ ${failures} UI smoke assertions FAILED`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
