"use client";

import { useState, useEffect, useMemo } from "react";
import { Search, RefreshCw, CreditCard, Banknote, Smartphone, ImageIcon, X, Trash2 } from "lucide-react";
import { Ticket, TicketItem } from "@/types";

export default function OrderHistoryTab() {
  const [orders, setOrders] = useState<Ticket[]>([]);
  const [q, setQ] = useState("");
  const [methodFilter, setMethodFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [receiptModal, setReceiptModal] = useState<string | null>(null);

  const load = async () => {
    const r = await fetch("/api/reports");
    if (r.ok) {
      const d = await r.json();
      setOrders(d.orderHistory || []);
    }
  };

  const cleanOldReceipts = async () => {
    if (
      !confirm(
        "Free up storage?\n\nRemoves receipt PHOTOS from paid bills older than 30 days.\nOrder records (items, totals, method) stay in history."
      )
    )
      return;
    const r = await fetch("/api/tickets/cleanup", { method: "POST" });
    const d = await r.json();
    alert(d.message || "Cleanup done");
    load();
  };

  const deleteOrder = async (id: number, tableName: string, amount: number) => {
    if (!confirm(`Delete this order history?\n\n${tableName} • ${amount} ETB\n\nThis permanently removes the record from the database.`)) return;
    const r = await fetch(`/api/tickets?id=${id}`, { method: "DELETE" });
    if (r.ok) {
      setOrders((prev) => prev.filter((o) => o.id !== id));
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(
    () =>
      orders.filter((o) => {
        const searchText = `${o.tableName} ${o.createdBy} ${o.status} ${new Date(o.closedAt || o.updatedAt || "").toLocaleDateString()}`.toLowerCase();
        const matchQ = !q || searchText.includes(q.toLowerCase());
        const matchM = methodFilter === "all" || (o.paymentMethod || "cash") === methodFilter;
        const matchS = statusFilter === "all" || o.status === statusFilter;
        return matchQ && matchM && matchS;
      }),
    [orders, q, methodFilter, statusFilter]
  );

  const methodIcon = (m?: string | null) =>
    m === "card" ? <CreditCard className="w-3.5 h-3.5 text-sky-400" />
    : m === "online" || m === "telebirr" ? <Smartphone className="w-3.5 h-3.5 text-amber-400" />
    : m === "cbe" ? <Smartphone className="w-3.5 h-3.5 text-violet-400" />
    : <Banknote className="w-3.5 h-3.5 text-emerald-400" />;

  const fmtTime = (t: Ticket) => {
    const d = t.closedAt || t.updatedAt;
    return d ? new Date(d).toLocaleString() : "—";
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-serif font-bold text-amber-100">Order History ({filtered.length})</h2>
          <p className="text-xs text-stone-400">Every completed & cancelled bill — search by date, table, waiter, method or status.</p>
        </div>
        <div className="flex gap-2 self-start">
          <button
            onClick={cleanOldReceipts}
            className="p-2 bg-emerald-800 hover:bg-emerald-700 text-emerald-100 rounded-xl text-xs font-bold flex items-center gap-1.5"
            title="Clear receipt photos older than 30 days to free storage"
          >
            <Trash2 className="w-4 h-4" /> Clean Old Receipts
          </button>
          <button onClick={load} className="p-2 bg-white/10 hover:bg-white/20 text-amber-200 rounded-xl" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search table, waiter, date..."
            className="w-full bg-[#2C1B17] border border-stone-700 rounded-xl pl-9 pr-3 py-2.5 text-xs text-white"
          />
        </div>
        <select value={methodFilter} onChange={(e) => setMethodFilter(e.target.value)} className="bg-[#2C1B17] border border-stone-700 rounded-xl p-2.5 text-xs text-white">
          <option value="all">All Payment Methods</option>
          <option value="cash">Cash</option>
          <option value="telebirr">Telebirr</option>
          <option value="cbe">CBE Birr</option>
          <option value="card">Card</option>
          <option value="online">Online (legacy)</option>
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="bg-[#2C1B17] border border-stone-700 rounded-xl p-2.5 text-xs text-white">
          <option value="all">All Statuses</option>
          <option value="paid">Paid</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      {/* Orders list */}
      {filtered.length === 0 ? (
        <div className="p-10 bg-[#2C1B17] rounded-2xl border border-stone-800 text-center text-stone-500 text-xs">
          No orders match your search. Paid bills appear here automatically.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filtered.map((o) => (
            <div key={o.id} className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-4 space-y-3">
              {/* header */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-serif font-bold text-amber-100">{o.tableName}</p>
                  <p className="text-[10px] text-stone-500">
                    {fmtTime(o)} • by {o.createdBy || "—"}
                  </p>
                </div>
                <div className="text-right flex flex-col items-end gap-1.5">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`inline-block text-[10px] font-black px-2.5 py-1 rounded-full uppercase ${
                        o.status === "paid" ? "bg-emerald-500/20 text-emerald-400" : o.status === "completed" ? "bg-sky-500/20 text-sky-300" : "bg-rose-500/20 text-rose-400"
                      }`}
                    >
                      {o.status === "paid" ? "✓ PAID" : o.status}
                    </span>
                    <button
                      onClick={() => deleteOrder(o.id, o.tableName, o.totalAmount)}
                      className="p-1.5 bg-rose-500/20 text-rose-400 hover:bg-rose-600 hover:text-white rounded-lg transition"
                      title="Delete this order record"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <p className="font-serif font-black text-lg text-[#C9A227]">{o.totalAmount} ETB</p>
                </div>
              </div>

              {/* payment + receipt */}
              <div className="flex items-center justify-between bg-black/30 rounded-xl px-3 py-2">
                <span className="flex items-center gap-1.5 text-xs font-bold capitalize">
                  {methodIcon(o.paymentMethod)} {o.paymentMethod || "cash"} payment
                </span>
                {(o.status === "paid" || o.status === "completed") && o.paymentMethod !== "cash" && (
                  <button
                    onClick={async () => {
                      const r = await fetch(`/api/tickets/receipt?id=${o.id}`);
                      const d = await r.json();
                      if (d.receiptImage) setReceiptModal(d.receiptImage);
                    }}
                    className="flex items-center gap-1 text-[10px] font-bold text-sky-300 bg-sky-900/40 px-2 py-1 rounded-lg hover:bg-sky-800"
                  >
                    <ImageIcon className="w-3 h-3" /> Receipt
                  </button>
                )}
              </div>

              {/* items */}
              <div className="bg-[#3D2314] rounded-xl p-3 space-y-1.5">
                {(o.items || []).map((i: TicketItem) => (
                  <div key={i.id} className={`text-xs flex justify-between gap-2 ${i.removed ? "opacity-40 line-through" : ""}`}>
                    <div className="flex-1 min-w-0">
                      <span className="text-stone-200">
                        {i.name} <span className="text-stone-500">x{i.quantity}</span>
                      </span>
                      {i.notes && <p className="text-[10px] text-amber-300/80 italic">📝 {i.notes}</p>}
                    </div>
                    <span className="font-bold text-amber-200 shrink-0">{i.price * i.quantity} ETB</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* receipt modal */}
      {receiptModal && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" onClick={() => setReceiptModal(null)}>
          <button className="absolute top-4 right-4 text-white"><X className="w-6 h-6" /></button>
          <img src={receiptModal} alt="Receipt" className="max-h-[85vh] max-w-full rounded-2xl border border-[#C9A227]" />
        </div>
      )}
    </div>
  );
}
