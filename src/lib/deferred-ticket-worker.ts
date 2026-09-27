import { asc, and, eq, lte, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { deferredTicketSends } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { deferredWorkerHeaders } from "@/lib/deferred-ticket-auth";
import { POST as createTicket } from "@/app/api/tickets/route";

const CLAIM_SIZE = 10;
const POLL_MS = 1000;
const MAX_ATTEMPTS = 8;

type WorkerGlobal = typeof globalThis & {
  __fanaDeferredTicketWorkerStarted?: boolean;
  __fanaDeferredTicketWorkerBusy?: boolean;
};

const workerGlobal = globalThis as WorkerGlobal;

/**
 * Durable due-order worker. The queue is in Postgres, so a process restart does
 * not lose a waiter submission; on startup this worker immediately catches up.
 * SKIP LOCKED lets more than one Railway instance share the queue safely.
 */
export function startDeferredTicketWorker() {
  if (workerGlobal.__fanaDeferredTicketWorkerStarted) return;
  workerGlobal.__fanaDeferredTicketWorkerStarted = true;

  const processDueOrders = async () => {
    if (workerGlobal.__fanaDeferredTicketWorkerBusy) return;
    workerGlobal.__fanaDeferredTicketWorkerBusy = true;

    try {
      await ensureTablesExist();
      const claimed = await db.transaction(async (tx) => {
        const now = new Date();
        const staleProcessingBefore = new Date(now.getTime() - 60_000);
        const due = await tx.select().from(deferredTicketSends)
          .where(and(
            lte(deferredTicketSends.dueAt, now),
            or(
              eq(deferredTicketSends.status, "pending"),
              and(
                eq(deferredTicketSends.status, "processing"),
                lt(deferredTicketSends.updatedAt, staleProcessingBefore),
              ),
            ),
          ))
          .orderBy(asc(deferredTicketSends.dueAt))
          .limit(CLAIM_SIZE)
          .for("update", { skipLocked: true });

        for (const send of due) {
          await tx.update(deferredTicketSends)
            .set({ status: "processing", attempts: send.attempts + 1, updatedAt: new Date() })
            .where(eq(deferredTicketSends.idempotencyKey, send.idempotencyKey));
        }
        return due.map((send) => ({ ...send, attempts: send.attempts + 1 }));
      });

      for (const send of claimed) {
        try {
          const response = await createTicket(new Request("http://fana-internal/api/tickets", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...deferredWorkerHeaders() },
            body: send.payload,
          }));

          if (response.ok) {
            await db.delete(deferredTicketSends)
              .where(eq(deferredTicketSends.idempotencyKey, send.idempotencyKey));
            continue;
          }

          const detail = await response.text().catch(() => "Order send failed");
          const permanent = response.status >= 400 && response.status < 500;
          const failed = permanent || send.attempts >= MAX_ATTEMPTS;
          const retryDelayMs = Math.min(60_000, 2000 * 2 ** Math.min(send.attempts - 1, 5));
          await db.update(deferredTicketSends).set({
            status: failed ? "failed" : "pending",
            dueAt: failed ? send.dueAt : new Date(Date.now() + retryDelayMs),
            lastError: detail.slice(0, 1000),
            updatedAt: new Date(),
          }).where(eq(deferredTicketSends.idempotencyKey, send.idempotencyKey));
          console.error("Deferred waiter ticket could not be sent", {
            key: send.idempotencyKey,
            status: response.status,
            attempts: send.attempts,
          });
        } catch (error) {
          const failed = send.attempts >= MAX_ATTEMPTS;
          const retryDelayMs = Math.min(60_000, 2000 * 2 ** Math.min(send.attempts - 1, 5));
          await db.update(deferredTicketSends).set({
            status: failed ? "failed" : "pending",
            dueAt: failed ? send.dueAt : new Date(Date.now() + retryDelayMs),
            lastError: String(error).slice(0, 1000),
            updatedAt: new Date(),
          }).where(eq(deferredTicketSends.idempotencyKey, send.idempotencyKey));
          console.error("Deferred waiter ticket processing error", { key: send.idempotencyKey, attempts: send.attempts });
        }
      }
    } catch (error) {
      // DB outages are transient: leave rows pending and retry on the next tick.
      console.error("Deferred waiter send worker failed", String(error));
    } finally {
      workerGlobal.__fanaDeferredTicketWorkerBusy = false;
    }
  };

  void processDueOrders();
  const timer = setInterval(() => { void processDueOrders(); }, POLL_MS);
  // Do not keep one-shot scripts alive just because this module was imported.
  if (typeof timer.unref === "function") timer.unref();
}
