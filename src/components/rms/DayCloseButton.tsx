"use client";

import { useCallback, useEffect, useState } from "react";
import { Moon, CheckCircle2 } from "lucide-react";
import { useStaffT, tNow, staffEtb } from "@/lib/staff-i18n";
import { formatEtb, type DayCloseRecord } from "@/lib/daily-sales";
import { formatClock } from "@/lib/order-lines";

/**
 * TODAY'S SHIFT END — the cashier's closing button (owner's decision, 29 Sept
 * 2026).
 *
 * WHAT THE OWNER ASKED FOR: a button that opens after the closing hour (1:00
 * Ethiopian local = 19:00, five hours after the shift change). When the
 * cashier taps it, the system adds up what the cashier has PRINTED today (the
 * EFD receipt moment — the paper the owner counts against the drawer) and sends
 * ONE notification to the owner's phone: "💰 Today's total sale • 12,450 ETB".
 * Tapping that notification opens the Daily Sales page in his dashboard.
 *
 * The button stays available after the first close, so a late correction can
 * be sent again; the close record then names the newer time and total.
 */

interface DayCloseState {
  cutoffHour: number;
  currentHour: number;
  canClose: boolean;
  todayKey: string;
  today: { total: number; bills: number; closed: DayCloseRecord | null };
}

export default function DayCloseButton({ onToast }: { onToast?: (msg: string) => void }) {
  const { t: L, td: Ld } = useStaffT();
  const [state, setState] = useState<DayCloseState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/reports/daily-sales", { cache: "no-store" });
      if (!r.ok) return;
      const data = (await r.json()) as DayCloseState;
      setState({
        cutoffHour: data.cutoffHour,
        currentHour: data.currentHour,
        canClose: data.canClose,
        todayKey: data.todayKey,
        today: data.today,
      });
    } catch {
      /* the top bar must never break over this */
    }
  }, []);

  useEffect(() => {
    // Async loader behind a fetch; the lint rule cannot see through the
    // function boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    // Refresh every few minutes: the hour of the closing gate moves on its own.
    const timer = setInterval(() => void load(), 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [load]);

  // Nothing to show before we know the hour (or if the API did not answer).
  if (!state) return null;

  const closed = state.today.closed;
  const hour = String(state.cutoffHour).padStart(2, "0");

  const closeDay = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/reports/daily-sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "day-close" }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        onToast?.(data?.error ? Ld(data.error) : tNow("Could not close the day. Try again."));
      } else {
        onToast?.(
          tNow("✓ Today's total sent to the owner • {value}", { value: staffEtb(Number(data?.total || 0)) })
        );
      }
    } catch {
      onToast?.(tNow("Network error. Try again."));
    }
    setBusy(false);
    void load();
  };

  if (!state.canClose) {
    return (
      <span
        className="text-[10px] font-black px-3 py-1.5 rounded-full bg-stone-800 text-stone-300 border border-stone-700 whitespace-nowrap"
        title={L("Today's shift end opens at {hour}:00 • the total is sent to the owner's phone", { hour })}
      >
        {L("🌙 Shift end at {hour}:00", { hour })}
      </span>
    );
  }

  return (
    <button
      onClick={() => void closeDay()}
      disabled={busy}
      className={`text-[10px] font-black px-3 py-1.5 rounded-full flex items-center gap-1.5 whitespace-nowrap transition disabled:opacity-50 ${
        closed ? "bg-emerald-700 hover:bg-emerald-600 text-white" : "bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] animate-pulse"
      }`}
      title={
        closed
          ? L("Closed {clock} • send the total again if something changed", { clock: formatClock(closed.at) })
          : L("Send today's total sale to the owner's phone")
      }
    >
      {closed ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
      {closed
        ? L("Total sent • {value}", { value: formatEtb(closed.total) })
        : L("Today's shift end")}
    </button>
  );
}
