#!/usr/bin/env tsx
/**
 * Regression guard: the SHIFT REPORT (cross-checker, Sept 2026).
 * Morning = before the shift change (14:00 EAT = 8:00 local), Afternoon = after,
 * Combined = 2+ people of the same role on one order. Pure, no database.
 */
import assert from "node:assert/strict";
import { buildShiftReport, type ShiftTicketRow, type ShiftItemRow } from "../src/lib/shift-report";
import { etDayKey } from "../src/lib/timezone";

const at = (hhmm: string) => new Date(`2026-09-24T${hhmm}:00+03:00`);
const day = etDayKey(at("10:00"))!;
const T = (id: number, o: Partial<ShiftTicketRow>): ShiftTicketRow => ({
  id, tableName: `Table ${id}`, orderNumber: `FANA-${id}`, orderType: "dine_in", status: "printed",
  totalAmount: 100, serviceNote: null, createdBy: null, confirmedBy: null, confirmedAt: null,
  printedBy: null, printedAt: null, closedBy: null, closedAt: null, verifiedBy: null, verifiedAt: null,
  createdAt: at("09:00"), ...o,
});
const I = (id: number, ticketId: number, o: Partial<ShiftItemRow>): ShiftItemRow => ({
  id, ticketId, name: `Item ${id}`, price: 50, quantity: 1, notes: null, removed: false,
  stationName: "kitchen", stationStatus: "done", stationStatusBy: null, stationStatusAt: null,
  stationAcceptedBy: null, stationAcceptedAt: null, stationDoneBy: null, stationDoneAt: null,
  createdAt: at("09:00"), ...o,
});
const staffRoles = { Abel: "waiter", Hana: "waiter", Alem: "waiter", Sara: "cashier", Meron: "cashier", Abnet: "kitchen", Mitke: "kitchen" };
const tickets = [
  T(1, { confirmedBy: "Abel", confirmedAt: at("09:10"), printedBy: "Sara", printedAt: at("09:20") }),
  T(2, { confirmedBy: "Hana", confirmedAt: at("11:00"), printedBy: "Sara", printedAt: at("11:05") }),
  // 13:55 accepted by Abel (morning), cleared by Alem (afternoon) → combined
  T(3, { confirmedBy: "Abel", confirmedAt: at("13:55"), closedBy: "Alem", closedAt: at("15:30"), status: "closed", printedBy: "Sara", printedAt: at("13:58") }),
  T(4, { confirmedBy: "Alem", confirmedAt: at("16:00"), printedBy: "Meron", printedAt: at("16:10") }),
  T(5, { confirmedBy: "Alem", confirmedAt: at("17:00") }), // never printed
];
const items = [
  I(10, 3, { stationAcceptedBy: "Abnet", stationAcceptedAt: at("13:57"), stationDoneBy: "Mitke", stationDoneAt: at("14:20") }),
  I(11, 1, { stationAcceptedBy: "Abnet", stationAcceptedAt: at("09:15"), stationDoneBy: "Abnet", stationDoneAt: at("09:30") }),
  I(12, 4, { stationStatus: "accepted", stationAcceptedBy: "Mitke", stationAcceptedAt: at("16:05") }),
];
const base = { date: "today" as const, dayKeys: [day], tickets, items, events: [], submissions: [], staffRoles };

const w = buildShiftReport({ ...base, role: "waiter" });
assert.deepEqual(w.morning.map((p) => p.name).sort(), ["Abel", "Hana"]);
assert.deepEqual(w.afternoon.map((p) => p.name).sort(), ["Alem"]);
assert.equal(w.combined.length, 1);
assert.equal(w.combined[0].label, "Abel - Alem");
assert.deepEqual(w.combined[0].ticketIds, [3]);
assert.ok(w.orders[5].flags.some((f) => /Never printed/.test(f)));

const c = buildShiftReport({ ...base, role: "cashier" });
assert.deepEqual(c.morning.map((p) => p.name), ["Sara"]);
assert.deepEqual(c.afternoon.map((p) => p.name), ["Meron"]);

const k = buildShiftReport({ ...base, role: "kitchen" });
assert.equal(k.combined[0].label, "Abnet - Mitke");
assert.ok(k.afternoon.some((p) => p.name === "Mitke"));
assert.ok(k.orders[4].flags.some((f) => /never marked done/.test(f)));

const k10 = buildShiftReport({ ...base, role: "kitchen", splitHour: 10 });
assert.ok(k10.afternoon.some((p) => p.name === "Abnet")); // custom shift change hour
console.log("verify-shift-report: OK");
