#!/usr/bin/env tsx
/**
 * Render-level guard for THE OWNER'S NOTIFY TIME, to the minute
 * (owner's decision, 30 Sept 2026).
 *
 * WHAT HE ASKED FOR, in his words: "can you make the time change button on the
 * sales cathagory customizable not only 3 hours 3,4,5 make it look like i can
 * add any time like 3:03 or any other make it changable to any then add save
 * button on the right after i change it".
 *
 * The Daily Sales tab used to offer three fixed hours (3:00 / 4:00 / 5:00
 * local). It now carries a real time field, the three hours are only quick
 * picks that fill it, and a SAVE button sits on its right — nothing is stored
 * until he presses it.
 *
 * This mounts the REAL tab in jsdom against a fake server and proves:
 *   1. the field shows the saved time and takes any minute (21:03);
 *   2. SAVE is the only thing that stores it, and it posts hour AND minute;
 *   3. a quick pick only FILLS the field (the owner still presses Save);
 *   4. the two moments on the page read to the minute (20:03 / 21:03), so the
 *      cashier's button and the automatic send are never a lie;
 *   5. the whole tab reads in Amharic too.
 *
 * Run with: npx tsx scripts/verify-notify-time-ui.tsx   (wired into `npm test`)
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "https://fana.test/admin?tab=sales",
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
for (const key of ["HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent", "CustomEvent", "localStorage", "sessionStorage"]) {
  g[key] = (dom.window as unknown as Record<string, unknown>)[key];
}
g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.IS_REACT_ACT_ENVIRONMENT = true;

/* ── the fake server: one stored setting, exactly like site_settings ─────── */

let stored = "21:00"; // what day_close_notify_hour holds
const posts: Array<Record<string, unknown>> = [];

const state = () => {
  const [h, m] = stored.split(":").map(Number);
  const cutoff = `${String(h - 1).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return {
    serverTime: new Date().toISOString(),
    notifyHour: h,
    notifyMinute: m,
    notifyAt: stored,
    cutoffHour: h - 1,
    cutoffMinute: m,
    cutoffAt: cutoff,
    currentHour: 19,
    currentMinute: 12,
    canClose: false,
    dueNow: false,
    todayKey: "2026-09-30",
    today: { total: 12450, bills: 88, closed: null },
    days: [{ dayKey: "2026-09-30", total: 12450, bills: 88, closed: null }],
  };
};

const fakeFetch = async (url: string, init?: RequestInit) => {
  const u = String(url);
  const method = init?.method || "GET";
  if (u.startsWith("/api/reports/daily-sales") && method === "POST") {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    posts.push(body);
    if (body.action === "set-notify-time") {
      stored = `${String(Number(body.hour)).padStart(2, "0")}:${String(Number(body.minute)).padStart(2, "0")}`;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, ...state() }) };
  }
  if (u.startsWith("/api/reports/daily-sales")) {
    return { ok: true, status: 200, json: async () => state() };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};
(dom.window as unknown as { fetch: unknown }).fetch = fakeFetch;
g.fetch = fakeFetch;

async function main() {
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { setStaffLang } = await import("../src/lib/staff-i18n");
  const DailySalesTab = (await import("../src/components/rms/DailySalesTab")).default;

  let failures = 0;
  const pass = (name: string, cond: boolean, extra = "") => {
    console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
    if (!cond) failures++;
  };

  const host = dom.window.document.getElementById("root")!;
  const text = () => (host.textContent || "").replace(/\s+/g, " ");
  const buttonsByText = (needle: string) =>
    [...host.querySelectorAll("button")].filter((b) => (b.textContent || "").includes(needle));
  const timeInput = () => host.querySelector<HTMLInputElement>("input[type='time']");
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
  const setTime = async (value: string) => {
    const input = timeInput();
    if (!input) throw new Error("no time field");
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(DailySalesTab));
    await new Promise((r) => setTimeout(r, 5));
  });
  await settle();

  /* ── 1. the field itself ──────────────────────────────────────────────── */
  pass("the owner gets a real TIME field, not three fixed hours", !!timeInput());
  pass("it shows the time that is stored (21:00)", timeInput()?.value === "21:00", String(timeInput()?.value));
  pass("it accepts any minute of the evening (12:00 .. 23:59)",
    timeInput()?.getAttribute("min") === "12:00" && timeInput()?.getAttribute("max") === "23:59");
  pass("SAVE sits beside it and does nothing while nothing changed",
    buttonsByText("Save").length === 1 && (buttonsByText("Save")[0] as HTMLButtonElement).disabled === true);

  /* ── 2. typing 21:03 and pressing Save ───────────────────────────────── */
  await setTime("21:03");
  pass("a typed time marks the change (Save wakes up, the page says so)",
    (buttonsByText("Save")[0] as HTMLButtonElement).disabled === false && text().includes("Not saved yet • press Save"));
  await click(buttonsByText("Save")[0]);
  await settle();
  pass("SAVE stores the exact minute: { action: set-notify-time, hour: 21, minute: 3 }",
    posts.length === 1 && posts[0].action === "set-notify-time" && posts[0].hour === 21 && posts[0].minute === 3,
    JSON.stringify(posts[0]));
  pass("the page then reads the server's own value back (21:03)",
    timeInput()?.value === "21:03" && text().includes("If she forgets, the system sends it by itself at 21:03."),
    String(timeInput()?.value));
  pass("...and the cashier's moment moves with it (one hour earlier, 20:03)",
    text().includes("Opens at 20:03"));

  /* ── 3. a quick pick only FILLS the field ────────────────────────────── */
  await click(buttonsByText("10:00 PM EAT")[0]);
  pass("a quick pick fills the field (22:00) without storing anything",
    timeInput()?.value === "22:00" && posts.length === 1 && text().includes("Not saved yet • press Save"),
    String(timeInput()?.value));
  await click(buttonsByText("Save")[0]);
  await settle();
  pass("pressing Save is what stores it", posts.length === 2 && posts[1].hour === 22 && posts[1].minute === 0,
    JSON.stringify(posts[1]));

  /* ── 4. it reads in Amharic too ──────────────────────────────────────── */
  setStaffLang("am");
  await act(async () => {
    root.render(React.createElement(DailySalesTab));
    await new Promise((r) => setTimeout(r, 5));
  });
  pass("the Amharic device reads the same picker in Amharic",
    /[\u1200-\u139F]/.test(text()) && text().includes("ፈጣን ምርጫዎች"), text().slice(0, 120));
  setStaffLang("en");

  await act(async () => root.unmount());

  if (failures > 0) {
    console.error(`\n❌ ${failures} notify-time check(s) failed\n`);
    process.exit(1);
  }
  console.log("\n✅ The owner picks ANY minute on the sales page, and Save is what stores it");
  console.log("   • 21:03 posts { action: set-notify-time, hour: 21, minute: 3 }");
  console.log("   • the quick picks only fill the field; both moments read to the minute");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
