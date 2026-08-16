"use client";

import { useState, useEffect, useRef } from "react";
import { Coffee, CookingPot, RefreshCw, LogOut, CheckCircle2, BellRing, Clock } from "lucide-react";
import { unlockAudio, playDing } from "@/lib/sound";
import { triggerDesktopNotification } from "@/lib/notifications";
import Link from "next/link";

type Station = "barista" | "kitchen";

interface StaffLite {
  id: number;
  name: string;
  role: string;
}

interface StationItem {
  id: number;
  ticketId: number;
  name: string;
  category: string;
  quantity: number;
  notes?: string | null;
  stationStatus: "pending" | "accepted" | "done";
}

interface StationTicket {
  id: number;
  tableName: string;
  orderNumber?: string | null;
  status: string;
  createdBy?: string | null;
  confirmedBy?: string | null;
  items: StationItem[];
}

const STATION_META = {
  barista: { label: "Barista", icon: Coffee, color: "amber", slug: "barista" as Station, desc: "Drinks, juices, coffees & cold beverages" },
  kitchen: { label: "Kitchen (Chef)", icon: CookingPot, color: "emerald", slug: "kitchen" as Station, desc: "Foods, pastries, meals & snacks" },
};

export default function StationApp({ station }: { station: Station }) {
  const meta = STATION_META[station];
  const Icon = meta.icon;

  const [staffName, setStaffName] = useState("");
  const [staffList, setStaffList] = useState<StaffLite[]>([]);
  const [selectedName, setSelectedName] = useState("");
  const [pin, setPin] = useState("");
  const [loginError, setLoginError] = useState("");
  const [tickets, setTickets] = useState<StationTicket[]>([]);
  const [alertsOn, setAlertsOn] = useState(false);
  const pendingSeenRef = useRef<Set<number>>(new Set());
  const initRef = useRef(false);

  useEffect(() => {
    setAlertsOn(localStorage.getItem(`fana_alerts_${station}`) === "1");
    const saved = sessionStorage.getItem(`fana_${station}`);
    if (saved) {
      const s = JSON.parse(saved);
      setStaffName(s.name);
    }
    fetch("/api/staff?public=1")
      .then((r) => r.json())
      .then((d) => setStaffList(d.filter((x: StaffLite) => x.role === station)))
      .catch(() => {});
  }, [station]);

  const login = async () => {
    setLoginError("");
    const r = await fetch("/api/staff/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: selectedName, pin, role: station }),
    });
    const d = await r.json();
    if (r.ok && d.success) {
      setStaffName(d.staff.name);
      sessionStorage.setItem(`fana_${station}`, JSON.stringify(d.staff));
    } else {
      setLoginError(`Wrong name or PIN. Ask admin for your ${meta.label} PIN.`);
    }
  };

  const logout = () => {
    sessionStorage.removeItem(`fana_${station}`);
    fetch("/api/staff/login", { method: "DELETE" }).catch(() => {});
    setStaffName("");
    setPin("");
  };

  const load = async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    const r = await fetch(`/api/station-items?station=${station}`);
    if (!r.ok) return;
    const data: StationTicket[] = await r.json();

    const nowPendingIds = new Set<number>();
    for (const t of data) for (const i of t.items) if (i.stationStatus === "pending") nowPendingIds.add(i.id);

    const fresh: number[] = [];
    for (const id of nowPendingIds) if (!pendingSeenRef.current.has(id)) fresh.push(id);
    fresh.forEach((id) => pendingSeenRef.current.add(id));

    if (initRef.current && alertsOn && fresh.length > 0) {
      playDing(2);
      // find table info for popup
      for (const t of data) for (const i of t.items) {
        if (fresh.includes(i.id)) {
          triggerDesktopNotification({
            title: `Fana Cafe • ${meta.label} Alert`,
            message: `New item at ${t.tableName}: ${i.name} x${i.quantity}${i.notes ? ` • note: ${i.notes}` : ""}`,
          });
          break;
        }
      }
    }
    initRef.current = true;

    setTickets(data);
  };

  useEffect(() => {
    if (staffName) {
      load();
      // REALTIME (SSE): the server pushes a "refresh" signal only when an
      // order/item changes, instead of polling every 8s.
      const es = new EventSource("/api/realtime?channel=orders");
      es.onmessage = () => load();
      es.onerror = () => load();
      // Refresh immediately when the tab becomes visible again (user action).
      const onVisible = () => {
        if (!document.hidden) load();
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        es.close();
        document.removeEventListener("visibilitychange", onVisible);
      };
    }
  }, [staffName]);

  const enableAlerts = async () => {
    unlockAudio();
    if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission();
    localStorage.setItem(`fana_alerts_${station}`, "1");
    setAlertsOn(true);
    playDing();
  };

  const setStatus = async (item: StationItem, status: "accepted" | "done" | "pending") => {
    await fetch("/api/station-items", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: item.id, stationStatus: status }),
    });
    load();
  };

  /* ── LOGIN ── */
  if (!staffName) {
    return (
      <div className="min-h-screen bg-[#1C120F] flex items-center justify-center p-4 text-white">
        <div className="bg-[#2C1B17] border border-[#C9A227]/40 rounded-3xl p-8 w-full max-w-sm space-y-6 shadow-2xl">
          <div className="text-center space-y-2">
            <div className="w-14 h-14 rounded-2xl bg-[#C9A227] text-[#2C1B17] flex items-center justify-center mx-auto">
              <Icon className="w-7 h-7" />
            </div>
            <h1 className="font-serif text-2xl font-bold text-amber-100">{meta.label} Login</h1>
            <p className="text-xs text-stone-400">{meta.desc}</p>
          </div>
          {loginError && (
            <div className="bg-rose-900/60 border border-rose-500 text-rose-200 text-xs p-3 rounded-xl">{loginError}</div>
          )}
          <div className="space-y-4">
            <select
              value={selectedName}
              onChange={(e) => setSelectedName(e.target.value)}
              className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-sm text-white"
            >
              <option value="">Select your name...</option>
              {staffList.map((s) => (
                <option key={s.id} value={s.name}>{s.name}</option>
              ))}
            </select>
            <input
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="••••"
              className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-sm text-white text-center tracking-[0.5em]"
            />
            <button
              onClick={login}
              disabled={!selectedName || !pin}
              className="w-full bg-gradient-to-r from-[#C9A227] to-amber-500 text-[#2C1B17] font-black text-sm uppercase py-4 rounded-xl disabled:opacity-40"
            >
              Login as {meta.label}
            </button>
            <Link href="/" className="block text-center text-xs text-[#C9A227] hover:underline">← Back to public website</Link>
          </div>
        </div>
      </div>
    );
  }

  const pendingCount = tickets.reduce((acc, t) => acc + t.items.filter((i) => i.stationStatus === "pending").length, 0);
  const acceptedCount = tickets.reduce((acc, t) => acc + t.items.filter((i) => i.stationStatus === "accepted").length, 0);

  return (
    <div className="min-h-screen bg-[#14100C] text-white pb-12">
      {/* Top bar */}
      <div className="sticky top-0 z-30 bg-[#2C1B17]/95 backdrop-blur border-b border-[#C9A227]/30 px-4 md:px-8 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[#C9A227] flex items-center justify-center">
            <Icon className="w-5 h-5 text-[#2C1B17]" />
          </div>
          <div>
            <h1 className="font-serif font-bold text-amber-100 leading-none">Fana Cafe — {meta.label}</h1>
            <p className="text-[10px] text-stone-400">{meta.desc} • {staffName}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={enableAlerts}
            className={`text-[10px] font-black px-3 py-1.5 rounded-full flex items-center gap-1.5 transition ${
              alertsOn ? "bg-emerald-600 text-white" : "bg-[#C9A227] text-[#2C1B17] animate-pulse"
            }`}
          >
            <BellRing className="w-3.5 h-3.5" />
            {alertsOn ? "ON" : "🔔 ENABLE"}
          </button>
          <button onClick={load} className="p-2 rounded-xl bg-white/10 text-amber-200" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={logout} className="p-2 rounded-xl bg-rose-600/80 text-white" title="Logout">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* counters */}
      <div className="max-w-4xl mx-auto px-4 md:px-6 pt-6 grid grid-cols-3 gap-3 text-center">
        <div className="bg-violet-950/60 border border-violet-700 rounded-2xl p-3.5">
          <p className="text-[10px] font-extrabold uppercase text-violet-300">New Incoming</p>
          <p className="font-serif font-black text-2xl text-white">{pendingCount}</p>
        </div>
        <div className="bg-amber-950/60 border border-amber-700 rounded-2xl p-3.5">
          <p className="text-[10px] font-extrabold uppercase text-amber-300">Started (Accepted)</p>
          <p className="font-serif font-black text-2xl text-white">{acceptedCount}</p>
        </div>
        <div className="bg-[#2C1B17] border border-stone-700 rounded-2xl p-3.5">
          <p className="text-[10px] font-extrabold uppercase text-stone-400">Open Tables</p>
          <p className="font-serif font-black text-2xl text-white">{tickets.length}</p>
        </div>
      </div>

      {/* tickets cards */}
      <div className="max-w-4xl mx-auto px-4 md:px-6 mt-5 space-y-4">
        {tickets.length === 0 ? (
          <div className="bg-[#2C1B17] border border-stone-800 rounded-2xl p-10 text-center text-stone-500 text-xs">
            All clear — no incoming items for the {meta.label} right now. New orders appear here instantly when the cashier accepts them.
          </div>
        ) : (
          tickets.map((t) => (
            <div key={t.id} className="bg-[#2C1B17] border border-[#C9A227]/30 rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-serif font-bold text-lg text-amber-100">
                    {t.tableName}
                    {t.orderNumber && (
                      <span className="ml-2 align-middle text-[10px] font-black bg-stone-800 border border-[#C9A227]/40 text-[#C9A227] px-2 py-0.5 rounded-full">
                        Order #{t.orderNumber}
                      </span>
                    )}
                  </p>
                  <p className="text-[10px] text-stone-500 flex items-center gap-1.5 uppercase font-bold">
                    <Clock className="w-3 h-3 text-[#C9A227]" /> {t.status.replace(/_/g, " ")}
                  </p>
                  <p className="text-[11px] text-[#C9A227] mt-0.5 font-semibold">
                    👤 Ordered by {t.createdBy || "—"}
                    {t.confirmedBy ? ` • Confirmed by ${t.confirmedBy}` : ""}
                  </p>
                </div>
                <span className="text-[10px] font-black px-2.5 py-1 rounded-full uppercase bg-[#C9A227]/20 text-[#C9A227]">
                  {t.items.length} item(s) for you
                </span>
              </div>

              <div className="space-y-2 divide-y divide-stone-800">
                {t.items.map((i) => (
                  <div
                    key={i.id}
                    className={`pt-2 flex items-center justify-between gap-3 text-xs ${
                      i.stationStatus === "done" ? "opacity-50" : ""
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className={`font-bold ${i.stationStatus === "done" ? "text-stone-500 line-through" : "text-amber-100"}`}>
                        {i.name} <span className="text-[#C9A227]">x{i.quantity}</span>
                      </p>
                      {i.notes && (
                        <p className={`text-sm font-semibold mt-1 px-2 py-1 rounded-lg bg-amber-950/50 border border-amber-700/40 ${i.stationStatus === "done" ? "text-stone-500 line-through" : "text-amber-200"}`}>
                          📝 {i.notes}
                        </p>
                      )}
                    </div>
                    {i.stationStatus === "pending" && (
                      <button
                        onClick={() => setStatus(i, "accepted")}
                        className="shrink-0 px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-black uppercase transition"
                      >
                        Accept ✓
                      </button>
                    )}
                    {i.stationStatus === "accepted" && (
                      <button
                        onClick={() => setStatus(i, "done")}
                        className="shrink-0 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black uppercase transition flex items-center gap-1"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" /> Done
                      </button>
                    )}
                    {i.stationStatus === "done" && (
                      <span className="shrink-0 text-[10px] font-black text-emerald-400 bg-emerald-950/60 px-2.5 py-1 rounded-full uppercase border border-emerald-700">
                        ✓ Done
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
