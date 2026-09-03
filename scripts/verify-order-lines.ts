#!/usr/bin/env tsx
/**
 * Unit coverage for `src/lib/order-lines.ts` — the shared order helpers behind
 * three of the six requested features:
 *
 *   • duplicate lines collapse ("2 Tea", not "1 Tea + 1 Tea") — both the
 *     read-only grouping used by every screen AND the conservative merge rule the
 *     order route applies in the database;
 *   • the customer-facing phase ("your food is being prepared" → "ready"),
 *     driven by the KITCHEN only, with barista items deliberately excluded;
 *   • arrival time / waiting labels the crew asked for.
 *
 * Pure functions — no database, no React, no network.
 * Run with: npx tsx scripts/verify-order-lines.ts   (wired into `npm test`)
 */
import {
  PROMOTION_NOTE_PREFIX,
  canMergeLines,
  customerOrderPhase,
  formatClock,
  formatDateTime,
  formatDayMonthYear,
  groupOrderLines,
  isPromotionLine,
  minutesSince,
  orderLineKey,
  stationProgress,
  waitingLabel,
  type OrderLine,
} from "../src/lib/order-lines";

function assert(name: string, condition: boolean) {
  console.log(`${condition ? "✅" : "❌"} ${name}`);
  if (!condition) throw new Error(`Failed: ${name}`);
}

/** Build a ticket_items-shaped row with sensible defaults. */
function line(over: Partial<OrderLine> & { id: number; name: string }): OrderLine {
  return {
    quantity: 1,
    price: 40,
    notes: "",
    removed: false,
    stationName: "kitchen",
    stationStatus: "pending",
    menuItemId: 1,
    ticketId: 7,
    createdAt: "2026-09-02T11:30:00.000Z",
    ...over,
  };
}

/* ── 1. line identity ─────────────────────────────────────────────────────── */
{
  const tea = line({ id: 1, name: "Tea", menuItemId: 5, price: 40 });
  assert("identical rows share a key", orderLineKey(tea) === orderLineKey(line({ id: 2, name: "Tea", menuItemId: 5, price: 40 })));
  assert("name case/whitespace is ignored", orderLineKey(tea) === orderLineKey(line({ id: 3, name: "  tEa ", menuItemId: 5, price: 40 })));
  assert("a different note is a different line", orderLineKey(tea) !== orderLineKey(line({ id: 4, name: "Tea", menuItemId: 5, price: 40, notes: "No sugar" })));
  assert("a different unit price is a different line", orderLineKey(tea) !== orderLineKey(line({ id: 5, name: "Tea", menuItemId: 5, price: 45 })));
  assert("a different station is a different line", orderLineKey(tea) !== orderLineKey(line({ id: 6, name: "Tea", menuItemId: 5, price: 40, stationName: "barista" })));
  assert("a different dish is a different line", orderLineKey(tea) !== orderLineKey(line({ id: 7, name: "Coffee", menuItemId: 9, price: 40 })));
  assert("a missing station defaults to kitchen", orderLineKey(line({ id: 8, name: "Tea", menuItemId: 5, stationName: null })) === orderLineKey(tea));
}

/* ── 2. promotion lines never merge ───────────────────────────────────────── */
{
  const promoNote = `${PROMOTION_NOTE_PREFIX} Lunch combo (1 of 2)`;
  assert("a Daily Board line is recognised by its note", isPromotionLine({ notes: promoNote }));
  assert("  …and leading whitespace does not hide it", isPromotionLine({ notes: `  ${promoNote}` }));
  assert("an ordinary note is not a promotion", !isPromotionLine({ notes: "No sugar" }));
  assert("a missing note is not a promotion", !isPromotionLine({}));

  const a = line({ id: 10, name: "Combo", price: 100, notes: promoNote });
  const b = line({ id: 11, name: "Combo", price: 100, notes: promoNote });
  assert("two identical promotion rows stay separate (exact combo totals survive)", !canMergeLines(a, b));
}

/* ── 3. the database merge rule ───────────────────────────────────────────── */
{
  const existing = line({ id: 20, name: "Tea", menuItemId: 5, price: 40, stationStatus: "pending" });
  const same = line({ id: 21, name: "Tea", menuItemId: 5, price: 40 });

  assert("a repeat order folds into the pending row", canMergeLines(existing, same));
  assert("  …case/whitespace differences still fold", canMergeLines(existing, line({ id: 22, name: " tea", menuItemId: 5, price: 40 })));
  assert("once the kitchen ACCEPTED the row, new work stays visible", !canMergeLines({ ...existing, stationStatus: "accepted" }, same));
  assert("once the row is DONE it is never touched again", !canMergeLines({ ...existing, stationStatus: "done" }, same));
  assert("a cashier-removed row is never revived by a merge", !canMergeLines({ ...existing, removed: true }, same));
  assert("a removed incoming row cannot merge either", !canMergeLines(existing, { ...same, removed: true }));
  assert("rows of different tickets never merge", !canMergeLines(existing, { ...same, ticketId: 8 }));
  assert("a different note keeps its own line", !canMergeLines(existing, { ...same, notes: "No sugar" }));
  assert("a different price keeps its own line", !canMergeLines(existing, { ...same, price: 45 }));
  assert("a barista item never folds into a kitchen row", !canMergeLines(existing, { ...same, stationName: "barista" }));
}

