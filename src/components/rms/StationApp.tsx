"use client";

import { useState, useEffect, useRef } from "react";
import { Coffee, CookingPot, CupSoda, RefreshCw, LogOut, CheckCircle2, BellRing, Clock, History, X } from "lucide-react";
import { unlockAudio, playAlarm, playDing, setStationBell } from "@/lib/sound";
import { formatClock, formatDayMonthYear, minutesSince, waitingLabel } from "@/lib/order-lines";
import { triggerDesktopNotification } from "@/lib/notifications";
import { enablePocketAlerts } from "@/lib/push-client";
import PocketAlertsHint from "@/components/rms/PocketAlertsHint";
import PocketAlertsChip from "@/components/rms/PocketAlertsChip";
import { usePocketAlerts } from "@/lib/use-pocket-alerts";
import Link from "next/link";
import { phrase, useStaffT, tNow } from "@/lib/staff-i18n";
import StaffLangToggle from "@/components/rms/StaffLangToggle";

type Station = "barista" | "kitchen" | "juice";

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
  /** WHO last pressed Accept/Done on this line (crew-action audit). */
  stationStatusBy?: string | null;
  /** WHEN they pressed it (crew-action audit). */
  stationStatusAt?: string | null;
  /** When THIS line arrived — a later "2 Tea" is newer work than the first one. */
  createdAt?: string | null;
}

interface StationTicket {
  id: number;
  tableName: string;
  orderNumber?: string | null;
  orderType?: string | null;
  serviceNote?: string | null;
  status: string;
  createdBy?: string | null;
  confirmedBy?: string | null;
  /** Group 8: when the order arrived + the guest's "bring the bill" request. */
  createdAt?: string | null;
  updatedAt?: string | null;
  receiptRequestedAt?: string | null;
  items: StationItem[];
}

/**
 * One order in "Today's History" — every line this crew RECEIVED today, from
 * bills that are still open or already cleared. `releasedAt` is when the work
 * reached them (the send, or the moment an addition landed), which is also
 * the day the history list groups by.
 */
interface HistoryTicket {
  id: number;
  tableName: string;
  orderNumber?: string | null;
  orderType?: string | null;
  serviceNote?: string | null;
  status: string;
  createdBy?: string | null;
  confirmedBy?: string | null;
  createdAt?: string | null;
  closedAt?: string | null;
  printedAt?: string | null;
  confirmedAt?: string | null;
  releasedAt?: string | null;
  items: Array<{
    id: number;
    name: string;
    quantity: number;
    notes?: string | null;
    stationStatus: string;
    stationStatusBy?: string | null;
    stationStatusAt?: string | null;
    createdAt?: string | null;
  }>;
}

const STATION_META = {
  barista: { label: phrase("Barista"), icon: Coffee, color: "amber", slug: "barista" as Station, desc: phrase("Machine coffee & cold beverages") },
  kitchen: { label: phrase("Kitchen (Chef)"), icon: CookingPot, color: "emerald", slug: "kitchen" as Station, desc: phrase("Foods, pastries, meals & snacks") },
  juice: { label: phrase("Juice Maker"), icon: CupSoda, color: "lime", slug: "juice" as Station, desc: phrase("Fresh juices, spris & punches") },
};

