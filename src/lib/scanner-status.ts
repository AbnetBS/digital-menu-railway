import { db } from "@/db";
import { siteSettings } from "@/db/schema";
import { CHANNELS, publishData } from "@/lib/realtime";
import { eq } from "drizzle-orm";

/**
 * Real-time ESP32 scanner reachability tracker.
 *
 * Combines TWO live signals so both connect and disconnect show up automatically:
 *   1. Active SSE stream (`/api/attendance/events?channel=device`):
 *      - Opens -> pushes `{"online":true}` immediately (<0.3s).
 *      - Closes/aborts -> waits 1.5s (so a brief stream handoff while uploading
 *        a finger scan does not blink Offline); if no new stream or HTTP request
 *        arrived, pushes `{"online":false}` immediately (~1.5s).
 *   2. Client-initiated HTTPS heartbeats (`biometrics?pending=1`, `clock`,
 *      `mappings`, `device-time`, `review`):
 *      - Catches silent power-plug pulls where a router NAT swallows TCP FIN:
 *        flips to `Offline` automatically in ~6.5s on 3s-beat firmware (~9s on
 *        older 5s-beat firmware so it never false-flickers before reflash).
 */
export const SCANNER_ONLINE_WINDOW_MS = 9_000;
const FAST_BEAT_ONLINE_WINDOW_MS = 6_500;
const STREAM_CLOSE_GRACE_MS = 1_500;
const ENROLL_ACTIVE_WINDOW_MS = 25_000;
const HEARTBEAT_SETTING_KEY = "attendance_scanner_heartbeat";
const DB_WRITE_THROTTLE_MS = 4_000;
const DB_READ_THROTTLE_MS = 2_500;

interface ScannerPresenceState {
  lastSeenMs: number;
  lastSource: string;
  beatIntervalMs: number;
  activeStreams: number;
  streamDisconnectedAtMs: number;
  lastPublishedOnline: boolean | null;
  lastDbWriteMs: number;
  lastDbReadMs: number;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

const globalForScanner = globalThis as unknown as {
  __fanaScannerPresence?: ScannerPresenceState;
};

function state(): ScannerPresenceState {
  if (!globalForScanner.__fanaScannerPresence) {
    globalForScanner.__fanaScannerPresence = {
      lastSeenMs: 0,
      lastSource: "",
      beatIntervalMs: 5_000,
      activeStreams: 0,
      streamDisconnectedAtMs: 0,
      lastPublishedOnline: null,
      lastDbWriteMs: 0,
      lastDbReadMs: 0,
      expiryTimer: null,
      disconnectTimer: null,
    };
  }
  return globalForScanner.__fanaScannerPresence;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>) {
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
}

function activeWindowFor(s: ScannerPresenceState): number {
  if (s.lastSource === "enroll_progress") return ENROLL_ACTIVE_WINDOW_MS;
  if (s.beatIntervalMs > 0 && s.beatIntervalMs <= 3_200) return FAST_BEAT_ONLINE_WINDOW_MS;
  return SCANNER_ONLINE_WINDOW_MS;
}

function computeOnlineNow(s: ScannerPresenceState, now: number): boolean {
  if (s.lastSeenMs <= 0) return false;
  const win = activeWindowFor(s);
  if (now - s.lastSeenMs > win) return false;
  // If the SSE stream explicitly disconnected and NO fresh HTTP beat arrived
  // after that disconnect within STREAM_CLOSE_GRACE_MS, report Offline right away.
  if (
    s.activeStreams === 0 &&
    s.streamDisconnectedAtMs > 0 &&
    s.lastSeenMs <= s.streamDisconnectedAtMs &&
    now - s.streamDisconnectedAtMs >= STREAM_CLOSE_GRACE_MS &&
    s.lastSource !== "enroll_progress" &&
    s.lastSource !== "clock_scan"
  ) {
    return false;
  }
  return true;
}

function pushRealtimeStatus(s: ScannerPresenceState, now = Date.now(), force = false) {
  const online = computeOnlineNow(s, now);
  if (!force && s.lastPublishedOnline === online) return;
  s.lastPublishedOnline = online;
  publishData(
    CHANNELS.scanner,
    JSON.stringify({
      online,
      lastSeenAt: s.lastSeenMs > 0 ? new Date(s.lastSeenMs).toISOString() : null,
      ageSeconds: s.lastSeenMs > 0 ? Math.max(0, Math.round((now - s.lastSeenMs) / 1000)) : null,
      source: s.lastSource || null,
    })
  );
}

function scheduleOfflineFlip(s: ScannerPresenceState) {
  if (s.expiryTimer) {
    clearTimeout(s.expiryTimer);
    s.expiryTimer = null;
  }
  const win = activeWindowFor(s);
  const timer = setTimeout(() => {
    s.expiryTimer = null;
    pushRealtimeStatus(s, Date.now());
  }, win + 150);
  unrefTimer(timer);
  s.expiryTimer = timer;
}

/**
 * Record that the ESP32 scanner just completed a real request to the server.
 */
export function recordScannerHeartbeat(
  source = "poll",
  persistToDb = Boolean(process.env.DATABASE_URL),
  reportedBeatMs?: number | null
): void {
  const now = Date.now();
  const s = state();
  if (reportedBeatMs && Number.isFinite(reportedBeatMs) && reportedBeatMs >= 1_000 && reportedBeatMs <= 15_000) {
    s.beatIntervalMs = reportedBeatMs;
  }
  s.lastSeenMs = now;
  s.lastSource = source;
  if (s.disconnectTimer && source !== "event_stream_close") {
    clearTimeout(s.disconnectTimer);
    s.disconnectTimer = null;
  }
  scheduleOfflineFlip(s);
  pushRealtimeStatus(s, now);

  if (persistToDb && now - s.lastDbWriteMs >= DB_WRITE_THROTTLE_MS) {
    s.lastDbWriteMs = now;
    const payload = JSON.stringify({ ts: now, source, beatMs: s.beatIntervalMs });
    void db
      .insert(siteSettings)
      .values({ key: HEARTBEAT_SETTING_KEY, value: payload, updatedAt: new Date(now) })
      .onConflictDoUpdate({
        target: siteSettings.key,
        set: { value: payload, updatedAt: new Date(now) },
      })
      .catch(() => {
        // Ignore transient DB write issues or isolated unit tests without site_settings.
      });
  }
}

/**
 * Called when the ESP32 opens `/api/attendance/events?channel=device`.
 * Returns an idempotent cleanup callback to invoke on socket close / abort.
 */
export function onScannerStreamOpen(reportedBeatMs?: number | null): () => void {
  const s = state();
  s.activeStreams += 1;
  s.streamDisconnectedAtMs = 0;
  if (s.disconnectTimer) {
    clearTimeout(s.disconnectTimer);
    s.disconnectTimer = null;
  }
  recordScannerHeartbeat("event_stream", Boolean(process.env.DATABASE_URL), reportedBeatMs);

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    s.activeStreams = Math.max(0, s.activeStreams - 1);
    if (s.activeStreams === 0) {
      const closedAt = Date.now();
      s.streamDisconnectedAtMs = closedAt;
      if (s.disconnectTimer) clearTimeout(s.disconnectTimer);
      const timer = setTimeout(() => {
        s.disconnectTimer = null;
        pushRealtimeStatus(s, Date.now());
      }, STREAM_CLOSE_GRACE_MS + 50);
      unrefTimer(timer);
      s.disconnectTimer = timer;
    }
  };
}

