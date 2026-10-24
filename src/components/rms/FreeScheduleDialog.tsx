"use client";
import { useEffect, useState } from "react";
import { CalendarDays, Trash2, X } from "lucide-react";
import { leaveDays } from "@/lib/free-schedule";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Row = {
  id: number;
  scheduleType: string;
  weekday: number | null;
  freeDate: string | null;
  freeDateEc: string | null;
  freeUntil: string | null;
  freeUntilEc: string | null;
  days: number | null;
  startTime: string;
  endTime: string;
  note: string | null;
};

/**
 * FREE SCHEDULE (owner, Oct 2026)
 *
 * Three buttons, because the owner thinks in three situations:
 *
 *   Repeating every week   the normal weekly free day
 *   One specific date      one free date he names himself
 *   Ye amet ereft          yearly leave: FROM and TO, because the run and the
 *                          number of days differ per person, plus an optional
 *                          note. Those days are never absences and the salary
 *                          is paid as if the person worked.
 */
export default function FreeScheduleDialog({ member, onClose }: { member: { id: number; name: string }; onClose: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [type, setType] = useState<"weekly" | "dated" | "annual">("weekly");
  const [weekday, setWeekday] = useState(0);
  const [date, setDate] = useState("");
  const [until, setUntil] = useState("");
  const [start, setStart] = useState("00:00");
  const [end, setEnd] = useState("23:59");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const r = await fetch(`/api/attendance/free?memberId=${member.id}`, { cache: "no-store" });
    if (r.ok) setRows(await r.json());
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member.id]);

  const leaveCount = type === "annual" ? leaveDays(date, until || date) : 0;

  const save = async () => {
    setMsg("");
    setErr("");
    if (type === "dated" && !date.trim()) {
      setErr("Write the Ethiopian date of the free day, for example 2019-02-15.");
      return;
    }
    if (type === "annual" && !date.trim()) {
      setErr("Write the first day of the ye amet ereft, for example 2019-01-01.");
      return;
    }
    if (type === "annual" && until.trim() && until < date) {
      setErr("The last day of the leave cannot be before the first day.");
      return;
    }
    setSaving(true);
    try {
      const r = await fetch("/api/attendance/free", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberId: member.id,
          scheduleType: type,
          weekday,
          freeDate: date,
          freeUntil: type === "annual" ? until || date : "",
          startTime: type === "annual" ? "00:00" : start,
          endTime: type === "annual" ? "23:59" : end,
          note,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error || "Could not save the free days");
        return;
      }
      setMsg(
        type === "annual"
          ? `Ye amet ereft saved: ${leaveDays(date, until || date)} day(s). He will not be written absent, and the salary is paid as if he worked.`
          : "Free schedule saved"
      );
      setNote("");
      await load();
    } catch {
      setErr("Network error. The free days were not saved.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: number) => {
    try {
      const r = await fetch(`/api/attendance/free?id=${id}&memberId=${member.id}`, { method: "DELETE" });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setErr(d.error || "Could not remove the free days");
        return;
      }
      setMsg("Free days removed");
      await load();
    } catch {
      setErr("Network error. The free days were not removed.");
    }
  };

  const describe = (r: Row) => {
    if (r.scheduleType === "annual") {
      const from = r.freeDateEc || r.freeDate || "";
      const to = r.freeUntilEc || r.freeUntil || from;
      const days = r.days || leaveDays(r.freeDate, r.freeUntil);
      return `Ye amet ereft • ${from} to ${to} E.C. • ${days} day${days === 1 ? "" : "s"}`;
    }
    if (r.scheduleType === "dated") return `Free date ${r.freeDateEc || r.freeDate} E.C.`;
    return `Every ${DAYS[Number(r.weekday) || 0]}`;
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-[#2C1B17] border border-[#C9A227] rounded-3xl p-5 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between gap-3">
          <div>
            <h3 className="font-bold text-amber-100">Free schedule • {member.name}</h3>
            <p className="text-xs text-stone-400">Free dates are not counted as absences.</p>
          </div>
          <button onClick={onClose} aria-label="Close free schedule" className="text-stone-300 hover:text-white self-start">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* The three kinds. Ye amet ereft is a button of its own so nobody has
            to understand a "type" list to find the yearly leave. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {[
            { key: "weekly" as const, title: "Every week", hint: "The same free day repeats" },
            { key: "dated" as const, title: "One date", hint: "A single free day" },
            { key: "annual" as const, title: "Ye amet ereft", hint: "Yearly leave, from to" },
          ].map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => {
                setType(option.key);
                setMsg("");
                setErr("");
              }}
              className={`rounded-xl border p-3 text-left transition ${
                type === option.key
                  ? "border-[#C9A227] bg-[#C9A227]/15 text-amber-100"
                  : "border-stone-700 bg-[#1C120F] text-stone-300 hover:border-stone-500"
              }`}
            >
              <span className="block text-xs font-black">{option.title}</span>
              <span className="block text-[10px] text-stone-400">{option.hint}</span>
            </button>
          ))}
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          {type === "weekly" && (
            <label className="text-xs">
              Weekday
              <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} className="block w-full mt-1 bg-[#1C120F] rounded-xl p-3">
                {DAYS.map((d, i) => (
                  <option value={i} key={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
          )}

          {type === "dated" && (
            <label className="text-xs sm:col-span-2">
              Ethiopian date (YYYY-MM-DD E.C.)
              <input
                type="text"
                inputMode="numeric"
                placeholder="2019-02-15"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="block w-full mt-1 bg-[#1C120F] rounded-xl p-3"
              />
            </label>
          )}

          {type === "annual" && (
            <>
              <label className="text-xs">
                Ye amet ereft from (E.C.)
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="2019-01-01"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="block w-full mt-1 bg-[#1C120F] rounded-xl p-3"
                />
              </label>
              <label className="text-xs">
                Until (E.C.)
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="2019-01-14"
                  value={until}
                  onChange={(e) => setUntil(e.target.value)}
                  className="block w-full mt-1 bg-[#1C120F] rounded-xl p-3"
                />
              </label>
              <p className="text-[11px] text-stone-400 sm:col-span-2 flex items-center gap-2">
                <CalendarDays className="w-3.5 h-3.5 text-[#C9A227]" />
                {leaveCount > 0
                  ? `${leaveCount} day${leaveCount === 1 ? "" : "s"} will be paid as if he worked, and he will not be written absent.`
                  : "Give the first and the last day. The number of free days differs per person."}
              </p>
            </>
          )}

          {type !== "annual" && (
            <>
              <label className="text-xs">
                Free from
                <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="block w-full mt-1 bg-[#1C120F] rounded-xl p-3" />
              </label>
              <label className="text-xs">
                Free until
                <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="block w-full mt-1 bg-[#1C120F] rounded-xl p-3" />
              </label>
            </>
          )}

          <label className="text-xs sm:col-span-2">
            Note (optional)
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={type === "annual" ? "For example: after one year of service" : ""}
              className="block w-full mt-1 bg-[#1C120F] rounded-xl p-3"
            />
          </label>
        </div>

        {err && <p className="text-rose-300 text-xs">{err}</p>}
        {msg && <p className="text-amber-300 text-xs">{msg}</p>}

        <button
          onClick={save}
          disabled={saving}
          className="bg-[#C9A227] text-[#21130f] rounded-xl px-5 py-3 text-xs font-black disabled:opacity-60"
        >
          {saving ? "Saving..." : type === "annual" ? "Add ye amet ereft" : "Add free day"}
        </button>

        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="bg-black/20 rounded-xl p-3 flex items-center gap-3">
              <div className="text-sm">
                <b>{describe(r)}</b>
                {r.scheduleType !== "annual" && (
                  <span className="text-stone-300">
                    {" "}
                    • {r.startTime}–{r.endTime}
                  </span>
                )}
                {r.scheduleType === "annual" && (
                  <span className="ml-2 text-[10px] font-black text-emerald-300 bg-emerald-950/50 border border-emerald-800 rounded-lg px-2 py-0.5">
                    PAID, NOT ABSENT
                  </span>
                )}
                {r.note ? <div className="text-xs text-stone-400">{r.note}</div> : null}
              </div>
              <button onClick={() => remove(r.id)} className="ml-auto text-rose-300 hover:text-rose-200" aria-label="Remove free days">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          {!rows.length && <p className="text-stone-500 text-sm">No free schedule added.</p>}
        </div>
      </div>
    </div>
  );
}
