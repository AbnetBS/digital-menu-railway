#!/usr/bin/env tsx
/** Mounted smoke test of the CASH PAYROLL table (owner, 2026-11-07).
 *
 *  It mounts the real component with a fake API and checks the things the
 *  owner asked for by name:
 *    - No. / Employee Name / Net pay / Signature, and a TOTAL line
 *    - New person (a name with no fingerprint) and From attendance both work
 *    - clicking a name makes it renameable, and the rename is saved
 *    - the bin at the end of a row deletes it
 *    - the cash print button asks the payroll page to print the cash sheet
 */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

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
g.confirm = () => true;
g.IS_REACT_ACT_ENVIRONMENT = true;

const rows = [
  { id: 1, memberId: 1, name: "Abebe Kebede", netPay: 4000, note: "", paid: false, paidAt: null, fromAttendance: true, sortOrder: 1 },
  { id: 2, memberId: null, name: "Dawit handyman", netPay: 2500.5, note: "", paid: false, paidAt: null, fromAttendance: false, sortOrder: 2 },
];
const addable = [{ id: 2, name: "Sara Mulu", role: "Waiter" }];
const signoff = { preparedBy: "", checkedBy: "", approvedBy: "" };
const calls: Array<Record<string, unknown>> = [];
let serverRows = [...rows];
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const fakeFetch = async (url: string, init?: { method?: string; body?: string }) => {
  if (!init || init.method !== "POST") return ok({ periodKey: "2019-02", rows: serverRows, signoff, addable, total: 0, count: serverRows.length });
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  calls.push(body);
  if (body.action === "add_name") {
    serverRows = [...serverRows, { id: 3, memberId: null, name: String(body.name), netPay: Number(body.netPay) || 0, note: "", paid: false, paidAt: null, fromAttendance: false, sortOrder: 3 }];
  }
  if (body.action === "rename") serverRows = serverRows.map((r) => (r.id === body.id ? { ...r, name: String(body.name) } : r));
  if (body.action === "remove") serverRows = serverRows.filter((r) => r.id !== body.id);
  if (body.action === "set_net_pay") serverRows = serverRows.map((r) => (r.id === body.id ? { ...r, netPay: Number(body.netPay) } : r));
  return ok({ success: true, rows: serverRows, signoff, addable, total: serverRows.reduce((s, r) => s + r.netPay, 0), count: serverRows.length });
};
g.fetch = fakeFetch;
(dom.window as unknown as { fetch: unknown }).fetch = fakeFetch;

