#!/usr/bin/env tsx
/** Mounted regression test for the actual Add Fingerprint panel. */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

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
  closed = false;
  readyState = 1;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  close() { this.closed = true; this.readyState = 2; }
}
g.EventSource = FakeEventSource;
const intervals = new Map<number, { callback: () => void; ms: number }>();
let intervalId = 0;
g.setInterval = (callback: () => void, ms: number) => { const id = ++intervalId; intervals.set(id, { callback, ms }); return id; };
g.clearInterval = (id: number) => { intervals.delete(id); };

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const people = [{ id: 1, name: "Abebe", roleId: null, roleName: "Staff", pinSet: false, active: true, fingers: [] }];
type Job = { id: number; status: string; detail: string | null; startedAt: string | null; memberName: string };
const jobs = new Map<number, Job>();
let created = 0;
let heldOldResponse: ((value: unknown) => void) | null = null;
let holdOldRequest = false;
let deferPosts = false;
const postResolvers = new Map<number, (value: unknown) => void>();
const fakeFetch = async (url: string, options?: { method?: string; body?: string }) => {
  const path = String(url);
  if (path === "/api/attendance/roles") return ok([]);
  if (path === "/api/attendance/members") return ok(people);
  if (path === "/api/attendance/today") return ok({ date: "2026-10-29", logs: [], stats: {} });
  if (path === "/api/attendance/biometrics" && options?.method === "POST") {
    const body = JSON.parse(options.body || "{}");
    if (body.action === "enroll") {
      const id = ++created;
      jobs.set(id, { id, status: "pending", detail: null, startedAt: null, memberName: "Abebe" });
      const response = ok({ job: { id, fingerprintId: id + 4 }, message: "Waiting for Abebe" });
      if (deferPosts) return await new Promise((resolve) => { postResolvers.set(id, resolve); });
      return response;
    }
    if (body.action === "cancel") return ok({ success: true });
  }
  if (path.startsWith("/api/attendance/biometrics?job=")) {
    const id = Number(path.split("=")[1]);
    const job = jobs.get(id);
    assert.ok(job, `unknown job ${id}`);
    const response = ok({ job: { ...job } });
    if (holdOldRequest && id === 1) {
      holdOldRequest = false;
      return await new Promise((resolve) => { heldOldResponse = resolve; });
    }
    return response;
  }
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
  const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 15)); }); };
  const click = async (label: string) => {
    const button = [...host.querySelectorAll("button")].find((el) => el.textContent?.trim() === label);
    assert.ok(button, `button ${label}`);
    await act(async () => button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    await flush();
  };
  await act(async () => root.render(React.createElement(AttendanceTab)));
  await flush();
  await click("Staff Members");
  await click("Add Fingerprint");
  assert.match(host.textContent || "", /Waiting for the scanner/);
  assert.doesNotMatch(host.textContent || "", /device shows his name now/i);

  // The SSE connection remains OPEN, but no event is delivered. The timer
  // must still discover that the device has picked up the request.
  const job = jobs.get(1)!;
  job.startedAt = "2026-10-29T12:00:00Z";
  job.detail = "Scanner received the request. Wait for PLACE FINGER on its screen";
  const eventSource = FakeEventSource.instances.find((es) => !es.closed && es.url.includes("channel=device"));
  assert.ok(eventSource && eventSource.readyState === 1);
  const timer = [...intervals.values()].find((entry) => entry.ms === 2000);
  assert.ok(timer, "polling runs even with an open but silent SSE stream");
  await act(async () => timer.callback());
  await flush();
  assert.match(host.textContent || "", /Scanner received the request/);
  assert.match(host.textContent || "", /Wait for PLACE FINGER/);

  // A slow response for a cancelled job must not mark a new job as failed,
  // even when the transport ignores AbortController.
  holdOldRequest = true;
  await act(async () => timer.callback());
  await flush();
  assert.ok(heldOldResponse);
  await click("Cancel");
  await click("Add Fingerprint");
  assert.match(host.textContent || "", /ID 6/);
  await act(async () => {
    (heldOldResponse as unknown as (value: unknown) => void)(ok({ job: { ...job, status: "failed", detail: "old failure" } }));
  });
  await flush();
  assert.match(host.textContent || "", /ID 6/);
  assert.doesNotMatch(host.textContent || "", /old failure/);

  // A completed current job is reflected without a stream event.
  const current = jobs.get(2)!;
  current.status = "done";
  const newTimer = [...intervals.values()].find((entry) => entry.ms === 2000);
  assert.ok(newTimer);
  await act(async () => newTimer.callback());
  await flush();
  assert.match(host.textContent || "", /Fingerprint Added/);
  await act(async () => root.unmount());
  assert.equal(intervals.size, 0);

  // Two fast clicks must not create overlapping jobs while the first request
  // is still in flight. The button also shows a clear sending state.
  jobs.clear(); created = 0; heldOldResponse = null; deferPosts = true; postResolvers.clear();
  const secondRoot = createRoot(host);
  await act(async () => secondRoot.render(React.createElement(AttendanceTab)));
  await flush();
  await click("Staff Members");
  const addButton = [...host.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Add Fingerprint");
  assert.ok(addButton);
  await act(async () => {
    addButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    addButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(postResolvers.size, 1);
  assert.match(host.textContent || "", /Sending\.\.\./);
  await act(async () => postResolvers.get(1)!(ok({ job: { id: 1, fingerprintId: 5 } })));
  await flush();
  assert.match(host.textContent || "", /ID 5/);
  await act(async () => secondRoot.unmount());
  assert.equal(intervals.size, 0);
  console.log("Enrollment UI passed: truthful waiting state, silent-stream polling, current-job success and stale-response protection.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
