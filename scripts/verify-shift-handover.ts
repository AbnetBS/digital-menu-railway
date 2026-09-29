#!/usr/bin/env tsx
/**
 * Regression guard: THE BARISTA HAND-OVER (owner, Sept 2026).
 *
 * The argument this settles forever: the admin shift button and the barista's
 * own Items-sold tab disagreed, and drinks went missing between shifts. The
 * rules now in force (barista lane only; kitchen, juice and buna untouched):
 *
 *   1. PHASES — before the shift change one owner works alone; at 14:00 EAT
 *      (8:00 local) a 20-minute window opens; after it the morning man only
 *      finishes what he accepted (HARD STOP).
 *   2. FIRST ACCEPT REGISTERS — a login claims nothing; the first accepted
 *      drink makes the shift yours; no double shifts; a taken line can never
 *      be silently re-taken.
 *   3. ONE LINE, ONE PAIR OF EYES — pending drinks are visible only to whoever
 *      may accept them; another barista's lines are silent shadows (taken),
 *      never board items.
 *   4. THE TWO PAPERS AGREE — buildShiftReport (barista) buckets by OWNER and
 *      counts per LINE, so each person's orders/amount equal buildStationSales
 *      "accepted" for the same rows (accept and done are the same person since
 *      the shift lock), and a Done at 14:35 still lands in the morning bucket.
 *      Days without claims keep the old clock behaviour.
 *
 * Pure, no database. Run with: npx tsx scripts/verify-shift-handover.ts
 * (wired into `npm test`)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  actionShiftByClaims,
  baristaViewer,
  canRegisterClaim,
  claimShiftFor,
  claimsByDayMap,
  filterBaristaLive,
  handoverPhase,
  HANDOVER_MINUTES,
  lineAcceptedOwner,
  lineDoneOwner,
  type HandoverShift,
} from "../src/lib/shift-handover";
import { buildShiftReport, type ShiftItemRow, type ShiftTicketRow } from "../src/lib/shift-report";
import { buildStationSales, type StationSalesItemRow } from "../src/lib/station-sales";
import { etDayKey, etStartOfToday } from "../src/lib/timezone";

const SPLIT = 14; // 14:00 EAT = 8:00 on the Ethiopian clock
// All times are EAT wall-clock times of TODAY (never a hardcoded date): the
// Items-sold comparison below counts the real "today", so this fixture must
// stay inside it on whatever day the test runs.
const midnight = etStartOfToday();
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(midnight.getTime() + (h * 60 + m) * 60 * 1000);
};
const day = etDayKey(at("10:00"))!;

/* ── 1. THE PHASES ───────────────────────────────────────────────────────── */
{
  assert.equal(handoverPhase(at("07:30"), SPLIT).phase, "open");
  assert.equal(handoverPhase(at("13:59"), SPLIT).phase, "open");
  assert.equal(handoverPhase(at("14:00"), SPLIT).phase, "handover");
  // The window is exactly HANDOVER_MINUTES long and closes at 14:20 EAT.
  const win = handoverPhase(at("14:10"), SPLIT);
  assert.equal(win.phase, "handover");
  assert.equal((win.windowEnd.getTime() - win.windowStart.getTime()) / 60000, HANDOVER_MINUTES);
  assert.equal(win.windowEnd.getTime(), at("14:20").getTime());
  assert.equal(handoverPhase(at("14:19"), SPLIT).phase, "handover");
  assert.equal(handoverPhase(at("14:20"), SPLIT).phase, "after");
  assert.equal(handoverPhase(at("22:00"), SPLIT).phase, "after");
  assert.equal(win.dayKey, day);
  assert.equal(claimShiftFor(at("09:10"), SPLIT), "morning");
  assert.equal(claimShiftFor(at("14:03"), SPLIT), "afternoon");
  console.log("✅ phases: open → 20-minute hand-over at the shift change → hard stop");
}

