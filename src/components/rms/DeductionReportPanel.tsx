"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, RefreshCw, ThumbsDown, X } from "lucide-react";
import { useStaffT } from "@/lib/staff-i18n";
import {
  decisionButtonLabels,
  decisionHeadline,
  pendingCounts,
  type DecisionEvent,
  type DecisionKind,
} from "@/lib/attendance-decisions";
import { currentEthiopianPeriod, payrollPeriodLabel } from "@/lib/payroll";
import { etDayKeyDaysAgo } from "@/lib/timezone";

/**
 * THE DEDUCTION REPORT (owner, 2026-11-08).
 *
 * This is the screen that grew where the "Open Kiosk /attendance" button used
 * to be. The owner does not use the kiosk tab; what he needs every evening is
 * the list of things a person did, each with two buttons:
 *
 *   abnet - late 30 min            [ Deduct ]  [ Do not deduct ]
 *   abnet - absent today           [ Deduct ]  [ Do not deduct ]
 *   abnet - left early 20 min      [ Deduct ]  [ Do not deduct ]
 *   abnet - overtime 2.5 h         [ Add overtime ] [ Do not add ]
 *
 * NOTHING is deducted until one of those buttons is pressed, and "Do not
 * deduct" (the reasonable excuse) is remembered with a reason. Overtime waits
 * the same way: the system never pays extra hours on its own.
 *
 * The decisions are recorded by /api/attendance/decisions into the same tables
 * payroll reads, so this screen and the salary sheet cannot disagree.
 */

type MonthEvent = DecisionEvent & { measuredMinutes?: number };

type MonthPayload = {
  period: string;
  from: string;
  to: string;
  events: MonthEvent[];
  members: Array<{ id: number; name: string }>;
  pending?: Record<string, number>;
  /** "approved" | "paid" once the owner has finalised the month. */
  locked?: string | null;
};

type RowDecision = "deduct" | "dont_deduct";

const TYPE_LABEL = {
  lateness: "Late",
  early_out: "Left early",
  absence: "Absent",
  overtime: "Overtime",
  shortage: "Breakage and shortage",
} as const satisfies Record<DecisionKind, string>;

