#!/usr/bin/env tsx
/**
 * Regression guard: the SHIFT REPORT (cross-checker, Sept 2026).
 * Morning = before the shift change (14:00 EAT = 8:00 local), Afternoon = after,
 * Combined = 2+ people of the same role on one order. Pure, no database.
 */
import assert from "node:assert/strict";
import {
  buildShiftReport,
  isLegacyAuditNote,
  orderSender,
  timelineText,
  type ShiftEventRow,
  type ShiftItemRow,
  type ShiftSubmissionRow,
  type ShiftTicketRow,
} from "../src/lib/shift-report";
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

// Buna makers also work the floor. Their outdoor food/drink submissions and
// accepted table orders must appear with waiter actions, not be confused with
// station Done taps. Shared bills stay visible in Combined for cross-checking.
const bunaFloor = buildShiftReport({ ...base, role: "waiter",
  staffRoles: { ...staffRoles, Tigist: "buna" },
  tickets: [...tickets,
    T(20, { tableName: "OUTDOOR • gate", orderType: "outdoor", createdBy: "Tigist", printedBy: "Sara", printedAt: at("12:30"), totalAmount: 220 }),
    T(21, { tableName: "Table 21", confirmedBy: "Tigist", confirmedAt: at("12:20"), printedBy: "Sara", printedAt: at("12:35") }),
    T(22, { tableName: "Table 22", confirmedBy: "Tigist", confirmedAt: at("13:55"), closedBy: "Abel", closedAt: at("15:00") }),
  ],
  items: [...items, I(20, 20, { name: "Sandwich", stationName: "kitchen", price: 220 })],
  submissions: [{ ticketId: 20, source: "staff", waiterName: "Tigist", lines: 1, createdAt: at("12:00") }],
});
assert.deepEqual(bunaFloor.morning.find((p) => p.name === "Tigist")?.ticketIds, [22, 21, 20]);
assert.ok(bunaFloor.orders[20].actions.some((a) => /Direct send/.test(a.label)));
assert.ok(bunaFloor.combined.some((g) => g.ticketIds.includes(22)));
assert.equal(bunaFloor.orders[20].totalAmount, 220);
assert.ok(!buildShiftReport({ ...base, role: "cashier", staffRoles: { ...staffRoles, Tigist: "buna" }, tickets: [T(20, { createdBy: "Tigist", orderType: "outdoor", printedBy: "Sara", printedAt: at("12:30") })], items: [], events: [], submissions: [] }).morning.some((p) => p.name === "Tigist"));

const c = buildShiftReport({ ...base, role: "cashier" });
assert.deepEqual(c.morning.map((p) => p.name), ["Sara"]);
assert.deepEqual(c.afternoon.map((p) => p.name), ["Meron"]);

const k = buildShiftReport({ ...base, role: "kitchen" });
assert.equal(k.combined[0].label, "Abnet - Mitke");
assert.ok(k.afternoon.some((p) => p.name === "Mitke"));
assert.ok(k.orders[4].flags.some((f) => /never marked done/.test(f)));

const k10 = buildShiftReport({ ...base, role: "kitchen", splitHour: 10 });
assert.ok(k10.afternoon.some((p) => p.name === "Abnet")); // custom shift change hour

