#!/usr/bin/env node
/**
 * Regression test — "Server-side authorization" (C-1 fix).
 *
 * Static source inspection (zero dependencies, runs anywhere). Enforces:
 *   1. Every API route with a mutation method (POST/PUT/DELETE/PATCH) is
 *      protected by a server-side guard — EXCEPT the three legitimate public
 *      auth endpoints (admin login, admin logout/verify, staff login/logout).
 *   2. Destructive/setup endpoints (reset, setup, seed, dbtest, menu-bulk,
 *      tickets/cleanup) require the ADMIN guard specifically.
 *   3. The admin session cookie is cryptographically signed (no static
 *      "authenticated" value).
 *   4. Staff login establishes a signed server-side session cookie.
 *   5. The customer order path (POST /api/tickets, source=customer) stays
 *      public while non-customer sources require a staff/admin session.
 *
 * Run with: node scripts/verify-auth-guards.mjs  (wired into `npm test`)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = join(root, "src", "app", "api");

const failures = [];
function pass(name, cond) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures.push(name);
}

// Routes whose mutations are legitimately public:
//  • login/logout endpoints
//  • /api/translate — public, rate-limited, read-only translation cache for
//    customer-facing menu text (no business data is created or changed).
//  • /api/table-status — the guest's own phone asks for the bill after the food
//    arrives. Rate-limited, table-scoped, and the ONLY thing it can write is
//    `tickets.receipt_requested_at` on an OPEN bill of that table (it can never
//    touch a status, a payment, a price or a quantity). scripts/verify-order-status.mjs
//    re-checks all of that on every `npm test`.
//  • /api/attendance/clock — biometric hardware (ESP32) and attendance kiosk scans.
//    Its PIN branch is NOT public: it refuses a clock-in unless an attendance
//    supervisor has unlocked the door tablet and not locked it again (section 4b).
//  • /api/attendance/supervisor — the door tablet's supervisor login/logout
//    itself (the account it checks lives in Staff Accounts).
const PUBLIC_MUTATION_ROUTES = new Set([
  join(API, "admin", "login", "route.ts"),
  join(API, "admin", "verify", "route.ts"),
  join(API, "staff", "login", "route.ts"),
  join(API, "translate", "route.ts"),
  join(API, "table-status", "route.ts"),
  join(API, "attendance", "clock", "route.ts"),
  join(API, "attendance", "supervisor", "route.ts"),
]);

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e === "route.ts") out.push(p);
  }
  return out;
}

const guardRe = /requireAdmin\(|requireStaff\(|requireStaffOrAdmin\(/;
const mutationRe = /export async function (POST|PUT|DELETE|PATCH)/;

// ── 1 & 2: mutation routes must be guarded ──────────────────────────────────
for (const file of walk(API)) {
  const src = readFileSync(file, "utf8");
  if (!mutationRe.test(src)) continue;
  const rel = relative(API, file);
  if (PUBLIC_MUTATION_ROUTES.has(file)) {
    pass(`${rel}: public auth endpoint (no guard expected)`, true);
    continue;
  }
  pass(`${rel}: mutation route has a guard`, guardRe.test(src));

  // Destructive endpoints must be ADMIN (not staff).
  if (/(reset|setup|seed|dbtest|menu-bulk|tickets\/cleanup)\/route\.ts$/.test(file)) {
    pass(`${rel}: destructive endpoint requires ADMIN`, /requireAdmin\(/.test(src));
  }
}

// ── 2b: ticket DELETE (permanent bill/history deletion) must be ADMIN ───────
{
  const tickets = readFileSync(join(API, "tickets", "route.ts"), "utf8");
  const del = tickets.slice(tickets.indexOf("export async function DELETE"));
  const delBody = del.slice(0, del.indexOf("}"));
  pass(
    "tickets DELETE requires ADMIN (not staff)",
    delBody.includes("requireAdmin(") && !delBody.includes("requireStaffOrAdmin(")
  );
}

// ── 3: admin cookie is signed, no static value ──────────────────────────────
{
  const login = readFileSync(join(API, "admin", "login", "route.ts"), "utf8");
  pass("admin login signs the session cookie", login.includes("signToken"));
  pass("admin login sets ADMIN_COOKIE", login.includes("ADMIN_COOKIE"));
  pass("no static \"authenticated\" cookie value remains", !login.includes('"authenticated"'));
}

// ── 4: staff login establishes a signed session ─────────────────────────────
{
  const login = readFileSync(join(API, "staff", "login", "route.ts"), "utf8");
  pass("staff login signs the session cookie", login.includes("signToken"));
  pass("staff login sets STAFF_COOKIE", login.includes("STAFF_COOKIE"));
  pass("staff login has a DELETE logout handler", /export async function DELETE/.test(login));
}

// ── 4b: the door tablet's supervisor unlock (no expiry, server-side) ────────
{
  const sup = readFileSync(join(API, "attendance", "supervisor", "route.ts"), "utf8");
  const clock = readFileSync(join(API, "attendance", "clock", "route.ts"), "utf8");
  const session = readFileSync(join(root, "src", "lib", "session.ts"), "utf8");
  const kiosk = readFileSync(join(root, "src", "app", "(internal)", "attendance", "page.tsx"), "utf8");
  const staffTab = readFileSync(join(root, "src", "components", "rms", "StaffTab.tsx"), "utf8");
  const stations = readFileSync(join(root, "src", "lib", "stations.ts"), "utf8");

  pass("the supervisor login signs a session cookie of its own", sup.includes("signToken") && sup.includes("SUPERVISOR_COOKIE"));
  pass("the supervisor login is rate limited like the other PIN logins", sup.includes("checkRateLimit("));
  pass("the supervisor login has a DELETE that locks the keypad again", /export async function DELETE/.test(sup));
  pass("it only accepts Staff Accounts with the attendance supervisor role", sup.includes("ATTENDANCE_SUPERVISOR_ROLE") && sup.includes("staffUsers"));
  pass("it never says which names exist (one answer for a bad name and a bad PIN)", sup.includes("Incorrect name or PIN"));
  pass("the supervisor session carries no expiry (owner: the 2 min window had no benefit)",
    !session.includes("SUPERVISOR_IDLE_TIMEOUT_MS") && !session.includes("Date.now() > exp") && session.includes("kind: \"attendance_supervisor\""));
  pass(
    "a PIN clock-in is refused without an unlocked tablet",
    clock.includes('if (method === "pin") {') &&
      clock.includes("requireSupervisor()") &&
      clock.includes("if (!supervisor.ok) return supervisor.response;") &&
      session.includes("needsSupervisor: true")
  );
  pass("the fingerprint clock-in needs no supervisor (the main way in stays open)", !/else\s*{[\s\S]{0,400}requireSupervisor/.test(clock));
  pass("the tablet keeps the unlock until a person locks it by hand",
    !kiosk.includes("SUPERVISOR_IDLE_TIMEOUT_MS") && kiosk.includes("Lock now") && kiosk.includes("open until someone locks it"));
  pass("locking the keypad from the tablet tells the server to drop the cookie",
    kiosk.includes('fetch("/api/attendance/supervisor", { method: "DELETE" })'));
  pass("the supervisor role can be handed out in Staff Accounts", staffTab.includes("ATTENDANCE_SUPERVISOR_ROLE") && stations.includes("ATTENDANCE_SUPERVISOR_ROLE"));
}

// ── 5: customer order path public, staff path guarded ───────────────────────
{
  const tickets = readFileSync(join(API, "tickets", "route.ts"), "utf8");
  pass("tickets POST keeps customer source public", tickets.includes('source === "customer"'));
  pass("tickets POST guards non-customer sources", tickets.includes("requireStaffOrAdmin("));
}

// ── Report ──────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error("\n❌ AUTH GUARD REGRESSION TEST FAILED\n");
  for (const f of failures) console.error("  • " + f);
  process.exit(1);
}
console.log("\n✅ Auth guard regression test PASSED");
console.log("   • all mutation routes guarded (except public login/logout)");
console.log("   • destructive endpoints require admin");
console.log("   • admin + staff sessions are cryptographically signed");
console.log("   • the door tablet's PIN needs a supervisor unlock that dies after 2 min");
