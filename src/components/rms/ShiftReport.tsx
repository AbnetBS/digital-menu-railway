"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { X, XCircle, RefreshCw, Sun, Sunset, Users, ChevronDown, ChevronRight, AlertTriangle, Clock, Printer } from "lucide-react";
import { formatClock, formatDateTime } from "@/lib/order-lines";
import {
  SHIFT_DATES,
  SHIFT_ROLES,
  STATION_ROLES,
  type ShiftDate,
  type ShiftOrderCard,
  type ShiftPersonRow,
  type ShiftReport as Report,
  type ShiftRole,
} from "@/lib/shift-report";
import { staffEtb, staffNum, useStaffT, type StaffI18n, type StaffPhrase } from "@/lib/staff-i18n";
import StaffLangToggle from "@/components/rms/StaffLangToggle";
import PrintLetterhead from "@/components/rms/PrintLetterhead";

type ShiftFilter = "all" | "morning" | "afternoon" | "combined";
type ShiftKey = "morning" | "afternoon" | "combined";
const SHIFT_FILTERS: { key: ShiftFilter; label: StaffPhrase }[] = [
  { key: "all", label: "All" },
  { key: "morning", label: "Morning" },
  { key: "afternoon", label: "Afternoon" },
  { key: "combined", label: "Combined" },
];
const SHIFT_LABEL: Record<ShiftKey, StaffPhrase> = { morning: "Morning", afternoon: "Afternoon", combined: "Combined" };
const SHIFT_TOTAL_LABEL: Record<ShiftKey, StaffPhrase> = {
  morning: "Morning total",
  afternoon: "Afternoon total",
  combined: "Combined total",
};
/** Same English words as SHIFT_ROLE_LABELS in shift-report.ts. */
const ROLE_LABEL: Record<ShiftRole, StaffPhrase> = {
  waiter: "Waiter",
  cashier: "Cashier",
  kitchen: "Kitchen",
  barista: "Barista",
  juice: "Juice Maker",
  buna: "Buna Maker",
};
const ROLE_PEOPLE: Record<ShiftRole, StaffPhrase> = {
  waiter: "Waiters and Buna makers",
  cashier: "Cashiers",
  kitchen: "Kitchen staff",
  barista: "Baristas",
  juice: "Juice makers",
  buna: "Buna makers",
};
const ROLE_PEOPLE_ON_ORDER: Record<ShiftRole, StaffPhrase> = {
  waiter: "Waiter(s)",
  cashier: "Cashier(s)",
  kitchen: "Kitchen staff",
  barista: "Barista(s)",
  juice: "Juice maker(s)",
  buna: "Buna maker(s)",
};
const DATE_LABEL: Record<ShiftDate, StaffPhrase> = {
  today: "Today",
  yesterday: "Yesterday",
  dayBefore: "Day Before Yesterday",
  week: "Last 7 Days",
};

/** 14 → "8:00" on the Ethiopian clock (day hours count from 6:00 AM). */
function ethiopianHour(h: number): string {
  const e = ((h - 6 + 24) % 12) || 12;
  return `${e}:00`;
}
const pad = (h: number) => `${String(h).padStart(2, "0")}:00`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-09-24" → "24 Sep 2026" (same style as the Sales Report paper). */
function fmtDayKey(key: string): string {
  const [y, m, d] = String(key || "").split("-").map((x) => Number(x));
  if (!y || !m || !d) return key;
  return `${String(d).padStart(2, "0")} ${MONTHS[m - 1] || ""} ${y}`;
}
/** The real dates a selection covers ("18 Sep 2026 – 24 Sep 2026"). */
function daysCovered(dayKeys: string[] | undefined): string {
  if (!dayKeys?.length) return "";
  const sorted = [...dayKeys].sort();
  const from = fmtDayKey(sorted[0]);
  const to = fmtDayKey(sorted[sorted.length - 1]);
  return from === to ? from : `${from} – ${to}`;
}

type ReportResponse = Report & { dayKeys: string[]; error?: string };
type OpenOrder = (o: ShiftOrderCard, opener: HTMLElement | null) => void;

/** Orders that belong to the selected shift filter (for the printed paper). */
function ordersInSelection(data: Report, shift: ShiftFilter): ShiftOrderCard[] {
  const all = Object.values(data.orders).sort((a, b) => b.ticketId - a.ticketId);
  if (shift === "all") return all;
  if (shift === "combined") return all.filter((o) => o.combined);
  return all.filter((o) => o.actions.some((a) => a.shift === shift));
}

/**
 * Keeps an element from scrolling while `active`, and puts the scroll
 * position back exactly where it was afterwards (no jump).
 */
function useScrollLock(getEl: () => HTMLElement | null, active: boolean) {
  useLayoutEffect(() => {
    if (!active) return;
    const el = getEl();
    if (!el) return;
    const top = el.scrollTop;
    const prev = el.style.overflow;
    el.style.overflow = "hidden";
    return () => {
      el.style.overflow = prev;
      if (el.scrollTop !== top) el.scrollTop = top;
    };
  }, [active, getEl]);
}

