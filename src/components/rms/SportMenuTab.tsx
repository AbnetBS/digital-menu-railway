"use client";

import SportMenuEditor from "@/components/rms/SportMenuEditor";

/**
 * SPORT MENU TAB (owner, 2026-11-07 — admin only since 2026-11-08).
 *
 * The owner's match-day price list lives on its own tab of the dashboard, next
 * to Menu: he opens it on a match day, adds cold drinks / hot drinks / pastry,
 * types the new price against each item, and switches it off again afterwards.
 *
 * "the one who is responsible to edit the items is the admin not the waiters".
 * The waiter never opens this: his Sport button shows the ordinary ordering
 * screen with these numbers already on it.
 */
export default function SportMenuTab() {
  return (
    <div className="space-y-3">
      <SportMenuEditor />
    </div>
  );
}