export default function StationApp({ station }: { station: Station }) {
  const { t: L, rich: Lr, td: Ld } = useStaffT();
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

  // ── TODAY'S HISTORY ──
  // The crew's own archive: every order they received today (open or already
  // cleared), exactly like the cashier's "Printed Today" pile but only THEIR
  // items. This replaces the old "Open Tables" counter — the crew asked for
  // their day's work, not the table count.
  const [showHistory, setShowHistory] = useState(false);
  const [salesPeriod, setSalesPeriod] = useState("today");
  const [salesMode, setSalesMode] = useState<"accepted" | "done" | "combined">("done");
  const [sales, setSales] = useState<Record<string, Array<{name: string; quantity: number; amount: number; bills: number}>>>({});
  const [salesLoading, setSalesLoading] = useState(false);
  const loadSales = async (period: string) => {
    setSalesLoading(true);
    try {
      const r = await fetch(`/api/station-sales?period=${period}`, { cache: "no-store" });
      if (r.ok) setSales(await r.json());
    } finally { setSalesLoading(false); }
  };
  const [historyTickets, setHistoryTickets] = useState<HistoryTicket[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyLoadRef = useRef<() => void>(() => {});

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const r = await fetch(`/api/station-items?station=${station}&history=1`);
      if (r.status === 401) return expireSession();
      if (r.ok) setHistoryTickets(await r.json());
    } catch {
      /* a failed history load keeps the previous list */
    } finally {
      setHistoryLoading(false);
    }
  };

  const openHistory = () => {
    setShowHistory(true);
    loadSales(salesPeriod);
  };

  // THIS PAGE'S ALARM SOUND (owner's decision, Sept 2026): the juice bar
  // stands next to the kitchen and the one shared alarm made the crews
  // answer each other's calls. Every alarm path on this page (new items,
  // stop-work, the pocket push relay, the test button) now follows this
  // page's own sound: the kitchen keeps the original counter bell, the
  // juice bar gets a completely different electronic two-tone "ba-doo"
  // beep with the same 6-pair pattern and the same volume. See sound.ts.
  // Each screen is its own tab (its own copy of the sound module), so the
  // two sounds can never leak into each other.
  useEffect(() => {
    setStationBell(station === "juice" ? "juice" : "kitchen");
  }, [station]);

  // Refs follow the latest render from an effect (never during render).
  useEffect(() => {
    alertsOnRef.current = alertsOn;
  }, [alertsOn]);
  // Ticks every 30s so the "waiting N min" badge on each ticket stays honest
  // even when no new order arrives to trigger a refresh.
  const [now, setNow] = useState(() => Date.now());
  const pendingSeenRef = useRef<Set<number>>(new Set());
  // EVERY ROLE EVENT RINGS: the crew also has to hear when a line they are
  // cooking is REMOVED or its quantity is corrected, and when an order they
  // were STILL WORKING ON disappears (cancelled, or cleared mid-prep). A
  // ticket that leaves the list with all of their items already DONE is not
  // an event for them — it only updates the screen (see `closedQuiet`).
  /** Item id -> what the crew last saw for that line. */
  const itemSigRef = useRef<
    Map<number, { quantity: number; name: string; ticketId: number; tableName: string; stationStatus: string }>
  >(new Map());
  /** Ticket id -> table name, so a vanished order can still be named. */
  const ticketNameRef = useRef<Map<number, string>>(new Map());
  // NEW marker on a row that already existed: when a waiter adds more of the
  // same pending line, the DB folds it into that line and only the quantity
  // grows. Keep the +N here until the crew accepts it, so they can see "this
  // existing row got new work" instead of mistaking it for an old quantity.
  const newPendingBadgesRef = useRef<Record<number, number>>({});
  const [newPendingBadges, setNewPendingBadges] = useState<Record<number, number>>({});
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
      setLoginError(tNow("Wrong name or PIN. Ask admin for your {label} PIN.", { label: tNow(meta.label) }));
    }
  };

  const logout = () => {
    sessionStorage.removeItem(`fana_${station}`);
    fetch("/api/staff/login", { method: "DELETE" }).catch(() => {});
    setStaffName("");
    setPin("");
  };

  // The staff cookie lives 12 hours (one shift). When it dies mid-service the
  // API answers 401 — going back to the login screen WITH an explanation beats
  // a silently frozen list showing yesterday's orders as today's work.
  const expireSession = () => {
    try {
      sessionStorage.removeItem(`fana_${station}`);
    } catch {}
    setPin("");
    setLoginError(tNow("Your session ended. Log in again to keep receiving orders."));
    setStaffName("");
  };

  const load = async () => {
    // GROUP 10 FIX: used to skip while the tab was hidden — but the kitchen
    // tablet dims its screen! SSE messages only arrive on change, so always
    // process them: the alarm rings even with a dimmed screen.
    const r = await fetch(`/api/station-items?station=${station}`);
    if (r.status === 401) return expireSession();
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
    const nextNewPendingBadges: Record<number, number> = { ...newPendingBadgesRef.current };
    // TABLE CLEARED / BILL PAID IS NOT AN ALARM (owner's decision, Sept 2026).
    // A ticket leaves this list the moment a waiter clears the table or marks
    // it paid, and the crew used to get a full "stop preparing" alarm for it
    // even when every one of their dishes was already DONE — pure noise, tens
    // of times a day. Now: the last snapshot tells us how much UNFINISHED work
    // (pending / accepted) that ticket still had. All done → silent, the card
    // just disappears. Still cooking → the alarm stands, because for them it
    // really is money burning. (A CANCELLATION is unaffected: it also pushes
    // ⛔ ORDER CANCELLED from the server, so it rings either way.)
    /** Ticket id -> unfinished lines as of the PREVIOUS load. */
    const prevOpenWork = new Map<number, number>();
    for (const seen of itemSigRef.current.values()) {
      if (seen.stationStatus !== "done") {
        prevOpenWork.set(seen.ticketId, (prevOpenWork.get(seen.ticketId) || 0) + 1);
      }
    }
    const closedQuiet: string[] = [];
    for (const t of data) {
      ticketNameRef.current.set(t.id, t.tableName);
      for (const i of t.items) {
        liveIds.add(i.id);
        const prev = itemSigRef.current.get(i.id);
        itemSigRef.current.set(i.id, {
          quantity: i.quantity,
          name: i.name,
          ticketId: t.id,
          tableName: t.tableName,
          stationStatus: i.stationStatus,
        });
        if (i.stationStatus !== "pending") {
          delete nextNewPendingBadges[i.id];
        } else if (initRef.current) {
          if (prev === undefined) {
            nextNewPendingBadges[i.id] = Math.max(nextNewPendingBadges[i.id] || 0, Number(i.quantity) || 0);
          } else if (i.quantity > prev.quantity) {
            nextNewPendingBadges[i.id] = (nextNewPendingBadges[i.id] || 0) + (i.quantity - prev.quantity);
          }
        }
        if (initRef.current && prev !== undefined && prev.quantity !== i.quantity) {
          changed.push({ tableName: t.tableName, name: i.name, from: prev.quantity, to: i.quantity });
        }
      }
    }
    const nowTicketIds = new Set(data.map((t) => t.id));
    for (const [id, seen] of [...itemSigRef.current.entries()]) {
      if (liveIds.has(id)) continue;
      itemSigRef.current.delete(id);
      delete nextNewPendingBadges[id];
      // The line disappeared while its bill is still open => it was removed.
      // (A bill that left the list entirely is reported once, below.)
      if (initRef.current && nowTicketIds.has(seen.ticketId)) {
        removed.push({ tableName: seen.tableName, name: seen.name });
      }
    }
    for (const [id, name] of [...ticketNameRef.current.entries()]) {
      if (nowTicketIds.has(id)) continue;
      ticketNameRef.current.delete(id);
      if (!initRef.current) continue;
      // Only a ticket with work still on the fire is worth an alarm.
      if ((prevOpenWork.get(id) || 0) > 0) gone.push(name);
      else closedQuiet.push(name);
    }

    if (initRef.current && alertsOnRef.current && (changed.length > 0 || removed.length > 0 || gone.length > 0)) {
      // Stop-work news: a removal or a cancelled order is urgent (the pan is
      // already on the fire), a quantity correction is a short ring.
      if (removed.length > 0 || gone.length > 0) playAlarm();
      else playDing();
      const message =
        removed.length > 0
          ? tNow("✗ {tableName}: {name} was REMOVED, do not prepare it", { tableName: removed[0].tableName, name: removed[0].name })
          : gone.length > 0
            ? tNow("⛔ {tableName}: order closed or cancelled, stop preparing", { tableName: gone[0] })
            : tNow("✎ {tableName}: {name} quantity {from} to {to}", { tableName: changed[0].tableName, name: changed[0].name, from: changed[0].from, to: changed[0].to });
      triggerDesktopNotification({
        title: tNow("Fana Cafe • {label} update", { label: tNow(meta.label) }),
        message,
        tag: `fana-station-change-${Date.now()}`,
      });
      showToast(message);
    }

    // The screen still tells the truth about a table that was cleared or paid
    // — it just does not make a sound or buzz the phone for it.
    if (
      initRef.current &&
      closedQuiet.length > 0 &&
      removed.length === 0 &&
      gone.length === 0 &&
      changed.length === 0
    ) {
      const tableName = closedQuiet[0];
      showToast(tNow("✓ {tableName}: bill closed • all your items were done", { tableName }));
    }

    if (initRef.current && alertsOnRef.current && fresh.length > 0) {
      // New food to cook = the crew must ACT → full alarm, not a gentle ding.
      playAlarm();
      // find table info for popup
      for (const t of data) for (const i of t.items) {
        if (fresh.includes(i.id)) {
          triggerDesktopNotification({
            title: tNow("Fana Cafe • {label} Alert", { label: tNow(meta.label) }),
            message: tNow("New item at {tableName}: {name} x{quantity}{value}", { tableName: t.tableName, name: i.name, quantity: i.quantity, value: i.notes ? tNow(" • note: {note}", { note: i.notes }) : "" }),
          });
          break;
        }
      }
    }
    newPendingBadgesRef.current = nextNewPendingBadges;
    setNewPendingBadges(nextNewPendingBadges);
    initRef.current = true;

    setTickets(data);
  };

  useEffect(() => {
    loadRef.current = load;
    historyLoadRef.current = loadHistory;
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
      <div className="relative min-h-screen bg-[#1C120F] flex items-center justify-center p-4 text-white">
        <StaffLangToggle compact className="absolute top-3 right-3" />
        <div className="bg-[#2C1B17] border border-[#C9A227]/40 rounded-3xl p-8 w-full max-w-sm space-y-6 shadow-2xl">
          <div className="text-center space-y-2">
            <div className="w-14 h-14 rounded-2xl bg-[#C9A227] text-[#2C1B17] flex items-center justify-center mx-auto">
              <Icon className="w-7 h-7" />
            </div>
            <h1 className="font-serif text-2xl font-bold text-amber-100">{L("{label} Login", { label: L(meta.label) })}</h1>
            <p className="text-xs text-stone-400">{L(meta.desc)}</p>
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
              <option value="">{L("Select your name...")}</option>
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
              {L("Login as {label}", { label: L(meta.label) })}
            </button>
            <Link href="/" className="block text-center text-xs text-[#C9A227] hover:underline">{L("← Back to public website")}</Link>
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
            <h1 className="font-serif font-bold text-amber-100 leading-none">{L("Fana Cafe • {label}", { label: L(meta.label) })}</h1>
            <p className="text-[10px] text-stone-400">{L(meta.desc)} • {staffName}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <PocketAlertsChip
            status={pocket.status}
            busy={pocket.busy}
            onArm={pocket.arm}
            onTest={pocket.test}
            onToast={showToast}
            notificationsEnabled={pocket.notificationsEnabled}
            onSetNotificationsEnabled={pocket.setNotificationsEnabled}
          />
          <button
            onClick={enableAlerts}
            className={`text-[10px] font-black px-3 py-1.5 rounded-full flex items-center gap-1.5 transition ${
              alertsOn ? "bg-emerald-600 text-white" : "bg-[#C9A227] text-[#2C1B17] animate-pulse"
            }`}
          >
            <BellRing className="w-3.5 h-3.5" />
            {alertsOn ? L("ON") : L("🔔 ENABLE")}
          </button>
          <StaffLangToggle compact />
          <button onClick={load} className="p-2 rounded-xl bg-white/10 text-amber-200" title={L("Refresh")}>
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={logout} className="p-2 rounded-xl bg-rose-600/80 text-white" title={L("Logout")}>
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

      {/* counters + the crew's own history button (owner's decision, Sept 2026:
          the crew asked for their day's work, not the table count) */}
      <div className="max-w-4xl mx-auto px-4 md:px-6 pt-6 grid grid-cols-3 gap-3 text-center">
        <div className="bg-violet-950/60 border border-violet-700 rounded-2xl p-3.5">
          <p className="text-[10px] font-extrabold uppercase text-violet-300">{L("New Incoming")}</p>
          <p className="font-serif font-black text-2xl text-white">{pendingCount}</p>
        </div>
        <div className="bg-amber-950/60 border border-amber-700 rounded-2xl p-3.5">
          <p className="text-[10px] font-extrabold uppercase text-amber-300">{L("Started (Accepted)")}</p>
          <p className="font-serif font-black text-2xl text-white">{acceptedCount}</p>
        </div>
        <button
          onClick={openHistory}
          className="bg-[#2C1B17] border border-[#C9A227]/50 hover:border-[#C9A227] hover:bg-[#3D2314] rounded-2xl p-3.5 transition flex flex-col items-center justify-center gap-1"
          title={L("Every order you received today, open or already cleared")}
        >
          <History className="w-5 h-5 text-[#C9A227]" />
          <p className="text-[10px] font-extrabold uppercase text-amber-200">{L("Items sold")}</p>
        </button>
      </div>

      {/* tickets cards */}
      <div className="max-w-4xl mx-auto px-4 md:px-6 mt-5 space-y-4">
        {tickets.length === 0 ? (
          <div className="bg-[#2C1B17] border border-stone-800 rounded-2xl p-10 text-center text-stone-500 text-xs">
            {L("All clear • no incoming items for the {label} right now. New orders and added items appear here instantly when they are sent.", { label: L(meta.label) })}
          </div>
        ) : (
          tickets.map((t) => (
            <div key={t.id} className="bg-[#2C1B17] border border-[#C9A227]/30 rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-serif font-bold text-lg text-amber-100">{t.tableName}</p>
                    {t.orderNumber && (
                      <span className="align-middle text-[10px] font-black bg-stone-800 border border-[#C9A227]/40 text-[#C9A227] px-2 py-0.5 rounded-full">
                        {L("Order #{orderNumber}", { orderNumber: t.orderNumber })}
                      </span>
                    )}
                    {t.orderType === "outdoor" && (
                      <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300 border border-violet-500/40">
                        {L("Outdoor")}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-stone-300 flex items-center gap-1.5 uppercase font-black">
                    <Clock className="w-3.5 h-3.5 text-[#C9A227]" /> {t.status.replace(/_/g, " ")}
                  </p>
                  {/* ARRIVAL TIME — the crew's first question: when did this land,
                      and how long has the table been waiting? */}
                  <p className="mt-1 flex items-center gap-1.5 flex-wrap text-sm font-black text-amber-200">
                    <Clock className="w-4 h-4 text-[#C9A227]" />
                    {Lr("Arrived {clock}<s>{dayMonthYear}</s><s2>waiting {waitingLabel}</s2>", { s: (s) => <span className="text-[11px] font-bold text-stone-300">{s}</span>, s2: (s) => <span
                      className={`text-[11px] font-black uppercase px-2 py-0.5 rounded-full ${
                        minutesSince(t.createdAt, now) >= 10
                          ? "bg-rose-600 text-white"
                          : "bg-stone-800 text-stone-200"
                      }`}
                    >{s}</span> }, { clock: formatClock(t.createdAt), dayMonthYear: formatDayMonthYear(t.createdAt), waitingLabel: Ld(waitingLabel(t.createdAt, now)) })}
                  </p>
                  <p className="text-xs text-[#D8B93E] mt-0.5 font-black">
                    {L("👤 Ordered by")} {t.createdBy || L("staff")}
                    {t.confirmedBy ? L(" • Confirmed by {confirmedBy}", { confirmedBy: t.confirmedBy }) : ""}
                  </p>
                  {t.serviceNote && <p className="text-[11px] font-bold text-sky-300 mt-0.5">📍 {t.serviceNote}</p>}
                  {t.receiptRequestedAt && (
                    <p className="mt-1 inline-block text-[11px] font-black text-emerald-300 bg-emerald-950/60 border border-emerald-700 rounded-lg px-2 py-1">
                      {L("🧾 Table asked for the bill at {clock}", { clock: formatClock(t.receiptRequestedAt) })}
                    </p>
                  )}
                </div>
                <span className="text-[10px] font-black px-2.5 py-1 rounded-full uppercase bg-[#C9A227]/20 text-[#C9A227]">
                  {L("{length} item(s) for you", { length: t.items.length })}
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
                      <p className={`font-bold flex flex-wrap items-center gap-2 ${i.stationStatus === "done" ? "text-stone-500 line-through" : "text-amber-100"}`}>
                        <span>
                          {i.name} <span className="text-[#C9A227]">x{i.quantity}</span>
                        </span>
                        {i.stationStatus === "pending" && (newPendingBadges[i.id] || 0) > 0 && (
                          <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-amber-400 text-black border border-amber-200">
                            {(newPendingBadges[i.id] || 0) > 1 ? L("NEW +{newPendingBadges}", { newPendingBadges: newPendingBadges[i.id] }) : L("NEW")}
                          </span>
                        )}
                      </p>
                      {i.createdAt && (
                        <p className="text-[11px] font-bold text-stone-300 mt-0.5">
                          {L("🕒 {clock} • waiting {waitingLabel}", { clock: formatClock(i.createdAt), waitingLabel: Ld(waitingLabel(i.createdAt, now)) })}
                        </p>
                      )}
                      {i.notes && (
                        <p className={`text-sm font-semibold mt-1 px-2 py-1 rounded-lg bg-amber-950/50 border border-amber-700/40 ${i.stationStatus === "done" ? "text-stone-500 line-through" : "text-amber-200"}`}>
                          📝 {i.notes}
                        </p>
                      )}
                      {/* WHO pressed it: a "done" nobody remembers is always
                          traceable to a person and a minute, never a mystery. */}
                      {(i.stationStatus === "done" || i.stationStatus === "accepted") && i.stationStatusBy && (
                        <p className="text-[11px] font-bold text-stone-400 mt-0.5">
                          {i.stationStatus === "done" ? L("✓ Done") : L("▶ Started")} {L("by {stationStatusBy}{value}", { stationStatusBy: i.stationStatusBy, value: i.stationStatusAt ? ` • ${formatClock(i.stationStatusAt)}` : "" })}
                        </p>
                      )}
                    </div>
                    {i.stationStatus === "pending" && (
                      <button
                        onClick={() => setStatus(i, "accepted")}
                        className="shrink-0 px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-black uppercase transition"
                      >
                        {L("Accept ✓")}
                      </button>
                    )}
                    {i.stationStatus === "accepted" && (
                      <button
                        onClick={() => setStatus(i, "done")}
                        className="shrink-0 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black uppercase transition flex items-center gap-1"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" /> {L("Done")}
                      </button>
                    )}
                    {i.stationStatus === "done" && (
                      <span className="shrink-0 text-[10px] font-black text-emerald-400 bg-emerald-950/60 px-2.5 py-1 rounded-full uppercase border border-emerald-700">
                        {L("✓ Done")}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {showHistory && <div className="fixed inset-0 z-40 bg-[#14100C] overflow-y-auto p-4 md:p-8 text-stone-100">
        <div className="max-w-3xl mx-auto space-y-5">
          <div className="flex items-center justify-between"><h2 className="text-xl font-black text-amber-200">{L("Items sold • {name}", { name: staffName })}</h2><button onClick={() => setShowHistory(false)} aria-label={L("Close")}><X /></button></div>
          <div className="flex flex-wrap gap-2">{[["today","Today"],["yesterday","Yesterday"],["dayBefore","Day Before Yesterday"],["week","Last 7 Days"]].map(([key,label]) => <button key={key} onClick={() => { setSalesPeriod(key); loadSales(key); }} className={`rounded-xl px-3 py-2 text-xs font-bold ${salesPeriod === key ? "bg-amber-500 text-black" : "bg-stone-800"}`}>{label}</button>)}</div>
          <div className="flex gap-2">{(["accepted","done","combined"] as const).map(mode => <button key={mode} onClick={() => setSalesMode(mode)} className={`rounded-xl px-3 py-2 text-xs font-bold capitalize ${salesMode === mode ? "bg-emerald-600" : "bg-stone-800"}`}>{mode}</button>)}<button onClick={() => loadSales(salesPeriod)} aria-label={L("Refresh sales")}><RefreshCw className={salesLoading ? "animate-spin" : ""} /></button></div>
          <p className="text-xs text-stone-400">{L("Accepted and Done count your own taps. Combined shows lines you accepted that someone else finished; it overlaps Accepted.")}</p>
          <div className="rounded-2xl border border-amber-700 bg-[#2C1B17] p-4">
            <h3 className="font-black text-amber-200">{L("{mode} • ITEMS SOLD", { mode: salesMode.toUpperCase() })}</h3>
            <p className="text-sm mt-1">{L("{n} items • {amount}", { n: (sales[salesMode] || []).reduce((n,r) => n+r.quantity,0), amount: `${(sales[salesMode] || []).reduce((n,r) => n+r.amount,0).toLocaleString()} ETB` })}</p>
            <div className="max-h-[55vh] overflow-y-auto mt-3 space-y-1">{(sales[salesMode] || []).map(r => <div key={r.name} className="flex justify-between gap-3 border-b border-stone-700 py-2 text-sm"><span>{r.name} ×{r.quantity}</span><span>{r.amount.toLocaleString()} ETB</span></div>)}{!salesLoading && !sales[salesMode]?.length && <p className="text-stone-400">{L("No items for this selection.")}</p>}</div>
          </div>
        </div>
      </div>}

      {/* ═══ TODAY'S HISTORY — the crew's archive of today's work ═══
          Every order this crew RECEIVED today (open or already cleared), the
          same idea as the cashier's "Printed Today" pile but only their items:
          the paper stack they used to keep next to the station. */}
      {false && showHistory && (
        <div className="fixed inset-0 z-40 bg-[#14100C] overflow-y-auto">
          <div className="sticky top-0 z-10 bg-[#2C1B17]/95 backdrop-blur border-b border-[#C9A227]/30 px-4 md:px-8 py-3.5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowHistory(false)}
                className="p-2 rounded-xl bg-white/10 text-amber-200 hover:bg-white/20"
                title={L("Back to the live list")}
              >
                <X className="w-4 h-4" />
              </button>
              <div>
                <h1 className="font-serif font-bold text-amber-100 leading-none">{L("Today’s History • {label}", { label: L(meta.label) })}</h1>
                <p className="text-[10px] text-stone-400">{L("Every order you received today, open or already cleared")}</p>
              </div>
            </div>
            <button onClick={loadHistory} className="p-2 rounded-xl bg-white/10 text-amber-200 hover:bg-white/20" title={L("Refresh")}>
              <RefreshCw className={`w-4 h-4 ${historyLoading ? "animate-spin" : ""}`} />
            </button>
          </div>

          <div className="max-w-4xl mx-auto px-4 md:px-6 pt-5 pb-12">
            {/* day summary */}
            <div className="grid grid-cols-3 gap-3 text-center mb-5">
              <div className="bg-[#2C1B17] border border-stone-700 rounded-2xl p-3.5">
                <p className="text-[10px] font-extrabold uppercase text-stone-400">{L("Orders today")}</p>
                <p className="font-serif font-black text-2xl text-white">{historyTickets.length}</p>
              </div>
              <div className="bg-amber-950/60 border border-amber-700 rounded-2xl p-3.5">
                <p className="text-[10px] font-extrabold uppercase text-amber-300">{L("Items made / to make")}</p>
                <p className="font-serif font-black text-2xl text-white">
                  {historyTickets.reduce((s, t) => s + t.items.reduce((x, i) => x + i.quantity, 0), 0)}
                </p>
              </div>
              <div className="bg-emerald-950/60 border border-emerald-700 rounded-2xl p-3.5">
                <p className="text-[10px] font-extrabold uppercase text-emerald-300">{L("Lines done")}</p>
                <p className="font-serif font-black text-2xl text-white">
                  {historyTickets.reduce((s, t) => s + t.items.filter((i) => i.stationStatus === "done").length, 0)}
                  <span className="text-sm text-stone-400">
                    /{historyTickets.reduce((s, t) => s + t.items.length, 0)}
                  </span>
                </p>
              </div>
            </div>

            {historyLoading && historyTickets.length === 0 ? (
              <div className="bg-[#2C1B17] border border-stone-800 rounded-2xl p-10 text-center text-stone-500 text-xs">
                {L("Loading today’s orders...")}
              </div>
            ) : historyTickets.length === 0 ? (
              <div className="bg-[#2C1B17] border border-stone-800 rounded-2xl p-10 text-center text-stone-500 text-xs">
                {L("Nothing yet today. Orders appear here the moment you receive them.")}
              </div>
            ) : (
              <div className="space-y-4">
                {historyTickets.map((t) => {
                  const doneCount = t.items.filter((i) => i.stationStatus === "done").length;
                  const stamp = t.releasedAt || t.createdAt;
                  return (
                    <div key={t.id} className="bg-[#2C1B17] border border-[#C9A227]/30 rounded-2xl p-4 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-serif font-bold text-lg text-amber-100">{t.tableName}</p>
                            {t.orderNumber && (
                              <span className="align-middle text-[10px] font-black bg-stone-800 border border-[#C9A227]/40 text-[#C9A227] px-2 py-0.5 rounded-full">
                                {L("Order #{orderNumber}", { orderNumber: t.orderNumber })}
                              </span>
                            )}
                            {t.orderType === "outdoor" && (
                              <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300 border border-violet-500/40">
                                {L("Outdoor")}
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] font-bold text-stone-300 mt-0.5">
                            {L("🕒 received {clock} • {dayMonthYear}", { clock: formatClock(stamp), dayMonthYear: formatDayMonthYear(stamp) })}
                          </p>
                          <p className="text-xs text-[#D8B93E] font-black truncate">
                            👤 {t.confirmedBy || t.createdBy || L("staff")}
                          </p>
                          {t.serviceNote && <p className="text-[11px] font-bold text-sky-300 truncate">📍 {t.serviceNote}</p>}
                        </div>
                        <div className="text-right shrink-0 space-y-1">
                          <span
                            className={`inline-block text-[10px] font-black px-2.5 py-1 rounded-full uppercase ${
                              t.status === "closed"
                                ? "bg-stone-800 text-stone-300"
                                : t.status === "printed"
                                ? "bg-amber-900/60 text-amber-300 border border-amber-700"
                                : "bg-emerald-900/60 text-emerald-300 border border-emerald-700"
                            }`}
                          >
                            {t.status === "closed" ? L("✓ cleared") : t.status === "printed" ? L("🖨 printed") : t.status.replace(/_/g, " ")}
                          </span>
                          <p className="text-[10px] font-black text-emerald-400">
                            {L("{doneCount}/{length} done", { doneCount, length: t.items.length })}
                          </p>
                        </div>
                      </div>
                      <div className="divide-y divide-stone-800">
                        {t.items.map((i) => (
                          <div key={i.id} className="py-2 flex items-center justify-between gap-3 text-xs">
                            <div className="flex-1 min-w-0">
                              <p className={`font-bold ${i.stationStatus === "done" ? "text-stone-500 line-through" : "text-amber-100"}`}>
                                {i.name} <span className="text-[#C9A227]">x{i.quantity}</span>
                              </p>
                              {i.notes && <p className="text-[11px] text-amber-200/80 italic mt-0.5">📝 {i.notes}</p>}
                              {(i.stationStatus === "done" || i.stationStatus === "accepted") && i.stationStatusBy && (
                                <p className="text-[11px] font-bold text-stone-400 mt-0.5">
                                  {i.stationStatus === "done" ? L("✓ Done") : L("▶ Started")} {L("by {stationStatusBy}{value}", { stationStatusBy: i.stationStatusBy, value: i.stationStatusAt ? ` • ${formatClock(i.stationStatusAt)}` : "" })}
                                </p>
                              )}
                            </div>
                            {i.stationStatus === "done" ? (
                              <span className="shrink-0 text-[10px] font-black text-emerald-400 bg-emerald-950/60 px-2.5 py-1 rounded-full uppercase border border-emerald-700">
                                {L("✓ Done")}
                              </span>
                            ) : i.stationStatus === "accepted" ? (
                              <span className="shrink-0 text-[10px] font-black text-amber-300 bg-amber-950/60 px-2.5 py-1 rounded-full uppercase border border-amber-700">
                                {L("Started")}
                              </span>
                            ) : (
                              <span className="shrink-0 text-[10px] font-black text-violet-300 bg-violet-950/60 px-2.5 py-1 rounded-full uppercase border border-violet-700">
                                {L("New")}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
