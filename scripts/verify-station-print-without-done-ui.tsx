#!/usr/bin/env tsx
/**
 * Render-level guard for "CASHIER PRINT WITHOUT DONE" on the admin Stations tab
 * (owner's request, Oct 2026).
 *
 * Mounts the REAL StationsTab in jsdom against a fake /api/settings, then checks:
 *
 *   1. the section sits under Station Sales Visibility and shows one switch per
 *      crew (Barista, Kitchen, Juice), all OFF on a fresh install;
 *   2. the saved value is read back: a crew switched ON in the database shows ON;
 *   3. tapping a switch saves the WHOLE map (only that crew changes) and the
 *      switch flips to ON once the server accepts it;
 *   4. tapping it again turns it back OFF and saves that;
 *   5. a refused save rolls the switch back to what it was and says so.
 *
 * Run with: npx tsx scripts/verify-station-print-without-done-ui.tsx  (wired into `npm test`)
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "https://fana.test/admin",
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.self = dom.window;
Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
for (const key of ["HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "localStorage", "sessionStorage"]) {
  g[key] = (dom.window as unknown as Record<string, unknown>)[key];
}
g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.IS_REACT_ACT_ENVIRONMENT = true;

/* ── the fake server ──────────────────────────────────────────────────────── */

type Call = { url: string; method: string; body?: Record<string, unknown> };
const calls: Call[] = [];
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const fail = () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) });

/** What the server stores for the switch. Starts with nothing saved (OFF everywhere). */
let storedPrintRule: string | undefined = undefined;
/** When true, the next settings PUT that touches the switch is refused. */
let refuseNextPrintRuleSave = false;

const fakeFetch = async (url: string, init?: RequestInit) => {
  const u = String(url);
  const method = init?.method || "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
  calls.push({ url: u, method, body });

  if (u === "/api/categories") return ok([{ id: 1, name: "Coffee", slug: "coffee" }]);
  if (u === "/api/settings" && method === "GET") {
    const settings: Record<string, string> = {
      category_routing: JSON.stringify({ coffee: "barista" }),
      waiter_send_hold_seconds: "60",
      station_sales_visibility: JSON.stringify({ barista: true, kitchen: true, juice: true }),
    };
    if (storedPrintRule !== undefined) settings.station_print_without_done = storedPrintRule;
    return ok(settings);
  }
  if (u === "/api/settings" && method === "PUT") {
    if (body && "station_print_without_done" in body) {
      if (refuseNextPrintRuleSave) {
        refuseNextPrintRuleSave = false;
        return fail();
      }
      storedPrintRule = String(body.station_print_without_done);
    }
    return ok({ success: true });
  }
  return ok({});
};
(dom.window as unknown as { fetch: unknown }).fetch = fakeFetch;
g.fetch = fakeFetch;

async function main() {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const StationsTab = (await import("../src/components/rms/StationsTab")).default;

  let failures = 0;
  const pass = (name: string, cond: boolean, extra = "") => {
    console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
    if (!cond) failures++;
  };

  // `host` is whichever container is on screen now (the second mount replaces the first).
  let host = dom.window.document.getElementById("root")!;
  const text = () => (host.textContent || "").replace(/\s+/g, " ");
  const switchFor = (crew: string) =>
    host.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="Cashier can print without ${crew} Done"]`);
  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
  };

  const root = createRoot(host);
  await act(async () => {
    root.render(<StationsTab />);
  });
  await flush();

  /* 1. placement and defaults */
  const title = "Cashier Print Without Done";
  const salesAt = text().indexOf("Station Sales Visibility");
  const printAt = text().indexOf(title);
  const holdAt = text().indexOf("Waiter Send Hold");
  pass("the section is shown, directly after Station Sales Visibility", salesAt >= 0 && printAt > salesAt && holdAt > printAt);
  const crews = ["Barista", "Kitchen", "Juice"];
  pass("one switch per crew: Barista, Kitchen and Juice", crews.every((c) => switchFor(c) !== null));
  pass("a fresh install shows every crew OFF", crews.every((c) => switchFor(c)?.getAttribute("aria-checked") === "false"));

  /* 2. a saved value is read back */
  storedPrintRule = JSON.stringify({ barista: false, kitchen: true, juice: false });
  calls.length = 0;
  await act(async () => {
    root.unmount();
  });
  const host2 = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host2);
  host = host2;
  const root2 = createRoot(host2);
  await act(async () => {
    root2.render(<StationsTab />);
  });
  await flush();
  const switchIn = (crew: string) =>
    host.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="Cashier can print without ${crew} Done"]`);
  pass(
    "a saved ON is shown ON, and only that crew (kitchen)",
    switchIn("Kitchen")?.getAttribute("aria-checked") === "true" &&
      switchIn("Barista")?.getAttribute("aria-checked") === "false" &&
      switchIn("Juice")?.getAttribute("aria-checked") === "false"
  );

  /* 3. turn the barista switch ON: the whole map is saved, only barista changes */
  const baristaSwitch = () => switchIn("Barista")!;
  await act(async () => {
    baristaSwitch().click();
  });
  await flush();
  const put = calls.find((c) => c.method === "PUT" && c.body && "station_print_without_done" in c.body);
  const sent = put ? JSON.parse(String(put.body!.station_print_without_done)) : null;
  pass(
    "switching Barista ON saves the map with barista ON and kitchen still ON",
    !!sent && sent.barista === true && sent.kitchen === true && sent.juice === false,
    `sent: ${JSON.stringify(sent)}`
  );
  pass("the switch flips to ON once the server accepts it", switchIn("Barista")?.getAttribute("aria-checked") === "true");
  pass("the saved text confirms the update", text().includes("Cashier print rule updated"));

  /* 4. turn it back OFF */
  await act(async () => {
    switchIn("Barista")!.click();
  });
  await flush();
  const lastPut = [...calls].reverse().find((c) => c.method === "PUT" && c.body && "station_print_without_done" in c.body);
  const lastSent = lastPut ? JSON.parse(String(lastPut.body!.station_print_without_done)) : null;
  pass("switching Barista back OFF saves barista OFF again", !!lastSent && lastSent.barista === false && lastSent.kitchen === true);
  pass("the switch is OFF again", switchIn("Barista")?.getAttribute("aria-checked") === "false");

  /* 5. a refused save rolls back */
  refuseNextPrintRuleSave = true;
  await act(async () => {
    switchIn("Juice")!.click();
  });
  await flush();
  pass("a refused save leaves the switch where it was (OFF)", switchIn("Juice")?.getAttribute("aria-checked") === "false");
  pass("a refused save says so", text().includes("Could not update the cashier print rule"));

  await act(async () => {
    root2.unmount();
  });

  console.log(
    failures === 0
      ? "\n✅ CASHIER PRINT WITHOUT DONE (admin screen) PASSED"
      : `\n❌ CASHIER PRINT WITHOUT DONE (admin screen) FAILED (${failures})`
  );
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
