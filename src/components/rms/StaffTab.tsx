"use client";

import { useState, useEffect } from "react";
import { Users, Plus, Trash2, ClipboardList, Monitor, RefreshCw } from "lucide-react";
import { StaffUser } from "@/types";

export default function StaffTab() {
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"waiter" | "cashier" | "barista" | "kitchen" | "admin">("waiter");
  const [pin, setPin] = useState("");

  const load = async () => {
    const r = await fetch("/api/staff");
    if (r.ok) setStaff(await r.json());
  };

  useEffect(() => {
    load();
  }, []);

  const addStaff = async () => {
    if (!name || !pin) return;
    const r = await fetch("/api/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, role, pin }),
    });
    if (r.ok) {
      setName("");
      setPin("");
      load();
    }
  };

  const removeStaff = async (id: number) => {
    if (!confirm("Remove this staff account?")) return;
    await fetch(`/api/staff?id=${id}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-serif font-bold text-amber-100">Staff Accounts</h2>
          <p className="text-xs text-stone-400">Create waiter & cashier logins (name + PIN). Share the PIN directly with staff.</p>
        </div>
        <button onClick={load} className="p-2 bg-white/10 hover:bg-white/20 text-amber-200 rounded-xl" title="Refresh">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Add staff form */}
      <div className="bg-[#2C1B17] rounded-2xl border border-[#C9A227]/30 p-5">
        <h3 className="text-sm font-bold text-amber-200 uppercase tracking-wider mb-3">Add New Staff</h3>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Staff name (e.g. Samuel)"
            className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "waiter" | "cashier" | "barista" | "kitchen" | "admin")}
            className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white"
          >
            <option value="waiter">Waiter (/waiter)</option>
            <option value="cashier">Cashier (/cashier)</option>
            <option value="barista">Barista (/barista)</option>
            <option value="kitchen">Kitchen/Chef (/kitchen)</option>
            <option value="admin">Admin (owner dashboard)</option>
          </select>
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="PIN (e.g. 4321)"
            inputMode="numeric"
            className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white"
          />
          <button
            onClick={addStaff}
            disabled={!name || !pin}
            className="bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-black text-xs uppercase rounded-xl flex items-center justify-center gap-2 disabled:opacity-40"
          >
            <Plus className="w-4 h-4" /> Create Account
          </button>
        </div>
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
                <p className="text-[10px] text-stone-400 uppercase font-extrabold">{s.role} • PIN: {s.pinSet ? "•••• (set)" : "not set"}</p>
              </div>
            </div>
            <button onClick={() => removeStaff(s.id)} className="p-2 bg-rose-500/20 text-rose-300 hover:bg-rose-500 hover:text-white rounded-lg transition" title="Remove">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
        {staff.length === 0 && (
          <div className="col-span-3 bg-[#2C1B17] rounded-2xl border border-stone-800 p-8 text-center text-stone-500 text-xs">
            No staff yet. Create your first waiter or cashier above.
          </div>
        )}
      </div>

      <div className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-4 flex items-start gap-3">
        <Users className="w-5 h-5 text-[#C9A227] shrink-0 mt-0.5" />
        <p className="text-xs text-stone-400 leading-relaxed">
          Staff open <strong className="text-white">/waiter</strong> (phones) or <strong className="text-white">/cashier</strong> (counter), pick their name, and enter this PIN.
          Admin access stays separate with your master password.
        </p>
      </div>
    </div>
  );
}
