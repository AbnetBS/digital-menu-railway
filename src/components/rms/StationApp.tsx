"use client";

import { useState, useEffect, useRef } from "react";
import { Coffee, CookingPot, RefreshCw, LogOut, CheckCircle2, BellRing, Clock } from "lucide-react";
import { unlockAudio, playAlarm, playDing } from "@/lib/sound";
import { formatClock, formatDayMonthYear, minutesSince, waitingLabel } from "@/lib/order-lines";
import { triggerDesktopNotification } from "@/lib/notifications";
import { enablePocketAlerts } from "@/lib/push-client";
import PocketAlertsHint from "@/components/rms/PocketAlertsHint";
import PocketAlertsChip from "@/components/rms/PocketAlertsChip";
import { usePocketAlerts } from "@/lib/use-pocket-alerts";
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
  /** When THIS line arrived — a later "2 Tea" is newer work than the first one. */
  createdAt?: string | null;
}

interface StationTicket {
  id: number;
  tableName: string;
  orderNumber?: string | null;
  status: string;
  createdBy?: string | null;
  confirmedBy?: string | null;
  /** Group 8: when the order arrived + the guest's "bring the bill" request. */
  createdAt?: string | null;
  updatedAt?: string | null;
  receiptRequestedAt?: string | null;
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
  // STALE-CLOSURE FIX: the SSE handler is created once (deps [staffName]) and
  // captured whatever `alertsOn` was then. Enabling alerts afterwards never
  // reached that copy, so the crew alarm stayed off. Reads go through the ref.
  const alertsOnRef = useRef(false);
  const [toast, setToast] = useState("");
  // Always points at the CURRENT load() for the SSE + push relays.
  const loadRef = useRef<() => void>(() => {});

  // Refs follow the latest render from an effect (never during render).
  useEffect(() => {
    alertsOnRef.current = alertsOn;
  }, [alertsOn]);
  // Ticks every 30s so the "waiting N min" badge on each ticket stays honest
  // even when no new order arrives to trigger a refresh.
  const [now, setNow] = useState(() => Date.now());
  const pendingSeenRef = useRef<Set<number>>(new Set());
  // EVERY ROLE EVENT RINGS: the crew also has to hear when a line they are
  // cooking is REMOVED or its quantity is corrected, and when a whole order
  // disappears (cancelled or the table was cleared). Those changes used to be
  // completely silent, so food was cooked for a bill that no longer wanted it.
  /** Item id -> what the crew last saw for that line. */
  const itemSigRef = useRef<Map<number, { quantity: number; name: string; ticketId: number; tableName: string }>>(new Map());
  /** Ticket id -> table name, so a vanished order can still be named. */
  const ticketNameRef = useRef<Map<number, string>>(new Map());
  const initRef = useRef(false);

  useEffect(() => {
    const ticker = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(ticker);
  }, []);