/* ── 4. read-only grouping (what the screens render) ──────────────────────── */
{
  // The exact case the owner described: tea now, sandwich now, tea again later.
  const rows = [
    line({ id: 30, name: "Tea", menuItemId: 5, price: 40, createdAt: "2026-09-02T11:30:00.000Z" }),
    line({ id: 31, name: "Sandwich", menuItemId: 6, price: 120, createdAt: "2026-09-02T11:30:00.000Z" }),
    line({ id: 32, name: "Tea", menuItemId: 5, price: 40, createdAt: "2026-09-02T11:41:00.000Z" }),
  ];
  const grouped = groupOrderLines(rows);
  assert("three rows collapse into two lines", grouped.length === 2);
  assert("the repeated tea reads as quantity 2", grouped[0].name === "Tea" && grouped[0].quantity === 2);
  assert("first-appearance order is preserved", grouped[0].name === "Tea" && grouped[1].name === "Sandwich");
  assert("every source row id is remembered", grouped[0].ids.join(",") === "30,32");
  assert("the representative id is the earliest row", grouped[0].id === 30);
  assert("the arrival time stays the FIRST order's", grouped[0].createdAt === "2026-09-02T11:30:00.000Z");

  const withNotes = groupOrderLines([
    line({ id: 40, name: "Tea", menuItemId: 5, notes: "" }),
    line({ id: 41, name: "Tea", menuItemId: 5, notes: "No sugar" }),
    line({ id: 42, name: "Tea", menuItemId: 5, notes: "No sugar" }),
  ]);
  assert("notes still split lines (2 No-sugar + 1 plain)", withNotes.length === 2 && withNotes[0].quantity === 1 && withNotes[1].quantity === 2);

  const withRemoved = [
    line({ id: 50, name: "Tea", menuItemId: 5 }),
    line({ id: 51, name: "Tea", menuItemId: 5, removed: true }),
  ];
  assert("removed rows are hidden from customer/cashier views", groupOrderLines(withRemoved)[0].quantity === 1);
  const audit = groupOrderLines(withRemoved, { includeRemoved: true });
  assert("  …but an audit view still lists them", audit.length === 2 && audit.reduce((s, g) => s + g.quantity, 0) === 2);
  assert("a removed row never inflates the live line's quantity", audit.find((g) => !g.removed)?.quantity === 1);
  assert("  …and keeps its own strikethrough flag", audit.find((g) => g.removed)?.quantity === 1 && audit.find((g) => g.removed)?.id === 51);

  const byStatus = groupOrderLines(
    [
      line({ id: 60, name: "Tea", menuItemId: 5, stationStatus: "pending" }),
      line({ id: 61, name: "Tea", menuItemId: 5, stationStatus: "accepted" }),
    ],
    { splitByStationStatus: true }
  );
  assert("crew screens can keep each state on its own line", byStatus.length === 2 && byStatus.every((g) => g.quantity === 1));

  assert("an empty bill groups to nothing", groupOrderLines([]).length === 0);
}

/* ── 5. station progress (kitchen only, measured in units) ────────────────── */
{
  const mixed: OrderLine[] = [
    line({ id: 70, name: "Beyaynet", quantity: 2, stationName: "kitchen", stationStatus: "done" }),
    line({ id: 71, name: "Soup", quantity: 1, stationName: "kitchen", stationStatus: "accepted" }),
    line({ id: 72, name: "Tea", quantity: 3, stationName: "kitchen", stationStatus: "pending" }),
    line({ id: 73, name: "Macchiato", quantity: 4, stationName: "barista", stationStatus: "pending" }),
    line({ id: 74, name: "Cancelled dish", quantity: 9, stationName: "kitchen", removed: true }),
  ];

  const kitchen = stationProgress(mixed, "kitchen");
  assert("kitchen counts UNITS, not rows (2+1+3)", kitchen.units === 6);
  assert("removed rows are not counted as work", kitchen.units === 6 && kitchen.lines === 3);
  assert("per-state unit totals are exposed", kitchen.done === 2 && kitchen.accepted === 1 && kitchen.pending === 3);
  assert("partly cooked kitchen reports 'preparing'", kitchen.state === "preparing");

  const barista = stationProgress(mixed, "barista");
  assert("the barista gets its own count", barista.units === 4 && barista.lines === 1);
  assert("untouched barista work is 'queued'", barista.state === "queued");

  assert("a station with nothing to do is idle", stationProgress(mixed, "kitchen").units > 0 && stationProgress([], "kitchen").state === "idle");
  const allDone = stationProgress([line({ id: 80, name: "Beyaynet", stationStatus: "done" })], "kitchen");
  assert("everything cooked means 'ready'", allDone.state === "ready" && allDone.done === 1);
  const accepted = stationProgress([line({ id: 81, name: "Beyaynet", stationStatus: "accepted" })], "kitchen");
  assert("accepted but not finished is still 'preparing'", accepted.state === "preparing");
}

