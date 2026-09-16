#!/usr/bin/env node
/**
 * Regression guard — GROUP ORDERS (owner's decision, Sept 2026).
 *
 * On busy nights the seating does not match the table grid: chairs get
 * dragged around, different peoples share one table, some guests sit with no
 * table at all. So the billing unit is the GROUP OF PEOPLE: each group gets
 * its own auto-numbered bill ("GROUP 3"), rounds join the same bill, each
 * group pays separately. This file statically inspects the whole path so the
 * guarantees cannot silently drift:
 *
 *   1. THE NUMBERING LIB: group numbers come from the SERVER (daily, never
 *      reused within a day, computed under an advisory lock so two waiters
 *      creating groups in the same instant still get consecutive numbers).
 *   2. THE ROUTE: a staff POST with groupOrder: true gets a server-stamped
 *      "GROUP <n>" label (the client can never pick or forge a number); a
 *      round with targetTicketId merges into that exact open outdoor bill and
 *      keeps the TARGET's label; the audit records the real session role (a
 *      waiter-sent group order says "Waiter", not "Cashier"); GET answers
 *      ?nextGroup=1 for the composer's display prediction.
 *   3. THE COMPOSER: the waiter-side modal POSTs source "staff" + orderType
 *      "outdoor" + groupOrder true + targetTicketId on rounds + an
 *      idempotency key; it lists only the OPEN GROUP bills as round targets;
 *      it shows the predicted next number; items carry per-item notes.
 *   4. THE WAITER APP: the Groups button sits in the top corner of the
 *      tables view and opens the composer wired to the signed-in waiter.
 *   5. THE CASHIER + HISTORY: group bills keep the Outdoor badge slot but
 *      the label tells the truth — "👥 Group" for GROUP bills, everywhere
 *      the badge renders (queue, outdoor section, history, bill modal).
 *
 * Static source inspection only — no database, no server, runs anywhere.
 * Run with: node scripts/verify-group-orders.mjs   (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const lib = read("src/lib/group-orders.ts");
const route = read("src/app/api/tickets/route.ts");
const composer = read("src/components/rms/GroupComposer.tsx");
const waiter = read("src/components/rms/WaiterApp.tsx");
const cashier = read("src/components/rms/CashierDashboard.tsx");
const history = read("src/components/rms/OrderHistoryTab.tsx");
const types = read("src/types/index.ts");

const failures = [];
let count = 0;
const pass = (name, ok) => {
  count += 1;
  if (!ok) failures.push(name);
  console.log(`${ok ? "✓" : "✗ FAIL"} ${name}`);
};

/* ── 1. the numbering lib ─────────────────────────────────────────────────── */
{
  pass("the GROUP label shape is defined once (GROUP <n>)", /export const GROUP_LABEL_RE = \/\^GROUP \(\\d\+\)\$\/;/.test(lib) && /export const groupLabel = \(n: number\) => `GROUP \$\{n\}`;/.test(lib));
  pass(
    "numbering is daily, keyed to Ethiopian midnight like the Coffee Note seq",
    /gte\(tickets\.createdAt, etStartOfToday\(\)\)/.test(lib),
  );
  pass(
    "numbering takes an advisory lock inside the ticket transaction (two waiters at once still get consecutive numbers)",
    /pg_advisory_xact_lock/.test(lib) && /export async function nextGroupNumberInTx\(tx: any\)/.test(lib),
  );
  pass(
    "the number is max of today's GROUP bills + 1 (never reused within a day)",
    /Math\.max\(max, Number\(match\[1\]\)\)/.test(lib) && /return max \+ 1;/.test(lib),
  );
}