/* ── 2. WHO SEES WHAT ────────────────────────────────────────────────────── */
{
  // A quiet morning, nobody registered yet: any logged-in barista sees the
  // board — somebody must be able to accept the first drink.
  assert.deepEqual(baristaViewer({ name: "Abel", phase: "open", morningOwner: null, afternoonOwner: null }), {
    seesPending: true,
    canAcceptPending: true,
    myShift: null,
    alsoMorning: false,
    blockedBy: null,
    canContinueAfternoon: false,
  });
  // The morning owner works alone: a second login waits on the lock screen,
  // which only NAMES the holder. A registered shift can not be taken.
  assert.deepEqual(baristaViewer({ name: "Biniam", phase: "open", morningOwner: "Abel", afternoonOwner: null }), {
    seesPending: false,
    canAcceptPending: false,
    myShift: null,
    alsoMorning: false,
    blockedBy: { name: "Abel", shift: "morning" },
    canContinueAfternoon: false,
  });
  // During the window BOTH work: the morning man keeps accepting (the
  // afternoon man may be late), the candidate may take his first drink.
  assert.equal(baristaViewer({ name: "Abel", phase: "handover", morningOwner: "Abel", afternoonOwner: null }).canAcceptPending, true);
  assert.equal(baristaViewer({ name: "Biniam", phase: "handover", morningOwner: "Abel", afternoonOwner: null }).seesPending, true);
  // Once the afternoon is registered, a third barista goes back to standby.
  assert.equal(baristaViewer({ name: "Chala", phase: "handover", morningOwner: "Abel", afternoonOwner: "Biniam" }).seesPending, false);
  // HARD STOP: after the window the morning man sees no pending drinks; the
  // afternoon owner carries on; an unregistered barista may still register.
  const morningAfter = baristaViewer({ name: "Abel", phase: "after", morningOwner: "Abel", afternoonOwner: "Biniam" });
  assert.equal(morningAfter.seesPending, false);
  assert.equal(morningAfter.myShift, "morning");
  // ...and the afternoon owner is exactly who he must name on the lock screen.
  assert.deepEqual(morningAfter.blockedBy, { name: "Biniam", shift: "afternoon" });
  assert.equal(morningAfter.canContinueAfternoon, false);
  assert.equal(baristaViewer({ name: "Biniam", phase: "after", morningOwner: "Abel", afternoonOwner: "Biniam" }).canAcceptPending, true);
  // The AFTERNOON can never be taken with the morning button (owner's rule):
  // a third barista only reads "today's afternoon shift is Biniam".
  const chalaAfter = baristaViewer({ name: "Chala", phase: "after", morningOwner: "Abel", afternoonOwner: "Biniam" });
  assert.equal(chalaAfter.seesPending, false);
  assert.deepEqual(chalaAfter.blockedBy, { name: "Biniam", shift: "afternoon" });
  console.log("✅ one owner per screen, both hands during the window, hard stop after");
}

/* ── 2b. A REGISTERED SHIFT IS LOCKED + CONTINUING INTO THE AFTERNOON ────── */
{
  // OWNER'S RULE (29 Sept 2026): exactly like the afternoon, a registered
  // MORNING shift can not be taken. A second barista only ever reads the lock
  // screen with the owner's name: there is no takeover button, in any phase,
  // and nothing in the envelope offers one.
  // The morning is still live and locked: he only reads the holder's name.
  const lockedMorning = baristaViewer({ name: "Chala", phase: "open", morningOwner: "Abel", afternoonOwner: null });
  assert.equal(lockedMorning.seesPending, false);
  assert.equal(lockedMorning.canAcceptPending, false);
  assert.equal(lockedMorning.myShift, null);
  assert.deepEqual(lockedMorning.blockedBy, { name: "Abel", shift: "morning" });
  // During/after the window nobody holds the afternoon yet, so his first drink
  // is still his door in (that is how an afternoon barista registers).
  assert.equal(baristaViewer({ name: "Chala", phase: "handover", morningOwner: "Abel", afternoonOwner: null }).seesPending, true);
  assert.equal(baristaViewer({ name: "Chala", phase: "after", morningOwner: "Abel", afternoonOwner: null }).seesPending, true);
  // Once the afternoon is held, a third barista is locked out for good.
  for (const phase of ["handover", "after"] as const) {
    const locked = baristaViewer({ name: "Chala", phase, morningOwner: "Abel", afternoonOwner: "Biniam" });
    assert.equal(locked.seesPending, false, `locked out during ${phase}`);
    assert.equal(locked.canAcceptPending, false, `no accepts during ${phase}`);
    assert.deepEqual(locked.blockedBy, { name: "Biniam", shift: "afternoon" });
  }
  // Nobody registered: there is nothing to take, just accept your first drink.
  assert.equal(baristaViewer({ name: "Chala", phase: "open", morningOwner: null, afternoonOwner: null }).seesPending, true);

  // CONTINUE: the morning owner, window closed, nobody holds the afternoon.
  const alone = baristaViewer({ name: "Abel", phase: "after", morningOwner: "Abel", afternoonOwner: null });
  assert.equal(alone.canContinueAfternoon, true);
  assert.equal(alone.seesPending, false);
  // Somebody else registered the afternoon: the button is gone, and he reads
  // the name of the man who takes over.
  assert.equal(baristaViewer({ name: "Abel", phase: "after", morningOwner: "Abel", afternoonOwner: "Biniam" }).canContinueAfternoon, false);
  // A full-day barista holds BOTH claims: the LIVE afternoon side wins, so he
  // sees and accepts new orders for the rest of the day.
  const fullDay = baristaViewer({ name: "Abel", phase: "after", morningOwner: "Abel", afternoonOwner: "Abel" });
  assert.deepEqual(fullDay, {
    seesPending: true,
    canAcceptPending: true,
    myShift: "afternoon",
    alsoMorning: true,
    blockedBy: null,
    canContinueAfternoon: false,
  });
  // A third barista is still held back by a full-day owner.
  assert.deepEqual(baristaViewer({ name: "Chala", phase: "after", morningOwner: "Abel", afternoonOwner: "Abel" }).blockedBy, { name: "Abel", shift: "afternoon" });
  console.log("✅ a registered shift is locked (morning and afternoon); continuing is the only road to a full day");
}