export default function DeductionReportPanel({
  onPendingChange,
  onClose,
}: {
  /** Told how many rows are still waiting, so the tab can show the count. */
  onPendingChange?: (pending: number) => void;
  onClose?: () => void;
}) {
  const { t: L } = useStaffT();
  const [period, setPeriod] = useState(() => currentEthiopianPeriod());
  const [data, setData] = useState<MonthPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const [msg, setMsg] = useState("");
  const [msgBad, setMsgBad] = useState(false);
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [memberId, setMemberId] = useState<number | "">("");

  /**
   * Every press answers on the screen itself, in its own strip: the button
   * feedback rule (scripts/verify-button-feedback.ts) and the owner's habit of
   * reading the line under the buttons.
   */
  const say = (text: string, bad = false) => {
    setMsg(text);
    setMsgBad(bad);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/attendance/decisions?period=${encodeURIComponent(period)}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Could not load the report");
      setData(body);
      onPendingChange?.(Number(body?.pending?.total || 0));
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), true);
    } finally {
      setLoading(false);
    }
  }, [period, onPendingChange]);

  useEffect(() => {
    // Deferred by a tick so the first paint is not a cascade of state writes,
    // exactly like the payroll tab does it.
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const decide = async (event: MonthEvent, decision: RowDecision) => {
    const key = `${event.type}|${event.memberId}|${event.date}`;
    setBusyKey(key);
    try {
      const res = await fetch("/api/attendance/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          period,
          memberId: event.memberId,
          date: event.date,
          type: event.type,
          decision,
          // The measured number, never the decided one: the server stores what
          // was approved, and an overtime row needs its hours to be paid.
          minutes: event.measuredMinutes || event.minutes,
          overtimeType: event.type === "overtime" ? event.overtimeType || "shift" : undefined,
          shiftLabel: event.type === "overtime" ? event.label : undefined,
          reason: decision === "dont_deduct" ? L("Reasonable excuse") : "",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Could not save the decision");
      setData((prev) => (prev ? { ...prev, events: body.events || prev.events } : prev));
      onPendingChange?.(Number(body?.pending?.total || 0));
      const words = decisionButtonLabels(event.type);
      say(
        decision === "deduct"
          ? event.type === "overtime"
            ? L("Overtime added. It is paid this month.")
            : L("Deduction confirmed for {name}.", { name: event.memberName })
          : L("{name} is not charged this time.", { name: event.memberName }),
        false
      );
      void words;
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusyKey("");
    }
  };

  const today = etDayKeyDaysAgo(0) || "";
  const yesterday = etDayKeyDaysAgo(1) || "";
  const all = data?.events || [];
  const visible = all
    .filter((e) => e.type !== "shortage")
    .filter((e) => (filter === "pending" ? e.status === "pending" : true))
    .filter((e) => (memberId === "" ? true : e.memberId === memberId));
  const counts = pendingCounts(all);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <label className="text-[11px] font-black uppercase tracking-wider text-stone-400">{L("Month")}</label>
          <input
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            placeholder="2019-10"
            className="bg-[#1C120F] border border-stone-700 rounded-xl px-3 py-2 text-sm text-white w-28"
            aria-label={L("Payroll month")}
          />
          <span className="text-[11px] font-bold text-stone-500">{payrollPeriodLabel(period)}</span>
        </div>
        <select
          value={memberId}
          onChange={(e) => setMemberId(e.target.value === "" ? "" : Number(e.target.value))}
          className="bg-[#1C120F] border border-stone-700 rounded-xl px-3 py-2 text-sm text-white"
          aria-label={L("Employee")}
        >
          <option value="">{L("All employees")}</option>
          {(data?.members || []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <div className="flex gap-1 bg-[#2C1B17] rounded-xl p-1">
          <button
            onClick={() => setFilter("pending")}
            className={`px-3 py-1.5 rounded-lg text-[11px] font-black ${
              filter === "pending" ? "bg-[#C9A227] text-[#2C1B17]" : "text-stone-300"
            }`}
          >
            {L("Waiting for me")} ({counts.total})
          </button>
          <button
            onClick={() => setFilter("all")}
            className={`px-3 py-1.5 rounded-lg text-[11px] font-black ${
              filter === "all" ? "bg-[#C9A227] text-[#2C1B17]" : "text-stone-300"
            }`}
          >
            {L("All decisions")}
          </button>
        </div>
        <button
          onClick={() => void load()}
          className="ml-auto p-2 bg-white/10 hover:bg-white/20 text-amber-200 rounded-xl"
          aria-label={L("Refresh")}
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        </button>
        {onClose && (
          <button onClick={onClose} className="p-2 bg-white/10 hover:bg-white/20 text-stone-200 rounded-xl" aria-label={L("Close")}>
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="bg-[#2C1B17] border border-[#C9A227]/30 rounded-2xl p-4">
        <p className="text-[11px] font-black uppercase tracking-wider text-amber-200">
          {L("Nothing is deducted until you decide")}
        </p>
        <p className="text-[11px] font-bold text-stone-400 mt-1">
          {L("Every absence, lateness, early leave and overtime waits here. Do not deduct when the reason is good: the person keeps the money and the reason is saved.")}
        </p>
        {data?.locked && (
          <p className="text-[11px] font-black text-amber-300 mt-2">
            {data.locked === "paid"
              ? L("This month's payroll is paid, so these decisions are locked.")
              : L("This month's payroll is approved, so these decisions are locked.")}
          </p>
        )}
      </div>

      {msg && (
        <div
          className={`text-xs font-bold px-4 py-3 rounded-xl border ${
            msgBad ? "bg-rose-950/40 text-rose-200 border-rose-800" : "bg-emerald-950/40 text-emerald-200 border-emerald-800"
          }`}
        >
          {msg}
        </div>
      )}

      {visible.length === 0 ? (
        <p className="text-center text-sm font-bold text-stone-400 py-8">
          {filter === "pending"
            ? L("Nothing is waiting for a decision this month.")
            : L("No attendance events in this month.")}
        </p>
      ) : (
        <div className="space-y-2">
          {visible.map((e) => {
            const key = `${e.type}|${e.memberId}|${e.date}`;
            const busy = busyKey === key;
            const labels = decisionButtonLabels(e.type);
            const settled = e.status !== "pending";
            return (
              <div
                key={key}
                className={`flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2.5 ${
                  settled
                    ? e.status === "approved"
                      ? "border-rose-900/60 bg-rose-950/20"
                      : "border-emerald-900/60 bg-emerald-950/20"
                    : "border-stone-700 bg-[#241714]"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-black text-amber-100 truncate">
                    {decisionHeadline({ ...e, memberName: e.memberName }, today, yesterday)}
                  </p>
                  <p className="text-[11px] font-bold text-stone-400">
                    {e.dateEc} E.C. · {L(TYPE_LABEL[e.type])}
                    {e.label ? ` · ${e.label}` : ""}
                    {settled
                      ? ` · ${e.status === "approved" ? L("Deducted") : L("Not deducted")}`
                      : ` · ${L("waiting")}`}
                    {e.reason ? ` · ${e.reason}` : ""}
                  </p>
                </div>
                {data?.locked ? (
                  <span
                    className={`text-[10px] font-black uppercase px-2.5 py-1 rounded-full ${
                      e.status === "approved" ? "bg-rose-900/60 text-rose-200" : e.status === "denied" ? "bg-emerald-900/60 text-emerald-200" : "bg-stone-800 text-stone-400"
                    }`}
                  >
                    {e.status === "approved"
                      ? L("Deducted")
                      : e.status === "denied"
                        ? L("Not deducted")
                        : L("waiting")}
                  </span>
                ) : settled ? (
                  <span
                    className={`text-[10px] font-black uppercase px-2.5 py-1 rounded-full ${
                      e.status === "approved" ? "bg-rose-900/60 text-rose-200" : "bg-emerald-900/60 text-emerald-200"
                    }`}
                  >
                    {e.status === "approved" ? L("Deducted") : L("Not deducted")}
                  </span>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => void decide(e, "deduct")}
                      disabled={busy}
                      className="flex items-center gap-1 bg-rose-700 hover:bg-rose-600 disabled:opacity-50 text-white text-[11px] font-black px-3 py-2 rounded-lg"
                    >
                      <Check className="w-3.5 h-3.5" /> {L(labels.confirm)}
                    </button>
                    <button
                      onClick={() => void decide(e, "dont_deduct")}
                      disabled={busy}
                      className="flex items-center gap-1 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-[11px] font-black px-3 py-2 rounded-lg"
                    >
                      <ThumbsDown className="w-3.5 h-3.5" /> {L(labels.deny)}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
