"use client";

import { useState, useEffect } from "react";
import { TrendingUp, ShoppingBag, CreditCard, Banknote, Smartphone, RefreshCw, ImageIcon, Award, PieChart } from "lucide-react";
import { ReportData } from "@/types";

export default function ReportsTab() {
  const [data, setData] = useState<ReportData | null>(null);
  const [receiptModal, setReceiptModal] = useState<string | null>(null);

  const load = async () => {
    const r = await fetch("/api/reports");
    if (r.ok) setData(await r.json());
  };

  useEffect(() => {
    load();
  }, []);

  const fmt = (n: number) => n.toLocaleString("en-US") + " ETB";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-serif font-bold text-amber-100">Today's Reports & Analytics</h2>
          <p className="text-xs text-stone-400">Live numbers from paid & completed bills — refreshes from the database.</p>
        </div>
        <button onClick={load} className="p-2 bg-white/10 hover:bg-white/20 text-amber-200 rounded-xl" title="Refresh">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {!data ? (
        <div className="p-10 text-center text-stone-500 text-sm">Loading reports...</div>
      ) : (
        <>
          {/* TIME INTERVAL cards — Today / Yesterday / Last Week / Last Month */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {(
              [
                { label: "Today", rev: data.todayRevenue, cnt: data.todayOrders, hl: true },
                { label: "Yesterday", rev: data.yesterdayRevenue || 0, cnt: data.yesterdayOrders || 0, hl: false },
                { label: "Last 7 Days", rev: data.weeklyRevenue || 0, cnt: data.weekOrders || 0, hl: false },
                { label: "Last 30 Days", rev: data.monthlyRevenue || 0, cnt: data.monthOrders || 0, hl: false },
              ] as const
            ).map((p) => (
              <div
                key={p.label}
                className={`rounded-2xl p-4 ${
                  p.hl
                    ? "bg-gradient-to-br from-[#C9A227] to-[#8C6D18] text-[#2C1B17]"
                    : "bg-[#2C1B17] border border-stone-800 text-white"
                }`}
              >
                <p className={`text-[10px] font-extrabold uppercase tracking-wider ${p.hl ? "opacity-80" : "text-stone-400"}`}>
                  {p.label}
                </p>
                <p className="font-serif font-black text-xl">{fmt(p.rev)}</p>
                <p className={`text-[10px] font-bold mt-0.5 ${p.hl ? "opacity-70" : "text-stone-500"}`}>{p.cnt} order(s)</p>
              </div>
            ))}
          </div>

          {/* KPI cards */}
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="bg-[#2C1B17] rounded-2xl p-5 border border-stone-800">
              <ShoppingBag className="w-5 h-5 mb-2 text-[#C9A227]" />
              <p className="text-[10px] font-extrabold uppercase tracking-wider text-stone-400">Orders Today</p>
              <p className="font-serif font-black text-2xl text-white">{data.todayOrders}</p>
            </div>
            <div className="bg-[#2C1B17] rounded-2xl p-5 border border-stone-800">
              <PieChart className="w-5 h-5 mb-2 text-[#C9A227]" />
              <p className="text-[10px] font-extrabold uppercase tracking-wider text-stone-400">Avg. Order Value</p>
              <p className="font-serif font-black text-2xl text-white">{fmt(data.averageOrderValue)}</p>
            </div>
            <div className="bg-[#2C1B17] rounded-2xl p-5 border border-stone-800">
              <Award className="w-5 h-5 mb-2 text-[#C9A227]" />
              <p className="text-[10px] font-extrabold uppercase tracking-wider text-stone-400">Payment Methods</p>
              <div className="flex gap-2 mt-1">
                {data.paymentStats.length === 0 && <span className="text-xs text-stone-500">No payments yet</span>}
                {data.paymentStats.map((p) => (
                  <span key={p.method} className="text-[11px] font-bold text-white bg-white/10 px-2 py-1 rounded-lg capitalize">
                    {p.method}: {p.count}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Peak selling hours */}
            <div className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-5">
              <h3 className="text-sm font-bold text-amber-200 uppercase tracking-wider mb-1">⏰ Peak Selling Hours (Today)</h3>
              {data.peakHour ? (
                <>
                  <p className="text-[11px] text-emerald-400 font-bold mb-3">
                    🔥 Busiest: {data.peakHour.hour}:00 – {data.peakHour.hour + 1}:00 ({data.peakHour.orders} orders, {data.peakHour.revenue.toLocaleString()} ETB)
                  </p>
                  <div className="space-y-2">
                    {(data.hourlySales || [])
                      .sort((a, b) => a.hour - b.hour)
                      .map((h) => {
                        const max = Math.max(...(data.hourlySales || [{ revenue: 1 }]).map((x) => x.revenue), 1);
                        return (
                          <div key={h.hour} className="flex items-center gap-2 text-[11px]">
                            <span className="w-14 font-bold text-stone-400">{h.hour}:00</span>
                            <div className="flex-1 h-3 bg-black/40 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${h.hour === data.peakHour?.hour ? "bg-gradient-to-r from-rose-500 to-[#C9A227]" : "bg-[#C9A227]/60"}`}
                                style={{ width: `${(h.revenue / max) * 100}%` }}
                              />
                            </div>
                            <span className="w-16 text-right font-bold text-[#C9A227]">{h.orders} ord</span>
                          </div>
                        );
                      })}
                  </div>
                </>
              ) : (
                <p className="text-xs text-stone-500">No sales yet today — peaks will appear once the first bills close.</p>
              )}
            </div>

            {/* Popular items */}
            <div className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-5">
              <h3 className="text-sm font-bold text-amber-200 uppercase tracking-wider mb-4">🏆 Highest-Selling Foods (Today)</h3>
              {data.popularItems.length === 0 ? (
                <p className="text-xs text-stone-500">No sales yet today.</p>
              ) : (
                <div className="space-y-2">
                  {data.popularItems.map((it, idx) => (
                    <div key={it.name} className="flex items-center gap-3 text-xs">
                      <span className="w-6 h-6 rounded-full bg-[#C9A227]/20 text-[#C9A227] font-black flex items-center justify-center text-[10px]">
                        {idx + 1}
                      </span>
                      <span className="flex-1 font-bold text-amber-100 truncate">{it.name}</span>
                      <span className="text-stone-400">x{it.quantity}</span>
                      <span className="font-extrabold text-[#C9A227]">{fmt(it.revenue)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Category sales */}
            <div className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-5">
              <h3 className="text-sm font-bold text-amber-200 uppercase tracking-wider mb-4">Sales by Category (Today)</h3>
              {data.categorySales.length === 0 ? (
                <p className="text-xs text-stone-500">No sales yet today.</p>
              ) : (
                <div className="space-y-3">
                  {data.categorySales.map((c) => {
                    const maxRev = Math.max(...data.categorySales.map((x) => x.revenue), 1);
                    return (
                      <div key={c.category}>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="font-bold text-amber-100 capitalize">{c.category}</span>
                          <span className="font-extrabold text-[#C9A227]">{fmt(c.revenue)}</span>
                        </div>
                        <div className="h-2 bg-black/40 rounded-full overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-[#C9A227] to-amber-500 rounded-full" style={{ width: `${(c.revenue / maxRev) * 100}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Payment stats — covers cash / telebirr / cbe / card (and legacy "online") */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {(
              [
                { m: "cash", label: "Cash", icon: <Banknote className="w-6 h-6 text-emerald-400" /> },
                { m: "telebirr", label: "Telebirr", icon: <Smartphone className="w-6 h-6 text-amber-400" /> },
                { m: "cbe", label: "CBE Birr", icon: <Smartphone className="w-6 h-6 text-violet-400" /> },
                { m: "card", label: "Card", icon: <CreditCard className="w-6 h-6 text-sky-400" /> },
                { m: "online", label: "Online (legacy)", icon: <Smartphone className="w-6 h-6 text-amber-400" /> },
              ] as const
            ).map(({ m, label, icon }) => {
              const found = data.paymentStats.find((p) => p.method === m);
              return (
                <div key={m} className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-4 flex items-center gap-3">
                  {icon}
                  <div>
                    <p className="text-[10px] uppercase font-extrabold text-stone-400">{label}</p>
                    <p className="font-serif font-black text-lg text-white">{found ? fmt(found.revenue) : "0 ETB"}</p>
                    <p className="text-[10px] text-stone-500">{found ? found.count : 0} payment(s)</p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Receipt photos */}
          <div className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-5">
            <h3 className="text-sm font-bold text-amber-200 uppercase tracking-wider mb-4 flex items-center gap-2">
              <ImageIcon className="w-4 h-4 text-[#C9A227]" /> Receipt Photos (Digital Payment Verification)
            </h3>
            {data.receipts.length === 0 ? (
              <p className="text-xs text-stone-500">No receipt photos uploaded yet. They appear when waiters photograph card/online receipts.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {data.receipts.map((r) => (
                  <button
                    key={r.id}
                    onClick={async () => {
                      // load the photo only WHEN the owner click-idle — never bundled in reports
                      const resp = await fetch(`/api/tickets/receipt?id=${r.id}`);
                      const d = await resp.json();
                      if (d.receiptImage) setReceiptModal(d.receiptImage);
                    }}
                    className="group text-left bg-black/30 border border-stone-700 rounded-xl p-3 hover:border-[#C9A227] transition"
                  >
                    <p className="text-[11px] font-bold text-amber-100 truncate">{r.tableName}</p>
                    <p className="text-[10px] text-stone-500 capitalize">{r.method} • {r.totalAmount} ETB</p>
                    <span className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-extrabold text-sky-300">
                      📷 View Receipt
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {receiptModal && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" onClick={() => setReceiptModal(null)}>
          <img src={receiptModal} alt="Receipt" className="max-h-[85vh] max-w-full rounded-2xl border border-[#C9A227]" />
        </div>
      )}
    </div>
  );
}
