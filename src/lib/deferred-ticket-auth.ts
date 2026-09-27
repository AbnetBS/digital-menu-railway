import { randomBytes } from "node:crypto";

/**
 * A process-local capability used only when the deferred-order worker invokes
 * the regular ticket POST handler. It is never sent to the browser or stored.
 */
type DeferredWorkerGlobal = typeof globalThis & {
  __fanaDeferredTicketWorkerKey?: string;
};

const globalForDeferredWorker = globalThis as DeferredWorkerGlobal;
if (!globalForDeferredWorker.__fanaDeferredTicketWorkerKey) {
  globalForDeferredWorker.__fanaDeferredTicketWorkerKey = randomBytes(32).toString("hex");
}

const HEADER = "x-fana-deferred-worker";

export function deferredWorkerHeaders(): Record<string, string> {
  return { [HEADER]: globalForDeferredWorker.__fanaDeferredTicketWorkerKey! };
}

export function isDeferredWorkerRequest(request: Request): boolean {
  const value = request.headers.get(HEADER);
  return Boolean(value && value === globalForDeferredWorker.__fanaDeferredTicketWorkerKey);
}
