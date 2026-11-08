"use client";

import SportMenuSheet from "@/components/rms/SportMenuSheet";

/**
 * SPORT MENU TAB (owner, 2026-11-07).
 *
 * The owner's match-day price list lives on its own tab of the dashboard, next
 * to Menu: he opens it on a match day, adds cold drinks / hot drinks / pastry,
 * types the new price against each item, and switches it off again afterwards.
 * The same sheet is the one the waiter opens from his ordering screen, so there
 * is exactly ONE editor and ONE list: no second place for a price to live.
 */
export default function SportMenuTab() {
  return (
    <div className="space-y-3">
      {/* The sheet is a full-screen overlay when it is opened from the waiter
          app. On the dashboard tab it is simply always open, so the owner reads
          it as a page of its own. */}
      <SportMenuSheet open embedded onClose={() => undefined} />
    </div>
  );
}
