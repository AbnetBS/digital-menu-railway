"use client";

import { useState, useEffect, useRef } from "react";
import {
  Coffee, RefreshCw, LogOut, BellRing, CheckCircle2, XCircle, CreditCard,
  Banknote, Smartphone, Users, Clock, Image as ImageIcon, Monitor,
} from "lucide-react";
import { Ticket, TicketItem, CafeTable, StaffUser } from "@/types";
import { triggerDesktopNotification } from "@/lib/notifications";
import { unlockAudio, playDing } from "@/lib/sound";

interface StaffLite {
  id: number;
  name: string;
  role: string;
}

export default function CashierDashboard() {
  const [staffName, setStaffName] = useState("");
  const [staffList, setStaffList] = useState<StaffLite[]>([]);
  const [selectedName, setSelectedName] = useState("");
  const [pin, setPin] = useState("");
  const [loginError, setLoginError] = useState("");

  const [tables, setTables] = useState<CafeTable[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [history, setHistory] = useState<Ticket[]>([]);
  const [receiptModal, setReceiptModal] = useState<string | null>(null);
  const prevCountRef = useRef(0);

  // ── CONNECTION INDICATOR (Group 3) ──
  // Reflects REAL backend communication (fetch success/failure), NOT the browser's
  // internet status. Lets the cashier tell "no new orders" from "we're not talking
  // to the server" at a glance.
  const [connStatus, setConnStatus] = useState<"online" | "offline">("online");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  // ── RING BELL + DESKTOP POPUP ALERT SYSTEM ──
  const [alertsOn, setAlertsOn] = useState(false);
  const seenEventsRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);

  useEffect(() => {
    setAlertsOn(localStorage.getItem("fana_alerts") === "1");
    const saved = sessionStorage.getItem("fana_cashier");
    if (saved) setStaffName(JSON.parse(saved).name);
    fetch("/api/staff?public=1")
      .then((r) => r.json())
      .then((d) => setStaffList(d.filter((s: StaffLite) => s.role === "cashier")))
      .catch(() => {});
  }, []);

  // One-time unlock: browsers need a user click before sound + desktop popups can play
  const enableAlerts = async () => {
    unlockAudio();
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    localStorage.setItem("fana_alerts", "1");
    setAlertsOn(true);
    playDing();
    triggerDesktopNotification({ title: "Fana Cafe • Cashier", message: "🔔 Ring bell + desktop alerts are now ON for this device!" });
  };

  const eventMessage = (t: Ticket): string | null => {
    const m: Record<string, string> = {
      pending_waiter: `🍽 New QR order — ${t.tableName} • ${t.totalAmount} ETB • needs confirmation`,
      confirmed: `✅ Order confirmed — ${t.tableName} • ${t.totalAmount} ETB`,
      preparing: `👨‍🍳 Preparing — ${t.tableName}`,
      ready_for_payment: `💳 Payment requested — ${t.tableName} • ${t.totalAmount} ETB`,
      completed: `✓ Payment completed — ${t.tableName} • verify & mark Paid`,
    };
    return m[t.status] || null;
  };

  const loadAll = async () => {
    // TRAFFIC FIX: don't poll when this browser tab isn't on-screen (TikTok breaks don't cost data)
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const [tRes, tkRes] = await Promise.all([fetch("/api/tables"), fetch("/api/tickets?active=1")]);
      // Connection indicator: ONLINE only when the backend actually answered both
      // polled endpoints; a failed/thrown fetch flips it to OFFLINE immediately.
      const backendOk = tRes.ok && tkRes.ok;
      setConnStatus(backendOk ? "online" : "offline");
      if (backendOk) setLastUpdated(new Date().toLocaleTimeString());
      if (tRes.ok) setTables(await tRes.json());
      if (tkRes.ok) {
      // PERFORMANCE (Group 1): poll ONLY the small active-orders payload every 8s —
      // paid history is fetched separately on a slow 60s timer (loadHistory below),
      // so we never re-download hundreds of old bills just to find new orders.
      const active: Ticket[] = await tkRes.json();

      // ── EVENT DETECTION: any order action (QR order, confirmation, payment request, payment done)
      const newEvents: Ticket[] = [];
      for (const t of active) {
        const key = `${t.id}:${t.status}`;
        if (!seenEventsRef.current.has(key)) {
          seenEventsRef.current.add(key);
          newEvents.push(t);
        }
      }

      if (initializedRef.current && alertsOn && newEvents.length > 0) {
        playDing();
        const first = newEvents[0];
        triggerDesktopNotification({
          title: "Fana Cafe • Cashier Alert",
          message: eventMessage(first) || `${first.tableName} updated`,
        });
      }
      initializedRef.current = true;

      setTickets(active);
      }
    } catch {
      // Fetch threw (network down, backend unreachable) → show OFFLINE clearly.
      setConnStatus("offline");
    }
  };

  // "Recently Paid" panel — loaded on login + every 60s (NOT on the 8s hot loop).
  // Group 3: uses the lightweight ?paid=1 endpoint (only the 12 most recent paid
  // bills, no items/receipts) instead of re-downloading up to 100 tickets + items.
  const loadHistory = async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    const r = await fetch("/api/tickets?paid=1&limit=12");
    if (r.ok) {
      setHistory(await r.json());
    }
  };

  useEffect(() => {
    if (staffName) {
      loadAll();
      loadHistory();
      // REALTIME (SSE): the server pushes a "refresh" signal only when an
      // order/payment changes, instead of polling every 8s/60s.
      const es = new EventSource("/api/realtime?channel=orders");
      es.onmessage = () => {
        loadAll();
        loadHistory();
      };
      es.onerror = () => {
        loadAll();
      };
      // Refresh immediately when the tab becomes visible again (user action).
      const onVisible = () => {
        if (!document.hidden) loadAll();
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        es.close();
        document.removeEventListener("visibilitychange", onVisible);
      };
    }
  }, [staffName]);

  const login = async () => {
    setLoginError("");
    const r = await fetch("/api/staff/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: selectedName, pin, role: "cashier" }),
    });
    const d = await r.json();
    if (r.ok && d.success) {
      setStaffName(d.staff.name);
      sessionStorage.setItem("fana_cashier", JSON.stringify(d.staff));
    } else {
      setLoginError("Wrong name or PIN. Ask admin for your PIN.");
    }
  };

  const logout = () => {
    sessionStorage.removeItem("fana_cashier");
    fetch("/api/staff/login", { method: "DELETE" }).catch(() => {});
    setStaffName("");
    setPin("");
  };

  const setStatus = async (id: number, status: string) => {
    await fetch("/api/tickets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        status,
        // Record who confirms the order (ignored server-side unless status === "confirmed").
        confirmedBy: staffName,
      }),
    });
    loadAll();
  };

  const removeItem = async (itemId: number) => {
    await fetch(`/api/tickets/items?id=${itemId}`, { method: "DELETE" });
    loadAll();
  };

  const updateItemQty = async (item: TicketItem, qty: number) => {
    await fetch("/api/tickets/items", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: item.id, quantity: qty }),
    });
    loadAll();
  };

  const markPaid = async (t: Ticket) => {
    // Release the table AND record the payment status. If it wasn't set yet
    // (legacy bills / cash verified at the counter), derive it from the method.
    const derived =
      t.paymentStatus && t.paymentStatus !== "unpaid"
        ? t.paymentStatus
        : t.paymentMethod === "cash"
        ? "paid_cash"
        : t.paymentMethod === "card"
        ? "paid_card"
        : t.paymentMethod === "cbe"
        ? "paid_cbe"
        : "paid_telebirr"; // online / telebirr / unknown digital
    await fetch("/api/tickets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: t.id,
        status: "paid",
        paymentStatus: derived,
        // GROUP 5 audit: record WHICH cashier verified & released this bill.
        verifiedBy: staffName || "(cashier)",
      }),
    });
    loadAll();
  };

  const cancelTicket = async (id: number) => {
    if (confirm("Cancel this whole order/bill?")) await setStatus(id, "cancelled");
  };

  /* ── LOGIN ── */
  if (!staffName) {
    return (
      <div className="min-h-screen bg-[#1C120F] flex items-center justify-center p-4 text-white">
        <div className="bg-[#2C1B17] border border-[#C9A227]/40 rounded-3xl p-8 w-full max-w-sm space-y-6 shadow-2xl">
          <div className="text-center space-y-2">
            <div className="w-14 h-14 rounded-2xl bg-[#C9A227] text-[#2C1B17] flex items-center justify-center mx-auto">
              <Monitor className="w-7 h-7" />
            </div>
            <h1 className="font-serif text-2xl font-bold text-amber-100">Cashier Login</h1>
            <p className="text-xs text-stone-400">Enter your name and PIN given by the admin.</p>
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
              className="w-full bg-gradient-to-r from-[#C9A227] to-[#B8921F] text-[#2C1B17] font-black text-sm uppercase py-4 rounded-xl disabled:opacity-40"
            >
              Login as Cashier
            </button>
            <a href="/" className="block text-center text-xs text-[#C9A227] hover:underline">← Back to public website</a>
          </div>
        </div>
      </div>
    );
  }

  const activeTickets = tickets;
  const pendingCount = tickets.filter((t) => t.status === "pending_waiter").length;
  const newCount = tickets.filter((t) => t.status === "confirmed").length;
  const payCount = tickets.filter((t) => t.status === "ready_for_payment" || t.status === "completed").length;

  const statusMeta: Record<string, { label: string; cls: string }> = {
    pending_waiter: { label: "⏳ NEEDS CONFIRMATION", cls: "bg-violet-600 text-white" },
    confirmed: { label: "🔔 CONFIRMED — NEW", cls: "bg-amber-500 text-black" },
    preparing: { label: "👨‍🍳 Preparing", cls: "bg-orange-600 text-white" },
    ready_for_payment: { label: "💳 Payment Requested", cls: "bg-purple-600 text-white" },
    completed: { label: "✓ Paid (verify)", cls: "bg-emerald-600 text-white" },
  };

  const methodIcon = (m?: string | null) =>
    m === "card" ? <CreditCard className="w-4 h-4 text-sky-400" />
    : m === "online" || m === "telebirr" ? <Smartphone className="w-4 h-4 text-amber-400" />
    : m === "cbe" ? <Smartphone className="w-4 h-4 text-violet-400" />
    : <Banknote className="w-4 h-4 text-emerald-400" />;

  const paymentStatusLabel = (s?: string | null) =>
    s === "paid_cash" ? "✓ PAID — CASH"
    : s === "paid_telebirr" ? "✓ PAID — TELEBIRR"
    : s === "paid_cbe" ? "✓ PAID — CBE BIRR"
    : s === "paid_card" ? "✓ PAID — CARD"
    : "✗ UNPAID";

  const paymentStatusCls = (s?: string | null) =>
    s && s !== "unpaid" ? "bg-emerald-600 text-white" : "bg-rose-600 text-white";

  // Cashier can correct/record how the bill was paid (separate from order status).
  const setPaymentStatus = async (id: number, paymentStatus: string) => {
    await fetch("/api/tickets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, paymentStatus }),
    });
    loadAll();
  };

  return (
    <div className="min-h-screen bg-[#14100C] text-white pb-10">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-[#2C1B17]/95 backdrop-blur border-b border-[#C9A227]/30 px-4 md:px-8 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[#C9A227] flex items-center justify-center">
            <Coffee className="w-5 h-5 text-[#2C1B17]" />
          </div>
          <div>
            <h1 className="font-serif font-bold text-amber-100 leading-none">Fana Cafe — Cashier</h1>
            <p className="text-[10px] text-stone-400">{staffName} • coordinating waiters & kitchen</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* CONNECTION INDICATOR (Group 3) — real backend communication, not browser internet */}
          <div
            className={`flex flex-col items-end ${
              connStatus === "online"
                ? "text-emerald-300"
                : "text-rose-300"
            }`}
            title={connStatus === "online" ? `Connected — last updated ${lastUpdated || "—"}` : "Lost contact with the server — reconnecting"}
          >
            <span className={`flex items-center gap-1.5 text-[10px] font-black px-2.5 py-1 rounded-full border ${
              connStatus === "online"
                ? "bg-emerald-900/40 border-emerald-500/40"
                : "bg-rose-900/60 border-rose-500/60 animate-pulse"
            }`}>
              <span className={`w-2 h-2 rounded-full ${connStatus === "online" ? "bg-emerald-400" : "bg-rose-400"}`} />
              {connStatus === "online" ? "ONLINE" : "OFFLINE — RECONNECTING"}
            </span>
            {lastUpdated && (
              <span className="text-[9px] text-stone-500 mt-0.5">last updated {lastUpdated}</span>
            )}
          </div>
          {/* RING BELL enable button — click once on each cashier device */}
          <button
            onClick={enableAlerts}
            className={`text-[10px] font-black px-3 py-1.5 rounded-full flex items-center gap-1.5 transition ${
              alertsOn
                ? "bg-emerald-600 text-white"
                : "bg-[#C9A227] text-[#2C1B17] animate-pulse"
            }`}
            title={alertsOn ? "Ring bell + desktop alerts enabled" : "Click once to enable ring bell & desktop alerts"}
          >
            <BellRing className="w-3.5 h-3.5" />
            {alertsOn ? "ALERTS ON" : "🔔 ENABLE ALERTS"}
          </button>
          {pendingCount > 0 && (
            <span className="bg-violet-600 text-white text-[10px] font-black px-2.5 py-1 rounded-full animate-pulse flex items-center gap-1">
              <BellRing className="w-3 h-3" /> {pendingCount} TO CONFIRM
            </span>
          )}
          {newCount > 0 && (
            <span className="bg-amber-500 text-black text-[10px] font-black px-2.5 py-1 rounded-full animate-pulse flex items-center gap-1">
              <BellRing className="w-3 h-3" /> {newCount} NEW
            </span>
          )}
          {payCount > 0 && (
            <span className="bg-purple-600 text-white text-[10px] font-black px-2.5 py-1 rounded-full">{payCount} PAY</span>
          )}
          <button onClick={() => { loadAll(); loadHistory(); }} className="p-2 rounded-xl bg-white/10 text-amber-200" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={logout} className="p-2 rounded-xl bg-rose-600/80 text-white" title="Logout">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-8">
        {/* TABLE OVERVIEW */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-widest text-amber-200/80 mb-3 flex items-center gap-2">
            <Users className="w-4 h-4 text-[#C9A227]" /> Tables Overview
          </h2>
          <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-10 gap-2">
            {tables.map((t) => (
              <div
                key={t.id}
                className={`rounded-xl p-3 text-center border-2 ${
                  t.status === "available"
                    ? "border-emerald-500/50 bg-emerald-950/30"
                    : t.status === "waiting"
                    ? "border-violet-500/60 bg-violet-950/30"
                    : t.status === "ready-for-payment"
                    ? "border-amber-400 bg-amber-950/30"
                    : t.status === "preparing"
                    ? "border-orange-500/60 bg-orange-950/30"
                    : "border-rose-500/50 bg-rose-950/30"
                }`}
              >
                <p className="text-[11px] font-bold text-amber-100">{t.name}</p>
                <p
                  className={`text-[9px] font-extrabold uppercase mt-1 ${
                    t.status === "available"
                      ? "text-emerald-400"
                      : t.status === "waiting"
                      ? "text-violet-400"
                      : t.status === "ready-for-payment"
                      ? "text-amber-300"
                      : t.status === "preparing"
                      ? "text-orange-400"
                      : "text-rose-400"
                  }`}
                >
                  {t.status === "available" ? "Free" : t.status === "waiting" ? "Waiting" : t.status === "ready-for-payment" ? "Pay" : t.status === "preparing" ? "Kitchen" : "Busy"}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ACTIVE TICKETS */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-widest text-amber-200/80 mb-3">
            Active Orders ({activeTickets.length})
          </h2>
          {activeTickets.length === 0 ? (
            <div className="bg-[#2C1B17] border border-stone-800 rounded-2xl p-8 text-center text-stone-500 text-sm">
              No active orders. Tickets sent by waiters appear here instantly.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {activeTickets.map((t) => {
                const items = (t.items || []);
                const visible = items.filter((i) => !i.removed);
                const meta = statusMeta[t.status] || statusMeta.new;
                return (
                  <div
                    key={t.id}
                    className={`bg-[#2C1B17] rounded-2xl border-2 p-4 space-y-3 ${
                      t.status === "pending_waiter" ? "border-violet-500/70 animate-pulse" : t.status === "confirmed" ? "border-amber-400/70" : t.status === "completed" ? "border-emerald-500/70" : t.status === "ready_for_payment" ? "border-purple-500/60" : t.status === "preparing" ? "border-orange-500/60" : "border-stone-700"
                    }`}
                  >
                    {/* header */}
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-serif font-bold text-lg text-amber-100">
                          {t.tableName}
                          {t.orderNumber && (
                            <span className="ml-2 align-middle text-[10px] font-black bg-stone-800 border border-[#C9A227]/40 text-[#C9A227] px-2 py-0.5 rounded-full">
                              #{t.orderNumber}
                            </span>
                          )}
                        </p>
                        <p className="text-[10px] text-stone-500 flex items-center gap-1">
                          <Clock className="w-3 h-3" /> {t.confirmedBy ? `by ${t.confirmedBy}` : `by ${t.createdBy || "waiter"}`}
                        </p>
                      </div>
                      <div className="text-right">
                        <span className={`inline-block text-[10px] font-black px-2.5 py-1 rounded-full ${meta.cls}`}>{meta.label}</span>
                        <p className="font-serif font-black text-xl text-[#C9A227] mt-1">{t.totalAmount} ETB</p>
                      </div>
                    </div>

                    {/* items (editable: qty adjust + remove) */}
                    <div className="bg-[#3D2314] rounded-xl divide-y divide-stone-800">
                      {items.map((i) => (
                        <div key={i.id} className={`p-2.5 text-xs flex items-center justify-between gap-2 ${i.removed ? "opacity-40 line-through" : ""}`}>
                          <div className="flex-1 min-w-0">
                            <p className="font-bold text-amber-100 truncate">{i.name}</p>
                            {i.notes && <p className="text-[10px] text-amber-300 italic">📝 {i.notes}</p>}
                          </div>
                          {!i.removed ? (
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button onClick={() => updateItemQty(i, Math.max(1, i.quantity - 1))} className="w-6 h-6 bg-white/10 rounded text-xs">−</button>
                              <span className="font-extrabold w-4 text-center">{i.quantity}</span>
                              <button onClick={() => updateItemQty(i, i.quantity + 1)} className="w-6 h-6 bg-[#C9A227] text-black rounded text-xs font-bold">+</button>
                              <button
                                onClick={() => removeItem(i.id)}
                                className="ml-1 px-2 py-1 bg-rose-900/60 text-rose-300 rounded text-[10px] font-bold hover:bg-rose-700 hover:text-white"
                                title="Remove (unavailable)"
                              >
                                Remove
                              </button>
                            </div>
                          ) : (
                            <span className="text-[10px] font-bold text-rose-400">REMOVED</span>
                          )}
                        </div>
                      ))}
                      {visible.length === 0 && <p className="p-3 text-center text-xs text-stone-500">All items removed.</p>}
                    </div>

                    {/* payment info — method + payment status (separate from order status) */}
                    {(t.status === "ready_for_payment" || t.status === "completed") && (
                      <div className="bg-black/30 rounded-xl p-3 border border-stone-700 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 text-xs">
                            {methodIcon(t.paymentMethod)}
                            <span className="font-bold capitalize">{t.paymentMethod ? `${t.paymentMethod} payment` : "Awaiting payment method"}</span>
                          </div>
                          <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${paymentStatusCls(t.paymentStatus)}`}>
                            {paymentStatusLabel(t.paymentStatus)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <select
                            value={t.paymentStatus || "unpaid"}
                            onChange={(e) => setPaymentStatus(t.id, e.target.value)}
                            className="bg-[#2C1B17] border border-stone-700 rounded-lg px-2 py-1.5 text-[11px] font-bold text-white flex-1"
                            title="Record how this bill was paid (order status is separate)"
                          >
                            <option value="unpaid">Unpaid</option>
                            <option value="paid_cash">Paid — Cash</option>
                            <option value="paid_telebirr">Paid — Telebirr</option>
                            <option value="paid_cbe">Paid — CBE Birr</option>
                            <option value="paid_card">Paid — Card</option>
                          </select>
                          {t.status === "completed" && t.paymentMethod !== "cash" && (
                            <button
                              onClick={async () => {
                                // fetch receipt photo ON DEMAND — saves ~70KB × 100s of polling transfers per day
                                const r = await fetch(`/api/tickets/receipt?id=${t.id}`);
                                const d = await r.json();
                                if (d.receiptImage) setReceiptModal(d.receiptImage);
                              }}
                              className="flex items-center gap-1 text-[11px] font-bold text-sky-300 bg-sky-900/40 px-2.5 py-1.5 rounded-lg hover:bg-sky-800 shrink-0"
                            >
                              <ImageIcon className="w-3.5 h-3.5" /> Receipt Photo
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* actions per status */}
                    <div className="flex flex-wrap gap-2 pt-1">
                      {t.status === "pending_waiter" && (
                        <>
                          <div className="w-full bg-violet-950/60 border border-violet-700 rounded-xl px-3 py-2 text-[11px] text-violet-200">
                            📣 Action: tell a waiter — <strong>"Go to {t.tableName} and confirm this order"</strong> — or confirm it yourself below.
                          </div>
                          <button
                            onClick={() => setStatus(t.id, "confirmed")}
                            className="flex-1 bg-violet-600 hover:bg-violet-500 text-white text-xs font-black py-2.5 rounded-xl"
                          >
                            ✓ Confirm Order (Customer Verified)
                          </button>
                        </>
                      )}
                      {t.status === "confirmed" && (
                        <button onClick={() => setStatus(t.id, "preparing")} className="flex-1 bg-orange-600 hover:bg-orange-500 text-white text-xs font-black py-2.5 rounded-xl">
                          Accept → Kitchen / Barista / Pastry
                        </button>
                      )}
                      {t.status === "preparing" && (
                        <span className="flex-1 text-center text-[11px] text-sky-300 bg-sky-950/60 py-2.5 rounded-xl border border-sky-800">
                          Preparing — waiter will request payment when customer finishes
                        </span>
                      )}
                      {t.status === "completed" && (
                        <button onClick={() => markPaid(t)} className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black py-2.5 rounded-xl flex items-center justify-center gap-2">
                          <CheckCircle2 className="w-4 h-4" /> Mark PAID & Release Table
                        </button>
                      )}
                      <button onClick={() => cancelTicket(t.id)} className="px-3 py-2.5 bg-rose-900/60 text-rose-300 text-xs font-bold rounded-xl hover:bg-rose-700 hover:text-white flex items-center gap-1">
                        <XCircle className="w-3.5 h-3.5" /> Cancel
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* TODAY'S PAID HISTORY */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-widest text-stone-400 mb-3 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" /> Recently Paid ({history.length})
          </h2>
          {history.length === 0 ? (
            <p className="text-xs text-stone-600">Paid bills will appear here after you mark them Paid.</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {history.map((t) => (
                <div key={t.id} className="bg-[#241714] border border-stone-800 rounded-xl p-3 flex items-center justify-between">
                  <div>
                    <p className="text-xs font-bold text-stone-300">{t.tableName}</p>
                    <p className="text-[10px] text-stone-500 capitalize flex items-center gap-1">{methodIcon(t.paymentMethod)} {t.paymentMethod || "cash"}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-extrabold text-emerald-400">{t.totalAmount} ETB</p>
                    <span className="text-[9px] font-black text-emerald-600 uppercase">PAID</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* receipt image modal */}
      {receiptModal && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" onClick={() => setReceiptModal(null)}>
          <img src={receiptModal} alt="Payment receipt" className="max-h-[85vh] max-w-full rounded-2xl border border-[#C9A227]" />
        </div>
      )}
    </div>
  );
}