/* ── 3. THE FIRST DRINK REGISTERS (and never a double shift) ─────────────── */
{
  assert.deepEqual(canRegisterClaim({ name: "Biniam", claimShift: "afternoon", morningOwner: null, afternoonOwner: null }), { ok: true, reason: null });
  // The owner of the morning can never own the afternoon of the same day.
  assert.deepEqual(canRegisterClaim({ name: "Abel", claimShift: "afternoon", morningOwner: "Abel", afternoonOwner: null }), {
    ok: false,
    reason: "double-shift",
  });
  // A registered shift is taken — the second man hears a name.
  const taken = canRegisterClaim({ name: "Chala", claimShift: "morning", morningOwner: "Abel", afternoonOwner: null });
  assert.equal(taken.ok, false);
  assert.equal(taken.reason, "taken");
  assert.equal(taken.holder, "Abel");
  console.log("✅ registration: first accept wins, double shifts are banned");
}

/* ── 4. LINE OWNERSHIP (audit columns win, legacy last-tap falls back) ────── */
{
  assert.equal(lineAcceptedOwner({ stationAcceptedBy: "Abel", stationStatus: "accepted", stationStatusBy: "Biniam" }), "Abel");
  assert.equal(lineAcceptedOwner({ stationStatus: "accepted", stationStatusBy: "Biniam" }), "Biniam");
  assert.equal(lineAcceptedOwner({ stationStatus: "pending" }), "");
  assert.equal(lineDoneOwner({ stationDoneBy: "Abel", stationStatus: "done", stationStatusBy: "Biniam" }), "Abel");
  assert.equal(lineDoneOwner({ stationStatus: "done", stationStatusBy: "Biniam" }), "Biniam");
  console.log("✅ one line, one owner: accept columns win, legacy taps fall back");
}

/* ── 5. THE LIVE LIST, PER VIEWER ────────────────────────────────────────── */
{
  const tickets = [
    {
      id: 1,
      items: [
        { id: 10, stationStatus: "pending" },
        { id: 11, stationStatus: "accepted", stationAcceptedBy: "Abel" },
        { id: 12, stationStatus: "accepted", stationAcceptedBy: "Biniam" },
        { id: 13, stationStatus: "done", stationDoneBy: "Biniam" },
      ],
    },
    // id 21 carries NO status at all: a row written before the status column
    // existed. It is work nobody has taken yet — pending, never a line that
    // leaks onto the other barista's board.
    { id: 2, items: [{ id: 20, stationStatus: "pending" }, { id: 21 }] },
  ];
  // Abel (may accept): pending lines + his own; Biniam's lines are shadows.
  const abelView = filterBaristaLive(tickets, { name: "Abel", seesPending: true });
  assert.equal(abelView.length, 2);
  const abelItems = abelView[0].items;
  // Both pending shapes reach a hand that may take work (status "pending" and
  // the empty status of an old row), and the statusless one leaves with the
  // hard stop exactly like a pending line.
  assert.deepEqual(abelView[1].items.map((i) => i.id).sort((a, b) => a - b), [20, 21]);
  assert.equal(abelItems.find((i) => i.id === 10)?.taken, undefined);
  assert.equal(abelItems.find((i) => i.id === 11)?.taken, undefined);
  assert.equal(abelItems.find((i) => i.id === 12)?.taken, true);
  assert.equal(abelItems.find((i) => i.id === 13)?.taken, true);
  // Abel after the hard stop: no pending drinks at all, his own line stays,
  // the shadows stay silent (a ticket of pure pending work leaves his board).
  const abelAfter = filterBaristaLive(tickets, { name: "Abel", seesPending: false });
  assert.equal(abelAfter.length, 1);
  assert.deepEqual(abelAfter[0].items.map((i) => i.id).sort(), [11, 12, 13]);
  console.log("✅ pending only for hands that may take them; others are shadows");
}

