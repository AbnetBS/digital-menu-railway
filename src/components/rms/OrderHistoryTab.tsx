"use client";

import { useState, useEffect, useMemo } from "react";
import { Search, RefreshCw, ImageIcon, X, Trash2 } from "lucide-react";
import { Ticket } from "@/types";
import { formatDateTime, groupOrderLines, type OrderLine } from "@/lib/order-lines";

const historyStatusOf = (t: Ticket) => t.historyStatus || (t.status === "cancelled" ? "cancelled" : "done");

const historyStatusMeta = (t: Ticket) => {
  const status = historyStatusOf(t);
  if (status === "edited_printed") return { label: t.historyStatusLabel || "Edited & Printed", cls: "bg-sky-500/20 text-sky-300" };
  if (status === "edited_cancelled") return { label: t.historyStatusLabel || "Edited & Cancelled", cls: "bg-rose-500/20 text-rose-200" };
  if (status === "cancelled") return { label: t.historyStatusLabel || "Cancelled", cls: "bg-rose-500/20 text-rose-400" };
  return { label: t.historyStatusLabel || "Done", cls: "bg-emerald-500/20 text-emerald-400" };
};

export default function OrderHistoryTab() {
  const [orders, setOrders] = useState<Ticket[]>([]);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [receiptModal, setReceiptModal] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  const load = async () => {
    const r = await fetch("/api/reports");
    // The admin cookie lives 7 days; when it dies this tab would show stale
    // history forever. Say so instead, with the way back.
    if (r.status === 401) {
      setExpired(true);
      return;
    }
    if (r.ok) {
      setExpired(false);
      const d = await r.json();
      setOrders(d.orderHistory || []);
    }
  };

  const cleanOldReceipts = async () => {
    if (
      !confirm(
        "Free up storage?\n\nPermanently deletes receipt PHOTOS of finished bills older than 30 days (completed, closed, paid, cancelled).\nOrder records (items, totals) stay in history."
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
        const searchText = [
          o.tableName,
          o.serviceNote,
          o.createdBy,
          o.status,
          o.historyStatus,
          o.historyStatusLabel,
          o.historyChangeSummary,
          o.orderType,
          (o.closedAt || o.updatedAt ? new Date(o.closedAt || o.updatedAt!).toLocaleDateString() : ""),
          ...(o.auditTrail || []).flatMap((event) => [event.label, event.detail, event.actorName]),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        const matchQ = !q || searchText.includes(q.toLowerCase());
        const matchS = statusFilter === "all" || historyStatusOf(o) === statusFilter;
        return matchQ && matchS;
      }),
    [orders, q, statusFilter]
  );

  const fmtTime = (t: Ticket) => {
    const d = t.closedAt || t.updatedAt;
    return d ? new Date(d).toLocaleString() : "n/a";
  };

  /**
   * One line per dish, however many times the table added it during the visit.
   * New orders are already merged in the database; this collapses the duplicates
   * left on bills created before that, so history reads "2 Tea" not "1 Tea, 1 Tea".
   */
  const displayItems = (t: Ticket) => groupOrderLines((t.items || []) as OrderLine[], { includeRemoved: true });

  return (
    <div className="space-y-5">
      {expired && (
        <div className="bg-rose-900/60 border border-rose-500 text-rose-200 text-xs p-3 rounded-xl font-bold">
          Your admin session ended. Reload the page and log in again to see fresh history.
        </div>
      )}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-serif font-bold text-amber-100">Order History ({filtered.length})</h2>
          {/* The list is the newest finished bills of the report's rolling window
              (today plus the 29 Ethiopian days before it). Say so: the owner's
              rule is that NOTHING is ever deleted, so an older bill is not lost,
              it has simply slid out of the window the reports read. */}
          <p className="text-xs text-stone-400">
            Newest finished bills of the last 30 days (today plus the 29 days before it) with audit trail • older bills
            are still stored, they just slide out of this window • search by date, table, waiter, outdoor note or status.
          </p>
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

      {/* Filters (no payment-method options — owner's decision) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search table, waiter, outdoor note, date..."
            className="w-full bg-[#2C1B17] border border-stone-700 rounded-xl pl-9 pr-3 py-2.5 text-xs text-white"
          />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="bg-[#2C1B17] border border-stone-700 rounded-xl p-2.5 text-xs text-white">
          <option value="all">All Statuses</option>
          <option value="done">Done</option>
          <option value="edited_printed">Edited &amp; Printed</option>
          <option value="edited_cancelled">Edited &amp; Cancelled</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      {/* Orders list */}
      {filtered.length === 0 ? (
        <div className="p-10 bg-[#2C1B17] rounded-2xl border border-stone-800 text-center text-stone-500 text-xs">
          No orders match your search. Closed and paid bills appear here automatically.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filtered.map((o) => {
            const meta = historyStatusMeta(o);
            return (
            <div key={o.id} className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-4 space-y-3">
              {/* header */}
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-serif font-bold text-amber-100">{o.tableName}</p>
                    {o.orderType === "outdoor" && (
                      <span className="inline-block text-[10px] font-black px-2.5 py-1 rounded-full uppercase bg-violet-500/20 text-violet-300 border border-violet-500/40">
                        {/^GROUP \d+$/i.test(String(o.tableName || "")) ? "👥 Group" : "Outdoor"}
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-stone-500">
                    {fmtTime(o)} • by {o.createdBy || "staff"}
                  </p>
                  {/* Group 8: when the order actually ARRIVED, not just when it closed. */}
                  <p className="text-[10px] text-stone-500">
                    🕒 arrived {formatDateTime(o.createdAt)}
                  </p>
                  {o.serviceNote && <p className="text-[11px] text-sky-300 font-bold mt-1">📍 {o.serviceNote}</p>}
                </div>
                <div className="text-right flex flex-col items-end gap-1.5">
                  <div className="flex items-center gap-1.5 flex-wrap justify-end">
                    <span className={`inline-block text-[10px] font-black px-2.5 py-1 rounded-full uppercase ${meta.cls}`}>
                      {meta.label}
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

              {/* receipt photo (bills that have one open it; others do nothing) */}
              {(o.status === "paid" || o.status === "completed") && (
                <div className="flex items-center justify-end bg-black/30 rounded-xl px-3 py-2">
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
                </div>
              )}

              {/* items */}
              <div className="bg-[#3D2314] rounded-xl p-3 space-y-1.5">
                {displayItems(o).map((i) => (
                  <div key={i.ids.join("-")} className={`text-xs flex justify-between gap-2 ${i.removed ? "opacity-40 line-through" : ""}`}>
                    <div className="flex-1 min-w-0">
                      <span className="text-stone-200">
                        {i.name} <span className="text-stone-500">x{i.quantity}</span>
                      </span>
                      {i.notes && <p className="text-[10px] text-amber-300/80 italic">📝 {i.notes}</p>}
                    </div>
                    <span className="font-bold text-amber-200 shrink-0">{Number(i.price ?? 0) * i.quantity} ETB</span>
                  </div>
                ))}
              </div>

              {(o.historyChangeSummary || (o.auditTrail || []).length > 0) && (
                <div className="bg-black/25 border border-stone-800 rounded-xl p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-extrabold uppercase tracking-wider text-amber-200">Audit Trail</p>
                    {o.historyChangeSummary && <p className="text-[10px] font-bold text-sky-300 text-right">{o.historyChangeSummary}</p>}
                  </div>
                  <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
                    {(o.auditTrail || []).map((event) => (
                      <div key={event.id} className="rounded-lg bg-[#241714] border border-stone-800 px-2.5 py-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-[11px] font-black text-stone-200">{event.label}</p>
                            {event.detail && <p className="text-[10px] text-stone-400 mt-0.5 break-words">{event.detail}</p>}
                          </div>
                          <span className="shrink-0 text-[10px] font-bold text-stone-500">{formatDateTime(event.createdAt)}</span>
                        </div>
                      </div>
                    ))}
                    {(o.auditTrail || []).length === 0 && (
                      <p className="text-[11px] text-stone-500">Older record with no detailed audit entries saved yet.</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          );})}
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
