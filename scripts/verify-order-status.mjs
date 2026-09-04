#!/usr/bin/env node
/**
 * Regression guard — the six guest-facing order features.
 *
 *   1. LIVE ORDER STATUS on the guest's own phone (public, table-scoped).
 *   2. ARRIVAL TIME / DATE + waiter name on the crew, waiter and cashier screens.
 *   3. DUPLICATE LINES merged ("2 Tea", never "1 Tea + 1 Tea").
 *   4. "BRING US THE BILL/RECEIPT" — guest taps, staff see it (and can clear it).
 *   5. REVIEW as the last step of the guest flow, with a thank-you state.
 *   6. (image side is covered by verify-image-reveal.mjs / verify-image-display.ts)
 *
 * Static source inspection only — no database, no server, runs anywhere.
 * Run with: node scripts/verify-order-status.mjs   (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const failures = [];
const pass = (name, cond) => {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures.push(name);
};

const status = read("src/app/api/table-status/route.ts");
const tickets = read("src/app/api/tickets/route.ts");
const schema = read("src/db/schema.ts");
const migrate = read("src/db/migrate.ts");
const stationItems = read("src/app/api/station-items/route.ts");
const tablesRoute = read("src/app/api/tables/route.ts");
const stationApp = read("src/components/rms/StationApp.tsx");
const waiterApp = read("src/components/rms/WaiterApp.tsx");
const cashier = read("src/components/rms/CashierDashboard.tsx");
const history = read("src/components/rms/OrderHistoryTab.tsx");
const orderStatusUi = read("src/components/rms/OrderStatus.tsx");
const app = read("src/components/rms/CustomerMenuApp.tsx");
const i18n = read("src/lib/i18n.ts");

/* ── 1. the public table-status endpoint ──────────────────────────────────── */
{
  pass("GET /api/table-status exists", /export async function GET/.test(status));
  pass("POST /api/table-status exists", /export async function POST/.test(status));
  pass("it is table-scoped and validates the table id", /searchParams\.get\("table"\)/.test(status) && /Number\.isInteger\(tableId\) \|\| tableId <= 0/.test(status));
  pass("guest reads are rate-limited per TABLE and per venue", /checkSharedIpRateLimit\("table-status", request, tableId, VENUE_POLICIES\.statusRead\)/.test(status));
  pass("bill requests are rate-limited separately", /table-status-request:venue:/.test(status) && /table-status-request:\$\{ip\}:\$\{tableId\}/.test(status));
  pass("responses are never cached (status must be live)", /"Cache-Control": "no-store"/.test(status));
  pass("no staff auth is required (guests have no session)", !/requireAdmin|requireStaff|requireCashier|requireWaiter/.test(status));
  // Every single ticket query in this file must be scoped to the requested table.
  const ticketScopes = [...status.matchAll(/\.from\(tickets\)[\s\S]{0,220}?\.where\(([\s\S]{0,120}?)\)/g)].map((m) => m[1]);
  pass("every ticket query is scoped to the requested table", ticketScopes.length >= 3 && ticketScopes.every((w) => w.includes("tickets.tableId, tableId")));
  pass("the payload leaks no staff names or receipt photos", !/createdBy|waiterName|staffName|receiptImage|pinHash/.test(status));
  pass("recently-paid bills stay visible for the thank-you/review window", /RECENTLY_CLOSED_GRACE_MS/.test(status) && /30 \* 60 \* 1000/.test(status));
  pass("the payload carries the customer phase + per-station progress", /phase: customerOrderPhase\(ticket, lines\)/.test(status) && /kitchen: stationProgress\(lines, "kitchen"\)/.test(status) && /barista: stationProgress\(lines, "barista"\)/.test(status));
  pass("duplicate lines are collapsed before they reach the guest", /groupOrderLines\(lines/.test(status));
}

/* ── 4. "bring us the bill" ───────────────────────────────────────────────── */
{
  pass("the request stamps receipt_requested_at", /\.set\(\{ receiptRequestedAt: new Date\(\)/.test(status));
  pass("only an OPEN ticket can be stamped", /notInArray\(tickets\.status, \["paid", "cancelled", "closed"\]\)/.test(status));
  pass("two guests tapping at once keep the FIRST request time", /isNull\(tickets\.receiptRequestedAt\)/.test(status));
  pass("staff are told immediately (realtime publish)", /publish\(CHANNELS\.orders\)/.test(status));
  pass("a table with no open order gets a friendly 404", /no open order for this table/i.test(status));
  // The guest endpoint is deliberately write-limited: one column, one row.
  pass("the only write it performs is the bill-request stamp", (status.match(/\.update\(/g) || []).length === 1 && !/\.insert\(|\.delete\(/.test(status));
  pass("that write touches only receipt_requested_at + updated_at", /\.set\(\{ receiptRequestedAt: new Date\(\), updatedAt: new Date\(\) \}\)/.test(status) && !/\.set\(\{[^}]*(status|totalAmount|quantity|price)/.test(status));
  pass("the route is registered as a public mutation (auth-guard test)", /table-status/.test(read("scripts/verify-auth-guards.mjs")));
  // Every guest in the room shares ONE public IP (café NAT / mobile CGNAT), so a
  // per-IP-only limit would cap the venue instead of one person.
  const limits = read("src/lib/rate-limit.ts");
  pass("public guest endpoints are limited per (IP + table) AND per venue", /export function checkSharedIpRateLimit/.test(limits) && /:venue:/.test(limits));
  pass("the venue limits live in one shared policy object", /export const VENUE_POLICIES/.test(limits));
  pass("the order route uses the shared-IP limiter", /checkSharedIpRateLimit\("customer-order", request, Number\(tableId\) \|\| 0, VENUE_POLICIES\.customerOrder\)/.test(tickets));
  pass("staff can clear the request again (cashier: 'already served')", /body\.receiptRequested === false \|\| body\.receiptRequested === null/.test(tickets) && /updates\.receiptRequestedAt = null/.test(tickets));
}

/* ── 1/4. schema + migration ──────────────────────────────────────────────── */
{
  pass("tickets.receiptRequestedAt exists in the schema", /receiptRequestedAt: timestamp\("receipt_requested_at"\)/.test(schema));
  pass("order_submissions table exists in the schema", /export const orderSubmissions = pgTable\("order_submissions"/.test(schema));
  pass("its idempotency key is NOT NULL", /idempotencyKey: varchar\("idempotency_key", \{ length: 64 \}\)\.notNull\(\)/.test(schema));
  pass("the migration creates the table", /CREATE TABLE IF NOT EXISTS order_submissions/.test(migrate));
  pass("the migration adds the new ticket column", /receipt_requested_at/.test(migrate));
  pass("the submission key is UNIQUE at the database level", /CREATE UNIQUE INDEX IF NOT EXISTS order_submissions_idempotency_key_key/.test(migrate));
  pass("submissions are indexed per ticket", /CREATE INDEX IF NOT EXISTS order_submissions_ticket_id_idx/.test(migrate));
  pass("the schema version was bumped so deployments migrate", /SCHEMA_VERSION = "2026-09-03-2"/.test(migrate));
}

/* ── 3. duplicate lines merge in the DATABASE, not just on screen ─────────── */
{
  pass("the order route uses the single shared merge rule", /import \{ canMergeLines \} from "@\/lib\/order-lines"/.test(tickets) && /canMergeLines\(row, incoming\)/.test(tickets));
  pass("a merge folds into the existing row instead of inserting", /mergeCandidates\.find\(/.test(tickets));
  pass("a merged line cannot grow without bound", /MAX_MERGED_LINE_QUANTITY/.test(tickets));
  pass("every accepted submission is recorded for idempotency", /insert\(orderSubmissions\)/.test(tickets));
  pass("a replayed submission key returns the recorded bill", /racedKey/.test(tickets) && /23505/.test(tickets));
  pass("read-only screens collapse what older bills still contain", /groupOrderLines/.test(history));
  pass("editable staff lists still render raw rows (their ± buttons write one row id)", !/groupOrderLines/.test(cashier) && !/groupOrderLines/.test(waiterApp) && !/groupOrderLines/.test(stationApp));
}

/* ── 2. arrival time / date + waiter name ─────────────────────────────────── */
{
  pass("station items expose the arrival timestamp", /createdAt/.test(stationItems) && /receiptRequestedAt/.test(stationItems));
  pass("the tables grid exposes when the open bill started", /activeTicketAt/.test(tablesRoute) && /activeTicketReceiptRequestedAt/.test(tablesRoute));
  pass("kitchen/barista cards show the arrival clock time", /Arrived \{formatClock\(t\.createdAt\)\}/.test(stationApp));
  pass("  …and how long the crew has been waiting", /waiting \{waitingLabel\(t\.createdAt, now\)\}/.test(stationApp));
  pass("a stale order is flagged (10 min threshold)", /minutesSince\(t\.createdAt, now\) >= 10/.test(stationApp));
  pass("the waiting clock keeps ticking without a reload", /setInterval/.test(stationApp));
  pass("the crew see a table's bill request", /receiptRequestedAt/.test(stationApp) && /asked for the bill/i.test(stationApp));
  pass("each item shows its own arrival time", /formatClock\(i\.createdAt\)/.test(stationApp));
  pass("the waiter's bill header shows arrival + waiter", /formatDateTime/.test(waiterApp) && /waitingLabel/.test(waiterApp));
  pass("the waiter's table grid shows how long each bill has been open", /since \{formatClock\(t\.activeTicketAt\)\}/.test(waiterApp));
  pass("the waiter sees a guest's bill request on the table AND on the bill", /activeTicketReceiptRequestedAt/.test(waiterApp) && /activeTicket\.receiptRequestedAt/.test(waiterApp));
  pass("the cashier sees when the order arrived and how long it has waited", /arrived \{formatClock\(t\.createdAt\)\}/.test(cashier) && /waiting \{waitingLabel\(t\.createdAt\)\}/.test(cashier));
  pass("the cashier sees a guest's bill request and can clear it", /Guest asked for the bill at \{formatClock\(t\.receiptRequestedAt\)\}/.test(cashier) && /onClick=\{\(\) => clearReceiptRequest\(t\)\}/.test(cashier) && /receiptRequested: false/.test(cashier));
  pass("paid history cards show date/time and the waiter", /formatDateTime\(printQueueMode \? \(t\.printedAt \|\| t\.createdAt\) : \(t\.closedAt \|\| t\.updatedAt \|\| t\.createdAt\)\)/.test(cashier));
  pass("order history shows when the order ARRIVED and who took it", /arrived \{formatDateTime\(o\.createdAt\)\}/.test(history) && /by \{o\.createdBy/.test(history));
}

/* ── 1. the guest's own status UI ─────────────────────────────────────────── */
{
  pass("the status module ships a provider, a pill and a banner", /export function OrderStatusProvider/.test(orderStatusUi) && /export function OrderStatusFab/.test(orderStatusUi) && /export function OrderStatusBanner/.test(orderStatusUi));
  pass("the guest's phone polls while the menu is open", /setInterval/.test(orderStatusUi) && /POLL_MS/.test(orderStatusUi));
  pass("a phone left on the table stops hammering the server", /document\.hidden/.test(orderStatusUi) && /visibilitychange/.test(orderStatusUi));
  pass("a failed poll can never break the menu", /catch \{\s*\/\/ A failed poll must never disturb the menu/.test(orderStatusUi));
  pass("barista items get NO progress bar (drinks are made in seconds)", /ticket\.kitchen\.units > 0/.test(orderStatusUi) && /drinks_only/.test(orderStatusUi));
  pass("the pill only appears once this table has an order", /if \(!ticket\) return null/.test(orderStatusUi));
  pass("the bill button disappears once requested or paid", /canRequestBill/.test(orderStatusUi) && /!billRequested/.test(orderStatusUi));
  pass("any live order can call for the bill, cooking or not (busy-hour rule)", /function canAskForBill\(ticket: TableTicketStatus\)/.test(orderStatusUi) && /!ticket\.receiptRequestedAt && ticket\.phase !== "paid" && ticket\.phase !== "cancelled"/.test(orderStatusUi));
  pass("the panel and the menu button follow the SAME bill rule", /const canRequestBill = Boolean\(ticket\) && canAskForBill\(ticket!\)/.test(orderStatusUi));
  pass("while it is still cooking the guest is still told when food comes", /\{!served && !billRequested/.test(orderStatusUi) && /os_bill_after_food/.test(orderStatusUi));
  pass("the status bar IS the bill button now (receipt icon + requestBill)", /export function OrderStatusBanner/.test(orderStatusUi) && /onClick=\{requestBill\}[\s\S]{0,400}Receipt className/.test(orderStatusUi.slice(orderStatusUi.indexOf("export function OrderStatusBanner"))));
  pass("the bill button on the menu says what it does, in both languages", /os_request_bill/.test(orderStatusUi) && /os_sending/.test(orderStatusUi));
  pass("a guest who already asked sees the confirmation instead of the button", /billRequested &&[\s\S]{0,300}os_bill_requested/.test(orderStatusUi));
  pass("the bill button is disabled while sending", /disabled=\{requesting\}/.test(orderStatusUi));
  pass("the menu page wraps itself in the provider", /<OrderStatusProvider/.test(app) && /tableId=\{tableId \?\? 0\}/.test(app));
  pass("the pill and the banner are both rendered", /<OrderStatusFab \/>/.test(app) && /<OrderStatusBanner \/>/.test(app));
  pass("the banner hides itself when there is no order at all", /empty:hidden/.test(app) && /if \(ticket\.phase === "none"\) return null/.test(orderStatusUi));
  pass("a drinks-only table also gets the bill button", !/phase === "drinks_only"[\s\S]{0,40}return null/.test(orderStatusUi));
  pass("submitting an order refreshes the status immediately", /setStatusRefreshKey\(\(k\) => k \+ 1\)/.test(app) && /refreshKey=\{statusRefreshKey\}/.test(app));
  pass("the pill sits above the language toggle and the cart bar", /bottom-\[88px\] right-5/.test(orderStatusUi));
}

/* ── 5. review as the last step of the flow ───────────────────────────────── */
{
  pass("the status panel links to the review", /onOpenReview/.test(orderStatusUi) && /os_rate_visit/.test(orderStatusUi));
  pass("the menu scrolls to a stable review anchor", /getElementById\("guest-review"\)/.test(app) && /id="guest-review"/.test(app));
  pass("the review card is highlighted when jumped to", /reviewPulse/.test(app) && /ring-4 ring-\[#C9A227\]/.test(app));
  pass("the ask appears after the table has ordered", /\{submitted && !reviewSent && \(/.test(app) && /review_cta_title/.test(app));
  pass("a submitted review turns into a thank-you card", /setReviewSent\(true\)/.test(app) && /review_thanks_title/.test(app));
}

/* ── i18n: every new string exists in English AND Amharic ─────────────────── */
{
  const amStart = i18n.indexOf("\n  am: {");
  const enBlock = i18n.slice(0, amStart);
  const amBlock = i18n.slice(amStart);
  const keysOf = (block) => new Set([...block.matchAll(/^ {4}([a-z0-9_]+):/gm)].map((m) => m[1]));
  const en = keysOf(enBlock);
  const am = keysOf(amBlock);

  const missingAm = [...en].filter((k) => !am.has(k));
  const missingEn = [...am].filter((k) => !en.has(k));
  pass("English and Amharic dictionaries have exactly the same keys", missingAm.length === 0 && missingEn.length === 0);
  if (missingAm.length) console.error("   missing in am:", missingAm.join(", "));
  if (missingEn.length) console.error("   missing in en:", missingEn.join(", "));

  const used = new Set([
    ...[...orderStatusUi.matchAll(/\bt\("([a-z0-9_]+)"/g)].map((m) => m[1]),
    ...[...orderStatusUi.matchAll(/labelKey: "([a-z0-9_]+)"/g)].map((m) => m[1]),
    ...[...app.matchAll(/\bt\("(os_[a-z0-9_]+|order_status|review_cta_title|review_cta_sub|review_thanks_title|review_thanks_sub)"\)/g)].map((m) => m[1]),
  ]);
  const untranslated = [...used].filter((k) => !en.has(k));
  pass(`every status string the UI asks for is translated (${used.size} keys)`, untranslated.length === 0);
  if (untranslated.length) console.error("   not in the dictionary:", untranslated.join(", "));

  const amharic = [...amBlock.matchAll(/^ {4}(os_[a-z0-9_]+|order_status): "([^"]+)"/gm)];
  const looksAmharic = amharic.filter(([, , value]) => /[\u1200-\u137F]/.test(value) || /^[\d\s.·✓—-]+$/.test(value));
  pass("the Amharic status strings are actually written in Amharic", amharic.length >= 20 && looksAmharic.length === amharic.length);
  if (looksAmharic.length !== amharic.length) {
    console.error("   suspicious:", amharic.filter((m) => !looksAmharic.includes(m)).map((m) => m[1]).join(", "));
  }
}

/* ── Report ───────────────────────────────────────────────────────────────── */
if (failures.length > 0) {
  console.error("\n❌ ORDER STATUS / MERGE / BILL-REQUEST REGRESSION TEST FAILED\n");
  for (const f of failures) console.error("  • " + f);
  process.exit(1);
}
console.log("\n✅ Order status, arrival times, line merging and bill requests PASSED");
console.log("   • guests see their own table's live status and can ask for the bill");
console.log("   • the crew see when every order arrived and who took it");
console.log("   • duplicate lines merge in the database and collapse on old bills");
console.log("   • every new string is translated into Amharic");
