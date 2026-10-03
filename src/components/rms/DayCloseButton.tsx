"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Moon, CheckCircle2, BellRing, X } from "lucide-react";
import { useStaffT, tNow, staffEtb } from "@/lib/staff-i18n";
import { formatEtb, dayKeyLabel, type DayCloseRecord } from "@/lib/daily-sales";
import { playAlarm } from "@/lib/sound";
import { triggerDesktopNotification } from "@/lib/notifications";

/**
 * TODAY'S SHIFT END — the cashier's closing button (owner's decisions, 29 Sept
 * 2026).
 *
 *   • "the today's shift end button will appear at 2 local time or 8:00 pm" —
 *     the button opens at the cutoff hour (20:00 EAT = 2:00 local; one hour
 *     before the owner's notify time) AND, at that moment, this device plays
 *     the alarm and shows a card so the cashier knows it is available;
 *   • "if she forgets to click that button the system will automatically send
 *     that notification after 1 hour which is 3 local time or 9:00 pm" — the
 *     background worker (and this screen, as a safety net) sends it at the
 *     owner's notify hour, recorded as "auto (system)";
 *   • "that button will disappear at midnight or 6 local time ... because
 *     after that counted as next day" — after midnight the EAT day has rolled
 *     over, the button hides and the new day starts its own window in the
 *     evening.
 *
 * The tap itself: the system adds up today's PRINTED bills (the EFD receipt
 * moment — the paper the owner counts against the drawer) and sends ONE normal
 * notification to the owner's phone. Tapping that notification opens the Daily
 * Sales page in his dashboard.
 *
 * THE TAP IS A SNAPSHOT, NOT A LOCK (owner's own words, 3 Oct 2026: "when the
 * cashier click end shift doesnt mean after that time no sale will be place
 * but to send notification to the owners"). Sales keep coming in afterwards,
 * the total keeps growing, and this same button sends the new number whenever
 * she presses it again. For the same reason the automatic send at her owner's
 * chosen time is no longer skipped just because a record already exists: it is
 * the day's FINAL number, and it is the one the owner reconciles against the
 * drawer.
 */

interface DayCloseDay {
  dayKey: string;
  total: number;
  bills: number;
  closed: DayCloseRecord | null;
}

interface DayCloseState {
  notifyHour: number;
  notifyMinute: number;
  /** "21:03" — the exact minute the owner's phone rings. */
  notifyAt: string;
  cutoffHour: number;
  cutoffMinute: number;
  /** "20:03" — the exact minute her button opens. */
  cutoffAt: string;
  currentHour: number;
  canClose: boolean;
  dueNow: boolean;
  todayKey: string;
  today: { total: number; bills: number; closed: DayCloseRecord | null };
  days: DayCloseDay[];
}

const ANNOUNCE_PREFIX = "fana_day_close_announced_";
/** This screen's own once-a-day latch for the automatic send (3 Oct 2026). */
const AUTO_ATTEMPT_PREFIX = "fana_day_close_auto_";

