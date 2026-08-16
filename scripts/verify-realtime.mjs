#!/usr/bin/env node
/**
 * Regression test — "Realtime (SSE) replaced polling".
 *
 * Static source inspection verifies that:
 *   1. The SSE hub + endpoint exist.
 *   2. The waiter/cashier/station screens subscribe via EventSource instead of
 *      setInterval polling for order/table data.
 *   3. Order/table mutation routes publish to the realtime channel.
 *
 * Run with: node scripts/verify-realtime.mjs  (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const failures = [];
function pass(name, cond) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures.push(name);
}

// ── 1. Hub + endpoint exist ─────────────────────────────────────────────────
const hub = read("src/lib/realtime.ts");
pass("realtime hub exports publish", /export function publish/.test(hub));
pass("realtime hub exports subscribe", /export function subscribe/.test(hub));
const route = read("src/app/api/realtime/route.ts");
pass("SSE endpoint sets text/event-stream", /text\/event-stream/.test(route));
pass("SSE endpoint requires staff/admin", /requireStaffOrAdmin/.test(route));

// ── 2. Staff screens use EventSource, not setInterval polling ───────────────
for (const f of [
  "src/components/rms/WaiterApp.tsx",
  "src/components/rms/CashierDashboard.tsx",
  "src/components/rms/StationApp.tsx",
]) {
  const src = read(f);
  pass(`${f} uses EventSource for realtime`, src.includes("EventSource"));
  pass(`${f} no longer polls orders via setInterval`, !/setInterval\(load/.test(src));
}

// ── 3. Mutation routes publish ──────────────────────────────────────────────
for (const f of [
  "src/app/api/tickets/route.ts",
  "src/app/api/tickets/items/route.ts",
  "src/app/api/station-items/route.ts",
  "src/app/api/tables/route.ts",
  "src/app/api/reset/route.ts",
]) {
  pass(`${f} publishes realtime events`, read(f).includes("publish(CHANNELS.orders)"));
}

if (failures.length > 0) {
  console.error("\n❌ REALTIME REGRESSION TEST FAILED\n");
  for (const f of failures) console.error("  • " + f);
  process.exit(1);
}
console.log("\n✅ Realtime regression test PASSED");
console.log("   • SSE hub + authenticated endpoint present");
console.log("   • waiter/cashier/station use EventSource (no order polling)");
console.log("   • mutation routes publish refresh events");
