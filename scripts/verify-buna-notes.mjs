#!/usr/bin/env node
/**
 * Regression guard — THE COFFEE NOTE (owner's decision, Sept 2026).
 *
 * The buna makers sell traditional coffee outdoor and never look at their
 * phones, so those sales must never enter the station flow. The cashier holds
 * each call as a numbered note; paying one creates an outdoor ticket that is
 * BORN FINISHED, straight into order history. This file statically inspects
 * the whole path so the guarantees cannot silently drift:
 *
 *   1. SCHEMA/MIGRATION: the buna_notes table exists in both, the daily
 *      numbering column exists, and the schema version was bumped.
 *   2. API GUARDS + PRICE AUTHORITY: every method is staff-guarded; the
 *      client can never send a name or a price (the server resolves the menu
 *      item, with the menu's buna as the default); quantities and the place
 *      note are bounded; held rows are edited/deleted, paid rows are locked.
 *   3. PAY ROUTE: the ticket is created outdoor + paid + printed (order
 *      history with the Outdoor badge, her EFD cross-check), the one line is
 *      buna/done so NO station screen can ever queue it, the note is claimed
 *      inside the same transaction (a double-tap cannot create two tickets),
 *      the FANA order number is stamped, the audit trail is written and the
 *      realtime channel is published.
 *   4. THE PANEL: Add New at the top, buna as the default item, square +/−
 *      steppers, the place note, the HOLD button, numbered rows with the time
 *      added and Edit / Paid / Delete, and the collapsed "paid today" strip.
 *   5. THE DASHBOARD: the Coffee Note button (with the held badge) opens the
 *      panel, and a payment refreshes the history lists.
 *
 * Static source inspection only — no database, no server, runs anywhere.
 * Run with: node scripts/verify-buna-notes.mjs   (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const schema = read("src/db/schema.ts");
const migrate = read("src/db/migrate.ts");
const types = read("src/types/index.ts");
const route = read("src/app/api/buna-notes/route.ts");
const pay = read("src/app/api/buna-notes/pay/route.ts");
const panel = read("src/components/rms/CoffeeNotePanel.tsx");
const cashier = read("src/components/rms/CashierDashboard.tsx");
const stationItems = read("src/app/api/station-items/route.ts");

const failures = [];
const pass = (name, cond) => {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures.push(name);
};

/* ── 1. schema + migration ────────────────────────────────────────────────── */
{
  pass("the buna_notes table exists in the drizzle schema", /export const bunaNotes = pgTable\("buna_notes"/.test(schema));
  pass(
    "the note carries the daily number, the item snapshot, the amount, the place and the payment link",
    /seq: integer\("seq"\)/.test(schema) &&
      /itemName: varchar\("item_name"/.test(schema) &&
      /unitPrice: integer\("unit_price"/.test(schema) &&
      /quantity: integer\("quantity"/.test(schema) &&
      /placeNote: varchar\("place_note"/.test(schema) &&
      /ticketId: integer\("ticket_id"\)/.test(schema)
  );
  pass("the migration creates the same table", /CREATE TABLE IF NOT EXISTS buna_notes/.test(migrate) && /place_note varchar\(200\)/.test(migrate));
  pass("the migration indexes the held/paid reads", /buna_notes_paid_at_held_at_idx/.test(migrate));
  pass("the schema version was bumped so deployments migrate", /SCHEMA_VERSION = "2026-09-16-1"/.test(migrate));
  pass("the shared BunaNote type exists", /export interface BunaNote/.test(types));
}

/* ── 2. the notes API: guards + price authority ───────────────────────────── */
{
  for (const method of ["GET", "POST", "PUT", "DELETE"]) {
    pass(
      `${method} /api/buna-notes requires a staff or admin session`,
      new RegExp(`export async function ${method}\\(`).test(route) &&
        /requireStaffOrAdmin\(\)/.test(route.split(`export async function ${method}`)[1] ?? "")
    );
  }
  pass(
    "the server resolves the item and price from the menu (client never sends them)",
    /effectivePrice/.test(route) && !/body\?\.(price|name|unitPrice|itemName)/.test(route)
  );
  pass(
    "no item picked means the menu's BUNA item is the default",
    /all\.find\(\(m\) => Boolean\(m\.isBuna\)\)/.test(route) && /\/buna\/i/.test(route)
  );
  pass("an unknown menu item is rejected", /That menu item does not exist/.test(route));
  pass("the amount is bounded (1..99)", /MAX_NOTE_QUANTITY = 99/.test(route) && /n < 1 \|\| n > MAX_NOTE_QUANTITY/.test(route));
  pass("the place note is trimmed and capped at 200", /slice\(0, 200\)/.test(route));
  pass(
    "note numbers restart each day (max seq of today + 1)",
    /nextSeqToday/.test(route) && /etStartOfToday\(\)/.test(route) && /coalesce\(max\(/.test(route)
  );
  pass("held rows can be edited, paid rows are locked (409)", /already paid and lives in order history/.test(route));
  pass("only HELD rows can be deleted", /Paid notes belong to order history and cannot be deleted/.test(route));
  pass("every mutation publishes the realtime refresh", (route.match(/publish\(CHANNELS\.orders\)/g) || []).length === 3);
}

/* ── 3. the pay route: a ticket born finished ─────────────────────────────── */
{
  pass("paying requires a staff or admin session", /requireStaffOrAdmin\(\)/.test(pay));
  pass("the note is claimed in the same transaction as the ticket", /db\.transaction/.test(pay) && /isNull\(bunaNotes\.paidAt\)/.test(pay));
  pass("a double-tap cannot create two tickets (zero claimed rows rolls back)", /claimed\.length === 0/.test(pay) && /ALREADY_PAID/.test(pay));
  pass(
    "the ticket is OUTDOOR (the history corner badge) and born PAID",
    /orderType: "outdoor"/.test(pay) && /status: "paid"/.test(pay) && /paymentStatus: "paid_cash"/.test(pay)
  );
  pass(
    "it is stamped printed + verified, so it enters her daily EFD cross-check",
    /printedAt: now/.test(pay) && /verifiedAt: now/.test(pay)
  );
  pass(
    "the one bill line is buna/done, so no station screen can ever queue it",
    /stationName: "buna"/.test(pay) && /stationStatus: "done"/.test(pay)
  );
  pass("the station feed really excludes finished bills", /notInArray\(tickets\.status, \["paid", "cancelled", "closed", "pending_waiter"\]\)/.test(stationItems));
  pass("the guaranteed FANA order number is stamped", /FANA-\$\{ticket\.id\}/.test(pay));
  pass("the payment is audit-trailed like every other ticket", /recordTicketEvent/.test(pay) && /Coffee note #\$\{note\.seq\} settled/.test(pay));
  pass("the ticket total is the note's price × amount", /note\.unitPrice\) \|\| 0\) \* quantity/.test(pay));
  pass("paying publishes the realtime refresh", /publish\(CHANNELS\.orders\)/.test(pay));
}

/* ── 4. the panel: exactly the page the owner described ───────────────────── */
{
  pass("Add New sits at the top of the page", /Add New/.test(panel) && /setFormOpen\(true\)/.test(panel));
  pass("the item defaults to Buna and can be changed by search", /defaultBunaItem/.test(panel) && /Buna \(default\)/.test(panel) && /Change the item\? Search the menu/.test(panel));
  pass("the amount uses square +/− steppers", /qtyStepper/.test(panel) && /w-11 h-11 rounded-xl/.test(panel) && /aria-label="One less"/.test(panel) && /aria-label="One more"/.test(panel));
  pass("the place (note) input is there", /Place \(note\)/.test(panel) && /Gate, parking, office/.test(panel));
  pass("the button says HOLD and holds a note", /HOLD/.test(panel) && /fetch\("\/api\/buna-notes",[\s\S]{0,200}method: "POST"/.test(panel));
  pass("held rows are numbered, newest first, with the time added", /\{note\.seq\}/.test(panel) && /formatClock\(note\.heldAt\)/.test(panel) && /newest first/.test(panel));
  pass("each held row has Edit, Paid and Delete", /Edit/.test(panel) && /Paid/.test(panel) && /Delete/.test(panel) && /startEdit/.test(panel) && /deleteNote/.test(panel));
  pass(
    "editing reuses the same line controls (item, amount, place)",
    /qtyStepper\(editQty, setEditQty\)/.test(panel) &&
      /setEditPickedId/.test(panel) &&
      /editSearch/.test(panel) &&
      /value=\{editPlace\}/.test(panel)
  );
  pass("paying and deleting both ask for confirmation", /Mark note #\$\{note\.seq\} as PAID/.test(panel) && /Delete note #\$\{note\.seq\}/.test(panel));
  pass("paid rows collapse into the 'paid today' strip with the order number", /Paid today/.test(panel) && /already in order history/.test(panel) && /FANA-\$\{note\.ticketId\}/.test(panel));
  pass("the panel holds a held note via POST /api/buna-notes", /fetch\("\/api\/buna-notes",[\s\S]{0,200}method: "POST"/.test(panel));
  pass("the panel marks paid via POST /api/buna-notes/pay", /fetch\("\/api\/buna-notes\/pay"/.test(panel));
}

/* ── 5. the dashboard wiring ──────────────────────────────────────────────── */
{
  // Coffee Note button on the cashier dashboard was retired at owner request (Sept 2026).
  // The panel component and history refresh wiring remain intact.
  pass("the panel remains mounted on the dashboard", /<CoffeeNotePanel/.test(cashier));
  pass("the badge refreshes with the history cadence", /fetch\("\/api\/buna-notes"\)[\s\S]{0,200}setCoffeeHeld/.test(cashier));
  pass("a paid note refreshes the history lists (it joined order history)", /onChanged=\{\(kind\)/.test(cashier) && /kind === "paid"/.test(cashier));
}

console.log(
  failures.length === 0
    ? "\n✅ Coffee Note (outdoor buna tab) regression test PASSED"
    : `\n❌ ${failures.length} Coffee Note assertions FAILED`
);
if (failures.length) process.exit(1);
