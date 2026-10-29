#!/usr/bin/env tsx
/** Mounted regression test: queued scans must appear in an already-open paper
 * sheet on the attendance event, with a polling fallback and no page jump. */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { etDayKeyDaysAgo } from "../src/lib/timezone";

const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://fana.test/admin", pretendToBeVisual: true });
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.localStorage = dom.window.localStorage;
g.IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: (() => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  closed = false;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  close() { this.closed = true; this.readyState = 2; }
}
g.EventSource = FakeEventSource;
const intervals = new Map<number, { callback: () => void; ms: number }>();
let intervalId = 0;
g.setInterval = (callback: () => void, ms: number) => { const id = ++intervalId; intervals.set(id, { callback, ms }); return id; };
g.clearInterval = (id: number) => { intervals.delete(id); };

const dates = Array.from({ length: 8 }, (_, i) => etDayKeyDaysAgo(7 - i)!);
const today = dates[7];
let times = ["", "", ""];
let sheetCalls = 0;
let holdNext: ((value: unknown) => void) | null = null;
let holdRequested = false;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const sheet = (values: string[]) => ({
  dates, today, pages: [dates.slice(0, 7), dates.slice(7)],
  staffList: ["Abebe", "Mulu", "Sara"].map((name, i) => ({ id: i + 1, name, role: "Staff", registeredOn: "2020-01-01" })),
  matrix: Object.fromEntries(values.map((time, i) => [i + 1, {
    [today]: time ? { clockInTime: time, clockOutTime: null, inStatus: "on_time", outStatus: "still_in", clockInMethod: "fingerprint" } : null,
  }])),
});
const fakeFetch = async (url: string) => {
  const path = String(url);
  if (path.startsWith("/api/attendance/logs?")) {
    sheetCalls++;
    const response = ok(sheet([...times]));
    if (holdRequested) {
      holdRequested = false;
      return await new Promise((resolve) => { holdNext = resolve; });
    }
    return response;
  }
  if (path === "/api/attendance/roles" || path === "/api/attendance/members") return ok([]);
  if (path === "/api/attendance/today") return ok({ date: today, logs: [], stats: { present: 0, completed: 0, stillIn: 0, late: 0, overtime: 0 } });
  return ok({});
};
g.fetch = fakeFetch;
(dom.window as unknown as { fetch: unknown }).fetch = fakeFetch;

async function main() {
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const AttendanceTab = (await import("../src/components/rms/AttendanceTab")).default;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
  const click = async (label: string) => {
    const button = [...host.querySelectorAll("button")].find((el) => el.textContent?.trim() === label);
    assert.ok(button, `button ${label}`);
    await act(async () => button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    await flush();
  };
  await act(async () => root.render(React.createElement(AttendanceTab)));
  await flush();
  await click("Paper Sheet View");
  assert.equal(sheetCalls, 1, "opening the sheet loads it");
  await click("2");
  const activeText = () => host.querySelector(".sheet-page.is-active")?.textContent || "";
  assert.match(activeText(), /Page 2 of 2/);

  // Three queued scans arrive while the paper view remains open.
  times = ["08:01", "08:03", "08:05"];
  const eventSource = FakeEventSource.instances.filter((s) => !s.closed && s.url.includes("attendance")).at(-1)!;
  await act(async () => { eventSource.onmessage?.(); eventSource.onmessage?.(); eventSource.onmessage?.(); });
  await flush();
  assert.match(activeText(), /Page 2 of 2/, "background refresh must not reset the page");
  for (const value of ["Abebe", "Mulu", "Sara", "08:01", "08:03", "08:05"]) assert.ok(activeText().includes(value), value);
  assert.ok(sheetCalls <= 3, "burst events are coalesced");

  // Even if the SSE event was lost, the visible-page timer catches the change.
  times = ["09:11", "09:12", "09:13"];
  const timer = [...intervals.values()].find((i) => i.ms === 8000);
  assert.ok(timer, "eight-second fallback is active even when SSE is connected");
  await act(async () => timer.callback());
  await flush();
  assert.match(activeText(), /09:11/);
  assert.match(activeText(), /Page 2 of 2/);

  // Ignore a slow response from an old view after navigation (even if a fake
  // transport disregards abort), and close its stream/timer.
  holdRequested = true;
  await act(async () => eventSource.onmessage?.());
  await flush();
  assert.ok(holdNext);
  await click("Today Live");
  assert.equal(eventSource.closed, true);
  times = ["10:21", "10:22", "10:23"];
  await click("Paper Sheet View");
  await act(async () => { (holdNext as unknown as (v: unknown) => void)(ok(sheet(["01:01", "01:02", "01:03"]))); });
  await flush();
  assert.ok(!host.textContent?.includes("01:01"), "stale response must be ignored after leaving the view");
  assert.ok(host.textContent?.includes("10:21"));
  await act(async () => root.unmount());
  assert.equal(intervals.size, 0);
  console.log("Attendance sheet UI passed: automatic three-person refresh, fallback, page preservation and stale-response protection.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