// ── "ACCEPTED BY n/a" (owner, Sept 2026) ─────────────────────────────────
// A waiter's own order goes straight to the stations and is never
// "accepted", so confirmedBy stays empty. The card must name the waiter who
// SENT it: Table 8 #FANA-2431 → "Sent by yeshi".
const E = (o: Partial<ShiftEventRow>): ShiftEventRow => ({
  ticketId: 8, eventType: "ticket_created", actorName: null, actorRole: null, toValue: null, details: null, createdAt: at("10:00"), ...o,
});
const S = (o: Partial<ShiftSubmissionRow>): ShiftSubmissionRow => ({
  ticketId: 8, source: "staff", waiterName: "yeshi", lines: 2, createdAt: at("10:00"), ...o,
});
const t8 = T(8, { tableName: "Table 8", orderNumber: "FANA-2431", createdBy: "yeshi", printedBy: "Sara", printedAt: at("10:05") });
const sentReport = buildShiftReport({
  ...base,
  role: "waiter",
  staffRoles: { ...staffRoles, yeshi: "waiter" },
  tickets: [...tickets, t8],
  submissions: [S({})],
  events: [
    E({ eventType: "ticket_created", actorName: "yeshi", actorRole: "waiter", details: "New staff order created" }),
    E({ eventType: "ticket_sent", actorName: "yeshi", actorRole: "waiter", details: "Waiter sent a new order to the stations", createdAt: at("10:00") }),
    E({ eventType: "status_changed", actorName: "Sara", actorRole: "cashier", toValue: "printed", details: "Legacy print backfill", createdAt: at("10:05") }),
    E({ eventType: "status_changed", actorName: "Abel", actorRole: "waiter", toValue: "confirmed", details: "Legacy confirmation backfill", createdAt: at("10:01") }),
  ],
});
const card8 = sentReport.orders[8];
assert.equal(card8.confirmedBy, null, "a waiter's own order has no 'accepted by'");
assert.equal(card8.sentBy, "yeshi", "Table 8 #FANA-2431 → Sent by yeshi");
assert.equal(card8.sentAt, at("10:00").toISOString());
// display only: totals / Combined / flags are unchanged by sentBy
assert.deepEqual(sentReport.morning.find((p) => p.name === "yeshi")?.ticketIds, [8]);
assert.deepEqual(sentReport.combined.map((g) => g.label), ["Abel - Alem"]);
assert.equal(sentReport.totals.orders, w.totals.orders + 1);
// "Legacy ... backfill" never reaches the screen: plain words instead
const texts = card8.timeline.map((l) => l.text);
assert.ok(!texts.some((x) => /legacy|backfill/i.test(x)), `timeline shows technical notes: ${texts.join(" | ")}`);
assert.ok(texts.includes("Order accepted") && texts.includes("Printed (EFD)"), texts.join(" | "));
// Tickets with an accepting person keep "Accepted by"; sentBy is still filled when known.
assert.equal(sentReport.orders[1].confirmedBy, "Abel");

// orderSender priority: first STAFF submission → ticket_sent actor → any staff submission → createdBy person
assert.deepEqual(orderSender(t8, [S({ createdAt: at("10:00") })], []), { name: "yeshi", at: at("10:00").toISOString() });
assert.equal(
  orderSender(T(9, { createdBy: "Customer (QR)" }), [S({ ticketId: 9, source: "customer", waiterName: null })], [
    E({ ticketId: 9, eventType: "ticket_sent", actorName: "Hana", createdAt: at("10:02") }),
  ]).name,
  "Hana",
  "a QR order released by a waiter is 'Sent by' that waiter"
);
assert.equal(orderSender(T(9, { createdBy: "Customer (QR)" }), [S({ ticketId: 9, source: "customer", waiterName: null })], []).name, null);
assert.equal(orderSender(T(9, { createdBy: "Waiter" }), [], []).name, null, "placeholder names are not a person");
assert.equal(orderSender(T(9, { createdBy: "Customer" }), [], []).name, null);
assert.equal(orderSender(T(9, { createdBy: "Hana" }), [], []).name, "Hana");
assert.equal(
  orderSender(T(9, {}), [S({ ticketId: 9, source: "customer", waiterName: null, createdAt: at("09:00") }), S({ ticketId: 9, waiterName: "Alem", createdAt: at("09:30") })], []).name,
  "Alem",
  "a later staff submission still names the waiter"
);

// timelineText: legacy notes → plain words, real notes untouched
assert.equal(timelineText({ eventType: "status_changed", toValue: "confirmed", details: "Legacy confirmation backfill" }), "Order accepted");
assert.equal(timelineText({ eventType: "ticket_created", toValue: null, details: "Legacy bill existed before audit logging" }), "Order created");
assert.equal(timelineText({ eventType: "status_changed", toValue: "closed", details: "Legacy table-cleared backfill" }), "Table cleared");
assert.equal(timelineText({ eventType: "status_changed", toValue: "completed", details: "Legacy payment backfill" }), "Marked paid");
assert.equal(timelineText({ eventType: "status_changed", toValue: "cancelled", details: "Legacy something backfill" }), "Order cancelled");
assert.equal(timelineText({ eventType: "item_edited", toValue: null, details: "Tea: quantity 2 → 3" }), "Tea: quantity 2 → 3");
assert.equal(timelineText({ eventType: "status_changed", toValue: "printed", details: null }), "Printed (EFD)");
assert.equal(timelineText({ eventType: "weird_new_thing", toValue: null, details: null }), "Weird new thing");
assert.ok(isLegacyAuditNote("Legacy confirmation backfill"));
assert.ok(isLegacyAuditNote("Legacy bill edit happened before detailed audit logging"));
assert.ok(!isLegacyAuditNote("Waiter sent a new order to the stations"));
console.log("verify-shift-report: OK");
