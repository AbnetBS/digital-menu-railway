#!/usr/bin/env tsx
/**
 * LOAD GUARD — "a room full of phones, one public IP".
 *
 * Tomorrow's failure mode is not raw throughput, it is the rate limiter: every
 * guest in the restaurant reaches this server through the SAME public IP (the
 * café's WiFi router NATs them all; mobile carriers do the same with CGNAT). A
 * limit written as "N requests per IP" therefore caps the whole VENUE, not one
 * person. With the old numbers a full room was cut off inside minutes:
 *
 *   • GET  /api/table-status  240/IP/10min  → only ~4 phones could poll (12s)
 *   • POST /api/tickets        30/IP/10min  → only 30 orders for EVERY table
 *   • POST /api/reviews         5/IP/hour   → only 5 reviews for the whole café
 *
 * Those endpoints are now limited per (IP + table) AND per IP, with the venue
 * number sized for a full room. This script replays real traffic models against
 * the REAL configuration (`VENUE_POLICIES`, imported — never duplicated) with a
 * controllable clock, and asserts:
 *
 *   1. a full house (and a double-size one) is never throttled;
 *   2. one abusive phone is throttled WITHOUT touching the tables next to it;
 *   3. a flood that rotates table ids still hits the venue ceiling;
 *   4. the old per-IP-only limits really would have blocked that same traffic.
 *
 * No server, no database, no network — pure in-memory limiter.
 * Run with: npx tsx scripts/verify-shared-ip-limits.ts   (wired into `npm test`)
 */
import { checkRateLimit, checkSharedIpRateLimit, VENUE_POLICIES } from "../src/lib/rate-limit";

let failures = 0;
function assert(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures++;
}

/* ── controllable clock: the limiter reads Date.now(), so a whole service can
      be replayed in milliseconds instead of hours ─────────────────────────── */
const realNow = Date.now();
let clock = realNow;
(Date as unknown as { now: () => number }).now = () => clock;
const advance = (ms: number) => {
  clock += ms;
};
void advance;

/** One reusable Request per IP — the limiter only reads X-Forwarded-For. */
const requestFor = (ip: string) =>
  new Request("https://fana.test/api/table-status", { headers: { "x-forwarded-for": ip } });

interface Stats {
  allowed: number;
  blocked: number;
  seconds: number;
}

type Kind = "order" | "status" | "bill" | "review";
interface Event {
  at: number;
  kind: Kind;
  table: number;
}

const POLICY: Record<Kind, typeof VENUE_POLICIES.customerOrder> = {
  order: VENUE_POLICIES.customerOrder,
  status: VENUE_POLICIES.statusRead,
  bill: VENUE_POLICIES.statusRequest,
  review: VENUE_POLICIES.review,
};
const SCOPE: Record<Kind, string> = {
  order: "customer-order",
  status: "table-status",
  bill: "table-status-request",
  review: "review-submit",
};

/**
 * Replay one venue's evening: every phone orders on arrival, polls its order
 * status every `pollSeconds` while it eats, then asks for the bill and leaves a
 * review. All of them behind ONE public IP, exactly like the café's WiFi.
 */