  useEffect(() => {
    const saved = sessionStorage.getItem(`fana_${station}`);
    // A restored crew session means someone is on shift: alerts default to ON.
    const on = localStorage.getItem(`fana_alerts_${station}`) === "1" || !!saved;
    setAlertsOn(on);
    alertsOnRef.current = on;
    if (on) localStorage.setItem(`fana_alerts_${station}`, "1");
    if (saved) {
      const s = JSON.parse(saved);
      setStaffName(s.name);
    }
    fetch("/api/staff?public=1")
      .then((r) => r.json())
      .then((d) => setStaffList(d.filter((x: StaffLite) => x.role === station)))
      .catch(() => {});
  }, [station]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 4000);
  };

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
      // GROUP 10: the login tap is the gesture browsers need — unlock the loud
      // alarm AND arm pocket notifications for this crew tablet/phone.
      unlockAudio();
      localStorage.setItem(`fana_alerts_${station}`, "1");
      setAlertsOn(true);
      alertsOnRef.current = true;
      void enablePocketAlerts().then(() => pocket.refreshStatus());
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
    // GROUP 10 FIX: used to skip while the tab was hidden — but the kitchen
    // tablet dims its screen! SSE messages only arrive on change, so always
    // process them: the alarm rings even with a dimmed screen.
    const r = await fetch(`/api/station-items?station=${station}`);
    if (!r.ok) return;
    const data: StationTicket[] = await r.json();

    const nowPendingIds = new Set<number>();
    for (const t of data) for (const i of t.items) if (i.stationStatus === "pending") nowPendingIds.add(i.id);

    const fresh: number[] = [];
    for (const id of nowPendingIds) if (!pendingSeenRef.current.has(id)) fresh.push(id);
    fresh.forEach((id) => pendingSeenRef.current.add(id));

    // ── REMOVED / CHANGED / VANISHED WORK ──
    // A line the crew is cooking can be taken off the bill by the cashier, have
    // its quantity corrected, or vanish because the order was cancelled or the
    // table was cleared. All three used to be silent, so the pan kept going.
    const liveIds = new Set<number>();
    const changed: Array<{ tableName: string; name: string; from: number; to: number }> = [];
    const removed: Array<{ tableName: string; name: string }> = [];
    const gone: string[] = [];
    for (const t of data) {
      ticketNameRef.current.set(t.id, t.tableName);
      for (const i of t.items) {
        liveIds.add(i.id);
        const prev = itemSigRef.current.get(i.id);
        itemSigRef.current.set(i.id, { quantity: i.quantity, name: i.name, ticketId: t.id, tableName: t.tableName });
        if (initRef.current && prev !== undefined && prev.quantity !== i.quantity) {
          changed.push({ tableName: t.tableName, name: i.name, from: prev.quantity, to: i.quantity });
        }
      }
    }
    const nowTicketIds = new Set(data.map((t) => t.id));
    for (const [id, seen] of [...itemSigRef.current.entries()]) {
      if (liveIds.has(id)) continue;
      itemSigRef.current.delete(id);
      // The line disappeared while its bill is still open => it was removed.
      // (A bill that left the list entirely is reported once, below.)
      if (initRef.current && nowTicketIds.has(seen.ticketId)) {
        removed.push({ tableName: seen.tableName, name: seen.name });
      }
    }
    for (const [id, name] of [...ticketNameRef.current.entries()]) {
      if (nowTicketIds.has(id)) continue;
      ticketNameRef.current.delete(id);
      if (initRef.current) gone.push(name);
    }

    if (initRef.current && alertsOnRef.current && (changed.length > 0 || removed.length > 0 || gone.length > 0)) {
      // Stop-work news: a removal or a cancelled order is urgent (the pan is
      // already on the fire), a quantity correction is a short ring.
      if (removed.length > 0 || gone.length > 0) playAlarm();
      else playDing();
      const message =
        removed.length > 0
          ? `✗ ${removed[0].tableName}: ${removed[0].name} was REMOVED, do not prepare it`
          : gone.length > 0
            ? `⛔ ${gone[0]}: order closed or cancelled, stop preparing`
            : `✎ ${changed[0].tableName}: ${changed[0].name} quantity ${changed[0].from} to ${changed[0].to}`;
      triggerDesktopNotification({
        title: `Fana Cafe • ${meta.label} update`,
        message,
        tag: `fana-station-change-${Date.now()}`,
      });
      showToast(message);
    }

    if (initRef.current && alertsOnRef.current && fresh.length > 0) {
      // New food to cook = the crew must ACT → full alarm, not a gentle ding.
      playAlarm();
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
    loadRef.current = load;
  });

  // POCKET MODE: keeps this tablet/phone subscribed (self-healing) and rings
  // the loud alarm the moment a push lands, even if SSE was frozen.
  const pocket = usePocketAlerts({
    active: !!staffName,
    onAlert: () => loadRef.current(),
  });

  useEffect(() => {
    if (staffName) {
      load();
      // REALTIME (SSE): the server pushes a "refresh" signal only when an
      // order/item changes, instead of polling every 8s.
      //
      // WATCHDOG: a dimmed kitchen tablet gets its background tab throttled
      // and its socket dropped; EventSource does not always come back by
      // itself. Rebuild the stream whenever it is CLOSED so the crew never
      // sits in front of a frozen list.
      let es: EventSource | null = null;
      let stopped = false;

      const connect = () => {
        if (stopped) return;
        try {
          es?.close();
        } catch {
          /* ignore */
        }
        es = new EventSource("/api/realtime?channel=orders");
        es.onmessage = () => loadRef.current();
        es.onerror = () => loadRef.current();
      };

      connect();

      const revive = () => {
        if (stopped) return;
        if (!es || es.readyState === 2 /* CLOSED */) connect();
        loadRef.current();
      };
      const watchdog = setInterval(() => {
        if (!es || es.readyState === 2) connect();
      }, 30000);
      // Refresh immediately when the tab becomes visible again (user action).
      const onVisible = () => {
        if (!document.hidden) revive();
      };
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("online", revive);
      return () => {
        stopped = true;
        clearInterval(watchdog);
        es?.close();
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("online", revive);
      };
    }
  }, [staffName]);

  const enableAlerts = async () => {
    unlockAudio();
    if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission();
    localStorage.setItem(`fana_alerts_${station}`, "1");
    setAlertsOn(true);
    alertsOnRef.current = true;
    // (Re)arm pocket alerts + a sample ring so the crew knows it works.
    await enablePocketAlerts();
    void pocket.refreshStatus();
    playAlarm();
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
            <h1 className="font-serif font-bold text-amber-100 leading-none">Fana Cafe • {meta.label}</h1>
            <p className="text-[10px] text-stone-400">{meta.desc} • {staffName}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <PocketAlertsChip
            status={pocket.status}
            busy={pocket.busy}
            onArm={pocket.arm}
            onTest={pocket.test}
            onToast={showToast}
          />
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

      {/* Toast */}
      {toast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-emerald-600 text-white text-xs font-bold px-4 py-2.5 rounded-full shadow-2xl max-w-[90vw] text-center">
          {toast}
        </div>
      )}

      {/* iPhone pocket-mode instruction (Android needs nothing) */}
      <div className="max-w-4xl mx-auto px-4 md:px-6 pt-4">
        <PocketAlertsHint />
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
            All clear • no incoming items for the {meta.label} right now. New orders appear here instantly when the cashier accepts them.
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
                  <p className="text-[11px] text-stone-300 flex items-center gap-1.5 uppercase font-black">
                    <Clock className="w-3.5 h-3.5 text-[#C9A227]" /> {t.status.replace(/_/g, " ")}
                  </p>
                  {/* ARRIVAL TIME — the crew's first question: when did this land,
                      and how long has the table been waiting? */}
                  <p className="mt-1 flex items-center gap-1.5 flex-wrap text-sm font-black text-amber-200">
                    <Clock className="w-4 h-4 text-[#C9A227]" />
                    Arrived {formatClock(t.createdAt)}
                    <span className="text-[11px] font-bold text-stone-300">{formatDayMonthYear(t.createdAt)}</span>
                    <span
                      className={`text-[11px] font-black uppercase px-2 py-0.5 rounded-full ${
                        minutesSince(t.createdAt, now) >= 10
                          ? "bg-rose-600 text-white"
                          : "bg-stone-800 text-stone-200"
                      }`}
                    >
                      waiting {waitingLabel(t.createdAt, now)}
                    </span>
                  </p>
                  <p className="text-xs text-[#D8B93E] mt-0.5 font-black">
                    👤 Ordered by {t.createdBy || "staff"}
                    {t.confirmedBy ? ` • Confirmed by ${t.confirmedBy}` : ""}
                  </p>
                  {t.receiptRequestedAt && (
                    <p className="mt-1 inline-block text-[11px] font-black text-emerald-300 bg-emerald-950/60 border border-emerald-700 rounded-lg px-2 py-1">
                      🧾 Table asked for the bill at {formatClock(t.receiptRequestedAt)}
                    </p>
                  )}
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
                      {i.createdAt && (
                        <p className="text-[11px] font-bold text-stone-300 mt-0.5">
                          🕒 {formatClock(i.createdAt)} • waiting {waitingLabel(i.createdAt, now)}
                        </p>
                      )}
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
