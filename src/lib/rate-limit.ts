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