async function main() {
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const CashPayrollPanel = (await import("../src/components/rms/CashPayrollPanel")).default;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  // The panel loads its rows in its own effect; a few turns of the event loop
  // let the fetch promise, the state write and the re-render all finish.
  const flush = async () => {
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
    }
  };
  let printed = 0;
  const click = async (label: string) => {
    const el = [...host.querySelectorAll("button")].find((b) => b.textContent?.replace(/\s+/g, " ").trim() === label);
    assert.ok(el, `button "${label}"`);
    await act(async () => el!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    await flush();
  };
  const typeInto = async (el: HTMLInputElement | HTMLSelectElement, value: string) => {
    const proto = el instanceof dom.window.HTMLSelectElement ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    await act(async () => el.dispatchEvent(new dom.window.Event(el instanceof dom.window.HTMLSelectElement ? "change" : "input", { bubbles: true })));
    await flush();
  };

  await act(async () => {
    root.render(
      React.createElement(CashPayrollPanel, {
        period: "2019-02",
        monthLabel: "Tikimt 2019 E.C",
        dateEc: "2019-02-30",
        dateLabel: "09 November 2026",
        companyName: "FANA CAFÉ & RESTAURANT PLC",
        tin: "00 85 22 21 19",
        onChanged: () => {},
        onSaved: () => {},
        onFailed: () => {},
        onPrint: () => { printed++; },
      })
    );
  });
  await flush();
  await flush();

  const screen = host.textContent || "";
  assert.match(screen, /CASH PAYROLL \(no TIN\)/, "the table is titled");
  for (const head of ["S No", "Employee Name", "Net pay", "TOTAL (2 people)"]) assert.ok(screen.includes(head), `header ${head}`);
  assert.ok(screen.includes("4,000.00") && screen.includes("2,500.50"), "both net pays are shown on screen");
  console.log("✅ No. / Employee Name / Net pay and the TOTAL line are there");

  // 1. New person: a name with no fingerprint at all.
  await click("New person");
  const nameInput = [...host.querySelectorAll("input")].find((i) => i.placeholder === "e.g. Abebe Kebede") as HTMLInputElement;
  assert.ok(nameInput, "the new person name field");
  await typeInto(nameInput, "Meseret typist");
  const payInput = [...host.querySelectorAll("input")].find((i) => i.placeholder === "0.00") as HTMLInputElement;
  await typeInto(payInput, "1800");
  await click("Add");
  const addCall = calls.find((c) => c.action === "add_name");
  assert.ok(addCall && addCall.name === "Meseret typist" && addCall.netPay === 1800, JSON.stringify(addCall));
  assert.ok((host.textContent || "").includes("Meseret typist"), "the typed person appears in the row");
  console.log("✅ New person with no fingerprint is added with his net pay");

  // 2. From attendance: an existing member, with a picker.
  await click("From attendance");
  const select = host.querySelector("select") as HTMLSelectElement;
  assert.ok(select, "the attendance picker");
  assert.ok(select.textContent?.includes("Sara Mulu"), "the addable member is offered");
  await typeInto(select, "2");
  await click("Add");
  assert.ok(calls.some((c) => c.action === "add_member" && c.memberId === 2), "add_member was sent");
  console.log("✅ a person from the attendance list can be added");

  // 3. Click the name -> renameable -> saved.
  const renameButton = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Abebe Kebede"));
  assert.ok(renameButton, "the name is a button");
  await act(async () => renameButton!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  await flush();
  const editInput = [...host.querySelectorAll("input")].find((i) => i.value === "Abebe Kebede") as HTMLInputElement;
  assert.ok(editInput, "clicking the name opens an input with the current name");
  await typeInto(editInput, "Abebe K. Bekele");
  await act(async () => editInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await flush();
  assert.ok(calls.some((c) => c.action === "rename" && c.id === 1 && c.name === "Abebe K. Bekele"), "rename was sent");
  console.log("✅ clicking the name makes it renameable, and the rename is saved (member rename included on the server)");

  // 4. Net pay typed in place.
  const payButton = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "4,000.00");
  assert.ok(payButton, "the net pay cell is clickable");
  await act(async () => payButton!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  await flush();
  const payEdit = [...host.querySelectorAll("input")].find((i) => i.value === "4000") as HTMLInputElement;
  assert.ok(payEdit, "the pay input opens");
  await typeInto(payEdit, "4200");
  await act(async () => payEdit.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await flush();
  assert.ok(calls.some((c) => c.action === "set_net_pay" && c.netPay === 4200), "set_net_pay was sent");
  console.log("✅ the net pay is typed in the row and saved");

  // 5. The bin at the end of the row deletes it.
  // It asks first, in the panel itself (no blocking browser confirm).
  const before = calls.filter((c) => c.action === "remove").length;
  const bin = host.querySelector('button[aria-label="Remove Dawit handyman"]') as HTMLButtonElement;
  assert.ok(bin, "the delete button is at the end of the row");
  const clickEl = async (el: Element | null) => {
    assert.ok(el, "clickable");
    await act(async () => el!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    await flush();
  };
  await clickEl(bin);
  await clickEl([...host.querySelectorAll("button")].find((b) => b.textContent?.replace(/\s+/g, " ").trim() === "Keep him") ?? null);
  assert.equal(calls.filter((c) => c.action === "remove").length, before, "Keep him removes nothing");
  await clickEl(host.querySelector('button[aria-label="Remove Dawit handyman"]'));
  await clickEl([...host.querySelectorAll("button")].find((b) => b.textContent?.replace(/\s+/g, " ").trim() === "Remove him") ?? null);
  assert.ok(calls.some((c) => c.action === "remove" && c.id === 2), "remove was sent");
  assert.ok(!(host.textContent || "").includes("Dawit handyman"), "the deleted person is gone from the table");
  console.log("✅ the bin at the end of the row deletes that employee");

  // 6. The cash print button asks for the cash sheet.
  await click("Print cash sheet");
  assert.equal(printed, 1, "the cash print was asked for");
  console.log("✅ the separate cash print button fires");

  // 7. The printed sheet itself: the owner's four columns and the sign-off.
  const printedSheet = host.querySelector(".cash-print-sheet");
  assert.ok(printedSheet, "the print sheet exists");
  const text = printedSheet!.textContent || "";
  assert.ok(text.includes("CASH ON HAND FOR THE MONTH OF TIKIMT 2019 E.C"), text.slice(0, 200));
  assert.ok(text.includes("CASH PAYROLL SHEET") && text.includes("TIN NO"));
  for (const head of ["S No", "Employee Name", "Net pay", "Signature"]) assert.ok(text.includes(head), `printed ${head}`);
  for (const who of ["Prepared by", "Checked by", "Approved by"]) assert.ok(text.includes(who), `printed ${who}`);
  assert.ok(!/tax|pension|transport/i.test(text), "no tax, pension or transport column on the cash paper");
  console.log("✅ the printed cash sheet is his Excel: title, four columns, total, Prepared / Checked / Approved");

  const css = readFileSync(new URL("../src/components/rms/CashPayrollPanel.tsx", import.meta.url), "utf8");
  assert.ok(css.includes("cash-print-mode > .print-sheet { display: none"), "the cash print hides the TIN sheet");
  console.log("✅ the cash print never prints the 18 column TIN sheet");

  console.log("\n✅ CASH PAYROLL UI PASSED\n");
}
main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
