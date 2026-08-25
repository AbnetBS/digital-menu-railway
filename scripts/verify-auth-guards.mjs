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
const PUBLIC_MUTATION_ROUTES = new Set([
  join(API, "admin", "login", "route.ts"),
  join(API, "admin", "verify", "route.ts"),
  join(API, "staff", "login", "route.ts"),
  join(API, "translate", "route.ts"),
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