function replayVenue(opts: {
  ip: string;
  tables: number;
  phonesPerTable: number;
  minutes: number;
  pollSeconds: number;
  /** Legacy single-tier mode: limit on the IP alone (what the code used to do). */
  legacyPerIp?: Record<Kind, number>;
}): Stats & { perKind: Record<Kind, Stats> } {
  const { ip, tables, phonesPerTable, minutes, pollSeconds, legacyPerIp } = opts;
  const request = requestFor(ip);
  const events: Event[] = [];

  for (let table = 1; table <= tables; table++) {
    for (let phone = 0; phone < phonesPerTable; phone++) {
      // Stagger arrivals across the first half of the service so the room fills
      // up instead of 120 people scanning in the same second.
      const arrivalMin = Math.floor(((table - 1) * (minutes / 2)) / Math.max(1, tables));
      const arrival = arrivalMin * 60_000;
      const stayMs = Math.min(45, minutes - arrivalMin) * 60_000;
      if (stayMs <= 0) continue;

      events.push({ at: arrival, kind: "order", table });
      for (let t = pollSeconds * 1000; t < stayMs; t += pollSeconds * 1000) {
        events.push({ at: arrival + t, kind: "status", table });
      }
      events.push({ at: arrival + stayMs - 120_000, kind: "bill", table });
      // Only the first phone at a table writes the review.
      if (phone === 0) events.push({ at: arrival + stayMs - 60_000, kind: "review", table });
    }
  }
  events.sort((a, b) => a.at - b.at);

  const perKind: Record<Kind, Stats> = {
    order: { allowed: 0, blocked: 0, seconds: 0 },
    status: { allowed: 0, blocked: 0, seconds: 0 },
    bill: { allowed: 0, blocked: 0, seconds: 0 },
    review: { allowed: 0, blocked: 0, seconds: 0 },
  };
  const total: Stats = { allowed: 0, blocked: 0, seconds: minutes };

  clock = realNow; // each scenario starts on a fresh window
  for (const event of events) {
    clock = realNow + event.at; // absolute: events are already sorted by time
    const policy = POLICY[event.kind];
    const result = legacyPerIp
      ? checkRateLimit(`${SCOPE[event.kind]}:${ip}`, legacyPerIp[event.kind], policy.windowMs)
      : checkSharedIpRateLimit(SCOPE[event.kind], request, event.table, policy);
    const bucket = perKind[event.kind];
    if (result.allowed) {
      bucket.allowed++;
      total.allowed++;
    } else {
      bucket.blocked++;
      total.blocked++;
    }
  }
  return { ...total, perKind };
}

/* ── 1. a full house must never be throttled ──────────────────────────────── */
// The seeded venue is 10 tables; a busy service is modelled at 40 and 80.
const defaultVenue = replayVenue({ ip: "203.0.113.9", tables: 10, phonesPerTable: 4, minutes: 60, pollSeconds: 12 });
console.log(
  `\n📊 The seeded venue — 10 tables × 4 phones (40 guests, ONE café IP), 60 minutes:\n` +
    `   ${defaultVenue.allowed.toLocaleString()} requests allowed · ${defaultVenue.blocked} blocked` +
    ` (≈ ${(defaultVenue.allowed / 3600).toFixed(1)} req/s)\n`
);
assert("the seeded 10-table venue is never rate-limited", defaultVenue.blocked === 0, `${defaultVenue.blocked} blocked`);

const fullHouse = replayVenue({ ip: "203.0.113.10", tables: 40, phonesPerTable: 3, minutes: 60, pollSeconds: 12 });
console.log(
  `\n📊 40 tables × 3 phones (120 guests, ONE café IP), 60 minutes, polling every 12s:\n` +
    `   ${fullHouse.allowed.toLocaleString()} requests allowed · ${fullHouse.blocked} blocked\n` +
    `   orders ${fullHouse.perKind.order.allowed} · status reads ${fullHouse.perKind.status.allowed.toLocaleString()}` +
    ` · bill requests ${fullHouse.perKind.bill.allowed} · reviews ${fullHouse.perKind.review.allowed}\n` +
    `   ≈ ${Math.round(fullHouse.allowed / (60 * 60))} requests/second sustained\n`
);
assert("a full house is never rate-limited", fullHouse.blocked === 0, `${fullHouse.blocked} blocked`);
assert("every guest's order goes through", fullHouse.perKind.order.allowed === 40 * 3);
assert("every status poll goes through", fullHouse.perKind.status.blocked === 0);
assert("every bill request goes through", fullHouse.perKind.bill.allowed === 40 * 3);
assert("every review goes through", fullHouse.perKind.review.allowed === 40);

const doubleHouse = replayVenue({ ip: "203.0.113.11", tables: 80, phonesPerTable: 4, minutes: 60, pollSeconds: 12 });
console.log(
  `\n📊 80 tables × 4 phones (320 guests, ONE IP) — double the venue:\n` +
    `   ${doubleHouse.allowed.toLocaleString()} allowed · ${doubleHouse.blocked} blocked` +
    ` (≈ ${Math.round(doubleHouse.allowed / 3600)} req/s)\n`
);
assert("a DOUBLE-size venue is still never rate-limited", doubleHouse.blocked === 0, `${doubleHouse.blocked} blocked`);

