#!/usr/bin/env tsx
/**
 * Regression guard for incremental EFD receipts.
 *
 * The cashier keys only new work for receipt #2 (and later prints). A ticket's
 * printed_at column is only the latest print, so reports must use the print
 * audit plus quantity-change history to avoid re-counting old lines or merged
 * quantity top-ups.
 */
import assert from "node:assert/strict";
import { receiptPrintTimes, saleLinesForTicket, sumSaleItems } from "../src/lib/printed-sales";

const at = (time: string) => new Date(`2026-09-24T${time.length === 5 ? `${time}:00` : time}+03:00`);
const ticket = { id: 91, status: "printed", printedAt: at("10:50") };
const items = [
  // Two cups on receipt #1, one top-up on #2, one more on #3. A fourth cup
  // arrived after the last print and must remain outside every sales total.
  { id: 1, name: "Macchiato", price: 100, quantity: 4, removed: false, createdAt: at("09:00") },
  // A new line after receipt #1: it belongs only to receipt #2.
  { id: 2, name: "Tea", price: 50, quantity: 2, removed: false, createdAt: at("10:10") },
  // A new line after receipt #2: it belongs only to receipt #3.
  { id: 3, name: "Cake", price: 70, quantity: 1, removed: false, createdAt: at("10:35") },
  // Not yet on an EFD receipt.
  { id: 4, name: "Water", price: 20, quantity: 1, removed: false, createdAt: at("10:55") },
];
const printEvents = [at("10:00"), at("10:30"), at("10:50:01")];
const quantityEvents = [
  { itemId: 1, eventType: "item_quantity_changed", fromValue: "2", toValue: "3", createdAt: at("10:15") },
  { itemId: 1, eventType: "item_quantity_changed", fromValue: "3", toValue: "4", createdAt: at("10:40") },
];

const receipts = receiptPrintTimes(ticket, printEvents);
assert.deepEqual(receipts.map((date) => date.toISOString()), [
  at("10:00").toISOString(),
  at("10:30").toISOString(),
  at("10:50").toISOString(),
], "the ticket's exact latest printed_at should replace the delayed audit insert");

const lines = saleLinesForTicket(ticket, items, true, printEvents, quantityEvents);
const receiptTotals = new Map<string, number>();
for (const line of lines) {
  const receipt = new Date(String(line.soldAt)).toISOString();
  receiptTotals.set(receipt, (receiptTotals.get(receipt) || 0) + line.item.price * line.item.quantity);
}
assert.deepEqual([...receiptTotals.entries()], [
  [at("10:00").toISOString(), 200],
  [at("10:30").toISOString(), 200],
  [at("10:50").toISOString(), 170],
]);
assert.equal(sumSaleItems(lines.map((line) => line.item)), 570, "all three receipts count each quantity once");
assert.deepEqual(lines.map((line) => [line.item.id, line.item.quantity]), [
  [1, 2],
  [1, 1],
  [1, 1],
  [2, 2],
  [3, 1],
]);
assert.ok(!lines.some((line) => line.item.id === 4), "new items after the latest print are excluded");

// A cancelled bill and a removed line are not sales, even if a print exists.
assert.equal(saleLinesForTicket({ ...ticket, status: "cancelled" }, items, true, printEvents, quantityEvents).length, 0);
assert.equal(saleLinesForTicket(ticket, [{ ...items[0], removed: true }], true, printEvents, quantityEvents).length, 0);

console.log("✅ Incremental EFD receipt accounting regression test PASSED");
console.log("   • old printed items stay on their original receipt after a reprint");
console.log("   • merged quantity additions are split using item_quantity_changed history");
console.log("   • new item rows count on their first receipt only; post-print work is excluded");
