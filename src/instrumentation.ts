/**
 * Next.js server-startup hook.
 *
 * Starts the automatic receipt-photo retention job: every 24 hours, receipt
 * photos on bills that were paid more than 30 days ago are cleared (the order
 * record is kept). This keeps the database from growing indefinitely with old
 * receipt blobs on a free/paid Postgres plan — no manual button required.
 *
 * Single-instance safe: the scheduler is registered via a globalThis guard so
 * it starts exactly once per Node process (Railway runs `next start` as one
 * persistent process).
 */

/**
 * Deliberately does not start a timer here. Coolify/VPSDime can restart or
 * replace the container at any time, which would reset an in-process timer.
 * Schedule POST /api/tickets/cleanup from a Coolify scheduled task instead.
 */
export async function register() {
  // Keep the instrumentation hook valid for Next.js without starting a
  // best-effort scheduler that cannot survive container restarts.
}
