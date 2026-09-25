"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Minus, Plus, Search, Send, Users, XCircle } from "lucide-react";
import { Category, MenuItem, Ticket } from "@/types";
import { effectivePrice } from "@/lib/price";
import { useStaffT, tNow } from "@/lib/staff-i18n";

/**
 * GROUP ORDERS (owner's decision, Sept 2026).
 *
 * On busy nights the seating does not match the table grid at all: chairs get
 * dragged around, different peoples end up sharing ONE table, some guests sit
 * on chairs with no table nearby. So the billing unit is the GROUP OF PEOPLE,
 * not the place. Each group gets its own auto-numbered bill ("GROUP 3") —
 * the waiter never types anything to identify them, the number IS the
 * identity, and each group pays separately at the cashier.
 *
 * The order rides the proven outdoor machinery: its own bill on a synthetic
 * table id, instantly released to the stations (kitchen / barista / buna /
 * juice finish it like any other order), shown to the cashier with a
 * 👥 GROUP badge, and settled into order history when paid.
 *
 * "Another round?" — the cards at the top list the OPEN group bills, so the
 * waiter adds items to the same group's bill instead of printing a new one
 * for every round (server: POST /api/tickets with targetTicketId). The
 * group NUMBER is stamped by the server (see @/lib/group-orders): daily,
 * never reused, never forgeable from the client.
 */

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
    return `group-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

const isGroupTicket = (t: Ticket) =>
  t.orderType === "outdoor" && /^GROUP \d+$/i.test(String(t.tableName || ""));

export default function GroupComposer({
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
  const { t: L } = useStaffT();
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  /** null = a brand-new group · a Ticket = adding a round to that group's bill. */
  const [target, setTarget] = useState<Ticket | null>(null);
  const [openGroups, setOpenGroups] = useState<Ticket[]>([]);
  /** What the server says the next group number will be (display only). */
  const [nextGroup, setNextGroup] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const pendingKeyRef = useRef("");

  useEffect(() => {
    if (!open || loaded) return;
    const load = async () => {
      const [menuRes, catRes, ticketsRes, nextRes] = await Promise.all([
        fetch("/api/menu"),
        fetch("/api/categories"),
        fetch("/api/tickets?active=1"),
        fetch("/api/tickets?nextGroup=1"),
      ]);
      if (menuRes.ok) setMenu(await menuRes.json());
      if (catRes.ok) setCategories(await catRes.json());
      if (ticketsRes.ok) {
        const all: Ticket[] = await ticketsRes.json();
        // Today's open group bills — the round targets.
        setOpenGroups(all.filter(isGroupTicket));
      }
      if (nextRes.ok) {
        const data = await nextRes.json();
        if (typeof data?.nextGroup === "number") setNextGroup(data.nextGroup);
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
    setSending(false);
    pendingKeyRef.current = "";
  };

  const close = () => {
    reset();
    setLoaded(false); // re-read the open groups next time
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
    if (!pendingKeyRef.current) pendingKeyRef.current = newSubmissionKey();
    setSending(true);
    const response = await fetch("/api/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "staff",
        waiterName,
        orderType: "outdoor",
        groupOrder: true,
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
          ? L("Your session ended. Log in again, then resend the order.")
          : data?.error || L("Could not send the group order")
      );
      return;
    }
    const data = await response.json();
    const group = String(data?.tableName || "");
    const message = data?.duplicate
      ? tNow("Already sent • not sent twice")
      : data?.merged
      ? tNow("✓ Added to {group}", { group })
      : tNow("✓ {group} created • sent to the stations", { group });
    reset();
    setLoaded(false); // the open-group cards must re-read
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
              <h2 className="font-serif font-black text-xl text-amber-100">{L("Group Orders")}</h2>
              <p className="text-[11px] text-stone-400">
                {L("Guests away from their table? Each group of people gets its own numbered bill. No table needed.")}
              </p>
            </div>
          </div>
          <button onClick={close} className="p-2 rounded-xl bg-rose-900/40 text-rose-300 hover:bg-rose-700 hover:text-white">
            <XCircle className="w-4 h-4" />
          </button>
        </div>

        <div className="grid md:grid-cols-[1.2fr_1fr]">
          {/* ── LEFT: the groups + the menu ── */}
          <div className="p-4 md:border-r border-stone-800 space-y-4">
            <div>
              <p className="text-[11px] font-black uppercase tracking-wider text-emerald-300">
                {L("Open groups · tap one to add a round")}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  onClick={() => setTarget(null)}
                  className={`px-3.5 py-2.5 rounded-xl border text-xs font-black transition ${
                    target === null
                      ? "bg-emerald-500/20 border-emerald-400 text-emerald-200"
                      : "bg-[#2C1B17] border-stone-700 text-stone-300 hover:border-emerald-500/50"
                  }`}
                >
                  <Users className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />
                  {L("New group")}{nextGroup ? L(" • will be GROUP {nextGroup}", { nextGroup }) : ""}
                </button>
                {openGroups.map((g) => (
                  <button
                    key={g.id}
                    onClick={() => setTarget(g)}
                    className={`px-3.5 py-2.5 rounded-xl border text-xs font-black transition ${
                      target?.id === g.id
                        ? "bg-emerald-500/20 border-emerald-400 text-emerald-200"
                        : "bg-[#2C1B17] border-stone-700 text-stone-300 hover:border-emerald-500/50"
                    }`}
                  >
                    {g.tableName} · {g.totalAmount} ETB
                  </button>
                ))}
              </div>
              {openGroups.length === 0 && (
                <p className="text-[11px] text-stone-500 mt-1.5">
                  {L("No open groups right now. The first send starts GROUP {n}.", { n: nextGroup || 1 })}
                </p>
              )}
            </div>

            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={L("Search the menu…")}
                className="w-full bg-black/30 border border-stone-700 rounded-xl pl-9 pr-3 py-2.5 text-sm text-white"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setCategory("all")}
                className={`px-3 py-1.5 rounded-full text-[11px] font-black border transition ${
                  category === "all" ? "bg-amber-500/20 border-amber-400 text-amber-200" : "bg-[#241714] border-stone-700 text-stone-400"
                }`}
              >
                {L("All")}
              </button>
              {categories.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setCategory(c.name)}
                  className={`px-3 py-1.5 rounded-full text-[11px] font-black border transition ${
                    category === c.name ? "bg-amber-500/20 border-amber-400 text-amber-200" : "bg-[#241714] border-stone-700 text-stone-400"
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2.5 max-h-[42vh] overflow-y-auto pr-1">
              {filteredMenu.map((item) => (
                <button
                  key={item.id}
                  onClick={() => addToCart(item)}
                  disabled={!item.isAvailable}
                  className={`text-left bg-[#241714] border rounded-2xl p-3 transition ${
                    item.isAvailable ? "border-stone-800 hover:border-emerald-500/60" : "border-stone-800 opacity-40"
                  }`}
                >
                  <p className="text-sm font-black text-amber-100 leading-tight">{item.name}</p>
                  <p className="text-[11px] text-stone-400 mt-1">{effectivePrice(item).price} ETB</p>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <span className="text-[10px] font-bold text-stone-500 uppercase">{item.category}</span>
                    <span className={`text-[10px] font-black px-2.5 py-1 rounded-full ${item.isAvailable ? "bg-emerald-500/20 text-emerald-300" : "bg-stone-800 text-stone-500"}`}>
                      {item.isAvailable ? L("Add") : L("Out")}
                    </span>
                  </div>
                </button>
              ))}
              {filteredMenu.length === 0 && (
                <div className="md:col-span-2 bg-[#241714] border border-stone-800 rounded-2xl p-6 text-center text-sm text-stone-500">
                  {L("No menu items match that search.")}
                </div>
              )}
            </div>
          </div>

          {/* ── RIGHT: the order summary ── */}
          <div className="p-4 md:p-5 space-y-4 bg-[#16100D]">
            <div>
              <p className="text-[11px] font-black uppercase tracking-wider text-emerald-300">{L("Order summary")}</p>
              <h3 className="font-serif font-black text-2xl text-white mt-1">
                {target ? target.tableName : nextGroup ? `GROUP ${nextGroup}` : L("New group")}
              </h3>
              <p className="text-[11px] font-bold text-stone-500 mt-0.5">
                {target ? L("another round on the same bill") : L("its own bill, paid separately, labeled GROUP {n}", { n: nextGroup || 1 })}
              </p>
            </div>

            <div className="bg-[#2C1B17] border border-stone-800 rounded-2xl divide-y divide-stone-800 max-h-[45vh] overflow-y-auto">
              {cart.length === 0 ? (
                <p className="p-5 text-center text-sm text-stone-500">{L("Pick items on the left to build the order.")}</p>
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
                      placeholder={L("Per-item note: no sugar, extra mayo…")}
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
              {sending
                ? L("Sending…")
                : target
                ? L("Add to {tableName} • {total} ETB", { tableName: target.tableName, total })
                : L("Send Group Order • {total} ETB", { total })}
            </button>
            {target && (
              <button onClick={() => setTarget(null)} className="w-full text-[11px] font-bold text-stone-400 hover:text-stone-200 py-1">
                {L("Start a different group instead")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