/* ── 6. what the guest's own screen says ──────────────────────────────────── */
{
  const kitchenRow = line({ id: 90, name: "Beyaynet", stationName: "kitchen", stationStatus: "pending" });
  const drinkRow = line({ id: 91, name: "Macchiato", stationName: "barista", stationStatus: "pending" });

  assert("no ticket at all → none", customerOrderPhase(null, []) === "none");
  assert("sent but the waiter has not confirmed → waiting", customerOrderPhase({ status: "pending_waiter" }, [kitchenRow]) === "waiting");
  assert("confirmed, kitchen not started → confirmed", customerOrderPhase({ status: "open" }, [kitchenRow]) === "confirmed");
  assert("kitchen accepted/cooking → preparing", customerOrderPhase({ status: "open" }, [{ ...kitchenRow, stationStatus: "accepted" }]) === "preparing");
  assert("kitchen finished everything → ready", customerOrderPhase({ status: "open" }, [{ ...kitchenRow, stationStatus: "done" }]) === "ready");
  assert("food + drink follows the FOOD", customerOrderPhase({ status: "open" }, [{ ...kitchenRow, stationStatus: "done" }, drinkRow]) === "ready");

  // The explicit ask: coffee/juice/cake need no progress bar.
  assert("a barista-only bill is 'drinks_only' (no progress bar)", customerOrderPhase({ status: "open" }, [drinkRow]) === "drinks_only");
  assert("  …even with several drinks", customerOrderPhase({ status: "open" }, [drinkRow, { ...drinkRow, id: 92, quantity: 3 }]) === "drinks_only");

  assert("ready_for_payment → bill", customerOrderPhase({ status: "ready_for_payment" }, [{ ...kitchenRow, stationStatus: "done" }]) === "bill");
  assert("completed → bill", customerOrderPhase({ status: "completed" }, [kitchenRow]) === "bill");
  assert("paid wins over everything else", customerOrderPhase({ status: "open", paymentStatus: "paid_cash" }, [kitchenRow]) === "paid");
  assert("status paid also wins", customerOrderPhase({ status: "paid" }, [kitchenRow]) === "paid");
  assert("cancelled is reported honestly", customerOrderPhase({ status: "cancelled" }, [kitchenRow]) === "cancelled");
  // Every line removed by the cashier ⇒ no kitchen work left to track.
  assert("a ticket with no live lines has no food progress", customerOrderPhase({ status: "open" }, []) === "drinks_only");
}

/* ── 7. arrival time helpers (the crew's #1 question) ─────────────────────── */
{
  const at = "2026-09-02T11:30:00.000Z";
  const now = new Date("2026-09-02T11:42:30.000Z").getTime();

  assert("minutes since arrival are whole minutes", minutesSince(at, now) === 12);
  assert("a future/unknown time never shows negative minutes", minutesSince("2026-09-02T12:00:00.000Z", now) === 0);
  assert("a missing time reads as no waiting", minutesSince(null, now) === 0 && minutesSince("not a date", now) === 0);
  assert("waiting label: under a minute is 'just now'", waitingLabel(new Date(now - 30_000).toISOString(), now) === "just now");
  assert("waiting label: exactly one minute", waitingLabel(new Date(now - 60_000).toISOString(), now) === "1 min");
  assert("waiting label: 12 minutes", waitingLabel(at, now) === "12 min");
  assert("waiting label: an old order keeps counting (2h+)", waitingLabel(new Date(now - 130 * 60_000).toISOString(), now) === "130 min");
  assert("waiting label survives a missing timestamp", waitingLabel(null, now) === "just now");

  assert("clock renders HH:MM", /^\d{2}:\d{2}$/.test(formatClock(at)));
  assert("clock shows 'n/a' when unknown", formatClock(null) === "n/a" && formatClock("garbage") === "n/a");
  assert("day/month/year renders a real date", /\d{4}/.test(formatDayMonthYear(at)));
  assert("day/month/year shows 'n/a' when unknown", formatDayMonthYear(null) === "n/a");
  assert("date+time combines both", formatDateTime(at).includes(formatClock(at)) && formatDateTime(at).includes("·"));
  assert("date+time shows 'n/a' when unknown", formatDateTime(null) === "n/a");
  assert("a Date object works as well as a string", formatClock(new Date(at)) === formatClock(at));
}

console.log("\n✅ Order-line grouping, merge rule, phases and arrival times PASSED");
