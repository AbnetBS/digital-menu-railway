"use client";

/**
 * THE "GUEST IS WAITING" SCREEN.
 *
 * A guest ordering, adding a dish, or asking for the bill is the one thing
 * staff cannot predict. A toast in a corner is not enough: the phone is in a
 * pocket and the tablet is behind the counter.
 *
 * So when one of those three things happens, this takes over the whole screen
 * with ONE big button. It rings exactly ONCE (the alarm already played where
 * the event was detected) and then stays SILENT: during a rush a card that
 * keeps re-ringing for an unanswered event trains staff to ignore the phone.
 * The card itself stays on screen with its big button until it is pressed —
 * pressing the button is the confirmation: it does the job (confirm the
 * order / open the table) and closes the screen.
 */

import { Bell, Receipt, UtensilsCrossed, X } from "lucide-react";

export interface UrgentAlert {
  /** Stable id, so the same event does not re-open the screen after it is answered. */
  id: string;
  /** "order" = new order, "added" = extra dishes, "bill" = asked for the bill. */
  kind: "order" | "added" | "bill";
  /** Big line: which table. */
  table: string;
  /** Small line: money, dish count, whatever helps decide. */
  detail?: string;
  /** Text on the big button ("✓ CONFIRM ORDER", "OPEN BILL", "GOT IT"). */
  actionLabel: string;
  /** What the big button does, on top of closing the screen. */
  onAction?: () => void;
}

const LOOK = {
  order: { icon: UtensilsCrossed, title: "NEW ORDER", ring: "from-amber-500 to-orange-600" },
  added: { icon: Bell, title: "ITEMS ADDED", ring: "from-amber-500 to-rose-600" },
  bill: { icon: Receipt, title: "BILL REQUESTED", ring: "from-emerald-500 to-teal-600" },
} as const;

export default function UrgentAlertOverlay({
  alert,
  onClose,
}: {
  alert: UrgentAlert | null;
  onClose: () => void;
}) {
  if (!alert) return null;

  const look = LOOK[alert.kind];
  const Icon = look.icon;

  const answer = () => {
    try {
      // Stop the phone buzzing the moment it is answered.
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        navigator.vibrate(0);
      }
    } catch {
      /* ignore */
    }
    alert.onAction?.();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black/85 backdrop-blur-sm p-6">
      <button
        onClick={onClose}
        aria-label="Close"
        className="absolute top-5 right-5 p-3 rounded-2xl bg-white/10 text-white/70"
      >
        <X className="w-5 h-5" />
      </button>

      <div
        className={`w-28 h-28 rounded-full bg-gradient-to-br ${look.ring} flex items-center justify-center shadow-2xl`}
      >
        <Icon className="w-14 h-14 text-white" />
      </div>

      <p className="mt-6 text-sm tracking-[0.3em] text-white/60">{look.title}</p>
      <p className="mt-2 text-4xl font-black text-white text-center leading-tight">{alert.table}</p>
      {alert.detail ? <p className="mt-2 text-lg text-amber-200 text-center">{alert.detail}</p> : null}

      <button
        onClick={answer}
        className="mt-10 w-full max-w-sm py-6 rounded-3xl bg-gradient-to-r from-amber-500 to-orange-600 text-white text-2xl font-black shadow-xl active:scale-95 transition"
      >
        {alert.actionLabel}
      </button>
      <p className="mt-4 text-xs text-white/45 text-center">
        It rang once. The card stays here until you press the button.
      </p>
    </div>
  );
}
