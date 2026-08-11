#!/usr/bin/env node
/**
 * Focused regression test — "No runtime database seeding".
 *
 * Guards against the audit finding GROUP 1 regression:
 *   ensureDbSeeded() / seed-db.ts must NEVER execute from normal request handling.
 *
 * The checks are static (zero dependencies, runs anywhere):
 *   1. No runtime API route may import seed-db / call ensureDbSeeded.
 *      The ONLY allowed callers are the explicit endpoints /api/seed and /api/setup.
 *   2. No page or component may auto-fire fetch("/api/seed").
 *   3. seed-db.ts may not contain destructive DML (row DELETEs or category/name
 *      rewriting) — seeding is additive (INSERT defaults when empty) only.
 *
 * Run with: npm test
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(root, "src");

const EXPLICIT_SEED_ROUTES = new Set([
  join(SRC, "app", "api", "seed", "route.ts"),
  join(SRC, "app", "api", "setup", "route.ts"),
]);

/** Walk a directory recursively and return all .ts/.tsx file paths. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

const failures = [];

// ── Check 1: runtime API routes must not touch seed-db ──────────────────────
for (const file of walk(join(SRC, "app", "api"))) {
  if (EXPLICIT_SEED_ROUTES.has(file)) continue;
  const text = readFileSync(file, "utf8");
  if (text.includes("seed-db") || text.includes("ensureDbSeeded")) {
    failures.push(
      `${relative(SRC, file)}: imports/calls runtime seeding (ensureDbSeeded / seed-db). Only /api/seed and /api/setup may seed.`
    );
  }
}

// ── Check 2: no auto-fired /api/seed fetches in pages/components ────────────
for (const dir of ["app", "components"]) {
  for (const file of walk(join(SRC, dir))) {
    const text = readFileSync(file, "utf8");
    if (/fetch\(\s*["'`]\/api\/seed/.test(text)) {
      failures.push(
        `${relative(SRC, file)}: auto-fires fetch("/api/seed") — seeding must be explicit only.`
      );
    }
  }
}

// ── Check 3: seed-db.ts must be additive only (no destructive DML) ──────────
{
  const seedPath = join(SRC, "lib", "seed-db.ts");
  const text = readFileSync(seedPath, "utf8");
  if (/\bDELETE\s+FROM\b/i.test(text)) {
    failures.push("src/lib/seed-db.ts: contains DELETE FROM — seeding must never delete rows.");
  }
  if (/db\.delete\(/.test(text)) {
    failures.push("src/lib/seed-db.ts: contains db.delete( — seeding must never delete rows.");
  }
  if (/\bUPDATE\s+(menu_items|categories|staff_users)\b/i.test(text)) {
    failures.push(
      "src/lib/seed-db.ts: contains UPDATE on menu_items/categories/staff_users — seeding must never rewrite owner data."
    );
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error("❌ RUNTIME SEEDING REGRESSION TEST FAILED\n");
  for (const f of failures) console.error("  • " + f);
  console.error("\nSeeding is allowed ONLY from the explicit endpoints /api/seed and /api/setup.");
  process.exit(1);
}

console.log("✅ Runtime seeding regression test PASSED");
console.log("   • No runtime API route imports seed-db / ensureDbSeeded");
console.log("   • No page/component auto-fires fetch(\"/api/seed\")");
console.log("   • seed-db.ts contains no destructive DML (deletes / category rewriting)");
