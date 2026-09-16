#!/usr/bin/env node
/**
 * Regression guard — MATCH DAY ORDERS (owner's decision, Sept 2026).
 *
 * On football nights the guests drag chairs from other tables to sit near
 * the screen, so table numbers stop describing reality — but the waiter
 * still has to take the order with some identifier, and the kitchen still
 * has to make the food. This file statically inspects the whole path so
 * the guarantees cannot silently drift:
 *
 *   1. THE ROUTE: a "MATCH • <spot>" label rides the outdoor flow untouched
 *      (no OUTDOOR prefix gets prepended, length still bounded); a staff
 *      POST with targetTicketId merges another round into that exact open
 *      outdoor bill instead of opening a new one; the audit records the
 *      real session role (a waiter-sent match order says "Waiter", and the
 *      actorRole says waiter, not cashier).
 *   2. THE COMPOSER: the waiter-side modal POSTs source "staff" + orderType
 *      "outdoor" + outdoorLabel "MATCH • <spot>" + targetTicketId on
 *      follow-up rounds + an idempotency key; it offers the open match
 *      bills it found via /api/tickets?active=1 so rounds land on the
 *      right bill; it sends items with per-item notes.
 *   3. THE WAITER APP: the ⚽ Match Day Order button exists on the tables
 *      view and opens the composer wired to the signed-in waiter's name.
 *   4. THE CASHIER: match orders keep the Outdoor badge slot but the label
 *      tells the truth — "⚽ Match" when the table name starts with MATCH,
 *      everywhere the badge renders (queue, outdoor section, history,
 *      bill modal).
 *
 * Static source inspection only — no database, no server, runs anywhere.
 * Run with: node scripts/verify-match-day.mjs   (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const route = read("src/app/api/tickets/route.ts");
const composer = read("src/components/rms/MatchDayComposer.tsx");
const waiter = read("src/components/rms/WaiterApp.tsx");
const cashier = read("src/components/rms/CashierDashboard.tsx");

const failures = [];
let count = 0;
const pass = (name, ok) => {
  count += 1;
  if (!ok) failures.push(name);
  console.log(`${ok ? "✓" : "✗ FAIL"} ${name}`);
};

/* ── 1. the route ─────────────────────────────────────────────────────────── */
{
  pass(
    "the label normalizer lets MATCH labels pass untouched (no OUTDOOR prefix)",
    /\^\(outdoor\|match\)\\b\/i\.test\(trimmed\) \? trimmed : `OUTDOOR • \$\{trimmed\}`/.test(route),
  );
  pass(
    "the label is still bounded to 50 characters",
    /\.slice\(0,\s*50\)/.test(route),
  );
  pass(
    "a staff POST resolves the sender's real session",
    /const senderSession = !isCustomer \? await readStaffSession\(\) : null;/.test(route),
  );
  pass(
    "actorRole prefers the session role (waiter-sent match orders audit as waiter)",
    /const actorRole = senderSession\?\.role \|\| actorRoleOf\(/.test(route),
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
    "the ticket_sent audit names the real sender role for outdoor orders",
    /senderSession\?\.role === "waiter" \? "Waiter" : "Cashier"[\s\S]{0,80}sent a new outdoor order to the stations/.test(route),
  );
}

/* ── 2. the composer ──────────────────────────────────────────────────────── */
{
  pass(
    "the composer POSTs as staff with the outdoor order type",
    /source: "staff",[\s\S]{0,80}orderType: "outdoor",/.test(composer),
  );
  pass(
    "a new group is labeled MATCH • <spot>",
    /outdoorLabel: target \? target\.tableName : `MATCH • \$\{spot\.trim\(\)\}`/.test(composer),
  );
  pass(
    "another round sends targetTicketId (and the existing bill's label)",
    /targetTicketId: target \? target\.id : undefined,/.test(composer),
  );
  pass(
    "every send carries an idempotency key",
    /idempotencyKey: pendingKeyRef\.current/.test(composer),
  );
  pass(
    "the idempotency key is a fresh UUID per send",
    /crypto\.randomUUID/.test(composer),
  );
  pass(
    "open match bills are discovered via the active-tickets endpoint",
    /\/api\/tickets\?active=1/.test(composer),
  );
  pass(
    "only outdoor tickets labeled MATCH become open-bill chips",
    /t\.orderType === "outdoor" && \/\^MATCH\\b\/i\.test\(String\(t\.tableName \|\| ""\)\)/.test(composer),
  );
  pass(
    "the payload includes the cart items with notes",
    /items:/.test(composer) && /note/.test(composer),
  );
}

/* ── 3. the waiter app wiring ─────────────────────────────────────────────── */
{
  pass("the composer is imported", /import MatchDayComposer from "@\/components\/rms\/MatchDayComposer";/.test(waiter));
  pass("the open state exists", /setMatchComposerOpen/.test(waiter));
  pass(
    "the ⚽ Match Day Order button sits on the tables view",
    /Match Day Order/.test(waiter) && /setMatchComposerOpen\(true\)/.test(waiter),
  );
  pass(
    "the composer is rendered with the signed-in waiter's name",
    /<MatchDayComposer[\s\S]{0,200}waiterName=\{staffName\}/.test(waiter),
  );
  pass(
    "closing it just closes (match bills never touch the table grid)",
    /onClose=\{\(\) => setMatchComposerOpen\(false\)\}/.test(waiter),
  );
}

/* ── 4. the cashier badges ────────────────────────────────────────────────── */
{
  pass(
    "match detection keys off the outdoor type + MATCH label",
    /const isMatch = \(t: Ticket\) => isOutdoor\(t\) && \/\^MATCH\\b\/i\.test\(String\(t\.tableName \|\| ""\)\);/.test(cashier),
  );
  pass(
    "the badge reads ⚽ Match for match orders, Outdoor otherwise",
    /const outdoorBadge = \(t: Ticket\) => \(isMatch\(t\) \? "⚽ Match" : "Outdoor"\);/.test(cashier),
  );
  const uses = (cashier.match(/\{outdoorBadge\(t\)\}/g) || []).length;
  const usesModal = /\{outdoorBadge\(billModal\)\}/.test(cashier);
  pass(
    `every badge slot uses the helper (${uses} ticket slots + the bill modal)`,
    uses === 4 && usesModal,
  );
  pass(
    "the outdoor section tells the cashier match-day orders land here too",
    /match-day orders waiters take when the chairs move to the screen/.test(cashier),
  );
}

console.log(
  failures.length === 0
    ? `\n✅ Match Day Orders regression test PASSED (${count} assertions)`
    : `\n❌ ${failures.length} Match Day assertions FAILED`,
);
if (failures.length) process.exit(1);
