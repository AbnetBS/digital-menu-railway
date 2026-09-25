#!/usr/bin/env tsx
/**
 * Render-level guard for the owner's EDIT button on the Staff tab
 * (`src/components/rms/StaffTab.tsx` → `PUT /api/staff`).
 *
 * Before this feature the Staff tab could only Create and Remove, so fixing a
 * misspelled name or a forgotten PIN meant deleting the person and adding them
 * again — and `PUT /api/staff` sat unused in the API. The owner asked for it:
 * "yes add edit that will be good feature".
 *
 * The rule that matters most is money: a person's login must survive an edit.
 * So this mounts the REAL tab in jsdom with a fake server and proves:
 *
 *   1. every card carries an Edit button next to Remove;
 *   2. tapping it opens a form pre-filled with that person's name and role,
 *      and an EMPTY PIN box;
 *   3. saving with an empty PIN box sends no pin at all — the server keeps the
 *      hash it already has, so the person can still sign in;
 *   4. a typed PIN is sent (that is how a new PIN is handed over), and a PIN
 *      shorter than 4 characters is refused before any request leaves;
 *   5. success says so and the list shows the new name;
 *   6. a server refusal shows the server's OWN reason, and no internet shows
 *      "Network error. Try again." — the form stays open either way, so the
 *      owner's typing is never thrown away;
 *   7. Cancel closes the form without touching the server;
 *   8. the whole form reads in Amharic when the device is set to Amharic.
 *
 * Requires the `jsdom` devDependency (no browser, no database, no server).
 * Run with: npx tsx scripts/verify-staff-edit-ui.tsx   (wired into `npm test`)
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
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
g.MouseEvent = dom.window.MouseEvent;
g.CustomEvent = dom.window.CustomEvent;
g.localStorage = dom.window.localStorage;
g.sessionStorage = dom.window.sessionStorage;
g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.IS_REACT_ACT_ENVIRONMENT = true;

/* ── the mocked server: the exact shapes GET/PUT /api/staff answer with ───── */

const SERVER_ROLES = ["waiter", "cashier", "barista", "kitchen", "buna", "juice", "admin"];

interface Row {
  id: number;
  name: string;
  role: string;
  /** The API never returns a PIN — only whether one is set. */
  pinSet: boolean;
  alertsOff?: boolean;
}

const staff: Row[] = [
  { id: 1, name: "Samuel", role: "waiter", pinSet: true },
  { id: 2, name: "Hanna", role: "cashier", pinSet: true, alertsOff: true },
  { id: 3, name: "Abnet", role: "buna", pinSet: false },
];

/** "serverError" answers the way the real route does: { error } + a 500. */
let mode: "ok" | "serverError" | "offline" = "ok";
const calls: Array<{ url: string; init?: RequestInit }> = [];
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const bad = (status: number, body: unknown) => ({ ok: false, status, json: async () => body });

const fakeFetch = async (url: string, init?: RequestInit) => {
  calls.push({ url: String(url), init });
  if (mode === "offline") throw new TypeError("Failed to fetch");
  const u = String(url);
  const method = init?.method || "GET";

  if (u === "/api/staff" && method === "GET") return ok(staff.map((s) => ({ ...s })));

  if (u === "/api/staff" && method === "PUT") {
    if (mode === "serverError") return bad(500, { error: "That name is already used by another staff member." });
    const body = JSON.parse(String(init?.body));
    if (!body.id) return bad(400, { error: "ID required" });
    const row = staff.find((s) => s.id === Number(body.id));
    if (!row) return bad(404, { error: "Not found" });
    if (typeof body.name === "string") row.name = body.name;
    // The server ignores an unknown role instead of storing it.
    if (SERVER_ROLES.includes(body.role)) row.role = body.role;
    if (body.pin) row.pinSet = true;
    return ok({ ...row, pinSet: row.pinSet });
  }

  return ok({});
};
(dom.window as unknown as { fetch: unknown }).fetch = fakeFetch;
g.fetch = fakeFetch;