/* ── 6. BUCKETS FOLLOW THE OWNER ─────────────────────────────────────────── */
{
  const claims = claimsByDayMap([
    { dayKey: day, shift: "morning", staffName: "Abel" },
    { dayKey: day, shift: "afternoon", staffName: "Biniam" },
  ]);
  // The morning man's Done at 14:35 (finishing through the window + beyond)
  // is still MORNING work now that he is the registered owner.
  assert.equal(actionShiftByClaims({ name: "Abel", at: at("14:35"), fallback: "afternoon", claimsByDay: claims }), "morning");
  // The afternoon man's 14:03 accept during the window is AFTERNOON work.
  assert.equal(actionShiftByClaims({ name: "Biniam", at: at("14:03"), fallback: "afternoon", claimsByDay: claims }), "afternoon");
  // No one registered (older days): the clock decides, exactly as before.
  assert.equal(actionShiftByClaims({ name: "X", at: at("09:00"), fallback: "morning", claimsByDay: claims }), "morning");
  assert.equal(actionShiftByClaims({ name: "X", at: at("09:00"), fallback: "morning", claimsByDay: null }), "morning");
  // A FULL-DAY barista holds both claims (he continued into the afternoon):
  // his actions go back to the clock, so the sheet shows him in both buckets,
  // exactly like the report's own note says.
  const fullDay = claimsByDayMap([
    { dayKey: day, shift: "morning", staffName: "Abel" },
    { dayKey: day, shift: "afternoon", staffName: "Abel" },
  ]);
  assert.equal(actionShiftByClaims({ name: "Abel", at: at("09:30"), fallback: "morning", claimsByDay: fullDay }), "morning");
  assert.equal(actionShiftByClaims({ name: "Abel", at: at("15:30"), fallback: "afternoon", claimsByDay: fullDay }), "afternoon");
  console.log("✅ the bucket follows the registered owner, not the raw clock");
}

