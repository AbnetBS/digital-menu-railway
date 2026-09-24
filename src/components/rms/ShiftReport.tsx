"use client";

import { useCallback, useEffect, useState } from "react";
import { XCircle, RefreshCw, Sun, Sunset, Users, ChevronDown, ChevronRight, AlertTriangle, Clock } from "lucide-react";
import { formatClock, formatDateTime } from "@/lib/order-lines";
import {
  SHIFT_DATES,
  SHIFT_DATE_LABELS,
  SHIFT_ROLES,
  SHIFT_ROLE_LABELS,
  STATION_ROLES,
  type ShiftDate,
  type ShiftOrderCard,
  type ShiftPersonRow,
  type ShiftReport as Report,
  type ShiftRole,
} from "@/lib/shift-report";

type ShiftFilter = "all" | "morning" | "afternoon" | "combined";
const SHIFT_FILTERS: { key: ShiftFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "morning", label: "Morning" },
  { key: "afternoon", label: "Afternoon" },
  { key: "combined", label: "Combined" },
];

/** 14 → "8:00" on the Ethiopian clock (day hours count from 6:00 AM). */
function ethiopianHour(h: number): string {
  const e = ((h - 6 + 24) % 12) || 12;
  return `${e}:00`;
}
const pad = (h: number) => `${String(h).padStart(2, "0")}:00`;
const etb = (n: number) => `${Number(n || 0).toLocaleString()} ETB`;

type ReportResponse = Report & { dayKeys: string[]; error?: string };

