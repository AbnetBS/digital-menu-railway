"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft, CheckCircle2, ChevronDown, Coffee, Loader2, Minus, Pencil, Plus,
  RefreshCw, Search, Trash2, XCircle,
} from "lucide-react";
import { BunaNote, MenuItem } from "@/types";
import { formatClock } from "@/lib/order-lines";

/**
 * THE COFFEE NOTE PAGE (owner's decision, Sept 2026).
 *
 * The cashier's held tab for OUTDOOR buna sales. The buna makers sell
 * traditional coffee outside and never look at their phones, so those sales
 * must not enter the station flow. When a call comes in she holds a note
 * here; when the buna maker settles up she taps PAID and the sale joins
 * order history as a normal outdoor order (Outdoor corner badge) — born
 * paid, so no station ever had to accept anything.
 *
 * Page layout, exactly as the owner described it:
 *   • "Add New" button at the top → one line: item (Buna by default, but she
 *     can change it) • amount with square +/− steppers • place note → HOLD
 *   • the held notes as numbered rows below it (1, 2, 3…), newest first,
 *     each with the time it was added and Edit / Paid / Delete
 *   • today's already-paid notes in a collapsed strip at the bottom, each
 *     linked to its order-history number
 */

interface NotesPayload {
  held: BunaNote[];
  paidToday: BunaNote[];
}

/** The menu's buna item — the default of every new note. */
function defaultBunaItem(menu: MenuItem[]): MenuItem | null {
  return (
    menu.find((m) => Boolean(m.isBuna)) ||
    menu.find((m) => /buna/i.test(String(m.name || ""))) ||
    null
  );
}