/* ── 7. THE TWO PAPERS AGREE (admin shift report === barista Items sold) ──── */
{
  const T = (id: number, o: Partial<ShiftTicketRow>): ShiftTicketRow => ({
    id, tableName: `Table ${id}`, orderNumber: `FANA-${id}`, orderType: "dine_in", status: "printed",
    totalAmount: 0, serviceNote: null, createdBy: null, confirmedBy: null, confirmedAt: null,
    printedBy: null, printedAt: null, closedBy: null, closedAt: null, verifiedBy: null, verifiedAt: null,
    createdAt: at("09:00"), ...o,
  });
  const I = (id: number, ticketId: number, o: Partial<ShiftItemRow>): ShiftItemRow => ({
    id, ticketId, name: `Item ${id}`, price: 50, quantity: 1, notes: null, removed: false,
    stationName: "barista", stationStatus: "done", stationStatusBy: null, stationStatusAt: null,
    stationAcceptedBy: null, stationAcceptedAt: null, stationDoneBy: null, stationDoneAt: null,
    createdAt: at("09:00"), ...o,
  });
  const tickets = [
    T(1, {}), // Abel alone: macchiato x2 + tea
    T(2, {}), // SHARED: Abel's latte (accepted 13:55, done inside the window) + Biniam's first drink at 14:03
    T(3, {}), // Biniam alone: milk
    T(4, { status: "cancelled" }), // cancelled: Abel accepted it, but nothing was sold
    T(5, {}), // Abel's line here was REMOVED off the bill: never a sale
    T(6, {}), // Abel finished late (14:50 accept, 15:05 done): still MORNING by owner
    T(7, {}), // Abel accepted, the CASHIER PRINT finished it: the marker is not a person
  ];
  const items = [
    I(10, 1, { name: "Macchiato", price: 70, quantity: 2, stationAcceptedBy: "Abel", stationAcceptedAt: at("09:10"), stationDoneBy: "Abel", stationDoneAt: at("09:25") }),
    I(11, 1, { name: "Tea", price: 40, quantity: 1, stationAcceptedBy: "Abel", stationAcceptedAt: at("10:00"), stationDoneBy: "Abel", stationDoneAt: at("10:20") }),
    I(12, 2, { name: "Latte", price: 90, quantity: 1, stationAcceptedBy: "Abel", stationAcceptedAt: at("13:55"), stationDoneBy: "Abel", stationDoneAt: at("14:12") }),
    I(13, 2, { name: "Macchiato", price: 70, quantity: 1, stationAcceptedBy: "Biniam", stationAcceptedAt: at("14:03"), stationDoneBy: "Biniam", stationDoneAt: at("14:06") }),
    I(14, 3, { name: "Milk", price: 60, quantity: 1, stationAcceptedBy: "Biniam", stationAcceptedAt: at("15:30"), stationDoneBy: "Biniam", stationDoneAt: at("15:40") }),
    I(15, 4, { name: "Tea", price: 40, quantity: 1, stationAcceptedBy: "Abel", stationAcceptedAt: at("11:00"), stationStatus: "accepted" }),
    I(16, 5, { name: "Juice", price: 100, quantity: 1, removed: true, stationAcceptedBy: "Abel", stationAcceptedAt: at("12:00"), stationDoneBy: "Abel", stationDoneAt: at("12:10") }),
    I(17, 6, { name: "Espresso", price: 70, quantity: 1, stationAcceptedBy: "Abel", stationAcceptedAt: at("14:50"), stationDoneBy: "Abel", stationDoneAt: at("15:05") }),
    I(18, 7, { name: "Macchiato", price: 80, quantity: 1, stationAcceptedBy: "Abel", stationAcceptedAt: at("10:30"), stationDoneBy: "cashier print", stationDoneAt: at("12:00") }),
  ];
  const staffRoles = { Abel: "barista", Biniam: "barista" };
  const shiftClaims: Array<{ dayKey: string; shift: HandoverShift; staffName: string }> = [
    { dayKey: day, shift: "morning", staffName: "Abel" },
    { dayKey: day, shift: "afternoon", staffName: "Biniam" },
  ];

  const report = buildShiftReport({
    role: "barista", date: "today", dayKeys: [day], tickets, items, events: [], submissions: [], staffRoles, shiftClaims,
  });

  // MORNING = Abel only, INCLUDING the drink he accepted at 14:50 and finished
  // at 15:05 (registered-owner bucketing, not the clock). The "cashier print"
  // marker never becomes a crew member: the line it finished still belongs to
  // Abel through his Accept, and no fake person appears anywhere.
  assert.deepEqual(report.morning.map((p) => p.name), ["Abel"]);
  const abel = report.morning[0];
  assert.deepEqual(abel.ticketIds.sort(), [1, 2, 6, 7]);
  assert.equal(abel.orders, 4);
  // Per-line amounts: 2×70 + 40 + 90 + 70 + 80 = 420. The cancelled order and
  // the removed line count NOTHING, exactly like his own Items-sold tab.
  assert.equal(abel.amount, 420);
  assert.ok(!report.afternoon.some((p) => /cashier print/i.test(p.name)));
  assert.ok(!report.combined.some((g) => /cashier print/i.test(g.label)));

  // AFTERNOON = Biniam only; his 14:03 window accept lands here.
  assert.deepEqual(report.afternoon.map((p) => p.name), ["Biniam"]);
  const biniam = report.afternoon[0];
  assert.deepEqual(biniam.ticketIds.sort(), [2, 3]);
  assert.equal(biniam.amount, 70 + 60);

  // The shared order stays visible for the cross-checker under Combined.
  assert.equal(report.combined.length, 1);
  assert.equal(report.combined[0].label, "Abel - Biniam");
  assert.deepEqual(report.combined[0].ticketIds, [2]);

  // THE ARGUMENT-SETTLER: each person's row equals what his own tablet says.
  // Since the shift lock (round 5) the same person accepts and finishes a line,
  // so "every line this person touched" is now exactly the ACCEPTED pile — the
  // union that used to be called Combined. The "#cashier print" marker still
  // never becomes a person: line 18 is Abel's through his accept.
  for (const [person, row] of [["Abel", abel], ["Biniam", biniam]] as const) {
    const sales = buildStationSales({
      period: "today", station: "barista", staff: person,
      rows: items.map((it) => ({ ...it, ticketStatus: tickets.find((t) => t.id === it.ticketId)?.status }) as StationSalesItemRow),
      now: at("18:00"),
    });
    assert.equal(row.amount, sales.modes.accepted.amount, `${person}: shift report must equal Items sold`);
    assert.equal(row.orders, sales.modes.accepted.bills, `${person}: order count must equal Items sold bills`);
  }

  // WITHOUT claims (a day before this feature existed): the old clock split
  // returns — Abel's 14:50 accept lands in the afternoon bucket again.
  const legacy = buildShiftReport({
    role: "barista", date: "today", dayKeys: [day], tickets, items, events: [], submissions: [], staffRoles,
  });
  assert.ok(legacy.morning.some((p) => p.name === "Abel"));
  assert.ok(legacy.afternoon.some((p) => p.name === "Abel"));
  assert.equal(legacy.shiftClaims, undefined);

  console.log("✅ the admin barista sheet and the barista's own Items sold always agree");
}