/* ── 2. the route ─────────────────────────────────────────────────────────── */
{
  pass(
    "the label normalizer lets GROUP labels pass untouched (no OUTDOOR prefix)",
    /\^\(outdoor\|group\)\\b\/i\.test\(trimmed\) \? trimmed : `OUTDOOR • \$\{trimmed\}`/.test(route),
  );
  pass(
    "a staff POST resolves the sender's real session",
    /const senderSession = !isCustomer \? await readStaffSession\(\) : null;/.test(route),
  );
  pass(
    "actorRole prefers the session role (waiter-sent group orders audit as waiter)",
    /const actorRole = senderSession\?\.role \|\| actorRoleOf\(/.test(route),
  );
  pass(
    "the group flag is detected exactly as the composer sends it",
    /const isGroupOrder = orderType === "outdoor" && body\?\.groupOrder === true;/.test(route),
  );
  pass(
    "a NEW group bill is stamped by the server under the advisory lock",
    /if \(isGroupOrder\) tableName = groupLabel\(await nextGroupNumberInTx\(tx\)\);/.test(route),
  );
  pass(
    "the POST reads targetTicketId for another-round merges",
    /const targetTicketId = Number\(body\?\.targetTicketId\) \|\| 0;/.test(route),
  );
  pass(
    "a targeted lookup merges into that exact open outdoor bill",
    /eq\(tickets\.id, targetTicketId\),[\s\S]{0,120}eq\(tickets\.orderType, "outdoor"\)/.test(route),
  );
  pass(
    "the merge path only triggers for a positive id (regular outdoor inserts untouched)",
    /targetTicketId > 0\s*\?\s*await tx[\s\S]{0,400}:\s*\[\]/.test(route),
  );
  pass(
    "another round keeps the TARGET's server-side label",
    /if \(isGroupOrder\) tableName = activeTickets\[0\]\.tableName;/.test(route),
  );
  pass(
    "the ticket_sent audit names the real sender role for outdoor orders",
    /senderSession\?\.role === "waiter" \? "Waiter" : "Cashier"[\s\S]{0,80}sent a new outdoor order to the stations/.test(route),
  );
  pass(
    "GET answers ?nextGroup=1 for the composer's display prediction",
    /searchParams\.get\("nextGroup"\) === "1"[\s\S]{0,200}nextGroupNumberToday\(\)/.test(route),
  );
}

/* ── 3. the composer ──────────────────────────────────────────────────────── */
{
  pass(
    "the composer POSTs as staff on the outdoor flow with the group flag",
    /source: "staff",[\s\S]{0,80}orderType: "outdoor",[\s\S]{0,80}groupOrder: true,/.test(composer),
  );
  pass(
    "another round sends targetTicketId (no client-picked label)",
    /targetTicketId: target \? target\.id : undefined,/.test(composer) && !/outdoorLabel/.test(composer),
  );
  pass(
    "every send carries an idempotency key (fresh UUID per send)",
    /idempotencyKey: pendingKeyRef\.current/.test(composer) && /crypto\.randomUUID/.test(composer),
  );
  pass(
    "open groups are discovered via the active-tickets endpoint",
    /\/api\/tickets\?active=1/.test(composer),
  );
  pass(
    "only outdoor tickets labeled GROUP become round targets",
    /t\.orderType === "outdoor" && \/\^GROUP \\d\+\$\/i\.test\(String\(t\.tableName \|\| ""\)\)/.test(composer),
  );
  pass(
    "the predicted next number comes from the server (display only)",
    /\/api\/tickets\?nextGroup=1/.test(composer) && /typeof data\?\.nextGroup === "number"/.test(composer),
  );
  pass(
    "the toast reports the SERVER-stamped group number",
    /const group = String\(data\?\.tableName \|\| ""\);/.test(composer) && /✓ \$\{group\} created/.test(composer),
  );
  pass(
    "the payload includes the cart items with notes",
    /items:/.test(composer) && /notes: line\.notes/.test(composer),
  );
}

/* ── 4. the waiter app wiring ─────────────────────────────────────────────── */
{
  pass("the composer is imported", /import GroupComposer from "@\/components\/rms\/GroupComposer";/.test(waiter));
  pass("the open state exists", /setGroupComposerOpen/.test(waiter));
  pass(
    "the Groups button sits in the top corner of the tables view (header row)",
    /Select Table[\s\S]{0,600}setGroupComposerOpen\(true\)[\s\S]{0,400}Groups/.test(waiter),
  );
  pass(
    "the composer is rendered with the signed-in waiter's name",
    /<GroupComposer[\s\S]{0,200}waiterName=\{staffName\}/.test(waiter),
  );
  pass(
    "closing it just closes (group bills never touch the table grid)",
    /onClose=\{\(\) => setGroupComposerOpen\(false\)\}/.test(waiter),
  );
}

/* ── 5. the cashier + history badges ──────────────────────────────────────── */
{
  pass(
    "group detection keys off the outdoor type + GROUP label",
    /const isGroup = \(t: Ticket\) => isOutdoor\(t\) && \/\^GROUP \\d\+\$\/i\.test\(String\(t\.tableName \|\| ""\)\);/.test(cashier),
  );
  pass(
    "the badge reads 👥 Group for group bills, Outdoor otherwise",
    /const outdoorBadge = \(t: Ticket\) => \(isGroup\(t\) \? "👥 Group" : "Outdoor"\);/.test(cashier),
  );
  const uses = (cashier.match(/\{outdoorBadge\(t\)\}/g) || []).length;
  const usesModal = /\{outdoorBadge\(billModal\)\}/.test(cashier);
  pass(
    `every cashier badge slot uses the helper (${uses} ticket slots + the bill modal)`,
    uses === 4 && usesModal,
  );
  pass(
    "the outdoor section tells the cashier group orders land here too",
    /group orders waiters take when the seating does not match the tables/.test(cashier),
  );
  pass(
    "order history shows the 👥 Group badge on paid group bills",
    /\{\/\^GROUP \\d\+\$\/i\.test\(String\(o\.tableName \|\| ""\)\) \? "👥 Group" : "Outdoor"\}/.test(history),
  );
}

/* ── 6. like a table: the group bill lives in the waiter's grid ──────────── */
{
  pass(
    "the CafeTable type carries the group flag (pseudo-table cards)",
    /isGroup\?: boolean;/.test(types),
  );
  pass(
    "loadTables derives the open group cards from the active tickets it already loads",
    /setGroupTickets\(all\.filter\(\(t\) => t\.orderType === "outdoor" && \/\^GROUP \\d\+\$\/i\.test\(String\(t\.tableName \|\| ""\)\)\)\);/.test(waiter),
  );
  pass(
    "group cards render in the grid, tapping one opens it like a table",
    /groupTickets\.map\(\(g\) => \([\s\S]{0,400}onClick=\{\(\) => openGroup\(g\)\}/.test(waiter),
  );
  pass(
    "openGroup builds a pseudo-table (synthetic id, ticket id, group flag) and opens the BILL view",
    /const openGroup = \(t: Ticket\) => \{[\s\S]{0,700}activeTicketId: t\.id,[\s\S]{0,300}isGroup: true,[\s\S]{0,200}setView\("bill"\);/.test(waiter),
  );
  pass(
    "the group card shows the status chip and total like a table card",
    /statusChip\(groupTableStatus\(g\)\)/.test(waiter) && /\{g\.totalAmount\} ETB open/.test(waiter),
  );
  pass(
    "Add Items on a group bill rides the group round flow (same bill, server label)",
    /const groupRound = selectedTable\.isGroup === true && !!selectedTable\.activeTicketId;/.test(waiter) &&
      /groupRound[\s\S]{0,200}\? \{ source: "staff", orderType: "outdoor", groupOrder: true, targetTicketId: selectedTable\.activeTicketId \}/.test(waiter),
  );
  pass(
    "a table order is still sent the table way (no group flag leaks into normal tables)",
    /: \{ tableId: selectedTable\.id \}/.test(waiter),
  );
  pass(
    "the round toast names the group bill",
    /✓ Items added to \$\{String\(d\.tableName \|\| "the group bill"\)\}/.test(waiter),
  );
  pass(
    "settling says Group Settled on a group bill, Table Cleared on a table",
    /selectedTable\?\.isGroup \? "Group Settled • Close Bill" : "Table Cleared • Free Table"/.test(waiter),
  );
  pass(
    "the grid hint explains the GROUP cards",
    /GROUP cards<\/span> are guest groups away from their table: open one to add items or settle it exactly like a table\./.test(waiter),
  );
}

console.log(
  failures.length === 0
    ? `\n✅ Group Orders regression test PASSED (${count} assertions)`
    : `\n❌ ${failures.length} Group Orders assertions FAILED`,
);
if (failures.length) process.exit(1);
