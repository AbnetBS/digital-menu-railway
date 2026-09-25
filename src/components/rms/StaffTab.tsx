"use client";

import { useState, useEffect } from "react";
import { Users, Plus, Trash2, ClipboardList, Monitor, RefreshCw } from "lucide-react";
import { StaffUser } from "@/types";
import { useStaffT } from "@/lib/staff-i18n";

export default function StaffTab() {
  const { t: L, rich: Lr, td: Ld } = useStaffT();
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"waiter" | "cashier" | "barista" | "kitchen" | "buna" | "juice" | "admin">("waiter");
  const [pin, setPin] = useState("");
  /** One line of feedback under the form: what worked, or why it did not. */
  const [msg, setMsg] = useState("");
  const [msgBad, setMsgBad] = useState(false);
  const say = (text: string, bad: boolean) => {
    setMsg(text);
    setMsgBad(bad);
    setTimeout(() => setMsg(""), 4000);
  };

  const load = async () => {
    const r = await fetch("/api/staff");
    if (r.ok) setStaff(await r.json());
  };

  useEffect(() => {
    load();
  }, []);

  const addStaff = async () => {
    if (!name || !pin) return;
    try {
      const r = await fetch("/api/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, role, pin }),
      });
      // A rejected account (a name that already exists, a bad PIN) used to fail
      // in silence, so the owner tapped CREATE again and again.
      const d = await r.json().catch(() => null);
      if (!r.ok) return say(d?.error || L("Failed to create the staff account."), true);
      setName("");
      setPin("");
      say(L("✓ Staff account created"), false);
      load();
    } catch {
      say(L("Network error. Try again."), true);
    }
  };

  const removeStaff = async (id: number) => {
    if (!confirm(L("Remove this staff account?"))) return;
    try {
      const r = await fetch(`/api/staff?id=${id}`, { method: "DELETE" });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        say(d?.error || L("Failed to remove the staff account."), true);
        return;
      }
      say(L("✓ Staff account removed"), false);
    } catch {
      say(L("Network error. Try again."), true);
      return;
    }
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-serif font-bold text-amber-100">{L("Staff Accounts")}</h2>
          <p className="text-xs text-stone-400">{L("Create waiter & cashier logins (name + PIN). Share the PIN directly with staff.")}</p>
        </div>
        <button onClick={load} className="p-2 bg-white/10 hover:bg-white/20 text-amber-200 rounded-xl" title={L("Refresh")}>
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Add staff form */}
      <div className="bg-[#2C1B17] rounded-2xl border border-[#C9A227]/30 p-5">
        <h3 className="text-sm font-bold text-amber-200 uppercase tracking-wider mb-3">{L("Add New Staff")}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={L("Staff name (e.g. Samuel)")}
            className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white"
          />
          <select
            value={role}
            onChange={(e) =>
              setRole(e.target.value as "waiter" | "cashier" | "barista" | "kitchen" | "buna" | "juice" | "admin")
            }
            className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white"
          >
            <option value="waiter">{L("Waiter (/waiter)")}</option>
            <option value="cashier">{L("Cashier (/cashier)")}</option>
            <option value="barista">{L("Barista (/barista)")}</option>
            <option value="kitchen">{L("Kitchen/Chef (/kitchen)")}</option>
            <option value="buna">{L("Buna Maker (/buna)")}</option>
            <option value="juice">{L("Juice Maker (/juice)")}</option>
            <option value="admin">{L("Admin (owner dashboard)")}</option>
          </select>
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder={L("PIN (e.g. 4321)")}
            inputMode="numeric"
            className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white"
          />
          <button
            onClick={addStaff}
            disabled={!name || !pin}
            className="bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-black text-xs uppercase rounded-xl flex items-center justify-center gap-2 disabled:opacity-40"
          >
            <Plus className="w-4 h-4" /> {L("Create Account")}
          </button>
        </div>
        {msg && (
          <p className={`mt-3 text-xs font-bold ${msgBad ? "text-rose-300" : "text-emerald-400"}`}>{msg}</p>
        )}
      </div>

      {/* Staff list */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {staff.map((s) => (
          <div key={s.id} className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${s.role === "cashier" ? "bg-purple-700" : "bg-emerald-700"}`}>
                {s.role === "cashier" ? <Monitor className="w-5 h-5 text-white" /> : <ClipboardList className="w-5 h-5 text-white" />}
              </div>
              <div>
                <p className="text-sm font-bold text-amber-100">{s.name}</p>
                <p className="text-[10px] text-stone-400 uppercase font-extrabold">
                  {Ld(s.role)} • PIN: {s.pinSet ? L("•••• (set)") : L("not set")}
                </p>
                {s.alertsOff && (
                  <p className="text-[10px] font-bold text-amber-300 mt-0.5" title={L("They tapped 'Off duty' in their app. Signing in with their PIN switches alerts back on.")}>
                    {L("🔕 Off duty (alerts silent)")}
                  </p>
                )}
              </div>
            </div>
            <button onClick={() => removeStaff(s.id)} className="p-2 bg-rose-500/20 text-rose-300 hover:bg-rose-500 hover:text-white rounded-lg transition" title={L("Remove")}>
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
        {staff.length === 0 && (
          <div className="col-span-3 bg-[#2C1B17] rounded-2xl border border-stone-800 p-8 text-center text-stone-500 text-xs">
            {L("No staff yet. Create your first waiter or cashier above.")}
          </div>
        )}
      </div>

      <div className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-4 flex items-start gap-3">
        <Users className="w-5 h-5 text-[#C9A227] shrink-0 mt-0.5" />
        <p className="text-xs text-stone-400 leading-relaxed">
          {Lr("Staff open <b>/waiter</b> (phones) or <b>/cashier</b> (counter), pick their name, and enter this PIN. Admin access stays separate with your master password.", { b: (s) => <strong className="text-white">{s}</strong> })}
        </p>
      </div>
    </div>
  );
}
