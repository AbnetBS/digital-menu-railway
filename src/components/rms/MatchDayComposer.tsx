"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Minus, Plus, Search, Send, XCircle } from "lucide-react";
import { Category, MenuItem, Ticket } from "@/types";
import { effectivePrice } from "@/lib/price";

/**
 * ⚽ MATCH DAY ORDER (owner's decision, Sept 2026).
 *
 * On football nights guests drag chairs from every table to the screen, and
 * the physical table numbers stop describing reality — but the waiter still
 * has to take the order, the kitchen still has to cook it, and the bill still
 * has to be paid by ONE identifiable group.
 *
 * This composer replaces the table number with a SPOT LABEL: one tap on a
 * quick chip ("Screen front", "Screen left"…) or free text ("Ahmed's group",
 * "blue chairs by the wall"). The order rides the proven outdoor machinery —
 * its own bill on a synthetic table id, instantly released to the stations
 * (kitchen / barista / buna / juice accept and finish it like any other),
 * shown to the cashier with a ⚽ MATCH badge, and settled into order history
 * when done.
 *
 * "Another round?" — the chips at the top list today's OPEN match bills, so
 * the waiter can add items to the same bill instead of printing a new one
 * for every round (server: POST /api/tickets with targetTicketId).
 */

interface CartLine {
  menuItemId: number;
  name: string;
  category: string;
  price: number;
  quantity: number;
  notes: string;
}

/** One-tap spot labels — the usual seating spots on a match night. */
const SPOT_CHIPS = ["Screen front", "Screen left", "Screen right", "By the door", "Corner side"];

