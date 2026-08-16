/**
 * In-memory pub/sub hub for Server-Sent Events (SSE).
 *
 * Replaces the 8-second polling of waiter/cashier/station screens: instead of
 * each client asking "is there anything new?" every few seconds, a mutation
 * route calls `publish(channel)` and every subscribed client's open SSE stream
 * is immediately told to refresh. Nothing happens → zero traffic.
 *
 * ⚠️ SINGLE-INSTANCE ONLY: subscriptions live in the Node process memory, so
 * this works when the whole app runs in ONE process (a single Railway service).
 * If the app is ever scaled to multiple replicas, events on one instance will
 * not reach clients connected to another. For one restaurant this is the
 * correct, zero-cost setup (no Supabase Realtime, no external broker).
 */

type Enqueue = (chunk: string) => void;

const subscribers = new Map<string, Set<Enqueue>>();

/** Channel names (single source of truth). */
export const CHANNELS = {
  /** Order/table/station operational changes (waiter, cashier, kitchen, barista). */
  orders: "orders",
} as const;

/** Register a stream sink for a channel. Returns an unsubscribe function. */
export function subscribe(channel: string, enqueue: Enqueue): () => void {
  let set = subscribers.get(channel);
  if (!set) {
    set = new Set();
    subscribers.set(channel, set);
  }
  set.add(enqueue);
  return () => {
    set.delete(enqueue);
    if (set.size === 0) subscribers.delete(channel);
  };
}

/** Notify every subscriber of a channel that something changed. */
export function publish(channel: string): void {
  const set = subscribers.get(channel);
  if (!set) return;
  for (const enqueue of set) {
    try {
      enqueue("data: refresh\n\n");
    } catch {
      // subscriber stream already closed — ignore
    }
  }
}