const slowNetwork = replayVenue({ ip: "203.0.113.12", tables: 40, phonesPerTable: 3, minutes: 60, pollSeconds: 5 });
assert(
  "even guests whose phones poll twice as often (tab switching, retries) stay unblocked",
  slowNetwork.blocked === 0,
  `${slowNetwork.blocked} blocked`
);

/* ── 2. one abusive phone must not take the room down with it ─────────────── */
{
  const ip = "203.0.113.20";
  const request = requestFor(ip);
  clock = realNow;
  let blockedAbuser = 0;
  let allowedAbuser = 0;
  // One phone hammering the status endpoint 100×/second for a whole window.
  for (let i = 0; i < VENUE_POLICIES.statusRead.perClient * 10; i++) {
    const r = checkSharedIpRateLimit("table-status", request, 7, VENUE_POLICIES.statusRead);
    if (r.allowed) allowedAbuser++;
    else blockedAbuser++;
  }
  const neighbour = checkSharedIpRateLimit("table-status", request, 8, VENUE_POLICIES.statusRead);
  assert("a hammering phone is cut off at its per-table limit", blockedAbuser > 0 && allowedAbuser === VENUE_POLICIES.statusRead.perClient, `${allowedAbuser} allowed`);
  assert("  …and the table next to it is completely unaffected", neighbour.allowed);
  assert("the throttled phone is told when to retry", !checkSharedIpRateLimit("table-status", request, 7, VENUE_POLICIES.statusRead).allowed);
}

/* ── 3. a flood that rotates table ids still hits the venue ceiling ───────── */
{
  const ip = "203.0.113.30";
  const request = requestFor(ip);
  clock = realNow;
  let allowed = 0;
  let blocked = 0;
  for (let i = 0; i < 5_000; i++) {
    const r = checkSharedIpRateLimit("customer-order", request, 1_000 + (i % 900), VENUE_POLICIES.customerOrder);
    if (r.allowed) allowed++;
    else blocked++;
  }
  assert("an order flood from one IP is stopped by the venue ceiling", blocked > 0 && allowed <= VENUE_POLICIES.customerOrder.perIp, `${allowed} allowed of 5,000`);
  assert("  …and the ceiling is far above what a real venue needs", VENUE_POLICIES.customerOrder.perIp >= 40 * 3 * 4);
}

/* ── 4. proof the OLD per-IP-only limits would have failed tomorrow ───────── */
{
  const legacy = replayVenue({
    ip: "203.0.113.40",
    tables: 40,
    phonesPerTable: 3,
    minutes: 60,
    pollSeconds: 12,
    legacyPerIp: { order: 30, status: 240, bill: 20, review: 5 },
  });
  console.log(
    `\n📊 The SAME full house against the old per-IP-only limits:\n` +
      `   ${legacy.allowed.toLocaleString()} allowed · ${legacy.blocked.toLocaleString()} BLOCKED` +
      ` (orders ${legacy.perKind.order.blocked}, status ${legacy.perKind.status.blocked.toLocaleString()},` +
      ` bills ${legacy.perKind.bill.blocked}, reviews ${legacy.perKind.review.blocked})\n`
  );
  assert("the old single-tier limits really would have blocked a full room", legacy.blocked > 1000);
  assert("  …guests would have been unable to ORDER", legacy.perKind.order.blocked > 0);
  assert("  …and the status pill would have died within minutes", legacy.perKind.status.blocked > legacy.perKind.status.allowed);
}

console.log(
  failures === 0
    ? "\n✅ Shared-IP / full-venue rate-limit guard PASSED"
    : `\n❌ ${failures} rate-limit assertions FAILED`
);
console.log(
  `   limits under test: orders ${VENUE_POLICIES.customerOrder.perClient}/table + ${VENUE_POLICIES.customerOrder.perIp}/venue per 10min ·` +
    ` status ${VENUE_POLICIES.statusRead.perClient}/table + ${VENUE_POLICIES.statusRead.perIp.toLocaleString()}/venue ·` +
    ` bill ${VENUE_POLICIES.statusRequest.perClient}/table + ${VENUE_POLICIES.statusRequest.perIp}/venue ·` +
    ` reviews ${VENUE_POLICIES.review.perIp}/venue per hour`
);
process.exit(failures === 0 ? 0 : 1);
