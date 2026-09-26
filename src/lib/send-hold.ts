/**
 * THE WAITER'S SEND HOLD (owner's decision, Sept 2026).
 *
 * The kitchen and the barista kept getting an order the waiter had just sent,
 * and then a correction a minute later: the waiter tapped SEND at the table,
 * walked to the kitchen, and only then noticed the wrong dish, the wrong
 * quantity or the missing "no sugar". The fix is a short HOLD on the waiter's
 * own send: the order is not released to the stations until the hold expires,
 * and a "Send now" button sits beside the countdown for the small,
 * not-complicated orders that should not wait at all.
 *
 * The hold lives on the waiter's phone (the cart is hers), so the default
 * seconds are a SETTING the owner can tune from the admin Stations tab as the
 * room gets busier or quieter: `waiter_send_hold_seconds`.
 */

/** How long a waiter's own order waits before it is released, by default. */
export const WAITER_SEND_HOLD_DEFAULT_SECONDS = 60;

/** The owner may tune the hold anywhere in this range. */
export const WAITER_SEND_HOLD_MIN_SECONDS = 10;
export const WAITER_SEND_HOLD_MAX_SECONDS = 600;

/** Read the owner's configured hold (missing/garbage → the default). */
export function waiterSendHoldSeconds(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return WAITER_SEND_HOLD_DEFAULT_SECONDS;
  return Math.min(WAITER_SEND_HOLD_MAX_SECONDS, Math.max(WAITER_SEND_HOLD_MIN_SECONDS, n));
}

/** "1:05" / "0:09" — the countdown the waiter reads at a glance. */
export function formatHoldClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