export default function ShiftReport({ onClose, logoUrl }: { onClose: () => void; logoUrl?: string | null }) {
  const i18n = useStaffT();
  const { t } = i18n;
  const [shift, setShift] = useState<ShiftFilter>("all");
  const [role, setRole] = useState<ShiftRole>("waiter");
  const [date, setDate] = useState<ShiftDate>("today");
  const [data, setData] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null); // expanded person/group key
  const [detail, setDetail] = useState<ShiftOrderCard | null>(null);
  const [savingSplit, setSavingSplit] = useState(false);
  const [printedAt, setPrintedAt] = useState<Date>(() => new Date());
  // The small floating X appears once the header (with its own X) has
  // scrolled out of view, so closing is always one tap away.
  const [headerGone, setHeaderGone] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async (r: ShiftRole, d: ShiftDate) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/reports/shifts?role=${r}&date=${d}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // First open: Shift = All, Role = Waiter, Date = Today.
  useEffect(() => {
    void Promise.resolve().then(() => load("waiter", "today"));
  }, [load]);

  // While the panel is open: the page behind it never scrolls, and the
  // browser's print (button or Ctrl+P) prints THIS report, not the page below.
  useLayoutEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    html.classList.add("fana-shift-open");
    const stamp = () => flushSync(() => setPrintedAt(new Date()));
    window.addEventListener("beforeprint", stamp);
    return () => {
      body.style.overflow = prevOverflow;
      html.classList.remove("fana-shift-open");
      window.removeEventListener("beforeprint", stamp);
    };
  }, []);

  // The popup freezes the list behind it; closing it lands on the same spot.
  const getScroller = useCallback(() => scrollerRef.current, []);
  useScrollLock(getScroller, !!detail);

  const openDetail: OpenOrder = useCallback((o, opener) => {
    openerRef.current = opener;
    setDetail(o);
  }, []);
  const closeDetail = useCallback(() => {
    setDetail(null);
    const el = openerRef.current;
    openerRef.current = null;
    // Give focus back to the card that opened it, without scrolling.
    if (el) requestAnimationFrame(() => el.focus({ preventScroll: true }));
  }, []);

  // Esc closes the popup first, then the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (detail) closeDetail();
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [detail, closeDetail, onClose]);

  const onScroll = () => {
    const el = scrollerRef.current;
    const head = headerRef.current;
    if (!el || !head) return;
    setHeaderGone(el.scrollTop > Math.max(48, head.offsetHeight - 24));
  };

  const pickRole = (r: ShiftRole) => {
    setRole(r);
    setOpen(null);
    load(r, date);
  };
  const pickDate = (d: ShiftDate) => {
    setDate(d);
    setOpen(null);
    load(role, d);
  };

  const saveSplit = async (h: number) => {
    setSavingSplit(true);
    setError(null);
    let failed: string | null = null;
    try {
      const r = await fetch("/api/reports/shifts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ splitHour: h }),
      });
      // The hour is a setting the whole paper depends on: if it did not save,
      // the report must say so instead of quietly keeping the old split.
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        failed = d?.error || "Could not save the shift change hour.";
      }
    } catch (e) {
      failed = e instanceof Error ? e.message : "Could not save the shift change hour.";
    }
    setSavingSplit(false);
    // Nothing changed on a failure, so do NOT reload: load() clears `error`,
    // and the message is the only thing telling the owner the hour stayed old.
    if (failed) return setError(failed);
    load(role, date);
  };

  const print = () => {
    flushSync(() => setPrintedAt(new Date()));
    window.print();
  };

  const split = data?.splitHour ?? 14;
  const station = STATION_ROLES.includes(role);
  const showMorning = shift === "all" || shift === "morning";
  const showAfternoon = shift === "all" || shift === "afternoon";
  const showCombined = shift === "all" || shift === "combined";

  const totalsRows: TotalsRow[] = data
    ? [
        ...(showMorning ? data.morning.map((p) => ({ name: p.name, shift: "morning" as const, orders: p.orders, amount: p.amount })) : []),
        ...(showAfternoon ? data.afternoon.map((p) => ({ name: p.name, shift: "afternoon" as const, orders: p.orders, amount: p.amount })) : []),
        ...(showCombined ? data.combined.map((g) => ({ name: g.label, shift: "combined" as const, orders: g.orders, amount: g.amount })) : []),
      ]
    : [];

  const pill = (active: boolean) =>
    `px-3 py-2 rounded-xl text-xs font-black uppercase tracking-wide transition active:scale-95 ${
      active ? "bg-[#C9A227] text-[#2C1B17]" : "bg-black/30 border border-stone-700 text-stone-300 hover:border-[#C9A227]/60"
    }`;

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm no-print" data-shift-report="panel">
      <style>{SHIFT_REPORT_CSS}</style>
      {/* THE SCROLLER: only this layer scrolls. The header is part of the
          content, so it scrolls away with everything else (owner, Sept 2026:
          the filters must not stay pinned over the list). */}
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="shift-report-scroller absolute inset-0 overflow-y-auto overscroll-contain p-2 sm:p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shift-report-title"
      >
        <div className="bg-[#1E120D] border-2 border-[#C9A227]/50 rounded-2xl w-full max-w-4xl mx-auto my-2">
          {/* Header: NOT sticky. */}
          <header ref={headerRef} className="border-b border-stone-800 px-4 sm:px-5 py-4 rounded-t-2xl" data-shift-report="header">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 id="shift-report-title" className="font-serif font-black text-xl text-amber-100 flex items-center gap-2">
                  <Clock className="w-5 h-5 text-[#C9A227]" /> {t("Shift Report")}
                </h2>
                <p className="text-[11px] text-stone-400 mt-0.5">
                  {t(
                    "Who handled which order, per shift. Morning = before {split} ({local} local), Afternoon = from {split}. Orders handled by 2+ people of the same role are listed under Combined.",
                    { split: pad(split), local: ethiopianHour(split) }
                  )}
                </p>
              </div>
              <div className="flex flex-wrap justify-end gap-2 shrink-0">
                <StaffLangToggle compact />
                <button
                  onClick={print}
                  className="px-2.5 py-2 rounded-lg bg-[#C9A227] text-[#2C1B17] hover:bg-amber-400 font-black text-xs uppercase flex items-center gap-1.5"
                  title={t("Print this selection")}
                  data-shift-report="print"
                >
                  <Printer className="w-4 h-4" /> {t("Print")}
                </button>
                <button onClick={() => load(role, date)} className="p-2 rounded-lg bg-white/10 text-amber-200 hover:bg-white/20" title={t("Refresh")} aria-label={t("Refresh")}>
                  <RefreshCw className={`w-5 h-5 ${loading ? "animate-spin" : ""}`} />
                </button>
                <button onClick={onClose} className="p-2 rounded-lg bg-white/10 text-stone-300 hover:bg-white/20" title={t("Close")} aria-label={t("Close shift report")}>
                  <XCircle className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Filters */}
            <div className="mt-3 space-y-2">
              <FilterRow label={t("Shift")}>
                {SHIFT_FILTERS.map((f) => (
                  <button key={f.key} className={pill(shift === f.key)} onClick={() => setShift(f.key)}>
                    {t(f.label)}
                  </button>
                ))}
              </FilterRow>
              <FilterRow label={t("Role")}>
                <select
                  value={role}
                  onChange={(e) => pickRole(e.target.value as ShiftRole)}
                  className="bg-black/40 border border-[#C9A227]/60 text-amber-100 text-xs font-black uppercase rounded-xl px-3 py-2"
                  aria-label={t("Role")}
                >
                  {SHIFT_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {t(ROLE_LABEL[r])}
                    </option>
                  ))}
                </select>
              </FilterRow>
              <FilterRow label={t("Date")}>
                {SHIFT_DATES.map((d) => (
                  <button key={d} className={pill(date === d)} onClick={() => pickDate(d)}>
                    {t(DATE_LABEL[d])}
                  </button>
                ))}
              </FilterRow>
            </div>
          </header>

          <div className="px-4 sm:px-5 py-4 space-y-4">
            {error && <div className="bg-rose-900/60 border border-rose-500 text-rose-200 text-xs p-3 rounded-xl font-bold">{i18n.td(error)}</div>}
            {!data ? (
              <p className="text-center text-stone-500 text-sm py-10">{t("Loading shift report...")}</p>
            ) : (
              <>
                {/* Summary */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Stat label={t(ROLE_PEOPLE[role])} value={String(data.totals.people)} />
                  <Stat label={t("Orders")} value={String(data.totals.orders)} />
                  <Stat label={t(station ? "Value of their lines" : "Bill value")} value={staffEtb(data.totals.amount)} />
                  <Stat label={t("Need a look")} value={String(data.totals.flagged)} warn={data.totals.flagged > 0} />
                </div>

                <p className="text-[11px] text-stone-400 font-bold">
                  {t(ROLE_LABEL[role])} • {t(DATE_LABEL[date])}
                  {data.dayKeys?.length ? ` • ${daysCovered(data.dayKeys)}` : ""}
                </p>

                {role === "waiter" && <p className="text-[11px] text-stone-400">{t("Buna makers who send or accept table and outdoor orders appear here alongside waiters. Bill totals may overlap when two people handle one bill; open the order to cross-check its actions and items.")}</p>}

                {/* TOTALS TABLE (cross-checker, Sept 2026): one line per person per
                    shift: "Abel • Waiter • Morning • 5 orders • 4,250 ETB". */}
                <TotalsTable role={role} rows={totalsRows} i18n={i18n} />

                {showMorning && (
                  <ShiftSection
                    icon={<Sun className="w-4 h-4 text-amber-300" />}
                    title={t("Morning Shift")}
                    subtitle={t("before {time}", { time: pad(split) })}
                    rows={data.morning}
                    prefix="m"
                    open={open}
                    setOpen={setOpen}
                    data={data}
                    station={station}
                    role={role}
                    onOpenOrder={openDetail}
                    shiftFilter="morning"
                    i18n={i18n}
                  />
                )}
                {showAfternoon && (
                  <ShiftSection
                    icon={<Sunset className="w-4 h-4 text-orange-400" />}
                    title={t("Afternoon Shift")}
                    subtitle={t("from {time}", { time: pad(split) })}
                    rows={data.afternoon}
                    prefix="a"
                    open={open}
                    setOpen={setOpen}
                    data={data}
                    station={station}
                    role={role}
                    onOpenOrder={openDetail}
                    shiftFilter="afternoon"
                    i18n={i18n}
                  />
                )}
                {showCombined && (
                  <section className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-4">
                    <h3 className="text-sm font-black text-amber-200 uppercase tracking-wider flex items-center gap-2 flex-wrap">
                      <Users className="w-4 h-4 text-sky-300" /> {t("Combined Shift")}
                      <span className="text-[10px] text-stone-500 normal-case font-bold tracking-normal">{t("2+ people on one order")}</span>
                    </h3>
                    {data.combined.length === 0 ? (
                      <p className="text-xs text-stone-500 mt-3">{t("No shared orders.")}</p>
                    ) : (
                      <ol className="mt-3 space-y-2">
                        {data.combined.map((g, idx) => {
                          const key = `c:${g.label}`;
                          return (
                            <li key={key}>
                              <PersonRow
                                idx={idx + 1}
                                name={g.label}
                                orders={g.orders}
                                amount={g.amount}
                                expanded={open === key}
                                onToggle={() => setOpen(open === key ? null : key)}
                                i18n={i18n}
                              />
                              {open === key && (
                                <OrderList ids={g.ticketIds} data={data} station={station} role={role} onOpen={openDetail} i18n={i18n} />
                              )}
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </section>
                )}

                {/* Shift change hour (owner setting) */}
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-stone-400 border-t border-stone-800 pt-3">
                  <span className="font-bold">{t("Shift change at")}</span>
                  <select
                    value={split}
                    disabled={savingSplit}
                    onChange={(e) => saveSplit(Number(e.target.value))}
                    className="bg-black/40 border border-stone-700 text-amber-100 rounded-lg px-2 py-1 font-bold"
                    aria-label={t("Shift change at")}
                  >
                    {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
                      <option key={h} value={h}>
                        {t("{time} ({local} local)", { time: pad(h), local: ethiopianHour(h) })}
                      </option>
                    ))}
                  </select>
                  <span>{t("Every action is placed in the shift it happened in, so a person who worked both shifts shows in both.")}</span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Small floating X: reachable wherever the list is scrolled. */}
      {headerGone && (
        <button
          onClick={onClose}
          className="absolute top-3 right-3 sm:top-4 sm:right-6 z-10 w-9 h-9 rounded-full bg-[#2C1B17]/95 border border-[#C9A227]/60 text-amber-100 shadow-xl flex items-center justify-center hover:bg-[#3D2314]"
          title={t("Close")}
          aria-label={t("Close shift report")}
          data-shift-report="floating-close"
        >
          <X className="w-4 h-4" />
        </button>
      )}

      {detail && <OrderDetail order={detail} role={role} station={station} onClose={closeDetail} i18n={i18n} />}

      <ShiftPrintSheet
        data={data}
        shift={shift}
        role={role}
        date={date}
        open={open}
        printedAt={printedAt}
        logoUrl={logoUrl}
        i18n={i18n}
      />
    </div>
  );
}

const SHIFT_REPORT_CSS = `
  .print-only { display: none; }
  .shift-print-sheet { display: none; }
  .shift-report-scroller { scrollbar-gutter: stable; }
  .shift-popup-card { max-height: 90vh; max-height: 90dvh; }
  @media print {
    @page { margin: 12mm; }
    html.fana-shift-open, html.fana-shift-open body {
      background: #fff !important;
      overflow: visible !important;
      height: auto !important;
    }
    html.fana-shift-open body > *:not(#fana-shift-print) { display: none !important; }
    html.fana-shift-open #fana-shift-print { display: block !important; }
    #fana-shift-print { font-size: 12px; line-height: 1.35; }
    #fana-shift-print, #fana-shift-print * {
      color: #000 !important;
      background: #fff !important;
      background-image: none !important;
      box-shadow: none !important;
      text-shadow: none !important;
    }
    #fana-shift-print h2 { font-size: 16px; font-weight: 900; margin: 10px 0 2px; }
    #fana-shift-print h3 { font-size: 13px; font-weight: 900; margin: 14px 0 4px; break-after: avoid; page-break-after: avoid; }
    #fana-shift-print table { width: 100%; border-collapse: collapse; }
    #fana-shift-print th, #fana-shift-print td { border: 1px solid #555; padding: 3px 6px; text-align: left; vertical-align: top; }
    #fana-shift-print th { font-weight: 900; }
    #fana-shift-print .num { text-align: right; white-space: nowrap; }
    #fana-shift-print thead { display: table-header-group; }
    #fana-shift-print tfoot { display: table-row-group; }
    #fana-shift-print tr, #fana-shift-print .sp-card, #fana-shift-print .sp-sign {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    #fana-shift-print .sp-card { border: 1px solid #555; padding: 5px 7px; margin: 0 0 6px; }
    #fana-shift-print .sp-tag { display: inline-block; border: 1px solid #000; padding: 0 4px; margin: 1px 3px 1px 0; font-size: 10px; font-weight: 800; }
  }
`;

interface TotalsRow {
  name: string;
  shift: ShiftKey;
  orders: number;
  amount: number;
}

function shiftTotals(rows: TotalsRow[]) {
  const shifts = [...new Set(rows.map((r) => r.shift))];
  return shifts.map((sh) => ({ shift: sh, amount: rows.filter((r) => r.shift === sh).reduce((s, r) => s + r.amount, 0) }));
}

function TotalsTable({ role, rows, i18n }: { role: ShiftRole; rows: TotalsRow[]; i18n: StaffI18n }) {
  const { t } = i18n;
  if (rows.length === 0) return null;
  return (
    <section className="bg-[#2C1B17] rounded-2xl border border-[#C9A227]/40 p-4 overflow-x-auto">
      <h3 className="text-sm font-black text-amber-200 uppercase tracking-wider mb-2">{t("Totals per person")}</h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase text-stone-500 text-left">
            <th className="py-1 pr-2">#</th>
            <th className="py-1 pr-2">{t("Name")}</th>
            <th className="py-1 pr-2">{t("Role")}</th>
            <th className="py-1 pr-2">{t("Shift")}</th>
            <th className="py-1 pr-2 text-right">{t("Orders")}</th>
            <th className="py-1 text-right">{t("Total")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-800">
          {rows.map((r, i) => (
            <tr key={`${r.shift}-${r.name}`}>
              <td className="py-1.5 pr-2 font-black text-[#C9A227]">{i + 1}</td>
              <td className="py-1.5 pr-2 font-black text-amber-100">{r.name}</td>
              <td className="py-1.5 pr-2 text-stone-300">{t(ROLE_LABEL[role])}</td>
              <td className="py-1.5 pr-2 text-stone-300">{t(SHIFT_LABEL[r.shift])}</td>
              <td className="py-1.5 pr-2 text-right text-stone-300">{r.orders}</td>
              <td className="py-1.5 text-right font-black text-[#C9A227]">{staffEtb(r.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {shiftTotals(rows).map((s) => (
            <tr key={s.shift} className="border-t border-stone-700">
              <td colSpan={5} className="py-1.5 pr-2 text-right font-black text-stone-300">{t(SHIFT_TOTAL_LABEL[s.shift])}</td>
              <td className="py-1.5 text-right font-black text-amber-100">{staffEtb(s.amount)}</td>
            </tr>
          ))}
        </tfoot>
      </table>
      <p className="text-[10px] text-stone-500 mt-2">
        {t("Combined orders are shared, so they are counted on each person and again under Combined. Compare shift totals, not the sum of all rows.")}
      </p>
    </section>
  );
}

function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="min-w-12 text-[10px] font-black uppercase tracking-wider text-stone-500">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`rounded-xl p-3 border ${warn ? "bg-rose-950/50 border-rose-700" : "bg-[#2C1B17] border-stone-800"}`}>
      <p className={`text-[10px] font-extrabold uppercase tracking-wider ${warn ? "text-rose-300" : "text-stone-400"}`}>{label}</p>
      <p className={`font-serif font-black text-lg ${warn ? "text-rose-200" : "text-amber-100"}`}>{value}</p>
    </div>
  );
}

function PersonRow(props: {
  idx: number;
  name: string;
  orders: number;
  amount: number;
  expanded: boolean;
  onToggle: () => void;
  hint?: string;
  i18n: StaffI18n;
}) {
  return (
    <button
      onClick={props.onToggle}
      aria-expanded={props.expanded}
      className={`w-full flex items-center gap-3 text-left rounded-xl px-3 py-2.5 border transition ${
        props.expanded ? "bg-[#3D2314] border-[#C9A227]/60" : "bg-black/25 border-stone-800 hover:border-[#C9A227]/40"
      }`}
    >
      <span className="w-6 text-xs font-black text-[#C9A227]">{props.idx}.</span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-black text-amber-100 truncate">{props.name}</span>
        {props.hint && <span className="block text-[10px] text-stone-500 font-bold">{props.hint}</span>}
      </span>
      <span className="text-[11px] font-bold text-stone-300 shrink-0">{props.i18n.t("{n} order(s)", { n: props.orders })}</span>
      <span className="text-xs font-black text-[#C9A227] shrink-0 w-24 text-right">{staffEtb(props.amount)}</span>
      {props.expanded ? <ChevronDown className="w-4 h-4 text-stone-400" /> : <ChevronRight className="w-4 h-4 text-stone-400" />}
    </button>
  );
}

function ShiftSection(props: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  rows: ShiftPersonRow[];
  prefix: string;
  open: string | null;
  setOpen: (k: string | null) => void;
  data: Report;
  station: boolean;
  role: ShiftRole;
  onOpenOrder: OpenOrder;
  shiftFilter: "morning" | "afternoon";
  i18n: StaffI18n;
}) {
  return (
    <section className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-4">
      <h3 className="text-sm font-black text-amber-200 uppercase tracking-wider flex items-center gap-2 flex-wrap">
        {props.icon} {props.title}
        <span className="text-[10px] text-stone-500 normal-case font-bold tracking-normal">{props.subtitle}</span>
      </h3>
      {props.rows.length === 0 ? (
        <p className="text-xs text-stone-500 mt-3">{props.i18n.t("Nobody in this shift.")}</p>
      ) : (
        <ol className="mt-3 space-y-2">
          {props.rows.map((p, idx) => {
            const key = `${props.prefix}:${p.name}`;
            return (
              <li key={key}>
                <PersonRow
                  idx={idx + 1}
                  name={p.name}
                  orders={p.orders}
                  amount={p.amount}
                  hint={p.firstAt && p.lastAt ? `${formatClock(p.firstAt)} – ${formatClock(p.lastAt)}` : undefined}
                  expanded={props.open === key}
                  onToggle={() => props.setOpen(props.open === key ? null : key)}
                  i18n={props.i18n}
                />
                {props.open === key && (
                  <><PersonSales ids={p.ticketIds} data={props.data} role={props.role} person={p.name} i18n={props.i18n} /><OrderList
                    ids={p.ticketIds}
                    data={props.data}
                    station={props.station}
                    role={props.role}
                    onOpen={props.onOpenOrder}
                    person={p.name}
                    shift={props.shiftFilter}
                    i18n={props.i18n}
                  /></>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** Item pile attributed to the person who actually handled each station line. */
function PersonSales({ ids, data, role, person, i18n }: { ids: number[]; data: Report; role: ShiftRole; person: string; i18n: StaffI18n }) {
  if (role === "cashier") return null;
  const pile = new Map<string, { quantity: number; amount: number }>();
  let bills = 0;
  for (const id of ids) {
    const order = data.orders[id];
    if (!order) continue;
    let counted = false;
    for (const item of order.items) {
      if (item.removed || (role !== "waiter" && item.stationName !== role)) continue;
      // Station ownership is the Accept/Done audit, not the waiter who sent the bill.
      if (role !== "waiter" && item.acceptedBy !== person && item.doneBy !== person) continue;
      const row = pile.get(item.name) || { quantity: 0, amount: 0 };
      row.quantity += item.quantity;
      row.amount += item.price * item.quantity;
      pile.set(item.name, row);
      counted = true;
    }
    if (counted) bills++;
  }
  const entries = [...pile.entries()].sort((a, b) => b[1].quantity - a[1].quantity);
  return <div className="mt-2 ml-2 sm:ml-8 rounded-xl border border-[#C9A227]/40 bg-black/25 p-3 text-xs text-stone-200">
    <p className="font-black text-amber-200 uppercase">{i18n.t(ROLE_LABEL[role])} • {i18n.t("{n} bill(s) • ITEMS SOLD", { n: bills })}</p>
    <p className="mt-1 font-bold">{i18n.t("{n} items • {amount}", { n: entries.reduce((n, [, v]) => n + v.quantity, 0), amount: staffEtb(entries.reduce((n, [, v]) => n + v.amount, 0)) })}</p>
    <div className="mt-2 max-h-36 overflow-y-auto space-y-1" role="list" aria-label={i18n.t("Items sold")}>
      {entries.length ? entries.map(([name, v]) => <div role="listitem" key={name} className="flex justify-between gap-3 border-b border-stone-800 py-1"><span>{name} ×{v.quantity}</span><strong>{staffEtb(v.amount)}</strong></div>) : <p>{i18n.t("No attributed items in these orders.")}</p>}
    </div>
  </div>;
}

function OrderList(props: {
  ids: number[];
  data: Report;
  station: boolean;
  role: ShiftRole;
  onOpen: OpenOrder;
  person?: string;
  shift?: "morning" | "afternoon";
  i18n: StaffI18n;
}) {
  return (
    <div className="mt-2 ml-2 sm:ml-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
      {props.ids.map((id) => {
        const o = props.data.orders[id];
        if (!o) return null;
        return props.station ? (
          <StationCard key={id} order={o} role={props.role} onOpen={(el) => props.onOpen(o, el)} i18n={props.i18n} />
        ) : (
          <FloorCard key={id} order={o} person={props.person} shift={props.shift} onOpen={(el) => props.onOpen(o, el)} i18n={props.i18n} />
        );
      })}
    </div>
  );
}

function Flags({ flags, i18n }: { flags: string[]; i18n: StaffI18n }) {
  if (!flags.length) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {flags.map((f) => (
        <span key={f} className="inline-flex items-center gap-1 text-[10px] font-black px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40">
          <AlertTriangle className="w-3 h-3" /> {i18n.td(f)}
        </span>
      ))}
    </div>
  );
}

/** "PRINTED", "CLOSED"... in English; the dictionary word in Amharic. */
function statusText(status: string, i18n: StaffI18n): string {
  return i18n.am ? i18n.td(status) : status.replace(/_/g, " ").toUpperCase();
}

function statusBadge(status: string, i18n: StaffI18n) {
  const cls =
    status === "cancelled"
      ? "bg-rose-500/20 text-rose-300 border-rose-500/40"
      : status === "closed" || status === "paid" || status === "completed"
        ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
        : "bg-sky-500/20 text-sky-300 border-sky-500/40";
  return <span className={`text-[10px] font-black px-2 py-0.5 rounded-full border ${cls}`}>{statusText(status, i18n)}</span>;
}

/** Waiter / cashier card: what this person did on the order. */
function FloorCard({
  order,
  person,
  shift,
  onOpen,
  i18n,
}: {
  order: ShiftOrderCard;
  person?: string;
  shift?: string;
  onOpen: (el: HTMLElement) => void;
  i18n: StaffI18n;
}) {
  const { t, td } = i18n;
  const mine = order.actions.filter((a) => (!person || a.name === person) && (!shift || a.shift === shift));
  const shown = mine.length ? mine : order.actions;
  const lines = order.items.filter((i) => !i.removed).length;
  return (
    <button
      onClick={(e) => onOpen(e.currentTarget)}
      className="w-full text-left bg-[#3D2314] rounded-xl border border-stone-800 hover:border-[#C9A227]/60 p-3 transition"
      data-shift-order={order.ticketId}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-serif font-black text-base text-amber-100">
            {order.tableName}
            {order.orderType === "outdoor" && <span className="ml-2 text-[10px] font-black text-violet-300">{t("OUTDOOR")}</span>}
            {order.combined && <span className="ml-2 text-[10px] font-black text-sky-300">{t("SHARED: {names}", { names: order.people.join(" - ") })}</span>}
          </p>
          <p className="text-[11px] text-stone-300">{order.printedAt ? `printed ${formatClock(order.printedAt)} • ${order.printedBy || "staff"}` : `🕒 ${formatDateTime(order.createdAt)}`}</p>
          <p className="text-[11px] text-stone-400">#{order.orderNumber || order.ticketId}</p>
          <p className="text-[11px] text-amber-300">👤 {order.confirmedBy || order.sentBy || "staff"}</p>
          <p className="text-[11px] text-emerald-300">{statusText(order.status, i18n)} {order.closedAt ? formatClock(order.closedAt) : ""}</p>
          <p className="text-[11px] text-stone-400 font-semibold">{t("{n} line(s) on the bill", { n: lines })}</p>
        </div>
        <div className="text-right shrink-0 space-y-1">
          <p className="text-sm font-black text-[#C9A227]">{staffEtb(order.totalAmount)}</p>
          {statusBadge(order.status, i18n)}
        </div>
      </div>
      <Flags flags={order.flags} i18n={i18n} />
    </button>
  );
}

/** Kitchen / barista / juice / buna card, like the station dashboard. */
function StationCard({ order, role, onOpen, i18n }: { order: ShiftOrderCard; role: ShiftRole; onOpen: (el: HTMLElement) => void; i18n: StaffI18n }) {
  const { t, td } = i18n;
  const mine = order.items.filter((i) => i.stationName === role && !i.removed);
  const done = mine.filter((i) => i.stationStatus === "done").length;
  const cleared = mine.length > 0 && done === mine.length;
  const who = order.confirmedBy || order.sentBy;
  return (
    <button
      onClick={(e) => onOpen(e.currentTarget)}
      className="w-full text-left bg-[#3D2314] rounded-xl border border-stone-800 hover:border-[#C9A227]/60 p-3 transition"
      data-shift-order={order.ticketId}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-serif font-black text-base text-amber-100">{order.tableName}</p>
          <p className="text-[11px] font-bold text-stone-300">
            {t("Order #{number}", { number: order.orderNumber || order.ticketId })} 🕒{" "}
            {t("received {time}", { time: formatDateTime(order.confirmedAt || order.createdAt) })}
          </p>
          {who && (
            <p className="text-[11px] font-bold text-stone-300">
              👤 {order.confirmedBy ? order.confirmedBy : t("Sent by {name}", { name: who })}
            </p>
          )}
        </div>
        <span
          className={`text-[10px] font-black px-2 py-1 rounded-full border shrink-0 ${
            cleared ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40" : "bg-rose-500/20 text-rose-300 border-rose-500/40"
          }`}
        >
          {cleared ? t("✓ CLEARED") : t("⚠ OPEN")} {t("{done}/{total} done", { done, total: mine.length })}
        </span>
      </div>
      <div className="mt-2 divide-y divide-stone-800/80">
        {mine.map((i) => (
          <div key={i.id} className="py-1.5 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-bold text-amber-100">
                {i.name} <span className="text-stone-400">x{i.quantity}</span>
              </p>
              {i.notes && <p className="text-[11px] italic text-amber-300">📝 {i.notes}</p>}
              {i.acceptedBy && (
                <p className="text-[11px] font-bold text-sky-300">
                  {t("▶ Accepted by {name}", { name: i.acceptedBy })}
                  {i.acceptedAt ? ` • ${formatClock(i.acceptedAt)}` : ""}
                </p>
              )}
              {i.doneBy ? (
                <p className="text-[11px] font-bold text-emerald-300">
                  {t("✓ Done by {name}", { name: i.doneBy })}
                  {i.doneAt ? ` • ${formatClock(i.doneAt)}` : ""}
                </p>
              ) : (
                <p className="text-[11px] font-black text-rose-300">{t("✗ never marked done")}</p>
              )}
            </div>
            <span className={`text-[10px] font-black shrink-0 ${i.stationStatus === "done" ? "text-emerald-300" : "text-rose-300"}`}>
              {i.stationStatus === "done" ? t("✓ DONE") : i18n.am ? td(i.stationStatus || "pending") : (i.stationStatus || "pending").toUpperCase()}
            </span>
          </div>
        ))}
      </div>
      {order.combined && <p className="text-[10px] font-black text-sky-300 mt-1">{t("SHARED: {names}", { names: order.people.join(" - ") })}</p>}
      <Flags flags={order.flags} i18n={i18n} />
    </button>
  );
}

/**
 * ORDER DETAILS POPUP (owner, Sept 2026). Rendered into <body> so it is
 * centred in the VISIBLE screen wherever the list is scrolled (inside the
 * panel it used to land at the top of the long list). The list behind is
 * frozen while it is open; only the popup itself scrolls when it is long.
 * Closes with the X, a tap on the dark backdrop, or Esc.
 */
function OrderDetail({
  order,
  role,
  station,
  onClose,
  i18n,
}: {
  order: ShiftOrderCard;
  role: ShiftRole;
  station: boolean;
  onClose: () => void;
  i18n: StaffI18n;
}) {
  const { t, td } = i18n;
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);
  const live = order.items.filter((i) => !i.removed);
  const removed = order.items.filter((i) => i.removed);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[70] bg-black/80 flex items-center justify-center p-3 sm:p-6 no-print [touch-action:none]"
      onClick={onClose}
      data-shift-report="order-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shift-order-title"
        className="shift-popup-card bg-[#2C1B17] border-2 border-[#C9A227]/50 rounded-2xl w-full max-w-lg overflow-y-auto overscroll-contain shadow-2xl [touch-action:pan-y]"
        onClick={(e) => e.stopPropagation()}
        data-shift-report="order-popup"
      >
        <div className="sticky top-0 z-10 bg-[#2C1B17] border-b border-stone-800 px-5 py-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 id="shift-order-title" className="font-serif font-black text-xl text-amber-100">
                {order.tableName}
              </h3>
              {statusBadge(order.status, i18n)}
            </div>
            <p className="text-xs font-bold text-stone-300">
              {order.orderNumber ? `#${order.orderNumber}` : `#${order.ticketId}`} • {t("opened {time}", { time: formatDateTime(order.createdAt) })}
            </p>
            {order.serviceNote && <p className="text-xs font-bold text-sky-300">📍 {order.serviceNote}</p>}
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            className="p-2 rounded-lg bg-white/10 text-stone-300 hover:bg-white/20 shrink-0"
            title={t("Close")}
            aria-label={t("Close order details")}
            data-shift-report="order-close"
          >
            <XCircle className="w-5 h-5" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3 text-xs">
          <Flags flags={order.flags} i18n={i18n} />
          <div className="grid grid-cols-2 gap-2">
            {order.confirmedBy || !order.sentBy ? (
              <Who label={t("Accepted by")} name={order.confirmedBy} at={order.confirmedAt} i18n={i18n} />
            ) : (
              <Who label={t("Sent by")} name={order.sentBy} at={order.sentAt} i18n={i18n} />
            )}
            <Who label={t("Printed by")} name={order.printedBy} at={order.printedAt} i18n={i18n} />
            <Who label={t("Cleared by")} name={order.closedBy} at={order.closedAt} i18n={i18n} />
            <Who label={t(ROLE_PEOPLE_ON_ORDER[role])} name={order.people.join(" - ")} i18n={i18n} />
          </div>

          <div className="bg-[#3D2314] rounded-xl divide-y divide-stone-800">
            {live.map((i) => (
              <div key={i.id} className={`p-3 flex items-start justify-between gap-3 ${station && !i.mine ? "opacity-50" : ""}`}>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-amber-100">{i.name}</p>
                  <p className="font-semibold text-stone-300">
                    {i.quantity} × {staffEtb(i.price)} • {td(i.stationName || "kitchen")} • {t("added {time}", { time: formatClock(i.createdAt) })}
                  </p>
                  {i.notes && <p className="italic text-amber-300">📝 {i.notes}</p>}
                  {i.acceptedBy && (
                    <p className="font-bold text-sky-300">
                      {t("▶ Accepted by {name}", { name: i.acceptedBy })} {i.acceptedAt ? `• ${formatClock(i.acceptedAt)}` : ""}
                    </p>
                  )}
                  {i.doneBy ? (
                    <p className="font-bold text-emerald-300">
                      {t("✓ Done by {name}", { name: i.doneBy })} {i.doneAt ? `• ${formatClock(i.doneAt)}` : ""}
                    </p>
                  ) : (
                    <p className="font-black text-rose-300">{t("✗ not marked done")}</p>
                  )}
                  {i.afterPrint && <p className="font-black text-amber-300">{t("⚠ added after the print: not on the EFD receipt yet")}</p>}
                </div>
                <span className="text-sm font-black text-[#C9A227] shrink-0">{staffEtb(i.price * i.quantity)}</span>
              </div>
            ))}
            {live.length === 0 && <p className="p-3 text-center text-stone-500">{t("No items.")}</p>}
          </div>
          {removed.length > 0 && (
            <div className="bg-rose-950/40 border border-rose-800 rounded-xl p-3">
              <p className="font-black text-rose-300 mb-1">{t("Removed lines")}</p>
              {removed.map((i) => (
                <p key={i.id} className="text-rose-200 line-through">
                  {i.quantity} × {i.name} ({staffEtb(i.price * i.quantity)})
                </p>
              ))}
            </div>
          )}
          <div className="bg-[#3D2314] border border-[#C9A227]/40 rounded-xl px-4 py-3 flex items-center justify-between">
            <span className="text-sm font-black text-stone-200">{t("Bill total")}</span>
            <span className="font-serif font-black text-2xl text-[#C9A227]">{staffEtb(order.totalAmount)}</span>
          </div>

          {order.timeline.length > 0 && (
            <div>
              <p className="font-black text-amber-200 uppercase tracking-wider text-[11px] mb-1">{t("Timeline")}</p>
              <ul className="space-y-1">
                {order.timeline.map((line, i) => (
                  <li key={i} className="text-stone-300">
                    <span className="font-bold text-stone-400">{formatClock(line.at)}</span> {td(line.text)}
                    {line.actor ? <span className="text-amber-300"> • {line.actor}</span> : null}
                    {line.role ? <span className="text-stone-500"> ({td(line.role)})</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function Who({ label, name, at, i18n }: { label: string; name: string | null; at?: string | null; i18n: StaffI18n }) {
  return (
    <div className="bg-black/25 rounded-lg p-2 border border-stone-800">
      <p className="text-[10px] font-black uppercase text-stone-500">{label}</p>
      <p className="font-bold text-amber-100 truncate">{name || i18n.t("n/a")}</p>
      {at && <p className="text-[10px] text-stone-400">{formatDateTime(at)}</p>}
    </div>
  );
}

/**
 * THE PRINTED SHIFT REPORT (owner, Sept 2026): the current selection on
 * paper, black on white, with the same letterhead as the Sales Report. It is
 * rendered into <body> and hidden on screen; while the panel is open the
 * print CSS shows ONLY this sheet, so Print (or Ctrl+P) never prints the
 * dark screen or the page behind it. Long lists simply continue on the next
 * page (table headers repeat, rows and cards never split).
 */
function ShiftPrintSheet({
  data,
  shift,
  role,
  date,
  open,
  printedAt,
  logoUrl,
  i18n,
}: {
  data: ReportResponse | null;
  shift: ShiftFilter;
  role: ShiftRole;
  date: ShiftDate;
  open: string | null;
  printedAt: Date;
  logoUrl?: string | null;
  i18n: StaffI18n;
}) {
  const { t, td } = i18n;
  if (typeof document === "undefined") return null;

  const split = data?.splitHour ?? 14;
  const shiftLabel = SHIFT_FILTERS.find((f) => f.key === shift)?.label || "All";
  const showMorning = shift === "all" || shift === "morning";
  const showAfternoon = shift === "all" || shift === "afternoon";
  const showCombined = shift === "all" || shift === "combined";

  let body: ReactNode;
  if (!data) {
    body = <p>{t("Nothing to print yet: the report is still loading.")}</p>;
  } else {
    const rows: TotalsRow[] = [
      ...(showMorning ? data.morning.map((p) => ({ name: p.name, shift: "morning" as const, orders: p.orders, amount: p.amount })) : []),
      ...(showAfternoon ? data.afternoon.map((p) => ({ name: p.name, shift: "afternoon" as const, orders: p.orders, amount: p.amount })) : []),
      ...(showCombined ? data.combined.map((g) => ({ name: g.label, shift: "combined" as const, orders: g.orders, amount: g.amount })) : []),
    ];
    const selection = ordersInSelection(data, shift);
    const flagged = selection.filter((o) => o.flags.length > 0);

    // The person list that is OPEN on screen (if any) prints its order cards.
    let expanded: { name: string; shift: ShiftKey; orders: ShiftOrderCard[] } | null = null;
    if (open) {
      const [prefix, ...rest] = open.split(":");
      const name = rest.join(":");
      if (prefix === "m" && showMorning) {
        const p = data.morning.find((x) => x.name === name);
        if (p) expanded = { name, shift: "morning", orders: p.ticketIds.map((id) => data.orders[id]).filter(Boolean) };
      } else if (prefix === "a" && showAfternoon) {
        const p = data.afternoon.find((x) => x.name === name);
        if (p) expanded = { name, shift: "afternoon", orders: p.ticketIds.map((id) => data.orders[id]).filter(Boolean) };
      } else if (prefix === "c" && showCombined) {
        const g = data.combined.find((x) => x.label === name);
        if (g) expanded = { name, shift: "combined", orders: g.ticketIds.map((id) => data.orders[id]).filter(Boolean) };
      }
    }

    body = (
      <>
        <p style={{ fontWeight: 800 }}>
          {t("{people} people • {orders} orders • {amount}", {
            people: data.totals.people,
            orders: data.totals.orders,
            amount: staffEtb(data.totals.amount),
          })}{" "}
          • {t("Need a look")}: {data.totals.flagged}
        </p>

        <h3>{t("Totals per person")}</h3>
        {rows.length === 0 ? (
          <p>{t("No orders for this selection.")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>{t("Name")}</th>
                <th>{t("Role")}</th>
                <th>{t("Shift")}</th>
                <th className="num">{t("Orders")}</th>
                <th className="num">{t("Total")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.shift}-${r.name}`}>
                  <td>{i + 1}</td>
                  <td>{r.name}</td>
                  <td>{t(ROLE_LABEL[role])}</td>
                  <td>{t(SHIFT_LABEL[r.shift])}</td>
                  <td className="num">{r.orders}</td>
                  <td className="num">{staffEtb(r.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              {shiftTotals(rows).map((s) => (
                <tr key={s.shift}>
                  <td colSpan={5} style={{ textAlign: "right", fontWeight: 900 }}>
                    {t(SHIFT_TOTAL_LABEL[s.shift])}
                  </td>
                  <td className="num" style={{ fontWeight: 900 }}>
                    {staffEtb(s.amount)}
                  </td>
                </tr>
              ))}
            </tfoot>
          </table>
        )}
        {rows.length > 0 && (
          <p style={{ fontSize: "10px", marginTop: 3 }}>
            {t("Combined orders are shared, so they are counted on each person and again under Combined. Compare shift totals, not the sum of all rows.")}
          </p>
        )}

        <h3>{t("Need a look ({n})", { n: flagged.length })}</h3>
        {flagged.length === 0 ? (
          <p>{t("No order in this selection needs a look.")}</p>
        ) : (
          flagged.map((o) => (
            <div key={o.ticketId} className="sp-card">
              <p style={{ fontWeight: 900 }}>
                {o.tableName} • #{o.orderNumber || o.ticketId} • {staffEtb(o.totalAmount)} • {statusText(o.status, i18n)}
              </p>
              <p>
                {o.flags.map((f) => (
                  <span key={f} className="sp-tag">
                    ⚠ {td(f)}
                  </span>
                ))}
              </p>
              <p style={{ fontSize: "11px" }}>{printWho(o, i18n)}</p>
            </div>
          ))
        )}

        {expanded && (
          <>
            <h3>{t("Orders of {name} • {shift}", { name: expanded.name, shift: t(SHIFT_LABEL[expanded.shift]) })}</h3>
            {expanded.orders.map((o) => (
              <div key={o.ticketId} className="sp-card">
                <p style={{ fontWeight: 900 }}>
                  {o.tableName} • #{o.orderNumber || o.ticketId} • {formatDateTime(o.createdAt)} • {staffEtb(o.totalAmount)} • {statusText(o.status, i18n)}
                </p>
                <p style={{ fontSize: "11px" }}>{printWho(o, i18n)}</p>
                <p style={{ fontSize: "11px" }}>
                  {o.actions
                    .filter((a) => expanded!.shift === "combined" || (a.name === expanded!.name && a.shift === expanded!.shift))
                    .map((a) => `${td(a.label)} • ${formatDateTime(a.at)}${expanded!.shift === "combined" ? ` • ${a.name}` : ""}`)
                    .join("  |  ")}
                </p>
                <table style={{ marginTop: 3 }}>
                  <tbody>
                    {o.items
                      .filter((i) => !i.removed)
                      .map((i) => (
                        <tr key={i.id}>
                          <td>
                            {i.quantity} × {i.name}
                            {i.notes ? ` (${i.notes})` : ""}
                          </td>
                          <td>
                            {i.doneBy ? t("✓ Done by {name}", { name: i.doneBy }) : i.acceptedBy ? t("▶ Accepted by {name}", { name: i.acceptedBy }) : ""}
                          </td>
                          <td className="num">{staffEtb(i.price * i.quantity)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {o.flags.length > 0 && (
                  <p>
                    {o.flags.map((f) => (
                      <span key={f} className="sp-tag">
                        ⚠ {td(f)}
                      </span>
                    ))}
                  </p>
                )}
              </div>
            ))}
          </>
        )}
      </>
    );
  }

  return createPortal(
    <div id="fana-shift-print" className="print-only shift-print-sheet" aria-hidden="true">
      <div style={{ borderBottom: "3px double #000", paddingBottom: 10, marginBottom: 12 }}>
        <PrintLetterhead logoUrl={logoUrl} />
        <div style={{ textAlign: "center" }}>
          <h2>{t("Shift Report ({role})", { role: t(ROLE_LABEL[role]) })}</h2>
          <p style={{ fontSize: "12px", fontWeight: 700 }}>
            {t("Shift: {shift} • Role: {role} • Date: {date}", { shift: t(shiftLabel), role: t(ROLE_LABEL[role]), date: t(DATE_LABEL[date]) })}
          </p>
          {data?.dayKeys?.length ? (
            <p style={{ fontSize: "12px", fontWeight: 700 }}>{t("Days covered: {range}", { range: daysCovered(data.dayKeys) })}</p>
          ) : null}
          <p style={{ fontSize: "11px" }}>
            {t("Morning = before {split} ({local} local) • Afternoon = from {split}", { split: pad(split), local: ethiopianHour(split) })}
          </p>
          <p style={{ fontSize: "11px" }}>{t("Printed: {time}", { time: printedAt.toLocaleString() })}</p>
        </div>
      </div>

      {body}

      {/* SIGNATURES: the paper is signed by the one who prepared it and the
          one who cross-checked it (same as the Sales Report). */}
      <div className="sp-sign" style={{ marginTop: 18, borderTop: "2px solid #000", paddingTop: 10 }}>
        <div style={{ display: "flex", gap: 32 }}>
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: "12px" }}>{t("Prepared by")}: ..............................</p>
            <p style={{ fontSize: "10px" }}>{t("Name and signature")}</p>
          </div>
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: "12px" }}>{t("Checked by")}: ..............................</p>
            <p style={{ fontSize: "10px" }}>{t("Name and signature")}</p>
          </div>
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: "12px" }}>{t("Date")}: ..............................</p>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** "Accepted by Abel" or, for a waiter's own order, "Sent by yeshi". */
function printWho(o: ShiftOrderCard, i18n: StaffI18n): string {
  if (o.confirmedBy) return i18n.t("Accepted by {name}", { name: o.confirmedBy });
  if (o.sentBy) return i18n.t("Sent by {name}", { name: o.sentBy });
  return `${i18n.t("Accepted by")}: ${i18n.t("n/a")}`;
}
