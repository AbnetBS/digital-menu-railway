"use client";

import { useState, useEffect, useRef } from "react";
import {
  Coffee, RefreshCw, LogOut, BellRing, CheckCircle2, XCircle, CreditCard,
  Banknote, Smartphone, Users, Clock, Image as ImageIcon, Monitor, Printer, AlertTriangle,
} from "lucide-react";
import { Ticket, TicketItem, CafeTable, StaffUser } from "@/types";
import { triggerDesktopNotification } from "@/lib/notifications";
import { formatClock, formatDateTime, waitingLabel } from "@/lib/order-lines";
import { unlockAudio, playDing, playAlarm } from "@/lib/sound";
import { enablePocketAlerts, pushSupported } from "@/lib/push-client";
import PocketAlertsHint from "@/components/rms/PocketAlertsHint";
import PocketAlertsChip from "@/components/rms/PocketAlertsChip";
import { usePocketAlerts } from "@/lib/use-pocket-alerts";

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
  // "Printed Today" — her daily archive, filled at PRINT time (see loadHistory).
  const [history, setHistory] = useState<Ticket[]>([]);
  const [receiptModal, setReceiptModal] = useState<string | null>(null);
  // GROUP 12: clickable bill cards — the expanded bill (Printed Today / queue).
  const [billModal, setBillModal] = useState<Ticket | null>(null);
  // Additions cards have two views: ONLY the new items (default) or the full
  // bill for context; this is the set of cards currently showing the full bill.
  const [fullBillOpen, setFullBillOpen] = useState<Set<number>>(new Set());
  const prevCountRef = useRef(0);

  // ── GROUP 9: PRINT-QUEUE MODE ──
  // Fana's real workflow: the cashier's ONLY system job is one click per order —
  // she keys the bill into the government EFD/POS on her desktop, prints the
  // order paper, and taps ✓ PRINTED here. Payment tracking stays in the EFD
  // world; waiters close bills by tapping "Table cleared". Mode comes from the
  // owner's Settings tab (cashier_mode), defaulting to print-queue.
  const [printQueueMode, setPrintQueueMode] = useState(true);
  const modeRef = useRef(true);
  // Which queue cards have the ✗ Problem panel open (cancel / correction).
  const [problemOpen, setProblemOpen] = useState<Set<number>>(new Set());

  // ── CONNECTION INDICATOR (Group 3) ──
  // Reflects REAL backend communication (fetch success/failure), NOT the browser's
  // internet status. Lets the cashier tell "no new orders" from "we're not talking
  // to the server" at a glance.
  const [connStatus, setConnStatus] = useState<"online" | "offline">("online");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  // ── RING BELL + DESKTOP POPUP ALERT SYSTEM ──
  const [alertsOn, setAlertsOn] = useState(false);
  // STALE-CLOSURE FIX: the SSE handler is built once (deps [staffName]) and
  // froze whatever `alertsOn` was at that moment, so enabling alerts later
  // never reached it and the counter tablet stayed silent. Reads use the ref.
  const alertsOnRef = useRef(false);
  const [toast, setToast] = useState("");
  // Always points at the CURRENT loaders for the SSE + push relays.
  const loadAllRef = useRef<() => void>(() => {});
  const loadHistoryRef = useRef<() => void>(() => {});

  // Refs follow the latest render from an effect (never during render).
  useEffect(() => {
    alertsOnRef.current = alertsOn;
  }, [alertsOn]);
  const seenEventsRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);

  useEffect(() => {
    const saved = sessionStorage.getItem("fana_cashier");
    // A restored session means the cashier is on shift: alerts default to ON.
    const on = localStorage.getItem("fana_alerts") === "1" || !!saved;
    setAlertsOn(on);
    alertsOnRef.current = on;
    if (on) localStorage.setItem("fana_alerts", "1");
    if (saved) setStaffName(JSON.parse(saved).name);
    fetch("/api/staff?public=1")
      .then((r) => r.json())
      .then((d) => setStaffList(d.filter((s: StaffLite) => s.role === "cashier")))
      .catch(() => {});
    // Owner switch: print-queue (EFD workflow) vs full payment recording.
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => {
        const mode = String(s.cashier_mode ?? "print-queue") === "full" ? false : true;
        setPrintQueueMode(mode);
        modeRef.current = mode;
      })
      .catch(() => {});
  }, []);

  // One-time unlock: browsers need a user click before sound + desktop popups can play
  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 4000);
  };

  const enableAlerts = async () => {
    unlockAudio();
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    localStorage.setItem("fana_alerts", "1");
    setAlertsOn(true);
    alertsOnRef.current = true;
    // (Re)arm pocket alerts too, then ring a sample so she KNOWS the device is
    // armed instead of guessing.
    if (pushSupported()) {
      await enablePocketAlerts();
      void pocket.refreshStatus();
    }
    playAlarm();
    triggerDesktopNotification({ title: "Fana Cafe • Cashier", message: "🔔 Ring bell + desktop + pocket alerts are now ON for this device!" });
  };

  const eventMessage = (t: Ticket): string | null => {
    // A guest waiting for the bill outranks whatever the status says.
    if (t.receiptRequestedAt) return `🧾 BILL REQUESTED • ${t.tableName} • ${t.totalAmount} ETB`;
    const m: Record<string, string> = {
      pending_waiter: `🍽 New QR order • ${t.tableName} • ${t.totalAmount} ETB • needs confirmation`,
      confirmed: `🧾 TO PRINT • ${t.tableName} • ${t.totalAmount} ETB`,
      preparing: `👨‍🍳 Preparing • ${t.tableName}`,
      printed: `🖨 Printed • ${t.tableName}`,
      ready_for_payment: `💳 Payment requested • ${t.tableName} • ${t.totalAmount} ETB`,
      completed: `✓ Payment completed • ${t.tableName} • verify & mark Paid`,
      closed: `✓ Table cleared • ${t.tableName} is free`,
      cancelled: `⛔ ORDER CANCELLED • ${t.tableName}`,
      paid: `✓ Bill settled • ${t.tableName}`,
    };
    return m[t.status] || null;
  };

  const loadAll = async () => {
    // GROUP 10 FIX: this used to return early while the tab was hidden (screen
    // off, tablet on the counter) — exactly when the alarm matters most — so it
    // never rang. SSE messages only arrive when something CHANGED, so we always
    // process them; the sound and vibration fire even with the screen off.
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
        // The key is the fingerprint of "something the cashier must react to".
        // receiptRequestedAt is part of it now: a guest asking for the bill does
        // NOT change the status, so that event used to slip past her silently.
        // The station progress is in there too, so she sees an order go ready.
        const cooked = (t.items || []).filter((i) => !i.removed && i.stationStatus === "done").length;
        const key = `${t.id}:${t.status}:${t.unprintedSubmissions || 0}:${t.receiptRequestedAt ? 1 : 0}:${cooked}`;
        if (!seenEventsRef.current.has(key)) {
          seenEventsRef.current.add(key);
          newEvents.push(t);
        }
      }

      if (initializedRef.current && alertsOnRef.current && newEvents.length > 0) {
        // A card entering HER print queue gets the full alarm; anything else
        // (status moves, cleared tables…) gets the standard ring.
        const needsMe = newEvents.some(
          (t) =>
            t.status === "confirmed" ||
            t.status === "pending_waiter" ||
            t.status === "ready_for_payment" ||
            t.status === "completed" ||
            t.status === "cancelled" ||
            !!t.receiptRequestedAt ||
            (t.status === "printed" && (t.unprintedSubmissions || 0) > 0)
        );
        if (needsMe) playAlarm();
        else playDing();
        const first = newEvents[0];
        triggerDesktopNotification({
          title: "Fana Cafe • Cashier Alert",
          message: eventMessage(first) || `${first.tableName} updated`,
          tag: `fana-cashier-${first.id}`,
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

  // "Printed Today" panel — loaded on login + every refresh (NOT on the 8s hot
  // loop, and it may skip while the tab is hidden to save data).
  // GROUP 12: in print-queue mode this is the cashier's DAILY CROSS-CHECK
  // against the EFD receipt count, so it must count HER action — the print —
  // not the waiter's table-clear. ?printedToday=1 returns every bill whose
  // printedAt is today (any status: freshly printed, crew working, or later
  // cleared), newest print first, WITH items so a tap opens the full bill.
  // A bill enters here the moment she taps ✓ PRINTED & SEND and STAYS after
  // the waiter clears the table (it was printed today — she still needs it
  // for the end-of-shift receipt count). Full mode keeps "Recently Paid".
  const loadHistory = async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    const r = await fetch(modeRef.current ? "/api/tickets?printedToday=1" : "/api/tickets?paid=1&limit=12");
    if (r.ok) {
      const rows: Ticket[] = await r.json();
      setHistory(modeRef.current ? sortedPrintedToday(rows) : rows);
    }
  };

  // Printed Today ordering: a bill with NEW items waiting for her next print
  // sorts to the very top (it is on her to-do list too); everything else is
  // newest print first.
  const sortedPrintedToday = (rows: Ticket[]): Ticket[] =>
    [...rows].sort((a, b) => {
      const aw = (a.unprintedSubmissions || 0) > 0 ? 1 : 0;
      const bw = (b.unprintedSubmissions || 0) > 0 ? 1 : 0;
      if (aw !== bw) return bw - aw;
      return new Date(b.printedAt || b.updatedAt || 0).getTime() - new Date(a.printedAt || a.updatedAt || 0).getTime();
    });

  useEffect(() => {
    loadAllRef.current = loadAll;
    loadHistoryRef.current = loadHistory;
  });

  // POCKET MODE: keeps this device subscribed (self-healing) and rings the
  // alarm the moment a push lands, even if the SSE stream was frozen.
  const pocket = usePocketAlerts({
    active: !!staffName,
    onAlert: () => {
      loadAllRef.current();
      loadHistoryRef.current();
    },
  });

  useEffect(() => {
    if (staffName) {
      loadAll();
      loadHistory();
      // REALTIME (SSE): the server pushes a "refresh" signal only when an
      // order/payment changes, instead of polling every 8s/60s.
      //
      // WATCHDOG: the counter tablet sleeps, the socket dies, and EventSource
      // does not always reconnect by itself. Rebuild the stream whenever it is
      // CLOSED so her queue is never quietly frozen.
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
        es.onmessage = () => {
          loadAllRef.current();
          loadHistoryRef.current();
        };
        es.onerror = () => {
          loadAllRef.current();
        };
      };

      connect();

      const revive = () => {
        if (stopped) return;
        if (!es || es.readyState === 2 /* CLOSED */) connect();
        loadAllRef.current();
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
      // GROUP 10: the login tap unlocks audio AND arms pocket notifications —
      // the cashier's phone/tablet rings even when the browser is closed.
      unlockAudio();
      localStorage.setItem("fana_alerts", "1");
      setAlertsOn(true);
      alertsOnRef.current = true;
      void enablePocketAlerts().then((res) => {
        void pocket.refreshStatus();
        if (res === "denied") {
          // notifications blocked in the browser — the in-app alarm still works
          console.warn("Pocket notifications blocked by the browser settings");
        }
      });
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

  /**
   * The guest tapped "bring us the bill" from their own phone (Group 8). Once the
   * receipt has physically reached the table, clear the flag so the badge stops
   * shouting. This touches ONLY receipt_requested_at — never a status or a price.
   */
  const clearReceiptRequest = async (t: Ticket) => {
    await fetch("/api/tickets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: t.id, receiptRequested: false }),
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

  // ── GROUP 9 (print-queue): the cashier's ONE click per order. She keys the
  // bill into the government EFD/POS, the order paper prints on her desktop,
  // and this tap moves the card out of her queue. Payment is not recorded here
  // by design — the EFD/POS remains the financial system of record.
  const markPrinted = async (t: Ticket) => {
    await fetch("/api/tickets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: t.id, status: "printed", printedBy: staffName || "(cashier)" }),
    });
    loadAll();
    loadHistory();
  };

  // Rare path: something is wrong with the order (item unavailable, wrong
  // table…) — reveals the correction tools (remove item / cancel order).
  const toggleProblem = (id: number) => {
    setProblemOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // GROUP 12: additions to an already-printed bill. The release gate uses one
  // cutoff rule — item.createdAt <= ticket.printedAt was on the printed
  // receipt; everything newer is NOT printed yet. Her TO PRINT card shows ONLY
  // those new items (she keys just the new items into the EFD and prints the
  // second receipt), never the whole bill again. Same rule as station-items.
  const isNewUnprinted = (item: TicketItem, t: Ticket): boolean => {
    if (item.removed) return false;
    if (!item.createdAt || !t.printedAt) return false;
    return new Date(item.createdAt).getTime() > new Date(t.printedAt).getTime();
  };
  const newItemsOf = (t: Ticket): TicketItem[] => (t.items || []).filter((i) => isNewUnprinted(i, t));
  const isAdditionCard = (t: Ticket): boolean =>
    t.status === "printed" && (t.unprintedSubmissions || 0) > 0;

  // Expanded queue card: the full bill for context, with the NEW items marked.
  const toggleFullBill = (id: number) => {
    setFullBillOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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

  // ── GROUP 9 (print-queue): what the cashier's queue is made of ──
  // Orders a waiter has confirmed but nobody keyed into the EFD yet, plus
  // already-printed bills that received ADDITIONS since the last print
  // (the old paper world's "print a second receipt" — now one re-print).
  const waitingConfirm = tickets.filter((t) => t.status === "pending_waiter");
  const toPrint = tickets.filter((t) => t.status === "confirmed");
  const addedCards = tickets.filter((t) => t.status === "printed" && (t.unprintedSubmissions || 0) > 0);
  const printQueue = [...addedCards, ...toPrint];

  // Board tile labels mean different things per mode. In print-queue mode the
  // board is the cashier's ambient awareness: rose = an order is waiting to be
  // keyed into the EFD, orange = printed and the crew is working on it.
  const boardLabel = (s?: string) => {
    if (s === "available") return "Free";
    if (printQueueMode) {
      if (s === "waiting") return "Confirm";
      if (s === "preparing") return "In progress";
      if (s === "ready-for-payment") return "Bill";
      return "TO PRINT";
    }
    if (s === "waiting") return "Waiting";
    if (s === "ready-for-payment") return "Pay";
    if (s === "preparing") return "Kitchen";
    return "Busy";
  };

  const statusMeta: Record<string, { label: string; cls: string }> = {
    pending_waiter: { label: "⏳ NEEDS CONFIRMATION", cls: "bg-violet-600 text-white" },
    confirmed: { label: "🔔 CONFIRMED • NEW", cls: "bg-amber-500 text-black" },
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
    s === "paid_cash" ? "✓ PAID • CASH"
    : s === "paid_telebirr" ? "✓ PAID • TELEBIRR"
    : s === "paid_cbe" ? "✓ PAID • CBE BIRR"
    : s === "paid_card" ? "✓ PAID • CARD"
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
            <h1 className="font-serif font-bold text-amber-100 leading-none">Fana Cafe • Cashier</h1>
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
            title={connStatus === "online" ? `Connected • last updated ${lastUpdated || "just now"}` : "Lost contact with the server • reconnecting"}
          >
            <span className={`flex items-center gap-1.5 text-[10px] font-black px-2.5 py-1 rounded-full border ${
              connStatus === "online"
                ? "bg-emerald-900/40 border-emerald-500/40"
                : "bg-rose-900/60 border-rose-500/60 animate-pulse"
            }`}>
              <span className={`w-2 h-2 rounded-full ${connStatus === "online" ? "bg-emerald-400" : "bg-rose-400"}`} />
              {connStatus === "online" ? "ONLINE" : "OFFLINE • RECONNECTING"}
            </span>
            {lastUpdated && (
              <span className="text-[9px] text-stone-500 mt-0.5">last updated {lastUpdated}</span>
            )}
          </div>
          <PocketAlertsChip
            status={pocket.status}
            busy={pocket.busy}
            onArm={pocket.arm}
            onTest={pocket.test}
            onToast={showToast}
          />
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
          {printQueueMode ? (
            <>
              {printQueue.length > 0 && (
                <span className="bg-amber-500 text-black text-[10px] font-black px-2.5 py-1 rounded-full animate-pulse flex items-center gap-1">
                  <Printer className="w-3 h-3" /> {printQueue.length} TO PRINT
                </span>
              )}
              {waitingConfirm.length > 0 && (
                <span className="bg-violet-600 text-white text-[10px] font-black px-2.5 py-1 rounded-full flex items-center gap-1">
                  <BellRing className="w-3 h-3" /> {waitingConfirm.length} WAITER
                </span>
              )}
            </>
          ) : (
            <>
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
            </>
          )}
          <button onClick={() => { loadAll(); loadHistory(); }} className="p-2 rounded-xl bg-white/10 text-amber-200" title="Refresh">
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

      <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-8">
        {/* iPhone pocket-mode instruction (Android needs nothing) */}
        <PocketAlertsHint />

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
                  {boardLabel(t.status)}
                </p>
                {/* Group 8/9: the guest asked for the bill — the cashier keys the
                    final receipt into the EFD, so this is HER action item. */}
                {t.activeTicketReceiptRequestedAt && (
                  <p className="text-[9px] font-black text-emerald-300 mt-1">🧾 BILL!</p>
                )}
                {!printQueueMode || t.status === "available" ? null : (
                  <p className="text-[9px] text-stone-500 mt-0.5">{t.activeTicketTotal ?? 0} ETB</p>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* ═══ GROUP 9: PRINT-QUEUE MODE — the cashier's whole job, one click per order ═══ */}
        {printQueueMode && (
          <>
            {/* QR orders still waiting for a WAITER to verify — deliberately NOT
                in the print queue: the cashier must never key an order into the
                EFD before a waiter has physically confirmed it with the guest. */}
            {waitingConfirm.length > 0 && (
              <section>
                <h2 className="text-xs font-bold uppercase tracking-widest text-violet-300/80 mb-3 flex items-center gap-2">
                  <Users className="w-4 h-4 text-violet-400" /> Waiting for waiter confirmation ({waitingConfirm.length})
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {waitingConfirm.map((t) => (
                    <div key={t.id} className="bg-[#241714] border border-violet-700/60 rounded-2xl p-4 flex items-center justify-between gap-3">
                      <div className="min-w-0 space-y-0.5">
                        <p className="font-serif font-bold text-amber-100">
                          {t.tableName}
                          {t.orderNumber && <span className="ml-1.5 text-[10px] font-black text-stone-400">#{t.orderNumber}</span>}
                        </p>
                        <p className="text-xs font-bold text-stone-300">🕒 arrived {formatClock(t.createdAt)} • {t.totalAmount} ETB</p>
                        <p className="text-xs font-bold text-violet-300 truncate">by {t.createdBy || "Customer (QR)"}</p>
                      </div>
                      <button
                        onClick={() => setStatus(t.id, "confirmed")}
                        className="shrink-0 bg-violet-600 hover:bg-violet-500 text-white text-[10px] font-black px-3 py-2.5 rounded-xl"
                        title="Only if the waiter already verified it with the guest. Normally the waiter does this"
                      >
                        ✓ Confirm myself
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* THE PRINT QUEUE — key the card into the EFD, print the order paper, tap ✓ PRINTED */}
            <section>
              <h2 className="text-xs font-bold uppercase tracking-widest text-amber-200/80 mb-3 flex items-center gap-2">
                <Printer className="w-4 h-4 text-[#C9A227]" /> To Print ({printQueue.length}) → key into EFD → print → tap ✓
              </h2>
              {printQueue.length === 0 ? (
                <div className="bg-[#2C1B17] border border-stone-800 rounded-2xl p-8 text-center text-stone-500 text-sm">
                  Nothing to print. Orders the waiters send appear here instantly.
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {printQueue.map((t) => {
                    const added = isAdditionCard(t);
                    const items = t.items || [];
                    const visible = items.filter((i) => !i.removed);
                    // GROUP 12: additions card — by default she keys ONLY the
                    // new, not-yet-printed items into the EFD (receipt #2).
                    // The full bill is one tap away for context (new items
                    // highlighted); the default view and print action are
                    // about the NEW items only.
                    const newItems = added ? newItemsOf(t) : visible;
                    const showFullBill = fullBillOpen.has(t.id);
                    const newTotal = newItems.reduce((s, i) => s + i.price * i.quantity, 0);
                    const newCount = newItems.reduce((s, i) => s + i.quantity, 0);
                    const problem = problemOpen.has(t.id);
                    return (
                      <div key={t.id} className={`bg-[#2C1B17] rounded-2xl border-2 p-4 space-y-3 ${added ? "border-amber-400" : "border-[#C9A227]/70"}`}>
                        {/* header */}
                        <div className="flex items-start justify-between gap-2">
                          <div className="space-y-0.5">
                            <p className="font-serif font-bold text-xl text-amber-100">
                              {t.tableName}
                              {t.orderNumber && (
                                <span className="ml-2 align-middle text-[10px] font-black bg-stone-800 border border-[#C9A227]/40 text-[#C9A227] px-2 py-0.5 rounded-full">
                                  #{t.orderNumber}
                                </span>
                              )}
                            </p>
                            <p className="text-xs font-bold text-stone-300 flex items-center gap-1">
                              <Clock className="w-3.5 h-3.5 text-[#C9A227]" /> {t.confirmedBy ? `by ${t.confirmedBy}` : `by ${t.createdBy || "waiter"}`}
                            </p>
                            <p className="text-xs font-bold text-stone-300">
                              🕒 arrived {formatClock(t.createdAt)} • waiting {waitingLabel(t.createdAt)}
                            </p>
                          </div>
                          <div className="text-right shrink-0">
                            {added ? (
                              <span className="inline-block text-[11px] font-black px-2.5 py-1 rounded-full bg-amber-400 text-black animate-pulse">
                                ⚠ {newCount} NEW item{newCount === 1 ? "" : "s"} on existing bill
                              </span>
                            ) : (
                              <span className="inline-block text-[11px] font-black px-2.5 py-1 rounded-full bg-amber-500 text-black">🔔 NEW ORDER</span>
                            )}
                            {added ? (
                              <>
                                <p className="font-serif font-black text-2xl text-amber-400 mt-1">{newTotal} ETB</p>
                                <p className="text-[11px] font-bold text-stone-300">new items only • whole bill {t.totalAmount} ETB</p>
                              </>
                            ) : (
                              <>
                                <p className="font-serif font-black text-2xl text-[#C9A227] mt-1">{t.totalAmount} ETB</p>
                                <p className="text-[11px] font-bold text-stone-300">{visible.reduce((s, i) => s + i.quantity, 0)} items</p>
                              </>
                            )}
                          </div>
                        </div>

                        {added && (
                          <p className="text-xs font-bold text-amber-300 bg-amber-950/40 border border-amber-700/40 rounded-xl px-3 py-2">
                            This bill was already printed. Key ONLY the new item{newCount === 1 ? "" : "s"} below into the EFD and print receipt #2. The crew gets them when you tap ✓.
                          </p>
                        )}

                        {/* The guest tapped "bring us the bill" on their own phone.
                            Arrives instantly over the realtime orders channel. */}
                        {t.receiptRequestedAt && (
                          <div className="flex items-center justify-between gap-2 bg-emerald-500/15 border border-emerald-500/50 rounded-xl px-3 py-2">
                            <p className="text-[11px] font-black text-emerald-300">
                              🧾 Guest asked for the bill at {formatClock(t.receiptRequestedAt)}
                            </p>
                            <button
                              onClick={() => clearReceiptRequest(t)}
                              className="shrink-0 text-[10px] font-bold px-2 py-1 rounded-lg bg-black/30 text-emerald-200 hover:bg-black/50"
                              title="Clear the request (bill already handed over)"
                            >
                              Clear
                            </button>
                          </div>
                        )}

                        {/* items — the list she reads while keying into the EFD.
                            Additions card: ONLY new items by default; the full
                            bill expands on demand with the new items highlighted.
                            Corrections only appear when ✗ Problem is open. */}
                        <div className="bg-[#3D2314] rounded-xl divide-y divide-stone-800">
                          {(showFullBill ? visible : newItems).map((i) => {
                            const isNew = added && isNewUnprinted(i, t);
                            return (
                              <div
                                key={i.id}
                                className={`p-2.5 text-xs flex items-center justify-between gap-2 ${
                                  i.removed ? "opacity-40 line-through" : isNew ? "bg-amber-400/15" : ""
                                }`}
                              >
                                <div className="flex-1 min-w-0">
                                  <p className="font-bold text-amber-100 truncate">
                                    {added && showFullBill && isNew ? <span className="text-amber-300 font-black">NEW • </span> : null}
                                    {i.name} <span className="text-stone-300 font-bold">({i.price} ETB)</span>
                                  </p>
                                  {i.notes && <p className="text-[11px] font-semibold text-amber-300 italic">📝 {i.notes}</p>}
                                </div>
                                <span className="font-extrabold text-amber-100 shrink-0">× {i.quantity}</span>
                                {problem && !i.removed ? (
                                  <button
                                    onClick={() => removeItem(i.id)}
                                    className="px-2 py-1 bg-rose-900/60 text-rose-300 rounded text-[10px] font-bold hover:bg-rose-700 hover:text-white shrink-0"
                                    title="Remove (unavailable)"
                                  >
                                    Remove
                                  </button>
                                ) : null}
                              </div>
                            );
                          })}
                          {visible.length === 0 && <p className="p-3 text-center text-xs text-stone-500">All items removed.</p>}
                        </div>

                        {added && (
                          <button
                            onClick={() => toggleFullBill(t.id)}
                            className="w-full text-xs font-black py-2 rounded-xl bg-stone-800/80 text-amber-200 hover:bg-stone-700 flex items-center justify-center gap-1.5"
                          >
                            {showFullBill
                              ? "▲ Show new items only"
                              : `▾ View full bill for context (${visible.reduce((s, i) => s + i.quantity, 0)} items • ${t.totalAmount} ETB)`}
                          </button>
                        )}

                        {/* the two buttons that are her entire job */}
                        <div className="flex gap-2 pt-1">
                          <button
                            onClick={() => markPrinted(t)}
                            className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-black py-4 rounded-xl flex items-center justify-center gap-2"
                            title="Confirms the EFD receipt is printed. This is what releases the items to the kitchen/barista"
                          >
                            <Printer className="w-5 h-5" /> ✓ PRINTED & SEND
                          </button>
                          <button
                            onClick={() => toggleProblem(t.id)}
                            className={`px-4 py-4 rounded-xl text-xs font-bold flex items-center gap-1.5 shrink-0 ${
                              problem ? "bg-rose-600 text-white" : "bg-rose-900/60 text-rose-300 hover:bg-rose-700 hover:text-white"
                            }`}
                          >
                            <AlertTriangle className="w-4 h-4" /> Problem
                          </button>
                        </div>
                        {problem && (
                          <div className="bg-rose-950/40 border border-rose-800 rounded-xl px-3 py-2 text-[11px] text-rose-200 space-y-2">
                            <p>Use <strong>Remove</strong> on an item above if it is unavailable, or cancel the whole order:</p>
                            <button
                              onClick={() => cancelTicket(t.id)}
                              className="bg-rose-700 hover:bg-rose-600 text-white text-[11px] font-black px-3 py-2 rounded-xl"
                            >
                              ✗ Cancel whole order
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}

        {/* ═══ FULL-PAYMENT MODE — the original cashier workflow ═══ */}
        {!printQueueMode && (
        <>
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
                        <p className="text-xs font-bold text-stone-300 flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5 text-[#C9A227]" /> {t.confirmedBy ? `by ${t.confirmedBy}` : `by ${t.createdBy || "waiter"}`}
                        </p>
                        {/* When the order ARRIVED and how long the table has been
                            waiting — the question staff keep asking. */}
                        <p className="text-xs font-bold text-stone-300">
                          🕒 arrived {formatClock(t.createdAt)} • waiting {waitingLabel(t.createdAt)}
                        </p>
                      </div>
                      <div className="text-right">
                        <span className={`inline-block text-[10px] font-black px-2.5 py-1 rounded-full ${meta.cls}`}>{meta.label}</span>
                        <p className="font-serif font-black text-xl text-[#C9A227] mt-1">{t.totalAmount} ETB</p>
                      </div>
                    </div>

                    {/* The guest tapped "bring us the bill" on their own phone.
                        Arrives instantly over the realtime orders channel. */}
                    {t.receiptRequestedAt && (
                      <div className="flex items-center justify-between gap-2 bg-emerald-500/15 border border-emerald-500/50 rounded-xl px-3 py-2">
                        <p className="text-[11px] font-black text-emerald-300">
                          🧾 Guest asked for the bill at {formatClock(t.receiptRequestedAt)}
                        </p>
                        <button
                          onClick={() => clearReceiptRequest(t)}
                          className="shrink-0 text-[10px] font-bold px-2 py-1 rounded-lg bg-black/30 text-emerald-200 hover:bg-black/50"
                          title="Clear the request (bill already handed over)"
                        >
                          Clear
                        </button>
                      </div>
                    )}

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
                            <option value="paid_cash">Paid • Cash</option>
                            <option value="paid_telebirr">Paid • Telebirr</option>
                            <option value="paid_cbe">Paid • CBE Birr</option>
                            <option value="paid_card">Paid • Card</option>
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
                            📣 Action: tell a waiter, <strong>"Go to {t.tableName} and confirm this order"</strong>, or confirm it yourself below.
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
                          Preparing • waiter will request payment when customer finishes
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

        </>
        )}

        {/* HISTORY — print-queue mode: "Printed Today" fills the moment she
            prints (cross-check vs the EFD receipt count); full mode: "Recently
            Paid". Every card opens the full bill (items, qty, prices, total). */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-widest text-stone-400 mb-3 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" /> {printQueueMode ? `Printed Today (${history.length})` : `Recently Paid (${history.length})`}
          </h2>
          {history.length === 0 ? (
            <p className="text-xs font-bold text-stone-500">
              {printQueueMode ? "Bills appear here the moment you tap ✓ PRINTED & SEND. Tap any card to check the whole bill against the EFD receipt." : "Paid bills will appear here after you mark them Paid."}
            </p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {history.map((t) => {
                const waiting = printQueueMode && (t.unprintedSubmissions || 0) > 0;
                const cleared = t.status === "closed";
                return (
                  <button
                    key={t.id}
                    onClick={() => setBillModal(t)}
                    className={`text-left bg-[#241714] rounded-xl p-3 flex items-center justify-between gap-2 transition hover:bg-[#2e1d18] active:scale-[0.98] ${
                      waiting ? "border-2 border-amber-400 animate-pulse" : "border border-stone-800"
                    }`}
                    title="Tap to see the full bill"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <p className="text-sm font-black text-amber-100">{t.tableName}</p>
                      {printQueueMode ? (
                        <p className="text-[11px] font-bold text-stone-300 truncate flex items-center gap-1">
                          <Printer className="w-3 h-3 text-[#C9A227] shrink-0" /> printed {formatClock(t.printedAt)} • {t.printedBy || "cashier"}
                        </p>
                      ) : (
                        <p className="text-[11px] font-bold text-stone-300 capitalize flex items-center gap-1">{methodIcon(t.paymentMethod)} {t.paymentMethod || "cash"}</p>
                      )}
                      {/* Group 8: table, date, time and waiter on every history card. */}
                      <p className="text-[11px] font-bold text-stone-300 truncate">🕒 {formatDateTime(printQueueMode ? (t.printedAt || t.createdAt) : (t.closedAt || t.updatedAt || t.createdAt))}</p>
                      <p className="text-[11px] font-bold text-[#D8B93E] truncate">👤 {t.confirmedBy || t.createdBy || "staff"}</p>
                      {printQueueMode && (
                        cleared ? (
                          <p className="text-[10px] font-black text-stone-400 uppercase">✓ cleared {t.closedAt ? formatClock(t.closedAt) : ""}</p>
                        ) : waiting ? (
                          <p className="text-[10px] font-black text-amber-300 uppercase">⚠ new item waiting</p>
                        ) : (
                          <p className="text-[10px] font-black text-emerald-400 uppercase">● open</p>
                        )
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-black text-emerald-400">{t.totalAmount} ETB</p>
                      {!printQueueMode && <span className="text-[9px] font-black text-emerald-600 uppercase">PAID</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* BILL DETAIL MODAL — every item with name, qty, unit price, line total,
          and the bill total. Opened from Printed Today cards (and anywhere a
          printed bill needs a cross-check against the EFD receipt). */}
      {billModal && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setBillModal(null)}
        >
          <div
            className="bg-[#2C1B17] border-2 border-[#C9A227]/50 rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-[#2C1B17] border-b border-stone-800 px-5 py-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="font-serif font-black text-xl text-amber-100">{billModal.tableName}</h3>
                <p className="text-xs font-bold text-stone-300 mt-0.5">
                  {billModal.orderNumber ? `#${billModal.orderNumber} • ` : ""}
                  printed {billModal.printedAt ? formatDateTime(billModal.printedAt) : "?"} • by {billModal.printedBy || "cashier"}
                </p>
                <p className="text-xs font-bold text-stone-300">
                  {billModal.status === "closed"
                    ? `✓ cleared ${billModal.closedAt ? formatDateTime(billModal.closedAt) : ""}`
                    : (billModal.unprintedSubmissions || 0) > 0
                    ? "⚠ new items waiting for your next print"
                    : "● open bill"}
                </p>
              </div>
              <button onClick={() => setBillModal(null)} className="p-2 rounded-lg bg-white/10 text-stone-300 hover:bg-white/20 shrink-0" title="Close">
                <XCircle className="w-5 h-5" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div className="bg-[#3D2314] rounded-xl divide-y divide-stone-800">
                {(billModal.items || []).filter((i) => !i.removed).map((i) => {
                  const isNew = !!billModal.printedAt && !!i.createdAt &&
                    new Date(i.createdAt).getTime() > new Date(billModal.printedAt!).getTime();
                  return (
                    <div key={i.id} className={`p-3 flex items-center justify-between gap-3 ${isNew ? "bg-amber-400/15" : ""}`}>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-amber-100 truncate">
                          {isNew && <span className="text-amber-300 font-black">NEW • </span>}
                          {i.name}
                        </p>
                        <p className="text-xs font-semibold text-stone-300">{i.quantity} × {i.price} ETB</p>
                        {i.notes && <p className="text-[11px] font-semibold text-amber-300 italic mt-0.5">📝 {i.notes}</p>}
                      </div>
                      <span className="text-sm font-black text-[#C9A227] shrink-0">{i.price * i.quantity} ETB</span>
                    </div>
                  );
                })}
              </div>
              <div className="bg-[#3D2314] border border-[#C9A227]/40 rounded-xl px-4 py-3 flex items-center justify-between">
                <span className="text-sm font-black text-stone-200">Bill total</span>
                <span className="font-serif font-black text-2xl text-[#C9A227]">{billModal.totalAmount} ETB</span>
              </div>
              <button
                onClick={() => setBillModal(null)}
                className="w-full py-3 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 text-sm font-black"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* receipt image modal */}
      {receiptModal && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" onClick={() => setReceiptModal(null)}>
          <img src={receiptModal} alt="Payment receipt" className="max-h-[85vh] max-w-full rounded-2xl border border-[#C9A227]" />
        </div>
      )}
    </div>
  );
}
