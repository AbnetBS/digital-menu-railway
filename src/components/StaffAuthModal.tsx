"use client";

import { useState, useEffect } from "react";
import {
  X,
  Lock,
  UtensilsCrossed,
  Receipt,
  Coffee,
  ChefHat,
  Flame,
  ShieldCheck,
  ArrowLeft,
  KeyRound,
  User,
  AlertCircle,
} from "lucide-react";
import { useStaffT, tNow } from "@/lib/staff-i18n";
import StaffLangToggle from "@/components/rms/StaffLangToggle";

export type RoleType = "waiter" | "cashier" | "barista" | "kitchen" | "buna" | "juice" | "admin";

interface StaffAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface StaffLite {
  id: number;
  name: string;
  role: string;
}

export default function StaffAuthModal({ isOpen, onClose }: StaffAuthModalProps) {
  const { t: L } = useStaffT();
  const [selectedRole, setSelectedRole] = useState<RoleType | null>(null);
  const [staffList, setStaffList] = useState<StaffLite[]>([]);
  const [selectedName, setSelectedName] = useState("");
  const [customName, setCustomName] = useState("");
  const [pin, setPin] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Reset internal state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setSelectedRole(null);
      setSelectedName("");
      setCustomName("");
      setPin("");
      setAdminPassword("");
      setError("");
    }
  }, [isOpen]);

  // Load public staff names when a staff role is selected
  useEffect(() => {
    if (selectedRole && selectedRole !== "admin") {
      setLoading(true);
      fetch("/api/staff?public=1")
        .then((res) => res.json())
        .then((data: StaffLite[]) => {
          if (Array.isArray(data)) {
            const filtered = data.filter((s) => s.role === selectedRole);
            setStaffList(filtered);
            if (filtered.length > 0) {
              setSelectedName(filtered[0].name);
            } else {
              setSelectedName("");
            }
          }
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [selectedRole]);

  if (!isOpen) return null;

  const handleRoleSelect = (role: RoleType) => {
    setSelectedRole(role);
    setError("");
    setPin("");
    setAdminPassword("");
  };

  const handleStaffLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const nameToUse = (selectedName || customName).trim();
    if (!nameToUse) {
      setError(tNow("Please select or enter your name."));
      return;
    }
    if (!pin.trim()) {
      setError(tNow("Please enter your PIN."));
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/staff/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nameToUse,
          pin: pin.trim(),
          role: selectedRole,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success && data.staff) {
        // Store staff session so the staff app recognizes login immediately
        const storageKey = `fana_${selectedRole}`;
        sessionStorage.setItem(storageKey, JSON.stringify(data.staff));
        localStorage.setItem(`fana_alerts_${selectedRole}`, "1");
        
        // Redirect to role dashboard
        const redirectUrl = `/${selectedRole}`;
        window.location.href = redirectUrl;
      } else {
        setError(data.error || tNow("Invalid name or PIN. Please try again."));
      }
    } catch {
      setError(tNow("Connection error. Please try again."));
    } finally {
      setLoading(false);
    }
  };

  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!adminPassword.trim()) {
      setError(tNow("Please enter the owner password."));
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPassword.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        window.location.href = "/admin";
      } else {
        setError(tNow("Incorrect password. Access denied."));
      }
    } catch {
      setError(tNow("Connection error. Please try again."));
    } finally {
      setLoading(false);
    }
  };

  const roles = [
    {
      id: "waiter" as const,
      title: L("Waiter"),
      description: L("Floor, tables & orders"),
      icon: <UtensilsCrossed className="w-6 h-6 text-amber-300" />,
      color: "from-amber-600/30 to-amber-900/30 border-amber-500/40 hover:border-amber-400",
      badgeBg: "bg-amber-500/20 text-amber-300 border-amber-500/40",
    },
    {
      id: "cashier" as const,
      title: L("Cashier"),
      description: L("Billing, printing & settlement"),
      icon: <Receipt className="w-6 h-6 text-purple-300" />,
      color: "from-purple-600/30 to-purple-900/30 border-purple-500/40 hover:border-purple-400",
      badgeBg: "bg-purple-500/20 text-purple-300 border-purple-500/40",
    },
    {
      id: "barista" as const,
      title: L("Barista"),
      description: L("Coffee, drinks & cake station"),
      icon: <Coffee className="w-6 h-6 text-emerald-300" />,
      color: "from-emerald-600/30 to-emerald-900/30 border-emerald-500/40 hover:border-emerald-400",
      badgeBg: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
    },
    {
      id: "kitchen" as const,
      title: L("Kitchen"),
      description: L("Food preparation station"),
      icon: <ChefHat className="w-6 h-6 text-orange-300" />,
      color: "from-orange-600/30 to-orange-900/30 border-orange-500/40 hover:border-orange-400",
      badgeBg: "bg-orange-500/20 text-orange-300 border-orange-500/40",
    },
    {
      id: "buna" as const,
      title: L("Buna Maker"),
      description: L("Traditional coffee, orders too"),
      icon: <Flame className="w-6 h-6 text-rose-300" />,
      color: "from-rose-600/30 to-rose-900/30 border-rose-500/40 hover:border-rose-400",
      badgeBg: "bg-rose-500/20 text-rose-300 border-rose-500/40",
    },
    {
      id: "juice" as const,
      title: L("Juice Maker"),
      description: L("Fresh juices, spris & punches"),
      icon: <UtensilsCrossed className="w-6 h-6 text-lime-300" />,
      color: "from-lime-600/30 to-lime-900/30 border-lime-500/40 hover:border-lime-400",
      badgeBg: "bg-lime-500/20 text-lime-300 border-lime-500/40",
    },
    {
      id: "admin" as const,
      title: L("Admin / Owner"),
      description: L("Management & site settings"),
      icon: <ShieldCheck className="w-6 h-6 text-[#C9A227]" />,
      color: "from-[#C9A227]/20 to-yellow-900/30 border-[#C9A227]/50 hover:border-[#C9A227]",
      badgeBg: "bg-[#C9A227]/20 text-[#C9A227] border-[#C9A227]/40",
    },
  ];

  const activeRoleConfig = roles.find((r) => r.id === selectedRole);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-lg bg-[#1C120F] border border-[#C9A227]/40 rounded-3xl p-6 md:p-8 text-white shadow-2xl overflow-hidden">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-stone-300 hover:text-white hover:bg-white/20 transition"
          aria-label={L("Close")}
        >
          <X className="w-5 h-5" />
        </button>
        <StaffLangToggle compact className="absolute top-4 left-4" />

        {/* Modal Header */}
        <div className="text-center space-y-2 mb-6">
          <div className="w-12 h-12 rounded-2xl bg-[#C9A227] text-[#2C1B17] flex items-center justify-center mx-auto shadow-lg font-bold">
            <Lock className="w-6 h-6" />
          </div>
          <h2 className="text-2xl font-serif font-bold text-amber-100">
            {L("Staff & Owner Portal")}
          </h2>
          <p className="text-xs text-stone-300">
            {L("Select your role to access your operational dashboard")}
          </p>
        </div>

        {/* Error Banner */}
        {error && (
          <div className="mb-4 bg-rose-950/90 border border-rose-500 text-rose-200 text-xs p-3 rounded-xl flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* STEP 1: Role Selection Grid */}
        {!selectedRole && (
          <div className="space-y-3">
            <p className="text-xs font-bold text-stone-400 uppercase tracking-wider text-center mb-1">
              {L("Select Your Role")}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {roles.map((r) => (
                <button
                  key={r.id}
                  onClick={() => handleRoleSelect(r.id)}
                  className={`flex items-center gap-3 p-3.5 rounded-2xl border bg-gradient-to-r ${r.color} transition text-left group hover:scale-[1.02] active:scale-[0.98]`}
                >
                  <div className="p-2 rounded-xl bg-black/40 border border-white/10 shrink-0">
                    {r.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-white group-hover:text-amber-200 transition">
                      {r.title}
                    </p>
                    <p className="text-[11px] text-stone-300 truncate">
                      {r.description}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* STEP 2: Selected Role Login Form */}
        {selectedRole && (
          <div className="space-y-5">
            {/* Active Role Indicator & Back Button */}
            <div className="flex items-center justify-between pb-3 border-b border-stone-800">
              <button
                type="button"
                onClick={() => setSelectedRole(null)}
                className="flex items-center gap-1.5 text-xs text-amber-300 hover:text-white bg-white/10 px-3 py-1.5 rounded-full transition"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>{L("Change Role")}</span>
              </button>
              <div
                className={`flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-extrabold uppercase ${activeRoleConfig?.badgeBg}`}
              >
                {activeRoleConfig?.icon}
                <span>{activeRoleConfig?.title}</span>
              </div>
            </div>

            {/* FORM FOR STAFF (Waiter / Cashier / Barista / Kitchen) */}
            {selectedRole !== "admin" ? (
              <form onSubmit={handleStaffLogin} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-amber-200 mb-1 flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5 text-[#C9A227]" />
                    <span>{L("Select Staff Member")}</span>
                  </label>
                  {staffList.length > 0 ? (
                    <select
                      value={selectedName}
                      onChange={(e) => setSelectedName(e.target.value)}
                      className="w-full bg-[#2C1B17] border border-stone-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[#C9A227]"
                    >
                      {staffList.map((s) => (
                        <option key={s.id} value={s.name}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      required
                      value={customName}
                      onChange={(e) => setCustomName(e.target.value)}
                      placeholder={L("Enter your name...")}
                      className="w-full bg-[#2C1B17] border border-stone-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[#C9A227]"
                    />
                  )}
                </div>

                <div>
                  <label className="block text-xs font-bold text-amber-200 mb-1 flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5 text-[#C9A227]" />
                    <span>{L("Enter 4-Digit PIN")}</span>
                  </label>
                  <input
                    type="password"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={10}
                    required
                    autoFocus
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    placeholder="••••"
                    className="w-full bg-[#2C1B17] border border-stone-700 rounded-xl px-4 py-3 text-sm text-white tracking-widest focus:outline-none focus:border-[#C9A227]"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-gradient-to-r from-[#C9A227] to-[#B8921F] hover:from-[#d6ad2a] hover:to-[#c29b21] text-[#2C1B17] font-black text-xs uppercase tracking-wider py-3.5 rounded-xl shadow-xl transition disabled:opacity-50"
                >
                  {loading ? L("Logging in...") : L("Login as {title}", { title: activeRoleConfig?.title })}
                </button>
              </form>
            ) : (
              /* FORM FOR ADMIN / OWNER */
              <form onSubmit={handleAdminLogin} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-amber-200 mb-1 flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5 text-[#C9A227]" />
                    <span>{L("Owner Password")}</span>
                  </label>
                  <input
                    type="password"
                    required
                    autoFocus
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    placeholder={L("Enter owner password...")}
                    className="w-full bg-[#2C1B17] border border-stone-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[#C9A227]"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-gradient-to-r from-[#C9A227] to-[#B8921F] hover:from-[#d6ad2a] hover:to-[#c29b21] text-[#2C1B17] font-black text-xs uppercase tracking-wider py-3.5 rounded-xl shadow-xl transition disabled:opacity-50"
                >
                  {loading ? L("Unlocking...") : L("Login To Owner Dashboard")}
                </button>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
