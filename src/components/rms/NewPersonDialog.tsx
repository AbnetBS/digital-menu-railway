"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, UserPlus, X } from "lucide-react";
import { useStaffT } from "@/lib/staff-i18n";
import { currentEthiopianPeriod, ethiopianMonthBounds, gregorianDateToEthiopian } from "@/lib/payroll";

/**
 * NEW PERSON, FROM THE PAYROLL SCREEN (owner, 2026-11-08).
 *
 * "also add these button for the New person From attendance main payroll too
 * okay so they can add when they want".
 *
 * The name, the role and the first month are asked here and the row is on the
 * salary sheet immediately, so the owner never has to leave the payroll to put
 * somebody on it. The month he picks is the month the person starts being
 * counted: a name added in Tikimt is not retroactively absent for Meskerem.
 *
 * The salary is NOT asked here on purpose. It is typed straight into the Basic
 * Salary cell of the sheet, where he can watch the net pay change while he
 * types, which is what he asked for originally ("when i click that employee
 * column box it must accept the values there").
 */

type Role = { id: number; name: string };

/** Today, as the attendance list stores it. */
const todayKey = () => {
  const now = new Date();
  return now.toLocaleDateString("en-CA", { timeZone: "Africa/Addis_Ababa" });
};

export default function NewPersonDialog({
  period,
  onClose,
  onAdded,
}: {
  /** The Ethiopian month open on the payroll, so the default is the one he reads. */
  period: string;
  onClose: () => void;
  onAdded: (name: string) => void | Promise<void>;
}) {
  const { t: L } = useStaffT();
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState<number | "">("");
  const [startMonth, setStartMonth] = useState(period || currentEthiopianPeriod());
  const [roles, setRoles] = useState<Role[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    let live = true;
    // Deferred by one tick: a fetch that lands during the mount render trips
    // the set-state-in-effect rule (the same pattern the other dialogs use).
    const timer = setTimeout(async () => {
      try {
        const r = await fetch("/api/attendance/roles", { cache: "no-store" });
        if (r.ok) {
          const d = await r.json();
          if (live) setRoles(Array.isArray(d) ? d.map((x: Role) => ({ id: Number(x.id), name: String(x.name) })) : []);
        }
      } catch {
        // A missing role list is not fatal: the role can be set later.
      }
    }, 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);

  /** The first day of the chosen Ethiopian month, as the list stores it. */
  const startedOn = useMemo(() => {
    const m = /^(\d{4})-(\d{2})$/.exec(startMonth.trim());
    if (!m) return todayKey();
    try {
      return ethiopianMonthBounds(Number(m[1]), Number(m[2])).from;
    } catch {
      return todayKey();
    }
  }, [startMonth]);

  const save = async () => {
    setError("");
    if (!name.trim()) {
      setError(L("Type the name first"));
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/attendance/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          roleId: roleId || null,
          // The month he picked is stored as the employment start, which is
          // what payroll and the report use to decide from which day this
          // person can be absent, late or owed anything.
          employmentStartedAt: startedOn,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(String(d.error || "Could not add the person"));
        return;
      }
      setDone(String(d.message || `${name.trim()} added`));
      await onAdded(name.trim());
      onClose();
    } catch {
      setError(L("Network error. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-[#2C1B17] border border-[#C9A227]/40 rounded-2xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <UserPlus className="w-5 h-5 text-[#C9A227]" />
          <h3 className="text-lg font-serif font-black text-amber-100">{L("New person")}</h3>
          <button
            onClick={onClose}
            className="ml-auto p-1.5 text-stone-400 hover:text-white rounded-lg"
            aria-label={L("Close")}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-[11px] font-bold text-stone-400">
          {L("He appears on the payroll sheet straight away. Type his Basic Salary in the cell after saving.")}
        </p>

        <label className="block">
          <span className="block text-[11px] font-bold text-amber-200 mb-1">{L("Name")}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Abebe"
            autoFocus
            className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-sm text-white"
          />
        </label>

        <label className="block">
          <span className="block text-[11px] font-bold text-amber-200 mb-1">{L("Role")}</span>
          <select
            value={roleId}
            onChange={(e) => setRoleId(e.target.value ? Number(e.target.value) : "")}
            className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-sm text-white"
          >
            <option value="">{L("Select role")}</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="block text-[11px] font-bold text-amber-200 mb-1">{L("Counted from this month")}</span>
          <input
            value={startMonth}
            onChange={(e) => setStartMonth(e.target.value)}
            placeholder="2019-02"
            pattern="\d{4}-(0[1-9]|1[0-3])"
            className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-sm text-white"
          />
          <span className="block text-[10px] font-bold text-stone-500 mt-1">
            {L("Ethiopian month, for example 2019-02 is Tikimt 2019")} · {startedOn} (
            {gregorianDateToEthiopian(startedOn)})
          </span>
        </label>

        {error && <p className="text-xs font-bold text-rose-300">{error}</p>}
        {done && <p className="text-xs font-bold text-emerald-300">{done}</p>}

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2.5 rounded-xl bg-white/10 text-xs font-bold text-white">
            {L("Cancel")}
          </button>
          <button
            onClick={() => void save()}
            disabled={busy}
            className="px-4 py-2.5 rounded-xl bg-[#C9A227] text-[#21130f] text-xs font-black disabled:opacity-50 flex items-center gap-1"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {L("Add person")}
          </button>
        </div>
      </div>
    </div>
  );
}
