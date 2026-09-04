"use client";

/**
 * THE "GUEST IS WAITING" SCREEN.
 *
 * A guest ordering, adding a dish, or asking for the bill is the one thing
 * staff cannot predict. A toast in a corner is not enough: the phone is in a
 * pocket and the tablet is behind the counter.
 *
 * So when one of those three things happens, this takes over the whole screen
 * with ONE big button, and the alarm keeps coming back roughly every 10
 * seconds until somebody presses it (capped, so a forgotten phone does not
 * ring all evening). Pressing the button is the confirmation: it does the job
 * (confirm the order / open the table) and closes the screen.
 */

import { useEffect, useRef } from "react";
import { Bell, Receipt, UtensilsCrossed, X } from "lucide-react";
import { playAlarm } from "@/lib/sound";

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

/** How often the alarm comes back while nobody answers. */
const REPEAT_MS = 10_000;
/** Stop after this many repeats, so it never rings forever. */
const MAX_REPEATS = 5;

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
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!alert) return;
    // The first alarm already played where the event was detected, so this
    // only handles the "still nobody answered" repeats.
    let fired = 0;
    timerRef.current = setInterval(() => {
      fired += 1;
      if (fired > MAX_REPEATS) {
        if (timerRef.current) clearInterval(timerRef.current);
        return;
      }
      playAlarm();
    }, REPEAT_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [alert]);

  if (!alert) return null;

  const look = LOOK[alert.kind];
  const Icon = look.icon;

  const answer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
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
        className={`w-28 h-28 rounded-full bg-gradient-to-br ${look.ring} flex items-center justify-center shadow-2xl animate-pulse`}
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
        The alarm keeps ringing until you press the button.
      </p>
    </div>
  );
}
