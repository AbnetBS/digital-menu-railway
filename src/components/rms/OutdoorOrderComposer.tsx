"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Minus, Plus, Search, Send, XCircle } from "lucide-react";
import { Category, MenuItem } from "@/types";
import { effectivePrice } from "@/lib/price";
import { useStaffT, tNow } from "@/lib/staff-i18n";

interface CartLine {
  menuItemId: number;
  name: string;
  category: string;
  price: number;
  quantity: number;
  notes: string;
}

function newSubmissionKey() {
  try {
    return crypto.randomUUID();
  } catch {
    return `outdoor-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export default function OutdoorOrderComposer({
  open,
  cashierName,
  onClose,
  onSent,
  makerMode = false,
}: {
  open: boolean;
  cashierName: string;
  onClose: () => void;
  onSent: (message: string) => void;
  makerMode?: boolean;
}) {
  const { t: L } = useStaffT();
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [label, setLabel] = useState("OUTDOOR");
  const [serviceNote, setServiceNote] = useState("");
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const pendingKeyRef = useRef("");

  useEffect(() => {
    if (!open || loaded) return;
    const load = async () => {
      const [menuRes, catRes] = await Promise.all([fetch("/api/menu"), fetch("/api/categories")]);
      if (menuRes.ok) setMenu(await menuRes.json());
      if (catRes.ok) setCategories(await catRes.json());
      setLoaded(true);
    };
    void load();
  }, [open, loaded]);

  const reset = () => {
    setCategory("all");
    setSearch("");
    setCart([]);
    setLabel("OUTDOOR");
    setServiceNote("");
    setSending(false);
    pendingKeyRef.current = "";
  };

  const close = () => {
    reset();
    onClose();
  };

  const addToCart = (item: MenuItem) => {
    if (!item.isAvailable) return;
    const livePrice = effectivePrice(item).price;
    setCart((prev) => {
      const existing = prev.find((line) => line.menuItemId === item.id && line.price === livePrice);
      if (existing) {
        return prev.map((line) =>
          line.menuItemId === item.id && line.price === livePrice
            ? { ...line, quantity: line.quantity + 1 }
            : line
        );
      }
      return [
        ...prev,
        {
          menuItemId: item.id,
          name: item.name,
          category: item.category,
          price: livePrice,
          quantity: 1,
          notes: "",
        },
      ];
    });
  };

  const updateQty = (menuItemId: number, next: number) => {
    if (next <= 0) {
      setCart((prev) => prev.filter((line) => line.menuItemId !== menuItemId));
      return;
    }
    setCart((prev) => prev.map((line) => (line.menuItemId === menuItemId ? { ...line, quantity: next } : line)));
  };

  const updateNotes = (menuItemId: number, notes: string) => {
    setCart((prev) => prev.map((line) => (line.menuItemId === menuItemId ? { ...line, notes } : line)));
  };

  const filteredMenu = useMemo(
    () =>
      menu.filter(
        (item) =>
          (category === "all" || item.category === category) &&
          item.name.toLowerCase().includes(search.toLowerCase())
      ),
    [menu, category, search]
  );

  const total = cart.reduce((sum, line) => sum + line.price * line.quantity, 0);

  const sendOrder = async () => {
    if (!open || sending || cart.length === 0) return;
    if (!pendingKeyRef.current) pendingKeyRef.current = newSubmissionKey();
    setSending(true);
    const response = await fetch("/api/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "staff",
        waiterName: cashierName,
        orderType: "outdoor",
        outdoorLabel: label,
        serviceNote,
        idempotencyKey: pendingKeyRef.current,
        items: cart.map((line) => ({
          menuItemId: line.menuItemId,
          name: line.name,
          category: line.category,
          price: line.price,
          quantity: line.quantity,
          notes: line.notes,
        })),
      }),
    });
    setSending(false);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      alert(
        response.status === 401
          ? L("Your cashier session ended. Log in again, then resend the order.")
          : data?.error || L("Could not send outdoor order")
      );
      return;
    }
    const data = await response.json();
    reset();
    onSent(data?.duplicate ? tNow("Outdoor order already sent") : tNow("✓ Outdoor order sent to stations and cashier queue"));
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm p-4 overflow-y-auto" onClick={close}>
      <div className="max-w-6xl mx-auto bg-[#1C120F] border border-[#C9A227]/40 rounded-3xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-[#2C1B17]/95 backdrop-blur border-b border-[#C9A227]/30 px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button onClick={close} className="p-2 rounded-xl bg-white/10 text-stone-200 hover:bg-white/20">
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <h2 className="font-serif font-black text-xl text-amber-100">{L("Outdoor Order")}</h2>
              <p className="text-[11px] text-stone-400">{makerMode ? L("Outdoor order • sends items to their stations and cashier") : L("Cashier-only flow • send through the normal kitchen, barista, buna and juice routing")}</p>
            </div>
          </div>
          <button onClick={close} className="p-2 rounded-xl bg-rose-900/40 text-rose-300 hover:bg-rose-700 hover:text-white">
            <XCircle className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1.4fr_0.9fr] gap-0">
          <div className="p-4 md:p-5 space-y-4 border-b xl:border-b-0 xl:border-r border-stone-800">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-black uppercase tracking-wider text-amber-200 mb-1">{L("Label shown on screens")}</label>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value.slice(0, 50))}
                  placeholder={L("OUTDOOR • White car")}
                  className="w-full bg-[#2C1B17] border border-stone-700 rounded-xl px-3 py-2.5 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] font-black uppercase tracking-wider text-amber-200 mb-1">{L("Note / delivery info")}</label>
                <input
                  value={serviceNote}
                  onChange={(e) => setServiceNote(e.target.value.slice(0, 500))}
                  placeholder={L("Phone, car color, gate, runner note...")}
                  className="w-full bg-[#2C1B17] border border-stone-700 rounded-xl px-3 py-2.5 text-sm text-white"
                />
              </div>
            </div>

            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={L("Search menu items...")}
                className="w-full bg-[#2C1B17] border border-stone-700 rounded-xl pl-9 pr-3 py-2.5 text-sm text-white"
              />
            </div>

            {menu.some((item) => item.isBuna && item.isAvailable) && <div className="rounded-2xl border border-orange-700/60 bg-orange-950/30 p-3">
              <p className="font-black text-orange-200 mb-2">{L("🫖 Traditional Buna • tap once per cup")}</p>
              <div className="flex flex-wrap gap-2">{menu.filter((item) => item.isBuna && item.isAvailable).map((item) =>
                <button key={item.id} onClick={() => addToCart(item)} className="rounded-xl bg-orange-700 px-4 py-2 text-white font-bold text-sm">+ {item.name} • {effectivePrice(item).price} ETB</button>
              )}</div>
            </div>}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setCategory("all")}
                className={`px-3 py-1.5 rounded-full text-[11px] font-black uppercase ${category === "all" ? "bg-[#C9A227] text-black" : "bg-white/10 text-stone-300 hover:bg-white/20"}`}
              >
                {L("All")}
              </button>
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => setCategory(cat.slug)}
                  className={`px-3 py-1.5 rounded-full text-[11px] font-black uppercase ${category === cat.slug ? "bg-[#C9A227] text-black" : "bg-white/10 text-stone-300 hover:bg-white/20"}`}
                >
                  {cat.name}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[55vh] overflow-y-auto pr-1">
              {filteredMenu.map((item) => {
                const price = effectivePrice(item).price;
                return (
                  <button
                    key={item.id}
                    onClick={() => addToCart(item)}
                    disabled={!item.isAvailable}
                    className={`text-left rounded-2xl border p-4 transition ${item.isAvailable ? "bg-[#241714] border-stone-800 hover:border-[#C9A227]/60" : "bg-stone-900/50 border-stone-900 opacity-50 cursor-not-allowed"}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-black text-amber-100 truncate">{item.name}</p>
                        <p className="text-[11px] text-stone-400 line-clamp-2 mt-1">{item.description}</p>
                      </div>
                      <span className="shrink-0 text-sm font-black text-[#C9A227]">{price} ETB</span>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <span className="text-[10px] font-bold text-stone-500 uppercase">{item.category}</span>
                      <span className="text-[10px] font-black px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-300">
                        {item.isAvailable ? L("Add") : L("Out")}
                      </span>
                    </div>
                  </button>
                );
              })}
              {filteredMenu.length === 0 && (
                <div className="md:col-span-2 bg-[#241714] border border-stone-800 rounded-2xl p-6 text-center text-sm text-stone-500">
                  {L("No menu items match that search.")}
                </div>
              )}
            </div>
          </div>

          <div className="p-4 md:p-5 space-y-4 bg-[#16100D]">
            <div>
              <p className="text-[11px] font-black uppercase tracking-wider text-amber-200">{L("Order summary")}</p>
              <h3 className="font-serif font-black text-2xl text-white mt-1">{label.trim() || L("OUTDOOR")}</h3>
              {serviceNote && <p className="text-xs font-bold text-sky-300 mt-1">📍 {serviceNote}</p>}
            </div>

            <div className="bg-[#2C1B17] border border-stone-800 rounded-2xl divide-y divide-stone-800 max-h-[50vh] overflow-y-auto">
              {cart.length === 0 ? (
                <p className="p-5 text-center text-sm text-stone-500">{L("Pick items on the left to build the outdoor order.")}</p>
              ) : (
                cart.map((line) => (
                  <div key={line.menuItemId} className="p-3 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-black text-amber-100">{line.name}</p>
                        <p className="text-[11px] text-stone-400">{L("{price} ETB each", { price: line.price })}</p>
                      </div>
                      <span className="text-sm font-black text-[#C9A227]">{line.price * line.quantity} ETB</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => updateQty(line.menuItemId, line.quantity - 1)} className="w-8 h-8 rounded-xl bg-white/10 text-stone-200 flex items-center justify-center">
                        <Minus className="w-4 h-4" />
                      </button>
                      <span className="w-8 text-center text-sm font-black text-white">{line.quantity}</span>
                      <button onClick={() => updateQty(line.menuItemId, line.quantity + 1)} className="w-8 h-8 rounded-xl bg-[#C9A227] text-black flex items-center justify-center">
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                    <input
                      value={line.notes}
                      onChange={(e) => updateNotes(line.menuItemId, e.target.value.slice(0, 500))}
                      placeholder={L("Per-item note: no sugar, extra mayo...")}
                      className="w-full bg-black/25 border border-stone-700 rounded-xl px-3 py-2 text-xs text-white"
                    />
                  </div>
                ))
              )}
            </div>

            <div className="bg-[#2C1B17] border border-[#C9A227]/40 rounded-2xl p-4 flex items-center justify-between">
              <span className="text-sm font-black text-stone-200">{L("Total")}</span>
              <span className="font-serif font-black text-2xl text-[#C9A227]">{total} ETB</span>
            </div>

            <button
              onClick={sendOrder}
              disabled={sending || cart.length === 0}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-black py-4 rounded-2xl flex items-center justify-center gap-2"
            >
              <Send className="w-4 h-4" />
              {sending ? L("Sending...") : L("Send Outdoor Order")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
