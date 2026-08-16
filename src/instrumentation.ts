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

const DAY_MS = 24 * 60 * 60 * 1000;

export async function register() {
  if (process.env.NODE_ENV !== "production") return;

  const g = globalThis as typeof globalThis & { __fanaReceiptCleanupStarted?: boolean };
  if (g.__fanaReceiptCleanupStarted) return;
  g.__fanaReceiptCleanupStarted = true;

  const { cleanupOldReceipts } = await import("@/lib/receipt-cleanup");

  // Run once shortly after boot (in case the app was down and old receipts
  // accumulated), then every 24 hours.
  setTimeout(() => {
    cleanupOldReceipts(30).catch(() => {});
  }, 60_000);

  setInterval(() => {
    cleanupOldReceipts(30).catch(() => {});
  }, DAY_MS);
}