export default function CoffeeNotePanel({
  open,
  cashierName,
  onClose,
  onChanged,
}: {
  open: boolean;
  cashierName: string;
  onClose: () => void;
  /** "held" = a note was added/edited/deleted · "paid" = one joined history. */
  onChanged: (kind: "held" | "paid") => void;
}) {
  const [notes, setNotes] = useState<NotesPayload>({ held: [], paidToday: [] });
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [paidOpen, setPaidOpen] = useState(false);

  // ── the Add New form ──
  const [formOpen, setFormOpen] = useState(false);
  const [pickedId, setPickedId] = useState<number | null>(null);
  const [itemSearch, setItemSearch] = useState("");
  const [qty, setQty] = useState(1);
  const [place, setPlace] = useState("");
  const [holding, setHolding] = useState(false);

  // ── inline editing of one held row ──
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editPickedId, setEditPickedId] = useState<number | null>(null);
  const [editSearch, setEditSearch] = useState("");
  const [editQty, setEditQty] = useState(1);
  const [editPlace, setEditPlace] = useState("");
  const [saving, setSaving] = useState(false);

  const bunaDefault = useMemo(() => defaultBunaItem(menu), [menu]);
  const pickedItem = useMemo(
    () => (pickedId != null ? menu.find((m) => m.id === pickedId) || null : bunaDefault),
    [menu, pickedId, bunaDefault]
  );
  const editItem = useMemo(
    () => (editPickedId != null ? menu.find((m) => m.id === editPickedId) || null : null),
    [menu, editPickedId]
  );

  const flash = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage((cur) => (cur === text ? "" : cur)), 3200);
  };

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/buna-notes");
      if (r.ok) setNotes(await r.json());
    } catch {
      /* the next open / action retries */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    // Same async boundary the OrderStatusProvider uses: the effect body
    // itself never updates state synchronously.
    const kickoff = setTimeout(() => {
      void load();
      setFormOpen(false);
      setEditingId(null);
      setPaidOpen(false);
    }, 0);
    return () => clearTimeout(kickoff);
  }, [open]);

  useEffect(() => {
    if (!open || menu.length > 0) return;
    fetch("/api/menu")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: MenuItem[]) => setMenu(Array.isArray(rows) ? rows : []))
      .catch(() => {});
  }, [open, menu.length]);

  if (!open) return null;

  const resetForm = () => {
    setPickedId(null); // null = the buna default
    setItemSearch("");
    setQty(1);
    setPlace("");
  };

  const filteredMenu = itemSearch
    ? menu.filter((m) => m.name.toLowerCase().includes(itemSearch.toLowerCase()))
    : menu;

  /** HOLD: one call = one numbered note. */
  const hold = async () => {
    if (holding) return;
    const item = pickedItem ?? bunaDefault;
    if (!item) {
      flash("No buna item on the menu. Search and pick an item first.");
      return;
    }
    setHolding(true);
    try {
      const r = await fetch("/api/buna-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          menuItemId: pickedId ?? undefined,
          quantity: qty,
          placeNote: place,
          heldBy: cashierName,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        flash(d?.error || "Could not hold this note. Try again.");
        return;
      }
      resetForm();
      setFormOpen(false);
      await load();
      onChanged("held");
      flash(`✓ Note #${d?.note?.seq ?? ""} held${place.trim() ? ` • ${place.trim()}` : ""}`);
    } catch {
      flash("Connection problem. Try again.");
    } finally {
      setHolding(false);
    }
  };

  const startEdit = (note: BunaNote) => {
    setEditingId(note.id);
    setEditPickedId(note.menuItemId ?? null);
    setEditSearch("");
    setEditQty(Math.max(1, Number(note.quantity) || 1));
    setEditPlace(note.placeNote || "");
  };

  const saveEdit = async () => {
    if (saving || editingId == null) return;
    setSaving(true);
    try {
      const r = await fetch("/api/buna-notes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingId,
          menuItemId: editPickedId ?? undefined,
          quantity: editQty,
          placeNote: editPlace,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        flash(d?.error || "Could not update this note. Try again.");
        return;
      }
      setEditingId(null);
      await load();
      onChanged("held");
      flash("✓ Note updated");
    } catch {
      flash("Connection problem. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const payNote = async (note: BunaNote) => {
    if (!confirm(`Mark note #${note.seq} as PAID?\n${note.itemName} ×${note.quantity} • ${note.placeNote || "no place note"}\nThis adds it to order history as an outdoor order.`)) return;
    try {
      const r = await fetch("/api/buna-notes/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: note.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        flash(d?.error || "Could not mark this note paid. Try again.");
        return;
      }
      await load();
      onChanged("paid");
      flash(`✓ Note #${note.seq} paid • ${d?.orderNumber || "added to order history"}`);
    } catch {
      flash("Connection problem. Try again.");
    }
  };

  const deleteNote = async (note: BunaNote) => {
    if (!confirm(`Delete note #${note.seq} (${note.itemName} ×${note.quantity})?\nIt was never an order, so nothing else changes.`)) return;
    try {
      const r = await fetch(`/api/buna-notes?id=${note.id}`, { method: "DELETE" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        flash(d?.error || "Could not delete this note. Try again.");
        return;
      }
      await load();
      onChanged("held");
      flash(`✓ Note #${note.seq} deleted`);
    } catch {
      flash("Connection problem. Try again.");
    }
  };

  const itemPicker = (
    picked: MenuItem | null,
    onPick: (id: number) => void,
    search: string,
    onSearch: (v: string) => void,
    list: MenuItem[],
    showDefaultChip: boolean,
    buna: MenuItem | null
  ) => (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`px-3 py-1.5 rounded-xl text-xs font-black border ${picked ? "bg-[#C9A227] text-black border-[#C9A227]" : "bg-white/5 text-stone-400 border-stone-700"}`}>
          {picked ? `${picked.name} • ${picked.price} ETB` : "Pick an item"}
        </span>
        {showDefaultChip && buna && picked?.id !== buna.id && (
          <button
            type="button"
            onClick={() => onPick(buna.id)}
            className="px-3 py-1.5 rounded-xl text-[11px] font-black bg-white/10 text-amber-200 border border-stone-700 hover:bg-white/20"
            title="Back to the default"
          >
            ↺ Buna (default)
          </button>
        )}
      </div>
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Change the item? Search the menu..."
          className="w-full bg-[#1C120F] border border-stone-700 rounded-xl pl-9 pr-3 py-2.5 text-sm text-white"
        />
      </div>
      {search && (
        <div className="max-h-40 overflow-y-auto rounded-xl border border-stone-800 divide-y divide-stone-800">
          {list.length === 0 && <p className="p-3 text-xs text-stone-500">No menu item matches.</p>}
          {list.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                onPick(m.id);
                onSearch("");
              }}
              className={`w-full text-left px-3 py-2.5 text-sm font-bold hover:bg-white/10 ${picked?.id === m.id ? "text-[#C9A227]" : "text-amber-100"}`}
            >
              {m.name} <span className="text-stone-400 font-semibold">• {m.price} ETB</span>
              {m.isBuna && <span className="ml-2 text-[10px] font-black text-amber-300 uppercase">buna</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const qtyStepper = (value: number, setValue: (n: number) => void) => (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => setValue(Math.max(1, value - 1))}
        className="w-11 h-11 rounded-xl bg-white/10 text-stone-100 border border-stone-700 flex items-center justify-center hover:bg-white/20 active:scale-95"
        aria-label="One less"
      >
        <Minus className="w-5 h-5" />
      </button>
      <span className="w-10 text-center font-serif text-2xl font-black text-white">{value}</span>
      <button
        type="button"
        onClick={() => setValue(Math.min(99, value + 1))}
        className="w-11 h-11 rounded-xl bg-[#C9A227] text-black flex items-center justify-center hover:bg-amber-400 active:scale-95"
        aria-label="One more"
      >
        <Plus className="w-5 h-5" />
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm p-3 md:p-6 overflow-y-auto" onClick={onClose}>
      <div
        className="max-w-2xl mx-auto bg-[#1C120F] border border-[#C9A227]/40 rounded-3xl overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="sticky top-0 z-10 bg-[#2C1B17]/95 backdrop-blur border-b border-[#C9A227]/30 px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button onClick={onClose} className="p-2 rounded-xl bg-white/10 text-stone-200 hover:bg-white/20" title="Back to the cashier dashboard">
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <h2 className="font-serif font-black text-xl text-amber-100 flex items-center gap-2">
                <Coffee className="w-5 h-5 text-[#C9A227]" /> Coffee Note
              </h2>
              <p className="text-[11px] text-stone-400">
                Outdoor buna tab • held until the buna maker settles, then PAID joins order history
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => void load()} className="p-2 rounded-xl bg-white/10 text-stone-200 hover:bg-white/20" title="Refresh">
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button onClick={onClose} className="p-2 rounded-xl bg-rose-900/40 text-rose-300 hover:bg-rose-700 hover:text-white" title="Close">
              <XCircle className="w-4 h-4" />
            </button>
          </div>
        </div>

        {message && (
          <p className="mx-4 mt-3 bg-emerald-900/40 border border-emerald-600/50 text-emerald-200 text-xs font-bold px-3 py-2.5 rounded-xl">
            {message}
          </p>
        )}

        <div className="p-4 md:p-5 space-y-5">
          {/* ── Add New ── */}
          <div className="space-y-3">
            {!formOpen ? (
              <button
                onClick={() => setFormOpen(true)}
                className="w-full bg-gradient-to-r from-[#C9A227] to-amber-500 text-[#2C1B17] text-sm font-black py-4 rounded-2xl border-2 border-[#C9A227] flex items-center justify-center gap-2 active:scale-[0.99]"
              >
                <Plus className="w-4 h-4" /> Add New
              </button>
            ) : (
              <div className="bg-[#241714] border border-[#C9A227]/40 rounded-2xl p-4 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-black uppercase tracking-wider text-amber-200">New note (a call came in)</p>
                  <button onClick={() => { setFormOpen(false); resetForm(); }} className="text-[11px] font-bold text-stone-400 hover:text-stone-200">
                    ✕ Cancel
                  </button>
                </div>

                {itemPicker(pickedItem, setPickedId, itemSearch, setItemSearch, filteredMenu, true, bunaDefault)}

                <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-4 items-start">
                  <div>
                    <p className="text-[11px] font-black uppercase tracking-wider text-amber-200 mb-1.5">Amount</p>
                    {qtyStepper(qty, setQty)}
                  </div>
                  <div>
                    <p className="text-[11px] font-black uppercase tracking-wider text-amber-200 mb-1.5">Place (note)</p>
                    <input
                      value={place}
                      onChange={(e) => setPlace(e.target.value.slice(0, 200))}
                      placeholder="Gate, parking, office, white car, for Ahmed..."
                      className="w-full bg-[#1C120F] border border-stone-700 rounded-xl px-3 py-3 text-sm text-white"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-black text-stone-300">
                    Total <span className="font-serif text-xl text-[#C9A227]">{(pickedItem?.price ?? 0) * qty} ETB</span>
                  </p>
                  <button
                    onClick={hold}
                    disabled={holding}
                    className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-black px-8 py-3.5 rounded-2xl flex items-center gap-2"
                  >
                    {holding ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                    {holding ? "Holding..." : "HOLD"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* ── On hold ── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-black uppercase tracking-widest text-amber-200">
                On Hold <span className="text-stone-500">({notes.held.length})</span>
              </h3>
              <p className="text-[10px] font-bold text-stone-500">newest first • not in the outdoor orders list</p>
            </div>
            {notes.held.length === 0 ? (
              <div className="bg-[#241714] border border-stone-800 rounded-2xl p-5 text-center text-sm text-stone-500">
                No notes on hold. Tap <strong className="text-stone-300">Add New</strong> when a call comes in.
              </div>
            ) : (
              <div className="space-y-2.5">
                {notes.held.map((note) => (
                  <div key={note.id} className="bg-[#241714] border border-stone-800 rounded-2xl p-3.5 space-y-3">
                    {editingId === note.id ? (
                      <div className="space-y-3">
                        {itemPicker(
                          editItem ?? menu.find((m) => m.id === editPickedId) ?? null,
                          setEditPickedId,
                          editSearch,
                          setEditSearch,
                          editSearch ? menu.filter((m) => m.name.toLowerCase().includes(editSearch.toLowerCase())) : menu,
                          false,
                          bunaDefault
                        )}
                        <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-3 items-start">
                          <div>
                            <p className="text-[11px] font-black uppercase tracking-wider text-amber-200 mb-1.5">Amount</p>
                            {qtyStepper(editQty, setEditQty)}
                          </div>
                          <div>
                            <p className="text-[11px] font-black uppercase tracking-wider text-amber-200 mb-1.5">Place (note)</p>
                            <input
                              value={editPlace}
                              onChange={(e) => setEditPlace(e.target.value.slice(0, 200))}
                              className="w-full bg-[#1C120F] border border-stone-700 rounded-xl px-3 py-3 text-sm text-white"
                            />
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={saveEdit}
                            disabled={saving}
                            className="flex-1 bg-[#C9A227] hover:bg-amber-400 disabled:opacity-40 text-black text-xs font-black py-3 rounded-xl flex items-center justify-center gap-1.5"
                          >
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Save
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="flex-1 bg-white/10 hover:bg-white/20 text-stone-200 text-xs font-black py-3 rounded-xl"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex items-start gap-2.5">
                            <span className="shrink-0 w-8 h-8 rounded-lg bg-[#C9A227] text-black font-serif font-black text-sm flex items-center justify-center" title={`Note number ${note.seq}`}>
                              {note.seq}
                            </span>
                            <div className="min-w-0">
                              <p className="text-sm font-black text-amber-100 leading-snug">
                                {note.itemName} <span className="text-stone-300 font-bold">×{note.quantity}</span>
                                <span className="text-stone-400 font-semibold text-xs ml-1.5">({note.unitPrice} ETB each)</span>
                              </p>
                              {note.placeNote && <p className="text-[11px] font-bold text-sky-300 mt-0.5">📍 {note.placeNote}</p>}
                              <p className="text-[10px] font-bold text-stone-500 mt-0.5">
                                held {formatClock(note.heldAt)}{note.heldBy ? ` • by ${note.heldBy}` : ""}
                              </p>
                            </div>
                          </div>
                          <span className="shrink-0 font-serif font-black text-lg text-[#C9A227]">
                            {note.unitPrice * note.quantity} ETB
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => startEdit(note)}
                            className="flex-1 min-w-[90px] bg-[#C9A227]/15 text-[#C9A227] border border-[#C9A227]/40 rounded-xl text-xs font-black py-2.5 flex items-center justify-center gap-1.5 hover:bg-[#C9A227] hover:text-black"
                          >
                            <Pencil className="w-3.5 h-3.5" /> Edit
                          </button>
                          <button
                            onClick={() => void payNote(note)}
                            className="flex-1 min-w-[90px] bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-black py-2.5 flex items-center justify-center gap-1.5"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" /> Paid
                          </button>
                          <button
                            onClick={() => void deleteNote(note)}
                            className="px-3 bg-rose-900/60 text-rose-300 hover:bg-rose-700 hover:text-white rounded-xl text-xs font-bold py-2.5 flex items-center justify-center gap-1.5"
                            title="Delete this note"
                          >
                            <Trash2 className="w-3.5 h-3.5" /> Delete
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Paid today (collapsed reference strip) ── */}
          <div className="rounded-2xl border border-stone-800 overflow-hidden">
            <button
              onClick={() => setPaidOpen((o) => !o)}
              className="w-full bg-[#241714] hover:bg-[#2C1B17] px-4 py-3 flex items-center justify-between gap-2"
            >
              <span className="text-xs font-black uppercase tracking-widest text-stone-400">
                Paid today <span className="text-emerald-400">({notes.paidToday.length})</span>
              </span>
              <span className="text-[10px] font-bold text-stone-500 flex items-center gap-1">
                already in order history <ChevronDown className={`w-4 h-4 transition-transform ${paidOpen ? "" : "rotate-180"}`} />
              </span>
            </button>
            {paidOpen && (
              <div className="divide-y divide-stone-800">
                {notes.paidToday.length === 0 ? (
                  <p className="px-4 py-4 text-xs text-stone-500">Nothing settled from the coffee note yet today.</p>
                ) : (
                  notes.paidToday.map((note) => (
                    <div key={note.id} className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs">
                      <div className="min-w-0 flex items-center gap-2.5">
                        <span className="shrink-0 w-6 h-6 rounded-md bg-emerald-900/50 text-emerald-300 font-black text-[11px] flex items-center justify-center">
                          {note.seq}
                        </span>
                        <p className="min-w-0">
                          <span className="font-black text-amber-100">{note.itemName} ×{note.quantity}</span>
                          {note.placeNote && <span className="text-stone-400 font-semibold"> • 📍 {note.placeNote}</span>}
                        </p>
                      </div>
                      <p className="shrink-0 text-stone-500 font-bold">
                        paid {formatClock(note.paidAt)}{note.ticketId ? ` • FANA-${note.ticketId}` : ""}
                      </p>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