function newSubmissionKey() {
  try {
    return crypto.randomUUID();
  } catch {
    return `match-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export default function MatchDayComposer({
  open,
  waiterName,
  onClose,
  onSent,
}: {
  open: boolean;
  waiterName: string;
  onClose: () => void;
  onSent: (message: string) => void;
}) {
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  /** null = a brand-new group · a Ticket = adding rounds to that match bill. */
  const [target, setTarget] = useState<Ticket | null>(null);
  const [openMatchBills, setOpenMatchBills] = useState<Ticket[]>([]);
  const [spot, setSpot] = useState("");
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const pendingKeyRef = useRef("");

  useEffect(() => {
    if (!open || loaded) return;
    const load = async () => {
      const [menuRes, catRes, ticketsRes] = await Promise.all([
        fetch("/api/menu"),
        fetch("/api/categories"),
        fetch("/api/tickets?active=1"),
      ]);
      if (menuRes.ok) setMenu(await menuRes.json());
      if (catRes.ok) setCategories(await catRes.json());
      if (ticketsRes.ok) {
        const all: Ticket[] = await ticketsRes.json();
        // Today's open match bills: outdoor tickets labeled by this composer.
        setOpenMatchBills(all.filter((t) => t.orderType === "outdoor" && /^MATCH\b/i.test(String(t.tableName || ""))));
      }
      setLoaded(true);
    };
    void load();
  }, [open, loaded]);

  const reset = () => {
    setCategory("all");
    setSearch("");
    setCart([]);
    setTarget(null);
    setSpot("");
    setSending(false);
    pendingKeyRef.current = "";
  };

  const close = () => {
    reset();
    setLoaded(false); // re-read the open bills next time
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
        { menuItemId: item.id, name: item.name, category: item.category, price: livePrice, quantity: 1, notes: "" },
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
    if (!target && !spot.trim()) return; // a new group needs its spot label
    if (!pendingKeyRef.current) pendingKeyRef.current = newSubmissionKey();
    setSending(true);
    const response = await fetch("/api/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "staff",
        waiterName,
        orderType: "outdoor",
        outdoorLabel: target ? target.tableName : `MATCH • ${spot.trim()}`,
        targetTicketId: target ? target.id : undefined,
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
          ? "Your session ended. Log in again, then resend the order."
          : data?.error || "Could not send the match day order"
      );
      return;
    }
    const data = await response.json();
    const message = data?.duplicate
      ? "Already sent • not sent twice"
      : data?.merged
      ? `✓ Added to ${target ? target.tableName : "the match bill"}`
      : `✓ Match order sent • ${target ? target.tableName : `MATCH • ${spot.trim()}`}`;
    reset();
    setLoaded(false); // the open-bills chips must re-read
    onSent(message);
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm p-4 overflow-y-auto" onClick={close}>
      <div
        className="max-w-6xl mx-auto bg-[#1C120F] border border-emerald-500/40 rounded-3xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 bg-[#2C1B17]/95 backdrop-blur border-b border-emerald-500/30 px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button onClick={close} className="p-2 rounded-xl bg-white/10 text-stone-200 hover:bg-white/20">
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <h2 className="font-serif font-black text-xl text-amber-100">⚽ Match Day Order</h2>
              <p className="text-[11px] text-stone-400">
                Chairs everywhere? Take the order with a spot label instead of a table number. It goes to the stations and the cashier like any order.
              </p>
            </div>
          </div>
          <button onClick={close} className="p-2 rounded-xl bg-rose-900/40 text-rose-300 hover:bg-rose-700 hover:text-white">
            <XCircle className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1.4fr_0.9fr] gap-0">
          <div className="p-4 md:p-5 space-y-4 border-b xl:border-b-0 xl:border-r border-stone-800">
            {/* ── who is this for? open match bills + the spot label ── */}
            <div className="space-y-2">
              <p className="text-[11px] font-black uppercase tracking-wider text-emerald-300">Who is this order for?</p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setTarget(null)}
                  className={`px-3 py-2 rounded-xl text-[11px] font-black border transition ${
                    target === null
                      ? "bg-emerald-600 border-emerald-400 text-white"
                      : "bg-white/5 border-stone-700 text-stone-300 hover:bg-white/10"
                  }`}
                >
                  ＋ New group
                </button>
                {openMatchBills.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTarget(t)}
                    className={`px-3 py-2 rounded-xl text-[11px] font-black border transition max-w-[240px] truncate ${
                      target?.id === t.id
                        ? "bg-emerald-600 border-emerald-400 text-white"
                        : "bg-white/5 border-stone-700 text-stone-300 hover:bg-white/10"
                    }`}
                    title={`Add another round to ${t.tableName} (${t.totalAmount} ETB open)`}
                  >
                    {t.tableName} • {t.totalAmount} ETB
                  </button>
                ))}
              </div>
              {target ? (
                <p className="text-[11px] font-bold text-emerald-300">
                  ➕ Adding another round to <strong>{target.tableName}</strong> → same bill, no new receipt for the group.
                </p>
              ) : (
                <>
                  <input
                    value={spot}
                    onChange={(e) => setSpot(e.target.value.slice(0, 40))}
                    placeholder="Where are they sitting? e.g. Ahmed's group, blue chairs…"
                    className="w-full bg-[#2C1B17] border border-emerald-700/50 rounded-xl px-3 py-2.5 text-sm text-white"
                  />
                  <div className="flex flex-wrap gap-2">
                    {SPOT_CHIPS.map((chip) => (
                      <button
                        key={chip}
                        onClick={() => setSpot(chip)}
                        className={`px-3 py-1.5 rounded-full text-[11px] font-black border transition ${
                          spot.trim().toLowerCase() === chip.toLowerCase()
                            ? "bg-[#C9A227] text-black border-[#C9A227]"
                            : "bg-white/5 text-stone-300 border-stone-700 hover:bg-white/10"
                        }`}
                      >
                        {chip}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search menu items..."
                className="w-full bg-[#2C1B17] border border-stone-700 rounded-xl pl-9 pr-3 py-2.5 text-sm text-white"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setCategory("all")}
                className={`px-3 py-1.5 rounded-full text-[11px] font-black uppercase ${category === "all" ? "bg-[#C9A227] text-black" : "bg-white/10 text-stone-300 hover:bg-white/20"}`}
              >
                All
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

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[50vh] overflow-y-auto pr-1">
              {filteredMenu.map((item) => {
                const price = effectivePrice(item).price;
                return (
                  <button
                    key={item.id}
                    onClick={() => addToCart(item)}
                    disabled={!item.isAvailable}
                    className={`text-left rounded-2xl border p-4 transition ${item.isAvailable ? "bg-[#241714] border-stone-800 hover:border-emerald-500/60" : "bg-stone-900/50 border-stone-900 opacity-50 cursor-not-allowed"}`}
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
                      <span className={`text-[10px] font-black px-2.5 py-1 rounded-full ${item.isAvailable ? "bg-emerald-500/20 text-emerald-300" : "bg-stone-800 text-stone-500"}`}>
                        {item.isAvailable ? "Add" : "Out"}
                      </span>
                    </div>
                  </button>
                );
              })}
              {filteredMenu.length === 0 && (
                <div className="md:col-span-2 bg-[#241714] border border-stone-800 rounded-2xl p-6 text-center text-sm text-stone-500">
                  No menu items match that search.
                </div>
              )}
            </div>
          </div>

          <div className="p-4 md:p-5 space-y-4 bg-[#16100D]">
            <div>
              <p className="text-[11px] font-black uppercase tracking-wider text-emerald-300">Order summary</p>
              <h3 className="font-serif font-black text-2xl text-white mt-1">
                {target ? target.tableName : spot.trim() ? `MATCH • ${spot.trim()}` : "Match Day Order"}
              </h3>
              <p className="text-[11px] font-bold text-stone-500 mt-0.5">
                {target ? "another round on the same bill" : "label shown to the stations and the cashier"}
              </p>
            </div>

            <div className="bg-[#2C1B17] border border-stone-800 rounded-2xl divide-y divide-stone-800 max-h-[45vh] overflow-y-auto">
              {cart.length === 0 ? (
                <p className="p-5 text-center text-sm text-stone-500">Pick items on the left to build the order.</p>
              ) : (
                cart.map((line) => (
                  <div key={line.menuItemId} className="p-3 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-black text-amber-100">{line.name}</p>
                        <p className="text-[11px] text-stone-400">{line.price} ETB each</p>
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
                      placeholder="Per-item note: no sugar, extra mayo..."
                      className="w-full bg-black/25 border border-stone-700 rounded-xl px-3 py-2 text-xs text-white"
                    />
                  </div>
                ))
              )}
            </div>

            <div className="bg-[#2C1B17] border border-[#C9A227]/40 rounded-2xl p-4 flex items-center justify-between">
              <span className="text-sm font-black text-stone-200">Total</span>
              <span className="font-serif font-black text-2xl text-[#C9A227]">{total} ETB</span>
            </div>

            <button
              onClick={sendOrder}
              disabled={sending || cart.length === 0 || (!target && !spot.trim())}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-black py-4 rounded-2xl flex items-center justify-center gap-2"
            >
              <Send className="w-4 h-4" />
              {sending
                ? "Sending..."
                : target
                ? `Add to ${target.tableName} • ${total} ETB`
                : `Send Match Order • ${total} ETB`}
            </button>
            {!target && !spot.trim() && cart.length > 0 && (
              <p className="text-[11px] font-bold text-amber-300 text-center">
                Pick a spot chip (or type where they are sitting) first.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