export async function getScannerStatus(
  now = Date.now(),
  allowDbFallback = Boolean(process.env.DATABASE_URL)
): Promise<{
  online: boolean;
  lastSeenAt: string | null;
  ageSeconds: number | null;
  source: string | null;
  windowSeconds: number;
}> {
  const s = state();
  const win = activeWindowFor(s);

  if (
    allowDbFallback &&
    (s.lastSeenMs === 0 || now - s.lastSeenMs > win) &&
    now - s.lastDbReadMs >= DB_READ_THROTTLE_MS
  ) {
    s.lastDbReadMs = now;
    try {
      const [row] = await db
        .select({ value: siteSettings.value })
        .from(siteSettings)
        .where(eq(siteSettings.key, HEARTBEAT_SETTING_KEY))
        .limit(1);
      if (row?.value) {
        const parsed = JSON.parse(row.value) as { ts?: unknown; source?: unknown; beatMs?: unknown };
        const ts = Number(parsed?.ts);
        if (Number.isFinite(ts) && ts > s.lastSeenMs && ts <= now + 5_000) {
          s.lastSeenMs = ts;
          if (typeof parsed.source === "string") s.lastSource = parsed.source;
          const bMs = Number(parsed?.beatMs);
          if (Number.isFinite(bMs) && bMs >= 1_000 && bMs <= 15_000) s.beatIntervalMs = bMs;
          if (now - ts <= activeWindowFor(s)) {
            scheduleOfflineFlip(s);
          }
        }
      }
    } catch {
      // Ignore if site_settings is not yet migrated in an isolated test.
    }
  }

  const seen = s.lastSeenMs;
  const online = computeOnlineNow(s, now);
  return {
    online,
    lastSeenAt: seen > 0 ? new Date(seen).toISOString() : null,
    ageSeconds: seen > 0 ? Math.max(0, Math.round((now - seen) / 1000)) : null,
    source: s.lastSource || null,
    windowSeconds: Math.round(activeWindowFor(s) / 1000),
  };
}