export default function DayCloseButton({ onToast }: { onToast?: (msg: string) => void }) {
  const { t: L, td: Ld } = useStaffT();
  const [state, setState] = useState<DayCloseState | null>(null);
  const [busy, setBusy] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/reports/daily-sales", { cache: "no-store" });
      if (!r.ok) return;
      const data = (await r.json()) as DayCloseState;
      setState({
        notifyHour: data.notifyHour,
        notifyMinute: data.notifyMinute ?? 0,
        notifyAt: data.notifyAt || `${String(data.notifyHour).padStart(2, "0")}:00`,
        cutoffHour: data.cutoffHour,
        cutoffMinute: data.cutoffMinute ?? 0,
        cutoffAt: data.cutoffAt || `${String(data.cutoffHour).padStart(2, "0")}:00`,
        currentHour: data.currentHour,
        canClose: data.canClose,
        dueNow: data.dueNow,
        todayKey: data.todayKey,
        today: data.today,
        days: data.days || [],
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
    // Every minute: the button's own moment (8:00 pm) must not be missed, and
    // the automatic send has its own minute to keep.
    const timer = setInterval(() => void load(), 60 * 1000);
    return () => clearInterval(timer);
  }, [load]);

  /** The one automatic send this screen performs when the owner's hour lands. */
  const autoSend = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const r = await fetch("/api/reports/daily-sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "day-close", auto: true }),
      });
      const data = await r.json().catch(() => null);
      // The answer is a real delivery report now (3 Oct 2026), not a hopeful
      // "posted". A refusal is spoken out loud: the cashier must know the
      // owner's total did not leave, because the total is the one number the
      // owner reconciles against the drawer.
      if (!r.ok || data?.ok === false) {
        onToast?.(
          data?.error
            ? Ld(data.error)
            : tNow("The system could not send today's total by itself. It will try again.")
        );
      }
    } catch {
      onToast?.(tNow("Network error. Try again."));
    }
    busyRef.current = false;
    void load();
  }, [load, onToast]);

  /* ── THE MOMENT THE BUTTON APPEARS: alarm + card ───────────────────────── */
  useEffect(() => {
    if (!state) return;
    const closed = !!state.today.closed;
    const canClose = state.canClose;
    const dueNow = state.dueNow;
    const announceKey = `${ANNOUNCE_PREFIX}${state.todayKey}`;
    const autoKey = `${AUTO_ATTEMPT_PREFIX}${state.todayKey}`;
    // A timer keeps setState out of the synchronous effect body
    // (react-hooks/set-state-in-effect): the alarm, the card and the automatic
    // send all belong to the same tick.
    const tick = setTimeout(() => {
      if (canClose && !closed) {
        let announced = false;
        try {
          announced = localStorage.getItem(announceKey) === "1";
        } catch {
          /* storage blocked: announce anyway (once per mount is harmless) */
        }
        if (!announced) {
          try {
            localStorage.setItem(announceKey, "1");
          } catch {
            /* ignore */
          }
          playAlarm();
          triggerDesktopNotification({
            title: tNow("Fana Cafe • Cashier"),
            message: tNow("🌙 Today's shift end is available • send today's total to the owner"),
          });
          setCardOpen(true);
        }
      }
      if (closed) setCardOpen(false);
      // THE AUTOMATIC SEND, once per day on this screen (3 Oct 2026). It used
      // to be skipped whenever the day already had a close record, which meant
      // a cashier who tapped early silenced the owner's FINAL number for the
      // whole evening: sales kept coming in, the total kept growing, and the
      // phone stayed quiet. Sending the total does not close the day, so this
      // screen now asks the server once, and the server's own latch decides
      // whether anything is still due.
      if (dueNow) {
        let tried = false;
        try {
          tried = localStorage.getItem(autoKey) === "1";
        } catch {
          /* storage blocked: ask once per mount, the server is idempotent */
        }
        if (!tried) {
          try {
            localStorage.setItem(autoKey, "1");
          } catch {
            /* ignore */
          }
          void autoSend();
        }
      }
    }, 0);
    return () => clearTimeout(tick);
  }, [state, autoSend]);

  if (!state) return null;

  const closed = state.today.closed;
  // "21:04" on the cafe clock — the moment the total was sent.
  const clock = (() => {
    if (!closed) return "";
    const d = new Date(closed.at);
    return Number.isFinite(d.getTime())
      ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
      : "";
  })();
  // The owner picks the exact minute now, so the cashier reads "20:03", not
  // a whole hour that would be a lie by up to 59 minutes.
  const cutoff = state.cutoffAt || `${String(state.cutoffHour).padStart(2, "0")}:00`;
  const notify = state.notifyAt || `${String(state.notifyHour).padStart(2, "0")}:00`;

  const closeDay = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/reports/daily-sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "day-close" }),
      });
      const data = await r.json().catch(() => null);
      // "Sent" is only claimed when a phone actually accepted it (3 Oct 2026).
      // Saying "sent to the owner" for a push that reached nobody is how the
      // owner ended up waiting for a total that was never delivered.
      if (!r.ok || data?.ok === false) {
        onToast?.(
          data?.error
            ? Ld(data.error)
            : tNow("Could not close the day. Try again.")
        );
      } else {
        setCardOpen(false);
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

  /* Before the cutoff hour: she reads exactly when the button opens. */
  if (!state.canClose) {
    return (
      <span
        className="text-[10px] font-black px-3 py-1.5 rounded-full bg-stone-800 text-stone-300 border border-stone-700 whitespace-nowrap"
        title={L("Today's shift end opens at {time} • the total is sent to the owner's phone", { time: cutoff })}
      >
        {L("🌙 Shift end at {time}", { time: cutoff })}
      </span>
    );
  }

  return (
    <>
      <button
        onClick={() => void closeDay()}
        disabled={busy}
        className={`text-[10px] font-black px-3 py-1.5 rounded-full flex items-center gap-1.5 whitespace-nowrap transition disabled:opacity-50 ${
          closed ? "bg-emerald-700 hover:bg-emerald-600 text-white" : "bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] animate-pulse"
        }`}
        title={
          closed
            ? L("Closed {clock} • send the total again if something changed", { clock: clock })
            : L("Send today's total sale to the owner's phone")
        }
      >
        {closed ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
        {closed ? L("Total sent • {value}", { value: formatEtb(closed.total) }) : L("Today's shift end")}
      </button>

      {/* THE CARD: it appears the moment the button opens, with the alarm, so
          the cashier cannot miss that the day can now be closed. */}
      {cardOpen && !closed && (
        <div className="fixed bottom-4 right-4 z-40 w-[320px] max-w-[92vw] bg-[#2C1B17] border-2 border-[#C9A227] rounded-2xl shadow-2xl p-4 space-y-3 no-print">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <BellRing className="w-5 h-5 text-[#C9A227] animate-pulse" />
              <p className="text-sm font-black text-amber-100">{L("Today's shift end is open")}</p>
            </div>
            <button onClick={() => setCardOpen(false)} className="text-stone-400 hover:text-white" title={L("Later")}>
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-[11px] text-stone-300 leading-snug">
            {L("Send today's total sale to the owner's phone. The system sends it by itself at {time} if you forget.", {
              time: notify,
            })}
          </p>
          {/* THE OWNER'S OWN WORDS (3 Oct 2026): "when the cashier click end
              shift doesnt mean after that time no sale will be place but to
              send notification to the owners". The tap is a snapshot, not a
              lock, and the cashier is the one who has to understand that. */}
          <p className="text-[11px] text-stone-400 leading-snug">
            {L("This sends the total up to now. Orders placed after it keep counting, and the button can send the new total again.")}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void closeDay()}
              disabled={busy}
              className="flex-1 bg-gradient-to-r from-[#C9A227] to-amber-500 text-[#2C1B17] font-black text-xs uppercase px-3 py-2.5 rounded-xl disabled:opacity-50"
            >
              {L("✓ Send to the owner now")}
            </button>
            <button
              onClick={() => setCardOpen(false)}
              className="px-3 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-amber-200 font-black text-xs uppercase"
            >
              {L("Later")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
