"use client";
import { useCallback, useEffect, useState } from "react";
import { CalendarDays, Loader2, Plus, Trash2, X } from "lucide-react";

type Holiday = { id: number; date: string; dateEc: string; name: string };

/**
 * HOLIDAY DATES (owner, Oct 2026).
 *
 * The Holiday OT label is clickable, and this is what opens: the owner types
 * the Ethiopian date and the name of the holiday, and from then on the system
 * knows that day. A person with a completed scan on it earns Holiday OT at the
 * 2.5 rate without anybody remembering to type hours, and the payroll row can
 * say "Meskel" beside the hours.
 *
 * The same dialog is opened from Payroll and from Attendance -> Overtime, so
 * there is one list of holidays in the cafe, not two.
 */
export default function HolidayManagerDialog({
  period,
  onClose,
  onChanged,
}: {
  period: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<Holiday[]>([]);
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/payroll/holidays", { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not load the holidays");
      setRows(Array.isArray(d) ? d : []);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not load the holidays");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const save = async () => {
    setMsg("");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) {
      setMsg("Type the Ethiopian date like 2019-02-15.");
      return;
    }
    if (!name.trim()) {
      setMsg("Type the name of the holiday.");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/payroll/holidays", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: date.trim(), name: name.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not save the holiday");
      setDate("");
      setName("");
      setMsg(`${d.name} saved. Holiday OT now counts on ${d.dateEc} E.C.`);
      await load();
      onChanged?.();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not save the holiday");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: Holiday) => {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch(`/api/payroll/holidays?id=${row.id}`, { method: "DELETE" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Could not remove the holiday");
      setMsg(`${row.name} removed.`);
      await load();
      onChanged?.();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not remove the holiday");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] bg-black/70 flex items-center justify-center p-4 no-print">
      <div className="w-full max-w-2xl bg-[#2C1B17] border border-[#C9A227] rounded-3xl p-5 space-y-4 max-h-[90vh] overflow-y-auto text-white">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-serif font-black text-lg text-amber-100 flex items-center gap-2">
            <CalendarDays className="w-5 h-5 text-[#C9A227]" /> Holiday dates
          </h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/10" aria-label="Close holiday dates">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid sm:grid-cols-[1fr_1.4fr_auto] gap-3 items-end bg-black/20 rounded-2xl p-4">
          <label className="text-[11px] font-bold text-amber-200">
            Date (E.C. YYYY-MM-DD)
            <input
              value={date}
              onChange={(e) => setDate(e.target.value)}
              placeholder="2019-02-15"
              inputMode="numeric"
              className="block mt-1 w-full bg-[#1C120F] border border-stone-700 rounded-xl p-3 text-white"
            />
          </label>
          <label className="text-[11px] font-bold text-amber-200">
            Name of the holiday
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Meskel, Eid, Fana anniversary..."
              className="block mt-1 w-full bg-[#1C120F] border border-stone-700 rounded-xl p-3 text-white"
            />
          </label>
          <button
            disabled={busy}
            onClick={save}
            className="bg-[#C9A227] text-[#21130f] rounded-xl px-5 py-3 text-xs font-black flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add holiday
          </button>
        </div>

        {msg && <div className="p-3 rounded-xl bg-amber-950 border border-amber-600 text-amber-100 text-xs">{msg}</div>}

        <div className="space-y-2">
          <p className="text-[10px] uppercase font-black tracking-wide text-stone-400">
            Holiday dates saved {rows.length > 0 ? `(${rows.length})` : ""}
          </p>
          {loading ? (
            <p className="text-xs text-stone-400 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading the holidays...
            </p>
          ) : rows.length === 0 ? (
            <p className="text-xs text-stone-500">No holiday dates saved yet ({period} E.C.).</p>
          ) : (
            rows.map((row) => (
              <div key={row.id} className="flex items-center gap-3 bg-black/20 rounded-xl p-3">
                <div className="w-10 h-10 rounded-xl bg-[#C9A227]/15 text-[#C9A227] flex items-center justify-center shrink-0">
                  <CalendarDays className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <p className="font-bold text-sm text-amber-100 truncate">{row.name}</p>
                  <p className="text-[11px] text-stone-400">
                    {row.dateEc} E.C. <span className="text-stone-600">•</span> {row.date}
                  </p>
                </div>
                <button
                  onClick={() => remove(row)}
                  disabled={busy}
                  className="ml-auto p-2 rounded-lg text-rose-300 hover:bg-rose-950/40 disabled:opacity-40"
                  aria-label={`Remove ${row.name}`}
                  title="Remove this holiday"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
