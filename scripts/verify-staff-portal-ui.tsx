#!/usr/bin/env tsx
/**
 * Render-level guard for the STAFF & OWNER PORTAL on a phone with a big system
 * font (owner's decision, 30 Sept 2026).
 *
 * THE BUG HE REPORTED, in his words: "when the owner try to inter in admin role
 * it isnt vissibe like the owner phone font is big and like the role choice
 * parts all roles arent vissible ... when he try to scrol upa nd clcik admin he
 * cant beacuse the fonts in his phone are to big and the admin page is cut".
 *
 * The portal was a `fixed inset-0` box with `overflow-hidden` on the card: at a
 * large font the seven roles overflowed the card, the last one (Admin / Owner)
 * was clipped, and nothing could scroll it back into view — the owner could not
 * reach his own dashboard from his phone.
 *
 * This mounts the REAL modal in jsdom (no browser, no database) and proves:
 *   1. all seven roles are actually in the DOM, Admin / Owner among them;
 *   2. the overlay is a scroll region and the card no longer clips;
 *   3. tapping Admin / Owner opens the owner password form;
 *   4. the phone's Back button steps back ONE layer: the form → the role grid →
 *      the portal shut → and only then does it leave the page.
 *
 * Run with: npx tsx scripts/verify-staff-portal-ui.tsx   (wired into `npm test`)
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "https://fana.test/previous",
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
g.CustomEvent = dom.window.CustomEvent;
g.localStorage = dom.window.localStorage;
g.sessionStorage = dom.window.sessionStorage;
g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.IS_REACT_ACT_ENVIRONMENT = true;

// The modal only fetches the public staff names once a role is picked.
const fakeFetch = async (url: string) => {
  if (String(url).startsWith("/api/staff")) {
    return {
      ok: true,
      status: 200,
      json: async () => [{ id: 1, name: "Samuel", role: "waiter" }],
    };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};
(dom.window as unknown as { fetch: unknown }).fetch = fakeFetch;
g.fetch = fakeFetch;

async function main() {
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const StaffAuthModal = (await import("../src/components/StaffAuthModal")).default;

  let failures = 0;
  const pass = (name: string, cond: boolean, extra = "") => {
    console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
    if (!cond) failures++;
  };

  const host = dom.window.document.getElementById("root")!;
  const text = () => (host.textContent || "").replace(/\s+/g, " ");
  const buttonsByText = (needle: string) =>
    [...host.querySelectorAll("button")].filter((b) => (b.textContent || "").includes(needle));
  const click = async (el: Element) => {
    await act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  const back = async () => {
    await act(async () => {
      dom.window.history.back();
      await new Promise((r) => setTimeout(r, 40));
    });
  };

  // The page the portal sits on, with a "previous page" behind it in history.
  dom.window.history.pushState({ __NA: true }, "", "/");
  const appUrl = dom.window.location.href;

  /** Did the portal's own close path run? (the Back press must reach it) */
  const state = { closed: false };
  const setClosed = (v: boolean) => {
    state.closed = v;
  };

  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(StaffAuthModal, { isOpen: true, onClose: () => setClosed(true) }));
    await new Promise((r) => setTimeout(r, 0));
  });

  /* ── 1. every role is really there, Admin / Owner included ─────────────── */
  const ROLES = ["Waiter", "Cashier", "Barista", "Kitchen", "Buna Maker", "Juice Maker", "Admin / Owner"];
  const missing = ROLES.filter((r) => !text().includes(r));
  pass("all seven roles are in the DOM (Admin / Owner is never cut off)", missing.length === 0, missing.join(", "));

  /* ── 2. the overlay scrolls instead of clipping ───────────────────────── */
  const overlay = host.firstElementChild as HTMLElement | null;
  const overlayClass = overlay?.className || "";
  pass("the portal is a scroll region (a big font can no longer hide a role)",
    /fixed inset-0/.test(overlayClass) && /overflow-y-auto/.test(overlayClass), overlayClass);
  const card = overlay?.firstElementChild?.firstElementChild as HTMLElement | null;
  const cardClass = card?.className || "";
  pass("the card itself no longer clips what does not fit (overflow-hidden is gone)",
    !!card && !/overflow-hidden/.test(cardClass), cardClass);
  pass("the card is centred by a min-height wrapper, so it scrolls from its top edge",
    /min-h-full flex items-center justify-center/.test(overlay?.firstElementChild?.className || ""));

  /* ── 3. tapping Admin / Owner opens the owner form ────────────────────── */
  const adminBtn = buttonsByText("Admin / Owner")[0];
  pass("the Admin / Owner card is a real button the owner can tap", !!adminBtn);
  await click(adminBtn);
  pass("tapping it opens the owner password form",
    text().includes("Owner Password") && text().includes("Login To Owner Dashboard"));

  /* ── 4. one Back press = one step back ────────────────────────────────── */
  await back();
  pass("Back #1 steps back to the role grid (the form closes, the portal stays)",
    !text().includes("Owner Password") && text().includes("Select Your Role") && !state.closed);
  pass("...and every role is reachable again, Admin / Owner included", text().includes("Admin / Owner"));
  pass("Back #1 never left the app", dom.window.location.href === appUrl && !state.closed);

  await back();
  pass("Back #2 shuts the portal (one layer per press, never two)", state.closed === true);
  pass("Back #2 still did not leave the page", dom.window.location.href === appUrl);

  await act(async () => {
    root.render(React.createElement(StaffAuthModal, { isOpen: false, onClose: () => setClosed(true) }));
  });
  await back();
  pass("Back #3, with nothing left inside the app, really leaves it",
    dom.window.location.pathname === "/previous", dom.window.location.href);

  await act(async () => root.unmount());

  if (failures > 0) {
    console.error(`\n❌ ${failures} staff-portal check(s) failed\n`);
    process.exit(1);
  }
  console.log("\n✅ The staff & owner portal survives a big system font");
  console.log("   • all seven roles render, Admin / Owner reachable, the list scrolls");
  console.log("   • one Back press = one step back: form → role grid → portal shut → out");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
