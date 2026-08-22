"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Coffee, Plus, Minus, Send, ArrowLeft, RefreshCw, CreditCard, Banknote,
  Smartphone, Camera, CheckCircle2, ClipboardList, Search, X, Users, LogOut, BellRing,
} from "lucide-react";
import { MenuItem, Ticket, TicketItem, CafeTable } from "@/types";
import { compressImage, optimizeImageUrl, FALLBACK_FOOD_IMAGE } from "@/lib/image-utils";
import { effectivePrice } from "@/lib/price";
import { unlockAudio, playDing } from "@/lib/sound";
import { triggerDesktopNotification } from "@/lib/notifications";
import { useRef } from "react";

interface StaffLite {
  id: number;
  name: string;
  role: string;
}

interface CartEntry {
  menuItemId: number;
  name: string;
  category: string;
  price: number;
  quantity: number;
  notes: string;
}

type View = "login" | "tables" | "order" | "bill" | "payment";

export default function WaiterApp() {
  // Auth
  const [staffName, setStaffName] = useState<string>("");
  const [staffList, setStaffList] = useState<StaffLite[]>([]);
  const [selectedName, setSelectedName] = useState("");
  const [pin, setPin] = useState("");
  const [loginError, setLoginError] = useState("");

  // Data
  const [tables, setTables] = useState<CafeTable[]>([]);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [activeTicket, setActiveTicket] = useState<Ticket | null>(null);

  // UI
  const [view, setView] = useState<View>("login");
  const [selectedTable, setSelectedTable] = useState<CafeTable | null>(null);
  const [cart, setCart] = useState<CartEntry[]>([]);
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState("");

  // ── IDEMPOTENCY (Group 1): one key per order submission, reused on retries so a
  //    double-tap / WiFi retry can NEVER duplicate items on the table bill.
  const pendingKeyRef = useRef("");
  const lastCartSigRef = useRef("");

  useEffect(() => {
    const sig = JSON.stringify(cart);
    if (pendingKeyRef.current && lastCartSigRef.current && sig !== lastCartSigRef.current) {
      pendingKeyRef.current = ""; // cart edited after a failure → new submission
    }
  }, [cart]);

  const newSubmissionKey = () =>
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Payment
  const [payMethod, setPayMethod] = useState<"cash" | "telebirr" | "cbe" | "card" | null>(null);
  const [receiptImage, setReceiptImage] = useState("");
  const [receiptEnabled, setReceiptEnabled] = useState(true);
  const [categories, setCategories] = useState<Array<{ slug: string; name: string }>>([
    { slug: "all", name: "All" },
  ]);

  // Ring bell alerts (new QR orders)
  const [alertsOn, setAlertsOn] = useState(false);
  const seenPendingRef = useRef<Set<number>>(new Set());
  const alertsInitRef = useRef(false);

  useEffect(() => {
    setAlertsOn(localStorage.getItem("fana_alerts_waiter") === "1");
    const saved = sessionStorage.getItem("fana_waiter");
    if (saved) {
      const s = JSON.parse(saved);
      setStaffName(s.name);
      setView("tables");
    }
    fetch("/api/staff?public=1")
      .then((r) => r.json())
      .then((d) => setStaffList(d.filter((s: StaffLite) => s.role === "waiter")))
      .catch(() => {});
    // Read owner switch: require receipt photo on card/online payments or not
    fetch("/api/settings").then((r) => r.json()).then((s) => setReceiptEnabled(String(s.receipt_enabled ?? "true") !== "false")).catch(() => {});
  }, []);

  useEffect(() => {
    if (staffName) {
      loadAll();
      // REALTIME (SSE): instead of polling every 8s, the server pushes a
      // "refresh" signal only when an order/table actually changes. This keeps
      // the network and database idle until something real happens.
      const es = new EventSource("/api/realtime?channel=orders");
      es.onmessage = () => loadTables();
      es.onerror = () => {
        // On a dropped connection the browser auto-reconnects; refresh once to
        // make sure nothing was missed while disconnected.
        loadTables();
      };
      // Refresh immediately when the tab becomes visible again (user action).
      const onVisible = () => {
        if (!document.hidden) loadTables();
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        es.close();
        document.removeEventListener("visibilitychange", onVisible);
      };
    }
  }, [staffName]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  };

  const enableAlerts = async () => {
    unlockAudio();
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    localStorage.setItem("fana_alerts_waiter", "1");
    setAlertsOn(true);
    playDing();
    showToast("🔔 Ring bell alerts ON");
  };

  const loadTables = async () => {
    // TRAFFIC FIX: skip polling while the tab is not visible
    if (typeof document !== "undefined" && document.hidden) return;
    const r = await fetch("/api/tables");
    if (r.ok) setTables(await r.json());

    // Ring bell when a NEW customer QR order (pending_waiter) appears on any table
    const tkRes = await fetch("/api/tickets?active=1");
    if (tkRes.ok) {
      const all: Ticket[] = await tkRes.json();
      const pending = all.filter((t) => t.status === "pending_waiter");
      const fresh = pending.filter((t) => !seenPendingRef.current.has(t.id));
      fresh.forEach((t) => seenPendingRef.current.add(t.id));

      if (alertsInitRef.current && alertsOn && fresh.length > 0) {
        playDing(3);
        const t0 = fresh[0];
        triggerDesktopNotification({
          title: "Fana Cafe • Waiter Alert",
          message: `🍽 New order request — ${t0.tableName} • ${t0.totalAmount} ETB • go confirm!`,
        });
        showToast(`🔔 New order request: ${t0.tableName}`);
      }
      alertsInitRef.current = true;
    }
  };

  const loadAll = async () => {
    loadTables();
    const m = await fetch("/api/menu");
    if (m.ok) setMenu(await m.json());
    const cr = await fetch("/api/categories");
    if (cr.ok) {
      const cats = (await cr.json()) as Array<{ slug: string; name: string }>;
      setCategories(cats.map((c) => ({ slug: c.slug, name: c.name })));
    }
  };

  const login = async () => {
    setLoginError("");
    const r = await fetch("/api/staff/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: selectedName, pin, role: "waiter" }),
    });
    const d = await r.json();
    if (r.ok && d.success) {
      setStaffName(d.staff.name);
      sessionStorage.setItem("fana_waiter", JSON.stringify(d.staff));
      setView("tables");
    } else {
      setLoginError("Wrong name or PIN. Ask admin for your PIN.");
    }
  };

  const logout = () => {
    sessionStorage.removeItem("fana_waiter");
    fetch("/api/staff/login", { method: "DELETE" }).catch(() => {});
    setStaffName("");
    setView("login");
    setPin("");
  };

  const openTable = async (t: CafeTable) => {
    setSelectedTable(t);
    setCart([]);
    if (t.activeTicketId) {
      const r = await fetch("/api/tickets?active=1");
      const all: Ticket[] = await r.json();
      const tk = all.find((x) => x.id === t.activeTicketId);
      if (tk) {
        setActiveTicket(tk);
        setView("bill");
        return;
      }
    }
    setActiveTicket(null);
    setView("order");
  };

  const addToCart = (item: MenuItem) => {
    if (!item.isAvailable) return;
    setCart((prev) => {
      const existing = prev.find((c) => c.menuItemId === item.id);
      if (existing) {
        return prev.map((c) => (c.menuItemId === item.id ? { ...c, quantity: c.quantity + 1 } : c));
      }
      return [...prev, { menuItemId: item.id, name: item.name, category: item.category, price: effectivePrice(item).price, quantity: 1, notes: "" }];
    });
  };

  const cartTotal = cart.reduce((s, c) => s + c.price * c.quantity, 0);

  const sendOrder = async () => {
    if (cart.length === 0 || !selectedTable || sending) return;
    if (!pendingKeyRef.current) pendingKeyRef.current = newSubmissionKey();
    lastCartSigRef.current = JSON.stringify(cart);
    setSending(true);
    const r = await fetch("/api/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tableId: selectedTable.id,
        waiterName: staffName,
        idempotencyKey: pendingKeyRef.current,
        items: cart.map((c) => ({
          menuItemId: c.menuItemId,
          name: c.name,
          category: c.category,
          price: c.price,
          quantity: c.quantity,
          notes: c.notes,
        })),
      }),
    });
    setSending(false);
    if (r.ok) {
      const d = await r.json();
      pendingKeyRef.current = "";
      setCart([]);
      showToast(d.duplicate ? "✓ Already sent — not sent twice" : d.merged ? "✓ Items added to the table bill" : "✓ Order sent to cashier");
      await loadTables();
      onGoBack();
    } else {
      showToast("Failed to send order — press Send again, it will not duplicate.");
    }
  };

  const refreshTicket = async () => {
    if (!activeTicket) return;
    const r = await fetch("/api/tickets?active=1");
    if (r.ok) {
      const all: Ticket[] = await r.json();
      const tk = all.find((x) => x.id === activeTicket.id);
      if (tk) setActiveTicket(tk);
    }
  };

  const updateItemQty = async (item: TicketItem, qty: number) => {
    await fetch("/api/tickets/items", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: item.id, quantity: qty }),
    });
    refreshTicket();
  };

  const requestPayment = async () => {
    if (!activeTicket) return;
    await fetch("/api/tickets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: activeTicket.id, status: "ready_for_payment" }),
    });
    setView("payment");
    loadTables();
  };

  const confirmPayment = async () => {
    if (!activeTicket || !payMethod) return;
    setSending(true);
    await fetch("/api/tickets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: activeTicket.id,
        status: "completed",
        paymentMethod: payMethod,
        // Payment status is separate from order status: record HOW it was paid now;
        // the cashier still verifies (for digital) and releases the table.
        paymentStatus: `paid_${payMethod}` as const,
        receiptImage: receiptImage || "",
      }),
    });
    setSending(false);
    setActiveTicket(null);
    setSelectedTable(null);
    setPayMethod(null);
    setReceiptImage("");
    showToast("✓ Payment completed — cashier will verify and release the table");
    setView("tables");
    loadTables();
  };

  const onGoBack = () => {
    setSelectedTable(null);
    setActiveTicket(null);
    setCart([]);
    setView("tables");
  };

  const filteredMenu = useMemo(
    () =>
      menu.filter(
        (m) =>
          (category === "all" || m.category === category) &&
          m.name.toLowerCase().includes(search.toLowerCase())
      ),
    [menu, category, search]
  );

  const billItems = (activeTicket?.items || []).filter((i) => !i.removed);
  const billTotal = billItems.reduce((s, i) => s + i.price * i.quantity, 0);

  const statusChip = (status?: string) =>
    status === "waiting"
      ? "bg-violet-600 text-white"
      : status === "ready-for-payment"
      ? "bg-amber-500 text-black"
      : status === "preparing"
      ? "bg-orange-600 text-white"
      : status === "occupied"
      ? "bg-rose-600 text-white"
      : "bg-emerald-600 text-white";

  const statusLabel = (status?: string) =>
    status === "available"
      ? "Available"
      : status === "waiting"
      ? "⏳ Confirm Order"
      : status === "ready-for-payment"
      ? "Pay Requested"
      : status === "preparing"
      ? "👨‍🍳 Preparing"
      : "Occupied";

  const confirmOrder = async () => {
    if (!activeTicket) return;
    await fetch("/api/tickets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: activeTicket.id, status: "confirmed", confirmedBy: staffName }),
    });
    showToast("✓ Order confirmed — sent to cashier & kitchen");
    onGoBack();
    loadTables();
  };

  /* ── LOGIN SCREEN ─────────────────────────────────────────── */
  if (view === "login") {
    return (
      <div className="min-h-screen bg-[#1C120F] flex items-center justify-center p-4 text-white">
        <div className="bg-[#2C1B17] border border-[#C9A227]/40 rounded-3xl p-8 w-full max-w-sm space-y-6 shadow-2xl">
          <div className="text-center space-y-2">
            <div className="w-14 h-14 rounded-2xl bg-[#C9A227] text-[#2C1B17] flex items-center justify-center mx-auto">
              <Users className="w-7 h-7" />
            </div>
            <h1 className="font-serif text-2xl font-bold text-amber-100">Waiter Login</h1>
            <p className="text-xs text-stone-400">Enter your name and PIN given by the admin.</p>
          </div>

          {loginError && (
            <div className="bg-rose-900/60 border border-rose-500 text-rose-200 text-xs p-3 rounded-xl">{loginError}</div>
          )}

          <div className="space-y-4">
            <div>
              <label className="text-xs font-bold text-amber-200 block mb-1">Your Name</label>
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
            </div>
            <div>
              <label className="text-xs font-bold text-amber-200 block mb-1">PIN</label>
              <input
                type="password"
                inputMode="numeric"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder="••••"
                className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-sm text-white text-center tracking-[0.5em]"
              />
            </div>
            <button
              onClick={login}
              disabled={!selectedName || !pin}
              className="w-full bg-gradient-to-r from-[#C9A227] to-[#B8921F] text-[#2C1B17] font-black text-sm uppercase py-4 rounded-xl disabled:opacity-40"
            >
              Login as Waiter
            </button>
            <a href="/" className="block text-center text-xs text-[#C9A227] hover:underline">← Back to public website</a>
          </div>
        </div>
      </div>
    );
  }

  /* ── MAIN WAITER SHELL ────────────────────────────────────── */
  return (
    <div className="min-h-screen bg-[#1C120F] text-white pb-24">
      {/* Top Bar */}
      <div className="sticky top-0 z-30 bg-[#2C1B17]/95 backdrop-blur border-b border-[#C9A227]/30 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-[#C9A227] flex items-center justify-center">
            <Coffee className="w-4 h-4 text-[#2C1B17]" />
          </div>
          <div>
            <p className="text-xs font-bold text-amber-100 leading-none">{staffName}</p>
            <p className="text-[10px] text-stone-400">Waiter • Fana Cafe</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={enableAlerts}
            className={`p-2 rounded-xl transition ${alertsOn ? "bg-emerald-600 text-white" : "bg-[#C9A227] text-[#2C1B17] animate-pulse"}`}
            title={alertsOn ? "Ring bell alerts ON" : "Enable ring bell alerts"}
          >
            <BellRing className="w-4 h-4" />
          </button>
          <button onClick={loadAll} className="p-2 rounded-xl bg-white/10 text-amber-200" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={logout} className="p-2 rounded-xl bg-rose-600/80 text-white" title="Logout">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-emerald-600 text-white text-xs font-bold px-4 py-2.5 rounded-full shadow-2xl">
          {toast}
        </div>
      )}

      {/* ── TABLES VIEW ── */}
      {view === "tables" && (
        <div className="p-4 space-y-4 max-w-3xl mx-auto">
          <div className="flex items-center justify-between">
            <h1 className="font-serif text-xl font-bold text-amber-100">Select Table</h1>
            <div className="flex gap-3 text-[10px]">
              <span className="flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" />Free</span>
              <span className="flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-full bg-violet-500 inline-block" />Waiting</span>
            <span className="flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block" />Busy</span>
              <span className="flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" />Pay</span>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {tables.map((t) => (
              <button
                key={t.id}
                onClick={() => openTable(t)}
                className={`rounded-2xl p-5 text-left border-2 transition active:scale-95 ${
                  t.status === "available"
                    ? "border-emerald-500/60 bg-emerald-950/40"
                    : t.status === "ready-for-payment"
                    ? "border-amber-400 bg-amber-950/40"
                    : "border-rose-500/60 bg-rose-950/30"
                }`}
              >
                <p className="font-serif font-bold text-lg text-amber-100">{t.name}</p>
                <span className={`inline-block mt-2 text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full ${statusChip(t.status)}`}>
                  {t.status === "available" ? "Available" : t.status === "ready-for-payment" ? "Pay Requested" : t.status === "preparing" ? "Preparing" : "Occupied"}
                </span>
                {t.activeTicketTotal ? (
                  <p className="text-[11px] text-stone-400 mt-1">{t.activeTicketTotal} ETB open</p>
                ) : null}
                {t.activeTicketBy ? (
                  <p className="text-[10px] text-[#C9A227] mt-1 font-semibold">👤 {t.activeTicketBy}</p>
                ) : null}
              </button>
            ))}
          </div>

          <div className="bg-[#2C1B17] border border-stone-800 rounded-2xl p-4">
            <p className="text-xs text-stone-400 leading-relaxed">
              Tap a <span className="text-emerald-400 font-bold">green table</span> to start a new order.
              Tap an <span className="text-rose-400 font-bold">occupied table</span> to view its bill, add more items, or request payment.
            </p>
          </div>
        </div>
      )}

      {/* ── ORDER VIEW (create/add items) ── */}
      {view === "order" && selectedTable && (
        <div className="max-w-3xl mx-auto">
          <div className="px-4 py-3 flex items-center gap-3 border-b border-stone-800">
            <button onClick={onGoBack} className="p-2 rounded-xl bg-white/10"><ArrowLeft className="w-4 h-4" /></button>
            <div className="flex-1">
              <h2 className="font-serif font-bold text-amber-100 text-lg leading-none">{selectedTable.name}</h2>
              <p className="text-[11px] text-stone-400">{activeTicket ? "Adding items to existing bill" : "New order"}</p>
            </div>
            {activeTicket && (
              <button onClick={() => setView("bill")} className="text-xs bg-[#C9A227]/20 text-[#C9A227] px-3 py-1.5 rounded-lg font-bold">
                View Bill
              </button>
            )}
          </div>

          {/* search + categories */}
          <div className="p-4 space-y-3 sticky top-[57px] bg-[#1C120F] z-20">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search menu..."
                className="w-full bg-[#2C1B17] border border-stone-700 rounded-xl pl-9 pr-3 py-2.5 text-sm"
              />
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {categories.map((c) => (
                <button
                  key={c.slug}
                  onClick={() => setCategory(c.slug)}
                  className={`px-3.5 py-1.5 rounded-full text-xs font-bold whitespace-nowrap ${
                    category === c.slug ? "bg-[#C9A227] text-[#2C1B17]" : "bg-[#2C1B17] text-stone-300"
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </div>

          {/* menu grid */}
          <div className="px-4 grid grid-cols-2 gap-3 pb-40">
            {filteredMenu.map((m) => {
              const inCart = cart.find((c) => c.menuItemId === m.id);
              const out = !m.isAvailable;
              return (
                <div key={m.id} className={`bg-[#2C1B17] rounded-2xl overflow-hidden border ${out ? "border-stone-800 opacity-50" : "border-stone-700"}`}>
                  <img src={optimizeImageUrl(m.imageUrl, 300, 200)} alt={m.name} className="w-full h-24 object-cover bg-stone-900" onError={(e) => { const el = e.currentTarget; if (!el.src.includes("placeholder")) el.src = FALLBACK_FOOD_IMAGE; }} />
                  <div className="p-2.5 space-y-1">
                    <p className="text-xs font-bold text-amber-100 leading-tight line-clamp-2">{m.name}</p>
                    <p className="text-[11px] text-[#C9A227] font-extrabold">{effectivePrice(m).onSale ? <span><span className="line-through text-stone-500 text-[10px]">{m.price} </span>{effectivePrice(m).price}</span> : m.price} ETB</p>
                    {out ? (
                      <span className="text-[10px] font-bold text-rose-400 bg-rose-900/40 px-2 py-0.5 rounded">Unavailable</span>
                    ) : (
                      <button
                        onClick={() => addToCart(m)}
                        className="w-full mt-1 bg-[#C9A227] text-[#2C1B17] text-[11px] font-extrabold py-1.5 rounded-lg flex items-center justify-center gap-1"
                      >
                        <Plus className="w-3 h-3" /> Add {inCart ? `(${inCart.quantity})` : ""}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* cart bottom sheet */}
          {cart.length > 0 && (
            <div className="fixed bottom-0 left-0 right-0 z-40 bg-[#2C1B17] border-t-2 border-[#C9A227] p-4 max-w-3xl mx-auto space-y-3">
              <div className="max-h-40 overflow-y-auto space-y-2">
                {cart.map((c) => (
                  <div key={c.menuItemId} className="bg-[#3D2314] rounded-xl p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-amber-100 flex-1 truncate">{c.name}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <button onClick={() => setCart(cart.map((x) => x.menuItemId === c.menuItemId ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x))} className="w-6 h-6 bg-white/10 rounded-md flex items-center justify-center"><Minus className="w-3 h-3" /></button>
                        <span className="font-extrabold text-[#C9A227] w-4 text-center">{c.quantity}</span>
                        <button onClick={() => setCart(cart.map((x) => x.menuItemId === c.menuItemId ? { ...x, quantity: x.quantity + 1 } : x))} className="w-6 h-6 bg-[#C9A227] text-black rounded-md flex items-center justify-center"><Plus className="w-3 h-3" /></button>
                        <button onClick={() => setCart(cart.filter((x) => x.menuItemId !== c.menuItemId))} className="text-rose-400 pl-1"><X className="w-4 h-4" /></button>
                      </div>
                    </div>
                    <input
                      value={c.notes}
                      onChange={(e) => setCart(cart.map((x) => (x.menuItemId === c.menuItemId ? { ...x, notes: e.target.value } : x)))}
                      placeholder="Note: No Sugar, Extra Mayo, Less Spicy..."
                      className="w-full bg-black/30 border border-stone-700 rounded-lg px-2 py-1 text-[11px] text-stone-300"
                    />
                  </div>
                ))}
              </div>
              <button
                onClick={sendOrder}
                disabled={sending}
                className="w-full bg-gradient-to-r from-[#C9A227] to-[#B8921F] text-[#2C1B17] font-black text-sm uppercase py-3.5 rounded-xl flex items-center justify-center gap-2 shadow-xl"
              >
                <Send className="w-4 h-4" />
                {sending ? "Sending..." : `Send Order • ${cartTotal} ETB`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── BILL VIEW (existing table) ── */}
      {view === "bill" && activeTicket && selectedTable && (
        <div className="p-4 max-w-2xl mx-auto space-y-4">
          <div className="flex items-center gap-3">
            <button onClick={onGoBack} className="p-2 rounded-xl bg-white/10"><ArrowLeft className="w-4 h-4" /></button>
            <div className="flex-1">
              <h2 className="font-serif font-bold text-amber-100 text-lg leading-none">{selectedTable.name} — Bill</h2>
              <p className="text-[11px] text-stone-400 capitalize">Status: {activeTicket.status.replace(/_/g, " ")}</p>
            </div>
            {activeTicket.status !== "ready_for_payment" && (
              <button onClick={() => setView("order")} className="text-xs bg-[#C9A227] text-[#2C1B17] px-3 py-2 rounded-lg font-bold flex items-center gap-1">
                <Plus className="w-3.5 h-3.5" /> Add Items
              </button>
            )}
          </div>

          <div className="bg-[#2C1B17] rounded-2xl border border-stone-800 divide-y divide-stone-800">
            {billItems.map((i) => (
              <div key={i.id} className="p-3.5 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-amber-100 flex-1">{i.name}</span>
                  <span className="font-extrabold text-[#C9A227] shrink-0">{i.price * i.quantity} ETB</span>
                </div>
                {i.notes && <p className="text-[11px] text-amber-300 italic">📝 {i.notes}</p>}
                {activeTicket.status !== "ready_for_payment" && (
                  <div className="flex items-center gap-2 pt-1">
                    <button onClick={() => updateItemQty(i, Math.max(1, i.quantity - 1))} className="w-6 h-6 bg-white/10 rounded-md flex items-center justify-center"><Minus className="w-3 h-3" /></button>
                    <span className="text-xs font-bold w-4 text-center">{i.quantity}</span>
                    <button onClick={() => updateItemQty(i, i.quantity + 1)} className="w-6 h-6 bg-[#C9A227] text-black rounded-md flex items-center justify-center"><Plus className="w-3 h-3" /></button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="bg-[#2C1B17] rounded-2xl border border-[#C9A227]/40 p-4 flex items-center justify-between">
            <span className="text-sm font-bold text-stone-300">Total Bill</span>
            <span className="font-serif font-black text-2xl text-[#C9A227]">{billTotal} ETB</span>
          </div>

          {activeTicket.status === "pending_waiter" && (
            <button
              onClick={confirmOrder}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-black text-sm uppercase py-4 rounded-xl flex items-center justify-center gap-2"
            >
              <CheckCircle2 className="w-4 h-4" /> Confirm Order → Send to Cashier
            </button>
          )}

          {activeTicket.status !== "ready_for_payment" && activeTicket.status !== "pending_waiter" && (
            <button
              onClick={requestPayment}
              className="w-full bg-amber-500 text-black font-black text-sm uppercase py-4 rounded-xl flex items-center justify-center gap-2"
            >
              <CreditCard className="w-4 h-4" /> Request Payment
            </button>
          )}

          {activeTicket.status === "ready_for_payment" && (
            <button
              onClick={() => setView("payment")}
              className="w-full bg-emerald-600 text-white font-black text-sm uppercase py-4 rounded-xl"
            >
              Continue to Payment →
            </button>
          )}
        </div>
      )}

      {/* ── PAYMENT VIEW ── */}
      {view === "payment" && activeTicket && selectedTable && (
        <div className="p-4 max-w-md mx-auto space-y-5">
          <div className="flex items-center gap-3">
            <button onClick={() => setView("bill")} className="p-2 rounded-xl bg-white/10"><ArrowLeft className="w-4 h-4" /></button>
            <h2 className="font-serif font-bold text-amber-100 text-lg">Payment — {selectedTable.name}</h2>
          </div>

          <div className="bg-[#2C1B17] rounded-2xl border border-[#C9A227]/40 p-4 text-center">
            <p className="text-xs text-stone-400">Amount to collect</p>
            <p className="font-serif font-black text-3xl text-[#C9A227]">{billTotal} ETB</p>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-bold text-amber-200">Ask the customer — payment method:</p>
            {([
              { m: "cash", icon: <Banknote className="w-5 h-5 text-emerald-400" />, label: "Cash" },
              { m: "telebirr", icon: <Smartphone className="w-5 h-5 text-amber-400" />, label: "Telebirr" },
              { m: "cbe", icon: <Smartphone className="w-5 h-5 text-violet-400" />, label: "CBE Birr" },
              { m: "card", icon: <CreditCard className="w-5 h-5 text-sky-400" />, label: "Card" },
            ] as const).map(({ m, icon, label }) => (
              <button
                key={m}
                onClick={() => setPayMethod(m)}
                className={`w-full flex items-center gap-3 p-4 rounded-2xl border-2 text-left transition ${
                  payMethod === m ? "border-[#C9A227] bg-[#C9A227]/10" : "border-stone-700 bg-[#2C1B17]"
                }`}
              >
                {icon}
                <div className="flex-1">
                  <p className="text-sm font-bold text-white">{label}</p>
                  <p className="text-[11px] text-stone-400">
                    {m === "cash" ? "Collect cash and confirm" : "Take receipt photo after payment (optional)"}
                  </p>
                </div>
                {payMethod === m && <CheckCircle2 className="w-5 h-5 text-[#C9A227]" />}
              </button>
            ))}
          </div>

          {payMethod && payMethod !== "cash" && receiptEnabled && (
            <div className="bg-[#2C1B17] rounded-2xl border border-stone-700 p-4 space-y-3">
              <p className="text-xs font-bold text-amber-200 flex items-center gap-1.5">
                <Camera className="w-4 h-4 text-[#C9A227]" /> Receipt Photo (optional)
              </p>
              {receiptImage && <img src={receiptImage} alt="Receipt" className="w-full h-40 object-cover rounded-xl border border-stone-600" />}
              <label className="flex items-center justify-center gap-2 w-full bg-white/10 hover:bg-white/20 text-white text-xs font-bold py-2.5 rounded-xl cursor-pointer">
                <Camera className="w-4 h-4" />
                {receiptImage ? "Retake Photo" : "Take Receipt Photo"}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    try {
                      // Compress on device (~4MB → ~70KB). The data-URL stays in
                      // state and is persisted by the server only when the bill is
                      // actually paid — a canceled photo never touches the database.
                      const small = await compressImage(f, 800, 0.65);
                      setReceiptImage(small);
                    } catch {
                      showToast("Could not read that photo — try again");
                    }
                  }}
                />
              </label>
            </div>
          )}

          <button
            onClick={confirmPayment}
            disabled={!payMethod || sending}
            className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-black text-sm uppercase py-4 rounded-xl disabled:opacity-40"
          >
            {sending
              ? "Confirming..."
              : `Confirm ${
                  payMethod === "cbe" ? "CBE Birr" : payMethod ? payMethod.charAt(0).toUpperCase() + payMethod.slice(1) : ""
                } Payment`}
          </button>

          <div className="flex items-center gap-2 text-[11px] text-stone-400 bg-[#2C1B17] rounded-xl p-3">
            <ClipboardList className="w-4 h-4 text-[#C9A227] shrink-0" />
            After confirmation, the cashier verifies and marks the order <strong className="text-white">Paid</strong> — the table then becomes Available automatically.
          </div>
        </div>
      )}
    </div>
  );
}
