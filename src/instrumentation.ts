/**
 * Next.js server-startup hook.
 *
 * The waiter send-hold queue is durable in Postgres and processed here by a
 * small worker. If Railway replaces the process, the next process picks up any
 * due rows from the database instead of losing the in-memory countdown.
 *
 * Receipt cleanup remains an external scheduled task; its daily schedule is
 * intentionally not implemented with an in-process timer.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startDeferredTicketWorker } = await import("@/lib/deferred-ticket-worker");
    startDeferredTicketWorker();
  }
}
