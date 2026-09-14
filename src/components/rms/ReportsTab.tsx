"use client";

import { useState, useEffect } from "react";
import { TrendingUp, ShoppingBag, RefreshCw, ImageIcon, PieChart, Coffee, CookingPot, Printer, XCircle, Users } from "lucide-react";
import { ReportData, Ticket } from "@/types";
import { formatClock, formatDateTime } from "@/lib/order-lines";

type Period = "today" | "yesterday" | "week" | "month";

const PERIOD_LABELS: Record<Period, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Last 7 Days",
  month: "Last 30 Days",
};

/** Plain-language empty-state suffix per period ("No sales …"). */
const PERIOD_EMPTY: Record<Period, string> = {
  today: "yet today",
  yesterday: "yesterday",
  week: "in the last 7 days",
  month: "in the last 30 days",
};

/** How the printed paper names the period it covers ("This paper covers …"). */
const PERIOD_COVER: Record<Period, string> = {
  today: "today's sales",
  yesterday: "yesterday's sales",
  week: "the last 7 days of sales",
  month: "the last 30 days of sales",
};

export default function ReportsTab() {
  const [data, setData] = useState<ReportData | null>(null);
  // The selected period: the four cards above are the switch, and EVERY section
  // below (cross-check, KPIs, peak hours, highest-selling, categories, printed
  // bills, receipts) describes only this period. The server computes it all —
  // the client just re-fetches with ?period=.
  const [period, setPeriod] = useState<Period>("today");
  const [receiptModal, setReceiptModal] = useState<string | null>(null);
  // The printed-bills archive card that is expanded into the full bill.
  const [billModal, setBillModal] = useState<Ticket | null>(null);
  const [waiterModal, setWaiterModal] = useState<string | null>(null);
  // Cafe letterhead (name, address, phone, logo) for the printed paper.
  const [brand, setBrand] = useState<Record<string, string>>({});
  const [expired, setExpired] = useState(false);

  const load = async (p: Period) => {
    const r = await fetch(`/api/reports?period=${p}`);
    // The admin cookie lives 7 days; when it dies this tab would show stale
    // figures forever. Say so instead, with the way back.
    if (r.status === 401) {
      setExpired(true);
      return;
    }
    if (r.ok) {
      setExpired(false);
      setData(await r.json());
    }
  };

  useEffect(() => {
    load("today");
    // The printed paper needs the cafe's real name, address and phone.
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : {}))
      .then((s) => setBrand(s || {}))
      .catch(() => {});
  }, []);

  const switchPeriod = (p: Period) => {
    if (p === period) return;
    setPeriod(p);
    load(p);
  };

  const fmt = (n: number) => n.toLocaleString("en-US") + " ETB";

  const stationMeta: Record<string, { label: string; icon: React.ReactNode; cls: string }> = {
    barista: { label: "Barista", icon: <Coffee className="w-5 h-5 text-amber-300" />, cls: "border-amber-700/60" },
    kitchen: { label: "Kitchen (Chef)", icon: <CookingPot className="w-5 h-5 text-emerald-300" />, cls: "border-emerald-700/60" },
    buna: { label: "Buna Makers", icon: <span className="text-xl leading-none">🫖</span>, cls: "border-orange-700/60" },
    juice: { label: "Juice Maker", icon: <span className="text-xl leading-none">🧃</span>, cls: "border-lime-700/60" },
  };

  const label = data?.periodLabel || PERIOD_LABELS[period];
  const emptySuffix = PERIOD_EMPTY[period];
  // KPI numbers follow the selected period (the four summary fields are always
  // all-period, so the client picks the matching pair here).
  const kpiRevenue =
    period === "yesterday" ? data?.yesterdayRevenue || 0
    : period === "week" ? data?.weeklyRevenue || 0
    : period === "month" ? data?.monthlyRevenue || 0
    : data?.todayRevenue || 0;
  const kpiOrders =
    period === "yesterday" ? data?.yesterdayOrders || 0
    : period === "week" ? data?.weekOrders || 0
    : period === "month" ? data?.monthOrders || 0
    : data?.todayOrders || 0;
  const kpiAvg = kpiOrders > 0 ? Math.round(kpiRevenue / kpiOrders) : 0;
  const waiterOrders = data?.waiterOrders || [];
  const waiterDetails = waiterModal ? waiterOrders.filter((row) => row.waiterName === waiterModal) : [];

  return (
    <div id="fana-report" className="space-y-6">
      {/* PRINT STYLES: the owner prints this report on the EFD-connected office
          computer. Screen-only controls hide; the dark cafe theme flattens to
          black-on-white so it reads on paper; bar fills stay visible; capped
          scroll areas expand so nothing is cut off. */}
      <style>{`
        .print-only { display: none; }
        @media print {
          @page { margin: 12mm; }
          body { background: #fff !important; }
          #fana-admin { background: #fff !important; padding: 0 !important; }
          .no-print { display: none !important; }
          .print-only { display: block !important; }
          #fana-report, #fana-report * {
            background-color: #fff !important;
            background-image: none !important;
            color: #000 !important;
            border-color: #888 !important;
            box-shadow: none !important;
            text-shadow: none !important;
          }
          #fana-report .print-bar { background-color: #333 !important; }
          #fana-report .print-scroll { max-height: none !important; overflow: visible !important; }
        }
      `}</style>

      {/* OFFICIAL LETTERHEAD, print only: this paper leaves the office, so it
          carries the logo and the full PLC name in English and Amharic. The
          address and phone are left BLANK: the person who writes the report
          fills in their own name, phone and address by hand. */}
      <div className="print-only" style={{ borderBottom: "3px double #000", paddingBottom: 10, marginBottom: 12 }}>
        <div style={{ textAlign: "center" }}>
          <img src={brand.logo_url || "/logo.png"} alt="Fana Cafe and Restaurant logo" style={{ height: 60, margin: "0 auto 6px" }} />
          <h1 style={{ fontSize: "22px", fontWeight: 900 }}>Fana Cafe and Restaurant PLC</h1>
          <p style={{ fontSize: "15px", fontWeight: 700 }}>ፋና ካፌ እና ሬስቶራንት ኃ.የተ.የ.ግ.ማ.</p>
        </div>
        <div style={{ fontSize: "12px", marginTop: 8, lineHeight: 2.2 }}>
          <p>Prepared by (name): ................................................................</p>
          <p>Phone: .................................... Address: ........................................................</p>
        </div>
        <div style={{ textAlign: "center" }}>
          <p style={{ fontSize: "14px", fontWeight: 800, marginTop: 8 }}>Sales Report ({label})</p>
          <p style={{ fontSize: "11px" }}>
            This paper covers {PERIOD_COVER[period]} and was printed {new Date().toLocaleString()}. Every amount on it
            comes from bills keyed into the EFD or marked paid.
          </p>
        </div>
      </div>

      {expired && (
        <div className="bg-rose-900/60 border border-rose-500 text-rose-200 text-xs p-3 rounded-xl font-bold no-print">
          Your admin session ended. Reload the page and log in again to see fresh figures.
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-serif font-bold text-amber-100">Sales Reports &amp; Analytics</h2>
          <p className="text-xs text-stone-400">
            Showing <strong className="text-amber-200">{label}</strong> • every bill keyed into the EFD (printed) or marked paid. Tap a period card below to switch.
          </p>
        </div>
        <div className="flex items-center gap-2 no-print">
          <button
            onClick={() => window.print()}
            className="bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-black text-xs uppercase px-4 py-2.5 rounded-xl flex items-center gap-2"
            title={`Print the ${label} report on this computer (EFD office PC)`}
          >
            <Printer className="w-4 h-4" /> Print Report
          </button>
          <button onClick={() => load(period)} className="p-2.5 bg-white/10 hover:bg-white/20 text-amber-200 rounded-xl" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {!data ? (
        <div className="p-10 text-center text-stone-500 text-sm">Loading reports...</div>
      ) : (
        <>
          {/* TIME INTERVAL cards — Today / Yesterday / Last 7 Days / Last 30 Days.
              These are the PERIOD SWITCH: tapping one reloads every section below
              for that period (the selected card is gold). */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {(
              [
                { key: "today", label: "Today", rev: data.todayRevenue, cnt: data.todayOrders },
                { key: "yesterday", label: "Yesterday", rev: data.yesterdayRevenue || 0, cnt: data.yesterdayOrders || 0 },
                { key: "week", label: "Last 7 Days", rev: data.weeklyRevenue || 0, cnt: data.weekOrders || 0 },
                { key: "month", label: "Last 30 Days", rev: data.monthlyRevenue || 0, cnt: data.monthOrders || 0 },
              ] as const
            ).map((p) => (
              <button
                key={p.key}
                onClick={() => switchPeriod(p.key)}
                title={`Show every section below for ${p.label}`}
                className={`rounded-2xl p-4 text-left transition active:scale-[0.98] ${
                  period === p.key
                    ? "bg-gradient-to-br from-[#C9A227] to-[#8C6D18] text-[#2C1B17]"
                    : "bg-[#2C1B17] border border-stone-800 text-white hover:border-[#C9A227]/60"
                }`}
              >
                <p className={`text-[10px] font-extrabold uppercase tracking-wider ${period === p.key ? "opacity-80" : "text-stone-400"}`}>
                  {p.label}
                </p>
                <p className="font-serif font-black text-xl">{fmt(p.rev)}</p>
                <p className={`text-[10px] font-bold mt-0.5 ${period === p.key ? "opacity-70" : "text-stone-500"}`}>{p.cnt} order(s)</p>
              </button>
            ))}
          </div>

          {/* ═══ CROSS-CHECK BY STATION — the paper world's four piles ═══
              Before this system the cross-checker collected the kitchen's, the
              barista's, the buna makers' and the juice maker's order papers, added
              each pile and compared the total with the cashier's EFD receipts.
              These four cards ARE those piles: the period's sales split by who
              prepared them. */}
          <div className="bg-[#2C1B17] rounded-2xl border border-[#C9A227]/40 p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-amber-200 uppercase tracking-wider">📋 Cross-Check by Station ({label})</h3>
                <p className="text-[11px] text-stone-400 mt-0.5">
                  Each crew&rsquo;s pile of the period&rsquo;s sales, split per item. Add the four totals and compare with the EFD receipt pile below.
                </p>
              </div>
              <div className="text-right">
                <p className="text-[10px] font-extrabold uppercase text-stone-400">Barista + Kitchen + Buna + Juice</p>
                <p className="font-serif font-black text-xl text-[#C9A227]">
                  {fmt((data.stationSales || []).reduce((s, x) => s + (x.revenue || 0), 0))}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
              {(data.stationSales || []).map((s) => {
                const meta = stationMeta[s.station] || stationMeta.kitchen;
                const items = (data.stationItems || []).filter((i) => i.station === s.station);
                return (
                  <div key={s.station} className={`bg-[#3D2314] rounded-2xl border ${meta.cls} p-4 space-y-3`}>
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-2 text-sm font-black text-amber-100">
                        {meta.icon} {meta.label}
                      </span>
                      <span className="text-[10px] font-bold text-stone-400">{s.orders} bill(s)</span>
                    </div>
                    <div className="flex items-end justify-between gap-2">
                      <div>
                        <p className="text-[10px] uppercase font-extrabold text-stone-400">Items sold</p>
                        <p className="font-serif font-black text-2xl text-white">{s.quantity}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] uppercase font-extrabold text-stone-400">Total sell</p>
                        <p className="font-serif font-black text-2xl text-[#C9A227]">{fmt(s.revenue)}</p>
                      </div>
                    </div>
                    <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1 print-scroll">
                      {items.length === 0 ? (
                        <p className="text-xs text-stone-500">Nothing sold from this station {emptySuffix}.</p>
                      ) : (
                        items.map((i) => (
                          <div key={`${i.station}-${i.name}`} className="flex items-center justify-between gap-2 text-xs bg-black/25 rounded-lg px-2.5 py-1.5">
                            <span className="font-bold text-amber-100 truncate">{i.name}</span>
                            <span className="shrink-0 text-stone-400 font-bold">x{i.quantity}</span>
                            <span className="shrink-0 font-extrabold text-[#C9A227]">{i.revenue.toLocaleString("en-US")}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* KPI cards (selected period). Payment methods were removed by the
              owner — the EFD is the money system of record, so the third card
              counts item units sold instead. */}
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="bg-[#2C1B17] rounded-2xl p-5 border border-stone-800">
              <ShoppingBag className="w-5 h-5 mb-2 text-[#C9A227]" />
              <p className="text-[10px] font-extrabold uppercase tracking-wider text-stone-400">Orders ({label})</p>
              <p className="font-serif font-black text-2xl text-white">{kpiOrders}</p>
            </div>
            <div className="bg-[#2C1B17] rounded-2xl p-5 border border-stone-800">
              <PieChart className="w-5 h-5 mb-2 text-[#C9A227]" />
              <p className="text-[10px] font-extrabold uppercase tracking-wider text-stone-400">Avg. Order Value</p>
              <p className="font-serif font-black text-2xl text-white">{fmt(kpiAvg)}</p>
            </div>
            <div className="bg-[#2C1B17] rounded-2xl p-5 border border-stone-800">
              <TrendingUp className="w-5 h-5 mb-2 text-[#C9A227]" />
              <p className="text-[10px] font-extrabold uppercase tracking-wider text-stone-400">Items Sold ({label})</p>
              <p className="font-serif font-black text-2xl text-white">{(data.totalItems || 0).toLocaleString("en-US")}</p>
            </div>
          </div>

          <div className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <div>
                <h3 className="text-sm font-bold text-amber-200 uppercase tracking-wider flex items-center gap-2">
                  <Users className="w-4 h-4 text-[#C9A227]" /> Waiter Ranking ({label})
                </h3>
                <p className="text-[11px] text-stone-400 mt-0.5">
                  Separate counts for accepted orders and directly created/sent orders. Tap a waiter to see the underlying order list.
                </p>
              </div>
            </div>
            {(data.waiterRanking || []).length === 0 ? (
              <p className="text-xs text-stone-500">No waiter activity {emptySuffix}.</p>
            ) : (
              <div className="space-y-2">
                {(data.waiterRanking || []).map((waiter, idx) => (
                  <button
                    key={waiter.name}
                    onClick={() => setWaiterModal(waiter.name)}
                    className="w-full text-left bg-[#241714] border border-stone-800 hover:border-[#C9A227]/50 rounded-2xl px-4 py-3 transition active:scale-[0.99]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-black text-amber-100 flex items-center gap-2">
                          <span className="w-6 h-6 rounded-full bg-[#C9A227]/20 text-[#C9A227] flex items-center justify-center text-[10px]">{idx + 1}</span>
                          <span className="truncate">{waiter.name}</span>
                        </p>
                        <p className="text-[10px] font-bold text-stone-500 mt-1">Tap to view this waiter&apos;s orders</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 justify-end">
                        <span className="text-[10px] font-black px-2.5 py-1 rounded-full bg-sky-500/20 text-sky-300">
                          Accepted {waiter.acceptedOrders}
                        </span>
                        <span className="text-[10px] font-black px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-300">
                          Direct {waiter.directOrders}
                        </span>
                        <span className="text-[10px] font-black px-2.5 py-1 rounded-full bg-[#C9A227]/20 text-[#C9A227]">
                          Total {waiter.totalActions}
                        </span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Peak selling hours */}
            <div className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-5">
              <h3 className="text-sm font-bold text-amber-200 uppercase tracking-wider mb-1">⏰ Peak Selling Hours ({label})</h3>
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
                                className={`h-full rounded-full print-bar ${h.hour === data.peakHour?.hour ? "bg-gradient-to-r from-rose-500 to-[#C9A227]" : "bg-[#C9A227]/60"}`}
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
                <p className="text-xs text-stone-500">No sales {emptySuffix}. Peaks will appear once the first bills close.</p>
              )}
            </div>

            {/* Popular items */}
            <div className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-5">
              <h3 className="text-sm font-bold text-amber-200 uppercase tracking-wider mb-4">🏆 Highest-Selling Foods ({label})</h3>
              {data.popularItems.length === 0 ? (
                <p className="text-xs text-stone-500">No sales {emptySuffix}.</p>
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
              <h3 className="text-sm font-bold text-amber-200 uppercase tracking-wider mb-4">Sales by Category ({label})</h3>
              {data.categorySales.length === 0 ? (
                <p className="text-xs text-stone-500">No sales {emptySuffix}.</p>
              ) : (
                <div className="space-y-3">
                  {data.categorySales.map((c) => {
                    const maxRev = Math.max(...data.categorySales.map((x) => x.revenue), 1);
                    return (
                      <div key={c.category}>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="font-bold text-amber-100 capitalize">{c.category}</span>
                          <span className="font-bold text-stone-400">{(c.quantity || 0).toLocaleString("en-US")} sold</span>
                          <span className="font-extrabold text-[#C9A227]">{fmt(c.revenue)}</span>
                        </div>
                        <div className="h-2 bg-black/40 rounded-full overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-[#C9A227] to-amber-500 rounded-full print-bar" style={{ width: `${(c.revenue / maxRev) * 100}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* ═══ PRINTED BILLS — the archive registered as history ═══
              The same list the cashier sees below her tables: every bill keyed
              into the EFD in the selected period, open or already cleared. This is
              the digital receipt pile the cross-checker compares with the station
              piles above. Tap any card to open the whole bill. Screen only: the
              printed paper carries just the one-line EFD total below instead of
              this whole archive of bills. */}
          <div className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-5 no-print">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <h3 className="text-sm font-bold text-amber-200 uppercase tracking-wider flex items-center gap-2">
                <Printer className="w-4 h-4 text-[#C9A227]" /> Printed Bills ({label}) • {(data.printedToday || []).length}
                {data.archiveCapped ? ` of ${data.archiveTotal}` : ""}
              </h3>
              <div className="text-right">
                <p className="text-[10px] font-extrabold uppercase text-stone-400">Total printed (compare with the EFD pile)</p>
                <p className="font-serif font-black text-xl text-emerald-400">{fmt(data.printedTodayTotal || 0)}</p>
              </div>
            </div>
            {data.archiveCapped && (
              <p className="text-[11px] font-bold text-amber-300 bg-amber-950/40 border border-amber-700/40 rounded-xl px-3 py-2 mb-4">
                Showing the newest {(data.printedToday || []).length} of {data.archiveTotal} bills • the total above covers the whole period.
              </p>
            )}
            {(data.printedToday || []).length === 0 ? (
              <p className="text-xs text-stone-500">
                No bills printed {emptySuffix}. Every bill the cashier taps ✓ PRINTED is registered here for the cross-check.
              </p>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {(data.printedToday || []).map((t) => {
                  const cleared = t.status === "closed";
                  return (
                    <button
                      key={t.id}
                      onClick={() => setBillModal(t)}
                      className={`text-left bg-[#241714] rounded-xl p-3 flex items-center justify-between gap-2 transition hover:bg-[#2e1d18] active:scale-[0.98] border ${
                        cleared ? "border-stone-700" : "border-stone-800"
                      }`}
                      title="Tap to see the full bill"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="text-sm font-black text-amber-100">{t.tableName}</p>
                          {t.orderType === "outdoor" && (
                            <span className="text-[9px] font-black uppercase px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300 border border-violet-500/40">
                              Outdoor
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] font-bold text-stone-300 truncate flex items-center gap-1">
                          <Printer className="w-3 h-3 text-[#C9A227] shrink-0" /> printed {formatClock(t.printedAt)} • {t.printedBy || "cashier"}
                        </p>
                        <p className="text-[11px] font-bold text-stone-300 truncate">🕒 {formatDateTime(t.printedAt || t.createdAt)}</p>
                        <p className="text-[11px] font-bold text-[#D8B93E] truncate">👤 {t.confirmedBy || t.createdBy || "staff"}</p>
                        {t.serviceNote && <p className="text-[10px] font-bold text-sky-300 truncate">📍 {t.serviceNote}</p>}
                        {cleared && (
                          <p className="text-[10px] font-black text-stone-400 uppercase">✓ cleared {t.closedAt ? formatClock(t.closedAt) : ""}</p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-black text-emerald-400">{t.totalAmount} ETB</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Print-only EFD pile summary: the paper keeps the cross-check total
              (bill count plus amount) while the whole bill archive above stays
              on screen, where it belongs. */}
          <div className="print-only" style={{ border: "1px solid #000", padding: "8px 10px" }}>
            <p style={{ fontSize: "13px", fontWeight: 800 }}>
              Bills keyed into the EFD ({label}): {data.archiveTotal || (data.printedToday || []).length} bills • {fmt(data.printedTodayTotal || 0)}
            </p>
            <p style={{ fontSize: "11px" }}>
              The bills themselves live in this screen&apos;s Printed Bills archive and are not listed on this paper. Add
              the four station pile totals above and compare with this EFD pile total. If they match, the day&apos;s sales
              are fully accounted for.
            </p>
          </div>

          {/* Receipt photos */}
          <div className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-5">
            <h3 className="text-sm font-bold text-amber-200 uppercase tracking-wider mb-4 flex items-center gap-2">
              <ImageIcon className="w-4 h-4 text-[#C9A227]" /> Receipt Photos ({label})
            </h3>
            {data.receipts.length === 0 ? (
              <p className="text-xs text-stone-500">No receipt photos {emptySuffix}.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {data.receipts.map((r) => (
                  <button
                    key={r.id}
                    onClick={async () => {
                      // load the photo only WHEN the owner clicks — never bundled in reports
                      const resp = await fetch(`/api/tickets/receipt?id=${r.id}`);
                      const d = await resp.json();
                      if (d.receiptImage) setReceiptModal(d.receiptImage);
                    }}
                    className="group text-left bg-black/30 border border-stone-700 rounded-xl p-3 hover:border-[#C9A227] transition"
                  >
                    <p className="text-[11px] font-bold text-amber-100 truncate">{r.tableName}</p>
                    <p className="text-[10px] text-stone-500">{r.totalAmount} ETB</p>
                    <span className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-extrabold text-sky-300 no-print">
                      📷 View Receipt
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* SIGNATURES, print only: an official paper is signed by the one who
              prepared it and the one who cross-checked it. */}
          <div className="print-only" style={{ marginTop: 8, borderTop: "2px solid #000", paddingTop: 10 }}>
            <p style={{ fontSize: "11px", marginBottom: 18 }}>
              I have compared the station pile totals on this paper with the EFD receipt pile and found them correct.
              Any difference is written down and explained below the signatures.
            </p>
            <div style={{ display: "flex", gap: 32 }}>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: "12px" }}>Prepared by: ..............................</p>
                <p style={{ fontSize: "10px" }}>Name and signature</p>
              </div>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: "12px" }}>Checked by: ..............................</p>
                <p style={{ fontSize: "10px" }}>Name and signature</p>
              </div>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: "12px" }}>Date: ..............................</p>
              </div>
            </div>
          </div>
        </>
      )}

      {waiterModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 no-print" onClick={() => setWaiterModal(null)}>
          <div className="bg-[#2C1B17] border-2 border-[#C9A227]/50 rounded-2xl w-full max-w-3xl max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 bg-[#2C1B17] border-b border-stone-800 px-5 py-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="font-serif font-black text-xl text-amber-100">{waiterModal}</h3>
                <p className="text-xs font-bold text-stone-300 mt-0.5">Orders and sends in {label}</p>
              </div>
              <button onClick={() => setWaiterModal(null)} className="p-2 rounded-lg bg-white/10 text-stone-300 hover:bg-white/20 shrink-0" title="Close">
                <XCircle className="w-5 h-5" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-3">
              {waiterDetails.length === 0 ? (
                <p className="text-xs text-stone-500">No orders for this waiter in {label.toLowerCase()}.</p>
              ) : (
                waiterDetails.map((row, idx) => (
                  <div key={`${row.kind}-${row.ticketId}-${row.happenedAt || idx}`} className="bg-[#3D2314] rounded-xl border border-stone-800 p-3 space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-black text-amber-100">{row.tableName}</p>
                          {row.orderType === "outdoor" && (
                            <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300 border border-violet-500/40">
                              Outdoor
                            </span>
                          )}
                          <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full ${row.kind === "accepted" ? "bg-sky-500/20 text-sky-300" : "bg-emerald-500/20 text-emerald-300"}`}>
                            {row.kind === "accepted" ? "Accepted" : "Direct send"}
                          </span>
                        </div>
                        <p className="text-[11px] font-bold text-stone-300 mt-0.5">
                          {row.orderNumber ? `#${row.orderNumber} • ` : ""}
                          {row.happenedAt ? formatDateTime(row.happenedAt) : "n/a"}
                        </p>
                        {row.serviceNote && <p className="text-[11px] font-bold text-sky-300">📍 {row.serviceNote}</p>}
                        {row.detail && <p className="text-[11px] text-stone-400">{row.detail}</p>}
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-black text-[#C9A227]">{fmt(row.totalAmount)}</p>
                        <p className="text-[10px] font-bold text-stone-400 uppercase">{row.status.replace(/_/g, " ")}</p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* BILL DETAIL MODAL — the printed-bills archive card expanded: every
          item with name, qty, unit price, line total and the bill total. */}
      {billModal && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 no-print"
          onClick={() => setBillModal(null)}
        >
          <div
            className="bg-[#2C1B17] border-2 border-[#C9A227]/50 rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-[#2C1B17] border-b border-stone-800 px-5 py-4 flex items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-serif font-black text-xl text-amber-100">{billModal.tableName}</h3>
                  {billModal.orderType === "outdoor" && (
                    <span className="text-[10px] font-black uppercase px-2.5 py-1 rounded-full bg-violet-500/20 text-violet-300 border border-violet-500/40">
                      Outdoor
                    </span>
                  )}
                </div>
                <p className="text-xs font-bold text-stone-300 mt-0.5">
                  {billModal.orderNumber ? `#${billModal.orderNumber} • ` : ""}
                  {billModal.printedAt
                    ? `printed ${formatDateTime(billModal.printedAt)} • by ${billModal.printedBy || "cashier"}`
                    : `arrived ${formatDateTime(billModal.createdAt)} • by ${billModal.confirmedBy || billModal.createdBy || "staff"}`}
                </p>
                <p className="text-xs font-bold text-stone-300">
                  {billModal.status === "closed"
                    ? `✓ cleared ${billModal.closedAt ? formatDateTime(billModal.closedAt) : ""}`
                    : "● open bill"}
                </p>
                {billModal.serviceNote && <p className="text-xs font-bold text-sky-300">📍 {billModal.serviceNote}</p>}
              </div>
              <button onClick={() => setBillModal(null)} className="p-2 rounded-lg bg-white/10 text-stone-300 hover:bg-white/20 shrink-0" title="Close">
                <XCircle className="w-5 h-5" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div className="bg-[#3D2314] rounded-xl divide-y divide-stone-800">
                {(billModal.items || []).filter((i) => !i.removed).map((i) => (
                  <div key={i.id} className="p-3 flex items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-amber-100 truncate">{i.name}</p>
                      <p className="text-xs font-semibold text-stone-300">{i.quantity} × {i.price} ETB</p>
                      {i.notes && <p className="text-[11px] font-semibold text-amber-300 italic mt-0.5">📝 {i.notes}</p>}
                    </div>
                    <span className="text-sm font-black text-[#C9A227] shrink-0">{i.price * i.quantity} ETB</span>
                  </div>
                ))}
                {(billModal.items || []).filter((i) => !i.removed).length === 0 && (
                  <p className="p-3 text-center text-xs text-stone-500">No items.</p>
                )}
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

      {receiptModal && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4 no-print" onClick={() => setReceiptModal(null)}>
          <img src={receiptModal} alt="Receipt" className="max-h-[85vh] max-w-full rounded-2xl border border-[#C9A227]" />
        </div>
      )}
    </div>
  );
}
