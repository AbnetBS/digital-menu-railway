/**
 * In-memory fixed-window rate limiter for a SINGLE-INSTANCE deployment
 * (Railway runs one Node process). No Redis / external service required.
 *
 * Each key (e.g. "admin-login:<ip>") is allowed `limit` attempts per
 * `windowMs` window. The window slides on a fixed cadence (resetAt), and the
 * map is pruned lazily so memory stays bounded under long uptime.
 */

interface Window {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Window>();
const MAX_ENTRIES = 10_000;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

function prune(): void {
  const now = Date.now();
  for (const [key, w] of buckets) {
    if (w.resetAt <= now) buckets.delete(key);
  }
}

export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    if (buckets.size >= MAX_ENTRIES) prune();
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  if (existing.count > limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Best-effort client IP. Railway terminates TLS at its proxy and sets
 * X-Forwarded-For; fall back to X-Real-IP, then a fixed bucket so the limiter
 * still protects when no proxy header is present.
 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/* ────────────────────────────────────────────────────────────────────────────
 * SHARED-IP LIMITING (the café problem)
 *
 * Every guest in the room reaches this server through the SAME public IP: the
 * café's WiFi router NATs them all, and mobile carriers do the same with CGNAT.
 * A plain per-IP limit therefore caps the whole RESTAURANT, not one person —
 * "30 customer orders per 10 minutes" becomes "30 orders for every table
 * combined", and at lunch time real guests get HTTP 429 and cannot order.
 *
 * So public guest endpoints are limited on TWO tiers:
 *   1. per (IP + table)  — one guest/table may not hammer the endpoint;
 *   2. per IP            — a whole venue's worth of traffic, sized so a busy
 *                          room never trips it, but a single-IP flood still does.
 * The stricter of the two answers, and its Retry-After is returned.
 * ────────────────────────────────────────────────────────────────────────── */

export interface VenuePolicy {
  /** Requests allowed for ONE table (one guest's phone) inside the window. */
  perClient: number;
  /** Requests allowed for the WHOLE venue — they all share one public IP. */
  perIp: number;
  windowMs: number;
}

const TEN_MINUTES = 10 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

/**
 * The single source of truth for public guest-endpoint limits.
 *
 * Sized from a real service, not from one user: 40 tables × 4 phones behind one
 * café WiFi IP, a phone polling its order status every 12s (~50 reads per
 * window), re-ordering drinks and dessert a few times, then asking for the bill
 * and leaving one review. `scripts/verify-shared-ip-limits.ts` replays exactly
 * that scenario against these numbers, so raising the traffic model and raising
 * the limits cannot drift apart.
 */
export const VENUE_POLICIES = {
  /** POST /api/tickets with source "customer" — one order submission. */
  customerOrder: { perClient: 30, perIp: 600, windowMs: TEN_MINUTES },
  /**
   * GET /api/table-status — the guest's status poll.
   *
   * `perClient` is PER TABLE, and a table is usually 2-4 phones all polling the
   * same bill every 12s: 4 phones × 50 polls = 200 per window, so 600 leaves
   * room for tab-switching refreshes and manual taps while still capping a
   * runaway client at ~1 request/second.
   *
   * `perIp` is the whole venue (they all share one NAT address): 20,000 per
   * window ≈ 33 reads/second ≈ 80 tables of polling guests. Each read is two
   * indexed SELECTs, well inside what Postgres serves.
   */
  statusRead: { perClient: 600, perIp: 20_000, windowMs: TEN_MINUTES },
  /** POST /api/table-status — "bring us the bill". */
  statusRequest: { perClient: 12, perIp: 300, windowMs: TEN_MINUTES },
  /** POST /api/reviews — one review per guest per hour, venue-wide. Every
   *  review needs admin approval before it is shown, so the cap only has to
   *  stop a spam run, not a busy Saturday. */
  review: { perClient: 5, perIp: 200, windowMs: ONE_HOUR },
} satisfies Record<string, VenuePolicy>;

export function checkSharedIpRateLimit(
  scope: string,
  request: Request,
  clientId: string | number,
  policy: VenuePolicy
): RateLimitResult {
  const ip = getClientIp(request);
  const client = checkRateLimit(`${scope}:${ip}:${clientId}`, policy.perClient, policy.windowMs);
  if (!client.allowed) return client;
  // Second tier: the venue as a whole. Checked after the per-table bucket so a
  // single noisy table is stopped by the cheap, narrow rule first.
  return checkRateLimit(`${scope}:venue:${ip}`, policy.perIp, policy.windowMs);
}