export default function ShiftReport({ onClose }: { onClose: () => void }) {
  const [shift, setShift] = useState<ShiftFilter>("all");
  const [role, setRole] = useState<ShiftRole>("waiter");
  const [date, setDate] = useState<ShiftDate>("today");
  const [data, setData] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null); // expanded person/group key
  const [detail, setDetail] = useState<ShiftOrderCard | null>(null);
  const [savingSplit, setSavingSplit] = useState(false);

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
    await fetch("/api/reports/shifts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ splitHour: h }),
    });
    setSavingSplit(false);
    load(role, date);
  };

  const split = data?.splitHour ?? 14;
  const station = STATION_ROLES.includes(role);
  const showMorning = shift === "all" || shift === "morning";
  const showAfternoon = shift === "all" || shift === "afternoon";
  const showCombined = shift === "all" || shift === "combined";

  const pill = (active: boolean) =>
    `px-3 py-2 rounded-xl text-xs font-black uppercase tracking-wide transition active:scale-95 ${
      active ? "bg-[#C9A227] text-[#2C1B17]" : "bg-black/30 border border-stone-700 text-stone-300 hover:border-[#C9A227]/60"
    }`;

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-start justify-center p-2 sm:p-4 no-print overflow-y-auto">
      <div className="bg-[#1E120D] border-2 border-[#C9A227]/50 rounded-2xl w-full max-w-4xl my-2">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-[#1E120D] border-b border-stone-800 px-4 sm:px-5 py-4 rounded-t-2xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-serif font-black text-xl text-amber-100 flex items-center gap-2">
                <Clock className="w-5 h-5 text-[#C9A227]" /> Shift Report
              </h2>
              <p className="text-[11px] text-stone-400 mt-0.5">
                Who handled which order, per shift. Morning = before {pad(split)} ({ethiopianHour(split)} local), Afternoon = from{" "}
                {pad(split)}. Orders handled by 2+ people of the same role are listed under Combined.
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => load(role, date)} className="p-2 rounded-lg bg-white/10 text-amber-200 hover:bg-white/20" title="Refresh">
                <RefreshCw className={`w-5 h-5 ${loading ? "animate-spin" : ""}`} />
              </button>
              <button onClick={onClose} className="p-2 rounded-lg bg-white/10 text-stone-300 hover:bg-white/20" title="Close">
                <XCircle className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Filters */}
          <div className="mt-3 space-y-2">
            <FilterRow label="Shift">
              {SHIFT_FILTERS.map((f) => (
                <button key={f.key} className={pill(shift === f.key)} onClick={() => setShift(f.key)}>
                  {f.label}
                </button>
              ))}
            </FilterRow>
            <FilterRow label="Role">
              <select
                value={role}
                onChange={(e) => pickRole(e.target.value as ShiftRole)}
                className="bg-black/40 border border-[#C9A227]/60 text-amber-100 text-xs font-black uppercase rounded-xl px-3 py-2"
              >
                {SHIFT_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {SHIFT_ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </FilterRow>
            <FilterRow label="Date">
              {SHIFT_DATES.map((d) => (
                <button key={d} className={pill(date === d)} onClick={() => pickDate(d)}>
                  {SHIFT_DATE_LABELS[d]}
                </button>
              ))}
            </FilterRow>
          </div>
        </div>

        <div className="px-4 sm:px-5 py-4 space-y-4">
          {error && <div className="bg-rose-900/60 border border-rose-500 text-rose-200 text-xs p-3 rounded-xl font-bold">{error}</div>}
          {!data ? (
            <p className="text-center text-stone-500 text-sm py-10">Loading shift report…</p>
          ) : (
            <>
              {/* Summary */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Stat label={SHIFT_ROLE_LABELS[role] + "s"} value={String(data.totals.people)} />
                <Stat label="Orders" value={String(data.totals.orders)} />
                <Stat label={station ? "Value of their lines" : "Bill value"} value={etb(data.totals.amount)} />
                <Stat label="Need a look" value={String(data.totals.flagged)} warn={data.totals.flagged > 0} />
              </div>

              <p className="text-[11px] text-stone-400 font-bold">
                {SHIFT_ROLE_LABELS[role]} • {SHIFT_DATE_LABELS[date]}
                {data.dayKeys?.length ? ` • ${data.dayKeys[data.dayKeys.length - 1]}${data.dayKeys.length > 1 ? ` → ${data.dayKeys[0]}` : ""}` : ""}
              </p>

              {/* TOTALS TABLE (cross-checker, Sept 2026): one line per person per
                  shift: "Abel • Waiter • Morning • 5 orders • 4,250 ETB". */}
              <TotalsTable
                role={role}
                rows={[
                  ...(showMorning ? data.morning.map((p) => ({ name: p.name, shift: "Morning", orders: p.orders, amount: p.amount })) : []),
                  ...(showAfternoon ? data.afternoon.map((p) => ({ name: p.name, shift: "Afternoon", orders: p.orders, amount: p.amount })) : []),
                  ...(showCombined ? data.combined.map((g) => ({ name: g.label, shift: "Combined", orders: g.orders, amount: g.amount })) : []),
                ]}
              />

              {showMorning && (
                <ShiftSection
                  icon={<Sun className="w-4 h-4 text-amber-300" />}
                  title="Morning Shift"
                  subtitle={`before ${pad(split)}`}
                  rows={data.morning}
                  prefix="m"
                  open={open}
                  setOpen={setOpen}
                  data={data}
                  station={station}
                  role={role}
                  onOpenOrder={setDetail}
                  shiftFilter="morning"
                />
              )}
              {showAfternoon && (
                <ShiftSection
                  icon={<Sunset className="w-4 h-4 text-orange-400" />}
                  title="Afternoon Shift"
                  subtitle={`from ${pad(split)}`}
                  rows={data.afternoon}
                  prefix="a"
                  open={open}
                  setOpen={setOpen}
                  data={data}
                  station={station}
                  role={role}
                  onOpenOrder={setDetail}
                  shiftFilter="afternoon"
                />
              )}
              {showCombined && (
                <section className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-4">
                  <h3 className="text-sm font-black text-amber-200 uppercase tracking-wider flex items-center gap-2">
                    <Users className="w-4 h-4 text-sky-300" /> Combined Shift
                    <span className="text-[10px] text-stone-500 normal-case font-bold tracking-normal">2+ people on one order</span>
                  </h3>
                  {data.combined.length === 0 ? (
                    <p className="text-xs text-stone-500 mt-3">No shared orders.</p>
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
                            />
                            {open === key && (
                              <OrderList ids={g.ticketIds} data={data} station={station} role={role} onOpen={setDetail} />
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
                <span className="font-bold">Shift change at</span>
                <select
                  value={split}
                  disabled={savingSplit}
                  onChange={(e) => saveSplit(Number(e.target.value))}
                  className="bg-black/40 border border-stone-700 text-amber-100 rounded-lg px-2 py-1 font-bold"
                >
                  {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
                    <option key={h} value={h}>
                      {pad(h)} ({ethiopianHour(h)} local)
                    </option>
                  ))}
                </select>
                <span>Every action is placed in the shift it happened in, so a person who worked both shifts shows in both.</span>
              </div>
            </>
          )}
        </div>
      </div>

      {detail && <OrderDetail order={detail} role={role} station={station} onClose={() => setDetail(null)} />}
    </div>
  );
}

function TotalsTable({ role, rows }: { role: ShiftRole; rows: { name: string; shift: string; orders: number; amount: number }[] }) {
  if (rows.length === 0) return null;
  const byShift = (sh: string) => rows.filter((r) => r.shift === sh).reduce((s, r) => s + r.amount, 0);
  const shifts = [...new Set(rows.map((r) => r.shift))];
  return (
    <section className="bg-[#2C1B17] rounded-2xl border border-[#C9A227]/40 p-4 overflow-x-auto">
      <h3 className="text-sm font-black text-amber-200 uppercase tracking-wider mb-2">Totals per person</h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase text-stone-500 text-left">
            <th className="py-1 pr-2">#</th>
            <th className="py-1 pr-2">Name</th>
            <th className="py-1 pr-2">Role</th>
            <th className="py-1 pr-2">Shift</th>
            <th className="py-1 pr-2 text-right">Orders</th>
            <th className="py-1 text-right">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-800">
          {rows.map((r, i) => (
            <tr key={`${r.shift}-${r.name}`}>
              <td className="py-1.5 pr-2 font-black text-[#C9A227]">{i + 1}</td>
              <td className="py-1.5 pr-2 font-black text-amber-100">{r.name}</td>
              <td className="py-1.5 pr-2 text-stone-300">{SHIFT_ROLE_LABELS[role]}</td>
              <td className="py-1.5 pr-2 text-stone-300">{r.shift}</td>
              <td className="py-1.5 pr-2 text-right text-stone-300">{r.orders}</td>
              <td className="py-1.5 text-right font-black text-[#C9A227]">{etb(r.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {shifts.map((sh) => (
            <tr key={sh} className="border-t border-stone-700">
              <td colSpan={5} className="py-1.5 pr-2 text-right font-black text-stone-300">{sh} total</td>
              <td className="py-1.5 text-right font-black text-amber-100">{etb(byShift(sh))}</td>
            </tr>
          ))}
        </tfoot>
      </table>
      <p className="text-[10px] text-stone-500 mt-2">
        Combined orders are shared, so they are counted on each person and again under Combined. Compare shift totals, not the sum of all rows.
      </p>
    </section>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="w-12 text-[10px] font-black uppercase tracking-wider text-stone-500">{label}</span>
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

function PersonRow(props: { idx: number; name: string; orders: number; amount: number; expanded: boolean; onToggle: () => void; hint?: string }) {
  return (
    <button
      onClick={props.onToggle}
      className={`w-full flex items-center gap-3 text-left rounded-xl px-3 py-2.5 border transition ${
        props.expanded ? "bg-[#3D2314] border-[#C9A227]/60" : "bg-black/25 border-stone-800 hover:border-[#C9A227]/40"
      }`}
    >
      <span className="w-6 text-xs font-black text-[#C9A227]">{props.idx}.</span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-black text-amber-100 truncate">{props.name}</span>
        {props.hint && <span className="block text-[10px] text-stone-500 font-bold">{props.hint}</span>}
      </span>
      <span className="text-[11px] font-bold text-stone-300 shrink-0">{props.orders} order(s)</span>
      <span className="text-xs font-black text-[#C9A227] shrink-0 w-24 text-right">{etb(props.amount)}</span>
      {props.expanded ? <ChevronDown className="w-4 h-4 text-stone-400" /> : <ChevronRight className="w-4 h-4 text-stone-400" />}
    </button>
  );
}

function ShiftSection(props: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  rows: ShiftPersonRow[];
  prefix: string;
  open: string | null;
  setOpen: (k: string | null) => void;
  data: Report;
  station: boolean;
  role: ShiftRole;
  onOpenOrder: (o: ShiftOrderCard) => void;
  shiftFilter: "morning" | "afternoon";
}) {
  return (
    <section className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-4">
      <h3 className="text-sm font-black text-amber-200 uppercase tracking-wider flex items-center gap-2">
        {props.icon} {props.title}
        <span className="text-[10px] text-stone-500 normal-case font-bold tracking-normal">{props.subtitle}</span>
      </h3>
      {props.rows.length === 0 ? (
        <p className="text-xs text-stone-500 mt-3">Nobody in this shift.</p>
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
                />
                {props.open === key && (
                  <OrderList
                    ids={p.ticketIds}
                    data={props.data}
                    station={props.station}
                    role={props.role}
                    onOpen={props.onOpenOrder}
                    person={p.name}
                    shift={props.shiftFilter}
                  />
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function OrderList(props: {
  ids: number[];
  data: Report;
  station: boolean;
  role: ShiftRole;
  onOpen: (o: ShiftOrderCard) => void;
  person?: string;
  shift?: "morning" | "afternoon";
}) {
  return (
    <div className="mt-2 ml-2 sm:ml-8 space-y-2">
      {props.ids.map((id) => {
        const o = props.data.orders[id];
        if (!o) return null;
        return props.station ? (
          <StationCard key={id} order={o} role={props.role} onOpen={() => props.onOpen(o)} />
        ) : (
          <FloorCard key={id} order={o} person={props.person} shift={props.shift} onOpen={() => props.onOpen(o)} />
        );
      })}
    </div>
  );
}

function Flags({ flags }: { flags: string[] }) {
  if (!flags.length) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {flags.map((f) => (
        <span key={f} className="inline-flex items-center gap-1 text-[10px] font-black px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40">
          <AlertTriangle className="w-3 h-3" /> {f}
        </span>
      ))}
    </div>
  );
}

function statusBadge(status: string) {
  const s = status.replace(/_/g, " ").toUpperCase();
  const cls =
    status === "cancelled"
      ? "bg-rose-500/20 text-rose-300 border-rose-500/40"
      : status === "closed" || status === "paid" || status === "completed"
        ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
        : "bg-sky-500/20 text-sky-300 border-sky-500/40";
  return <span className={`text-[10px] font-black px-2 py-0.5 rounded-full border ${cls}`}>{s}</span>;
}

/** Waiter / cashier card: what this person did on the order. */
function FloorCard({ order, person, shift, onOpen }: { order: ShiftOrderCard; person?: string; shift?: string; onOpen: () => void }) {
  const mine = order.actions.filter((a) => (!person || a.name === person) && (!shift || a.shift === shift));
  const shown = mine.length ? mine : order.actions;
  const lines = order.items.filter((i) => !i.removed).length;
  return (
    <button onClick={onOpen} className="w-full text-left bg-[#3D2314] rounded-xl border border-stone-800 hover:border-[#C9A227]/60 p-3 transition">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-serif font-black text-base text-amber-100">
            {order.tableName}
            {order.orderType === "outdoor" && <span className="ml-2 text-[10px] font-black text-violet-300">OUTDOOR</span>}
            {order.combined && <span className="ml-2 text-[10px] font-black text-sky-300">SHARED: {order.people.join(" - ")}</span>}
          </p>
          {shown.map((a, i) => (
            <p key={i} className="text-[11px] font-bold text-stone-300">
              <span className="text-amber-300 uppercase">{a.label}</span> {order.orderNumber ? `#${order.orderNumber}` : ""} • {formatDateTime(a.at)}
              {!person || order.combined ? <span className="text-stone-400"> • {a.name}</span> : null}
            </p>
          ))}
          <p className="text-[11px] text-stone-400 font-semibold">{lines} line(s) on the bill</p>
        </div>
        <div className="text-right shrink-0 space-y-1">
          <p className="text-sm font-black text-[#C9A227]">{etb(order.totalAmount)}</p>
          {statusBadge(order.status)}
        </div>
      </div>
      <Flags flags={order.flags} />
    </button>
  );
}

/** Kitchen / barista / juice / buna card, like the station dashboard. */
function StationCard({ order, role, onOpen }: { order: ShiftOrderCard; role: ShiftRole; onOpen: () => void }) {
  const mine = order.items.filter((i) => i.stationName === role && !i.removed);
  const done = mine.filter((i) => i.stationStatus === "done").length;
  const cleared = mine.length > 0 && done === mine.length;
  return (
    <button onClick={onOpen} className="w-full text-left bg-[#3D2314] rounded-xl border border-stone-800 hover:border-[#C9A227]/60 p-3 transition">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-serif font-black text-base text-amber-100">{order.tableName}</p>
          <p className="text-[11px] font-bold text-stone-300">
            Order {order.orderNumber ? `#${order.orderNumber}` : `#${order.ticketId}`} 🕒 received {formatDateTime(order.confirmedAt || order.createdAt)}
          </p>
          {order.confirmedBy && <p className="text-[11px] font-bold text-stone-300">👤 {order.confirmedBy}</p>}
        </div>
        <span
          className={`text-[10px] font-black px-2 py-1 rounded-full border shrink-0 ${
            cleared ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40" : "bg-rose-500/20 text-rose-300 border-rose-500/40"
          }`}
        >
          {cleared ? "✓ CLEARED" : "⚠ OPEN"} {done}/{mine.length} done
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
                  ▶ Accepted by {i.acceptedBy}
                  {i.acceptedAt ? ` • ${formatClock(i.acceptedAt)}` : ""}
                </p>
              )}
              {i.doneBy ? (
                <p className="text-[11px] font-bold text-emerald-300">
                  ✓ Done by {i.doneBy}
                  {i.doneAt ? ` • ${formatClock(i.doneAt)}` : ""}
                </p>
              ) : (
                <p className="text-[11px] font-black text-rose-300">✗ never marked done</p>
              )}
            </div>
            <span className={`text-[10px] font-black shrink-0 ${i.stationStatus === "done" ? "text-emerald-300" : "text-rose-300"}`}>
              {i.stationStatus === "done" ? "✓ DONE" : (i.stationStatus || "pending").toUpperCase()}
            </span>
          </div>
        ))}
      </div>
      {order.combined && <p className="text-[10px] font-black text-sky-300 mt-1">SHARED: {order.people.join(" - ")}</p>}
      <Flags flags={order.flags} />
    </button>
  );
}

function OrderDetail({ order, role, station, onClose }: { order: ShiftOrderCard; role: ShiftRole; station: boolean; onClose: () => void }) {
  const live = order.items.filter((i) => !i.removed);
  const removed = order.items.filter((i) => i.removed);
  return (
    <div className="fixed inset-0 z-[60] bg-black/85 flex items-center justify-center p-3" onClick={onClose}>
      <div className="bg-[#2C1B17] border-2 border-[#C9A227]/50 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-[#2C1B17] border-b border-stone-800 px-5 py-4 flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-serif font-black text-xl text-amber-100">{order.tableName}</h3>
              {statusBadge(order.status)}
            </div>
            <p className="text-xs font-bold text-stone-300">
              {order.orderNumber ? `#${order.orderNumber}` : `#${order.ticketId}`} • opened {formatDateTime(order.createdAt)}
            </p>
            {order.serviceNote && <p className="text-xs font-bold text-sky-300">📍 {order.serviceNote}</p>}
          </div>
          <button onClick={onClose} className="p-2 rounded-lg bg-white/10 text-stone-300 hover:bg-white/20">
            <XCircle className="w-5 h-5" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3 text-xs">
          <Flags flags={order.flags} />
          <div className="grid grid-cols-2 gap-2">
            <Who label="Accepted by" name={order.confirmedBy} at={order.confirmedAt} />
            <Who label="Printed by" name={order.printedBy} at={order.printedAt} />
            <Who label="Cleared by" name={order.closedBy} at={order.closedAt} />
            <Who label={`${SHIFT_ROLE_LABELS[role]}(s)`} name={order.people.join(" - ")} />
          </div>

          <div className="bg-[#3D2314] rounded-xl divide-y divide-stone-800">
            {live.map((i) => (
              <div key={i.id} className={`p-3 flex items-start justify-between gap-3 ${station && !i.mine ? "opacity-50" : ""}`}>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-amber-100">{i.name}</p>
                  <p className="font-semibold text-stone-300">
                    {i.quantity} × {i.price} ETB • {i.stationName || "kitchen"} • added {formatClock(i.createdAt)}
                  </p>
                  {i.notes && <p className="italic text-amber-300">📝 {i.notes}</p>}
                  {i.acceptedBy && <p className="font-bold text-sky-300">▶ Accepted by {i.acceptedBy} {i.acceptedAt ? `• ${formatClock(i.acceptedAt)}` : ""}</p>}
                  {i.doneBy ? (
                    <p className="font-bold text-emerald-300">✓ Done by {i.doneBy} {i.doneAt ? `• ${formatClock(i.doneAt)}` : ""}</p>
                  ) : (
                    <p className="font-black text-rose-300">✗ not marked done</p>
                  )}
                  {i.afterPrint && <p className="font-black text-amber-300">⚠ added after the print: not on the EFD receipt yet</p>}
                </div>
                <span className="text-sm font-black text-[#C9A227] shrink-0">{i.price * i.quantity} ETB</span>
              </div>
            ))}
            {live.length === 0 && <p className="p-3 text-center text-stone-500">No items.</p>}
          </div>
          {removed.length > 0 && (
            <div className="bg-rose-950/40 border border-rose-800 rounded-xl p-3">
              <p className="font-black text-rose-300 mb-1">Removed lines</p>
              {removed.map((i) => (
                <p key={i.id} className="text-rose-200 line-through">
                  {i.quantity} × {i.name} ({i.price * i.quantity} ETB)
                </p>
              ))}
            </div>
          )}
          <div className="bg-[#3D2314] border border-[#C9A227]/40 rounded-xl px-4 py-3 flex items-center justify-between">
            <span className="text-sm font-black text-stone-200">Bill total</span>
            <span className="font-serif font-black text-2xl text-[#C9A227]">{order.totalAmount} ETB</span>
          </div>

          {order.timeline.length > 0 && (
            <div>
              <p className="font-black text-amber-200 uppercase tracking-wider text-[11px] mb-1">Timeline</p>
              <ul className="space-y-1">
                {order.timeline.map((t, i) => (
                  <li key={i} className="text-stone-300">
                    <span className="font-bold text-stone-400">{formatClock(t.at)}</span> {t.text}
                    {t.actor ? <span className="text-amber-300"> • {t.actor}</span> : null}
                    {t.role ? <span className="text-stone-500"> ({t.role})</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Who({ label, name, at }: { label: string; name: string | null; at?: string | null }) {
  return (
    <div className="bg-black/25 rounded-lg p-2 border border-stone-800">
      <p className="text-[10px] font-black uppercase text-stone-500">{label}</p>
      <p className="font-bold text-amber-100 truncate">{name || "n/a"}</p>
      {at && <p className="text-[10px] text-stone-400">{formatDateTime(at)}</p>}
    </div>
  );
}
