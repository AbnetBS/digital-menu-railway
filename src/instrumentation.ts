/**
 * Next.js server-startup hook.
 *
 * The waiter send-hold queue is durable in Postgres and processed here by a
 * small worker. If Railway replaces the process, the next process picks up any
 * due rows from the database instead of losing the in-memory countdown.
 *
 * The DAY-CLOSE worker runs here for the same reason (owner, 29 Sept 2026):
 * when the cashier forgets to tap "Today's shift end", the owner's daily total
 * must still reach his phone. The check runs every minute, and the day's record
 * lives in the database, so a late start (or a replaced process) still sees
 * whether the day was already closed — one record, one notification.
 *
 * Receipt cleanup remains an external scheduled task; its daily schedule is
 * intentionally not implemented with an in-process timer.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startDeferredTicketWorker } = await import("@/lib/deferred-ticket-worker");
    startDeferredTicketWorker();
    const { startDayCloseWorker } = await import("@/lib/day-close");
    startDayCloseWorker();
  }
}