/* ── 8. THE WIRING (server route + screen), because this feature broke live ──
 *
 * The rules above were green while the cafe still saw the old shared board:
 * the devices are also used for /admin, and an admin cookie (7 days) made the
 * route answer "admin" and skip the hand-over completely. These guards read
 * the real source so that wiring can never silently disappear again.
 */
{
  const read = (rel: string) => readFileSync(path.resolve(__dirname, "..", rel), "utf8");
  const route = read("src/app/api/station-items/route.ts");
  const screen = read("src/components/rms/StationApp.tsx");

  // THE ADMIN COOKIE BUG: a crew member's own session must be read FIRST.
  const authStart = route.indexOf("async function authorizedStation");
  const auth = route.slice(authStart, route.indexOf("\n}", authStart) + 2);
  const staffPos = auth.indexOf("readStaffSession");
  const adminPos = auth.indexOf("readAdminSession");
  assert.ok(staffPos > -1 && adminPos > -1 && staffPos < adminPos, "authorizedStation must read the staff session before the admin session");

  // The GET must carry the lock-screen data the screen renders.
  for (const field of ["blockedBy: rule.blockedBy", "canContinueAfternoon: rule.canContinueAfternoon", "alsoMorning: rule.alsoMorning"]) {
    assert.ok(route.includes(field), `the barista envelope must carry ${field}`);
  }

  // A REGISTERED SHIFT IS LOCKED (owner, 29 Sept 2026): the morning takeover
  // is gone for good, and the only shift action left is continuing.
  const post = route.slice(route.indexOf("export async function POST"));
  assert.ok(!/take-morning|takeOverMorning/.test(route), "the morning takeover must not come back");
  assert.ok(!/No, this is my shift/.test(screen), "the takeover button must not come back");
  assert.ok(post.includes('action === "continue-afternoon"'), "the continue action must exist");
  const continueBlock = post.slice(post.indexOf('action === "continue-afternoon"'));
  assert.ok(continueBlock.includes('info.phase !== "after"'), "continuing into the afternoon waits for the window to close");
  assert.ok(continueBlock.includes("owners.morning.staffName !== viewerName"), "only the morning owner may continue");
  assert.ok(continueBlock.includes("owners.afternoon"), "a taken afternoon is never overwritten");

  // THE SCREEN: the owner's exact words must be on the standby screen, with
  // the two buttons wired to the two actions.
  assert.ok(screen.includes('L("Barista morning shift is taken by {name}"'), "the standby screen names the morning shift holder");
  assert.ok(screen.includes('L("Today\'s afternoon shift is {name}"'), "the standby screen names the afternoon shift holder");
  assert.ok(screen.includes('L("You are not in this shift. Orders show only on {name}\'s screen."'), "the lock screen says it is not his shift");
  assert.ok(screen.includes('L("I will continue as afternoon shift")') && screen.includes('runShiftAction("continue-afternoon")'), "the continue button must exist");
  assert.ok(screen.includes("lockScreen"), "the empty board must pick a lock screen (standby / continue / shift over)");

  console.log("✅ the wiring holds: staff session first, the locked shifts, the continue button");
}

console.log("\n🎉 THE BARISTA HAND-OVER: all guards green");
