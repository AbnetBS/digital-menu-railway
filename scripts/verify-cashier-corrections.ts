import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isCashierItemLocked, isCashierOrderLocked } from "../src/lib/cashier-corrections";

const now = Date.parse("2026-09-21T12:00:00Z");
const stamp = (age: number) => new Date(now - age);
const ticket = { status: "confirmed", createdAt: stamp(900_000), confirmedAt: stamp(60_000) };
const item = { createdAt: stamp(900_000), stationStatus: "pending", removed: false };

assert.equal(isCashierItemLocked(item, ticket, now), false, "sent pending item stays editable regardless of age");
assert.equal(isCashierItemLocked({ ...item, stationStatus: "accepted" }, ticket, now), false, "accepted item is still editable until done");
assert.equal(isCashierItemLocked({ ...item, stationStatus: "done" }, ticket, now), true, "done item locks immediately");
const old = { ...ticket, confirmedAt: stamp(60 * 60 * 1000) };
assert.equal(isCashierItemLocked(item, old, now), false, "old sent item no longer locks by time");
assert.equal(isCashierItemLocked(item, { ...ticket, confirmedAt: null }, now), false, "held orders remain editable");
const addition = { ...item, createdAt: stamp(1000) };
assert.equal(isCashierItemLocked(addition, old, now), false, "new line also stays editable until done");
assert.equal(isCashierOrderLocked({ ...old, items: [item, addition] }, now), false, "old pending dishes no longer block whole-order cancel");
assert.equal(isCashierOrderLocked({ ...ticket, items: [{ ...item, stationStatus: "done" }] }, now), true, "a live done item blocks whole-order cancel");
assert.equal(isCashierOrderLocked({ ...ticket, items: [{ ...item, stationStatus: "done", removed: true }, addition] }, now), false, "removed done items do not lock the remaining live bill");
assert.equal(isCashierItemLocked(item, { ...old, printedAt: stamp(1) }, now), false, "printing does not lock corrections");
assert.equal(isCashierItemLocked(item, { ...ticket, status: "closed" }, now), true, "finished tickets remain locked");

const cashier = readFileSync("src/components/rms/CashierDashboard.tsx", "utf8");
assert.match(cashier, /editTarget && canKeepEditing/);
assert.doesNotMatch(cashier, /setInterval\(\(\) => setNowTick\(Date.now\(\)\), 1000\)/);
assert.match(cashier, /onClick=\{\(\) => markPrinted\(t\)\}/);
for (const route of ["src/app/api/tickets/route.ts", "src/app/api/tickets/items/route.ts"]) {
  const source = readFileSync(route, "utf8");
  assert.match(source, /actorRole === "cashier"/);
  assert.match(source, /for\("update"\)/);
  assert.match(source, /CORRECTION_LOCK_MESSAGE/);
  assert.match(source, /status: 409/);
}
console.log("✓ Cashier corrections: station Done locks edits/cancel, sent age no longer locks, live editor and API guards");