async function main() {
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { setStaffLang } = await import("../src/lib/staff-i18n");
  const StaffTab = (await import("../src/components/rms/StaffTab")).default;

  let failures = 0;
  const pass = (name: string, cond: boolean, extra = "") => {
    console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
    if (!cond) failures++;
  };

  const host = dom.window.document.getElementById("root")!;
  const text = () => (host.textContent || "").replace(/\s+/g, " ");
  const buttonsByText = (needle: string) =>
    [...host.querySelectorAll("button")].filter((b) => (b.textContent || "").includes(needle));
  const editButtons = () => [...host.querySelectorAll('button[title="Edit"]')] as HTMLButtonElement[];
  /** The staff card that shows this person (the innermost one holding it). */
  const cardOf = (name: string) => {
    const cands = [...host.querySelectorAll("div")].filter(
      (d) => (d.textContent || "").includes(name) && d.querySelector('button[title="Edit"], button[title="አስተካክል"]')
    );
    return cands.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length)[0] ?? null;
  };
  /** The open edit form (the only card with the gold editing border). */
  const editCard = () =>
    [...host.querySelectorAll("div")].find((d) => String(d.className).includes("#C9A227]/50")) ?? null;

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
    await flush();
  };
  const setInput = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const setSelect = async (sel: HTMLSelectElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")!.set!;
      setter.call(sel, value);
      sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
  };
  const lastPut = () => [...calls].reverse().find((c) => c.init?.method === "PUT");
  const putBody = () => JSON.parse(String(lastPut()?.init?.body)) as Record<string, unknown>;

  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(StaffTab));
  });
  await flush();

  /* ── 1. the list, and an Edit button on every card ─────────────────────── */
  pass("the staff list loads", calls.some((c) => c.url === "/api/staff") && text().includes("Samuel"));
  pass("every person has an Edit button", editButtons().length === staff.length, `found ${editButtons().length}`);
  pass(
    "Edit sits beside Remove, it does not replace it",
    host.querySelectorAll('button[title="Remove"]').length === staff.length && editButtons().length === staff.length
  );

  /* ── 2. opening Edit pre-fills the person, PIN box empty ───────────────── */
  await click(cardOf("Samuel")?.querySelector('button[title="Edit"]') ?? null);
  const form = editCard();
  pass("tapping Edit opens the form on that card", !!form);
  const nameInput = form?.querySelectorAll("input")[0] as HTMLInputElement | undefined;
  const pinInput = form?.querySelectorAll("input")[1] as HTMLInputElement | undefined;
  const roleSelect = form?.querySelector("select") as HTMLSelectElement | undefined;
  pass("the name box already holds their name", nameInput?.value === "Samuel", nameInput?.value ?? "(no input)");
  pass("the role box already holds their screen", roleSelect?.value === "waiter", roleSelect?.value ?? "(no select)");
  pass("the PIN box is EMPTY, so their PIN is not shown to anyone", pinInput?.value === "");
  pass("the PIN box explains that empty means keep", /keep the current/i.test(pinInput?.placeholder || ""), pinInput?.placeholder || "");
  pass("nothing is sent to the server just by opening the form", !calls.some((c) => c.init?.method === "PUT"));

  /* ── 3. fixing a name with an empty PIN box keeps the login ────────────── */
  await setInput(nameInput!, "Samuel Tadesse");
  await click(buttonsByText("Save")[buttonsByText("Save").length - 1]);
  pass("Save sends PUT /api/staff", lastPut()?.url === "/api/staff");
  pass("the new name is sent with the person's id", putBody().id === 1 && putBody().name === "Samuel Tadesse", JSON.stringify(putBody()));
  pass("NO pin is sent when the box is empty — the person keeps their login", !("pin" in putBody()), JSON.stringify(putBody()));
  pass("success is said out loud", text().includes("✓ Staff account updated"), text().slice(0, 200));
  pass("the form closes and the list shows the new name", !editCard() && text().includes("Samuel Tadesse"));

  /* ── 4. handing over a NEW pin, and refusing a silly one ───────────────── */
  await click(cardOf("Hanna")?.querySelector('button[title="Edit"]') ?? null);
  const form2 = editCard()!;
  const pin2 = form2.querySelectorAll("input")[1] as HTMLInputElement;
  const sel2 = form2.querySelector("select") as HTMLSelectElement;
  await setSelect(sel2, "barista");
  await setInput(pin2, "12");
  calls.length = 0;
  await click(buttonsByText("Save")[buttonsByText("Save").length - 1]);
  pass("a PIN shorter than 4 characters is refused", text().includes("PIN must be at least 4 characters."));
  pass("a refused PIN never reaches the server", !calls.some((c) => c.init?.method === "PUT"));
  pass("the form stays open so the owner can fix the PIN", !!editCard());

  await setInput(pin2, "9876");
  await click(buttonsByText("Save")[buttonsByText("Save").length - 1]);
  pass("a typed PIN is sent as the new PIN", putBody().pin === "9876", JSON.stringify(putBody()));
  pass("moving someone to another screen is sent too", putBody().role === "barista", JSON.stringify(putBody()));
  pass("their name is not lost while changing the PIN", putBody().name === "Hanna", JSON.stringify(putBody()));

  /* ── 5. Cancel touches nothing ─────────────────────────────────────────── */
  await click(cardOf("Abnet")?.querySelector('button[title="Edit"]') ?? null);
  calls.length = 0;
  await click(buttonsByText("Cancel")[buttonsByText("Cancel").length - 1]);
  pass("Cancel closes the form", !editCard());
  pass("Cancel sends nothing", calls.filter((c) => c.init?.method === "PUT").length === 0);

  /* ── 6. an empty name cannot be saved ──────────────────────────────────── */
  await click(cardOf("Abnet")?.querySelector('button[title="Edit"]') ?? null);
  const name3 = editCard()!.querySelectorAll("input")[0] as HTMLInputElement;
  await setInput(name3, "   ");
  const saveBtn = buttonsByText("Save")[buttonsByText("Save").length - 1] as HTMLButtonElement;
  pass("Save is disabled while the name is blank", saveBtn.disabled === true);
  await setInput(name3, "Abnet");

  /* ── 7. the server says no: the owner reads WHY ────────────────────────── */
  mode = "serverError";
  calls.length = 0;
  await click(buttonsByText("Save")[buttonsByText("Save").length - 1]);
  pass("a server refusal is sent to the screen", calls.some((c) => c.init?.method === "PUT"));
  pass("the server's own reason is shown", text().includes("That name is already used by another staff member."), text().slice(0, 240));
  pass("the form stays open after a refusal", !!editCard());

  /* ── 8. no internet at all: still an answer ────────────────────────────── */
  mode = "offline";
  await click(buttonsByText("Save")[buttonsByText("Save").length - 1]);
  pass("no internet says 'Network error. Try again.'", text().includes("Network error. Try again."));
  pass("the typing survives a dead connection", (editCard()?.querySelectorAll("input")[0] as HTMLInputElement)?.value === "Abnet");
  mode = "ok";

  /* ── 9. Amharic: the whole edit form follows the device language ───────── */
  await click(buttonsByText("Cancel")[buttonsByText("Cancel").length - 1]);
  await act(async () => {
    setStaffLang("am");
  });
  await flush();
  pass("every Edit button reads in Amharic", host.querySelectorAll('button[title="አስተካክል"]').length === staff.length);
  pass("no English Edit title is left behind", host.querySelectorAll('button[title="Edit"]').length === 0);
  await click(cardOf("Abnet")?.querySelector('button[title="አስተካክል"]') ?? null);
  const amForm = editCard();
  pass("the Amharic form has its own Save and Cancel", /አስቀምጥ/.test(text()) && /ይቅር/.test(text()));
  const amPin = amForm?.querySelectorAll("input")[1] as HTMLInputElement | undefined;
  pass("the PIN hint is Amharic and still says PIN", /PIN/.test(amPin?.placeholder || "") && /[\u1200-\u137F]/.test(amPin?.placeholder || ""), amPin?.placeholder || "");
  pass("no raw English sentence is left on the edit form", !/leave empty to keep/i.test(text()));
  await act(async () => {
    setStaffLang("en");
  });

  console.log(
    failures === 0
      ? "\n✅ staff edit UI checks passed"
      : `\n❌ ${failures} staff edit UI assertions FAILED`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
