"use client";
import { useState } from "react";
import { Check, Trash2 } from "lucide-react";

export type PendingScan = {
  id: number;
  memberId: number | null;
  memberName: string;
  fingerprintId: number;
  reasonLabel: string;
  suggestedDate: string;
};

/**
 * Scans that reached the server with NO time at all. The system never guesses
 * their IN/OUT (guessing paired the wrong times). An admin types the arrival
 * time here; the scan then goes onto Today Live and the Paper Sheet.
 */
export default function PendingScanTimes({
  items,
  onChanged,
}: {
  items: PendingScan[];
  onChanged: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<number, { date: string; time: string }>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  if (items.length === 0) return null;

  const draftOf = (item: PendingScan) => drafts[item.id] || { date: item.suggestedDate, time: "" };
  const setDraft = (item: PendingScan, patch: Partial<{ date: string; time: string }>) =>
    setDrafts((d) => ({ ...d, [item.id]: { ...draftOf(item), ...patch } }));

  const confirm = async (item: PendingScan) => {
    const d = draftOf(item);
    if (!item.memberId) {
      setErr("Link this fingerprint to a staff member first.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time)) {
      setErr("Type the date and the arrival time (HH:MM).");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/attendance/review", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: [{ id: item.id, memberId: item.memberId, date: d.date, clockInTime: d.time }],
        }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Could not save the time");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the time");
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async (item: PendingScan) => {
    setBusy(true);
    try {
      await fetch(`/api/attendance/review?id=${item.id}`, { method: "DELETE" });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-amber-950/40 rounded-2xl border border-amber-500/50 p-4 space-y-3">
      <h3 className="text-sm font-black text-amber-200">Scans with no time ({items.length})</h3>
      <p className="text-[11px] text-stone-300">
        The scanner had no clock when these were taken. Type the arrival time to put them on the sheet.
      </p>
      {err && <p className="text-xs text-rose-300">{err}</p>}
      {items.map((item) => {
        const d = draftOf(item);
        return (
          <div key={item.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-bold text-white">{item.memberName}</span>
            <span className="text-[11px] text-stone-400">{item.reasonLabel}</span>
            <input
              type="date"
              value={d.date}
              onChange={(e) => setDraft(item, { date: e.target.value })}
              className="bg-white/10 rounded-lg px-2 py-1 text-white"
            />
            <input
              type="time"
              value={d.time}
              onChange={(e) => setDraft(item, { time: e.target.value })}
              className="bg-white/10 rounded-lg px-2 py-1 text-white"
            />
            <button
              onClick={() => confirm(item)}
              disabled={busy}
              className="inline-flex items-center gap-1 bg-emerald-700 text-white rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-40"
            >
              <Check className="w-3.5 h-3.5" /> Save time
            </button>
            <button
              onClick={() => dismiss(item)}
              disabled={busy}
              className="inline-flex items-center gap-1 bg-white/10 text-white rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-40"
            >
              <Trash2 className="w-3.5 h-3.5" /> Dismiss
            </button>
          </div>
        );
      })}
    </div>
  );
}
