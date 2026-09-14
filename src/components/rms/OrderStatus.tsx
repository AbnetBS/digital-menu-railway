"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ArrowLeft, CheckCircle2, ChevronDown, Loader2, Receipt, RefreshCw } from "lucide-react";
import { useT } from "@/lib/i18n";
import { formatClock, type CustomerOrderPhase } from "@/lib/order-lines";
import LanguageToggle from "@/components/LanguageToggle";

/**
 * THE GUEST'S ORDER STATUS + RECEIPT BUTTON.
 *
 * After a guest sends an order — or scans the QR when the waiter took the
 * order — a small floating pill sits above the language button showing that
 * this table HAS an order and what phase it is in. One tap opens the panel:
 * the dish list with a per-line chip (Accepted / Preparing / Ready) that
 * moves when the kitchen, barista or juice maker taps Accept/Done, plus the
 * running total. The receipt button below the menu is unchanged.
 *
 *   • <OrderStatusProvider/>   — keeps polling the public, table-scoped
 *                                `/api/table-status` endpoint so the page
 *                                knows whether THIS table has a live order,
 *                                what is on it, and whether the receipt was
 *                                already asked for (plus `requestBill` and a
 *                                manual `refresh` for the panel).
 *   • <OrderStatusDock/>       — the floating pill + expandable panel. Renders
 *                                nothing until the table has a live order.
 *   • <RequestReceiptButton/>  — one big button with a receipt icon. One tap
 *                                and the waiter's phone rings for ~3 seconds
 *                                and shows WHICH table. After the request it
 *                                is replaced by a confirmation line with the
 *                                time.
 *
 * BUNA RULE (owner's decision): buna lines ALWAYS show "Accepted". The buna
 * makers do not watch their phones, so their lane would sit "pending" forever
 * and trap the guest's view. This is display-only — nothing is auto-accepted
 * in the database, so waiter edits and cashier totals are untouched.
 */

/** How often the guest's phone asks for an update while the menu is open. */
const POLL_MS = 12_000;

export interface TableTicketLine {
  name: string;
  quantity: number;
  notes: string;
  /** Full crew lane ("kitchen" | "barista" | "buna" | "juice"). */
  station: string;
  stationStatus: string;
}

export interface TableTicketStatus {
  id: number;
  orderNumber: string | null;
  status: string;
  paymentStatus: string;
  totalAmount: number;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  receiptRequestedAt: string | null;
  phase: CustomerOrderPhase;
  lines: TableTicketLine[];
}

export interface TableStatus {
  tableId: number;
  ticket: TableTicketStatus | null;
}

interface OrderStatusValue {
  tableId: number;
  ticket: TableTicketStatus | null;
  /** Bill request in flight. */
  requesting: boolean;
  requestBill: () => Promise<void>;
  /** Immediate re-poll (the panel's "refresh now" button). */
  refresh: () => Promise<void>;
}

const OrderStatusContext = createContext<OrderStatusValue | null>(null);

export function useOrderStatus(): OrderStatusValue {
  const ctx = useContext(OrderStatusContext);
  if (!ctx) throw new Error("useOrderStatus must be used inside <OrderStatusProvider>");
  return ctx;
}

export interface OrderStatusProviderProps {
  tableId: number;
  /** Bump to force an immediate refresh (e.g. right after the guest submits). */
  refreshKey?: number;
  children?: ReactNode;
}

export function OrderStatusProvider({
  tableId,
  refreshKey = 0,
  children,
}: OrderStatusProviderProps) {
  const [status, setStatus] = useState<TableStatus | null>(null);
  const [requesting, setRequesting] = useState(false);

  const refresh = useCallback(async () => {
    if (!tableId) return;
    try {
      const response = await fetch(`/api/table-status?table=${tableId}`);
      if (response.ok) setStatus(await response.json());
    } catch {
      // A failed poll must never disturb the menu — the next tick retries.
    }
  }, [tableId]);

  useEffect(() => {
    if (!tableId) return;
    // First fetch on a 0ms timer: the same async boundary as the poll below, so
    // the effect body itself never updates state synchronously.
    const kickoff = setTimeout(refresh, 0);
    // Poll only while the tab is actually visible: a phone left open on the table
    // must not keep hammering the server all evening.
    const timer = setInterval(() => {
      if (typeof document === "undefined" || !document.hidden) refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(kickoff);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tableId, refresh, refreshKey]);

  const requestBill = useCallback(async () => {
    if (!tableId || requesting) return;
    setRequesting(true);
    try {
      const response = await fetch("/api/table-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table: tableId }),
      });
      if (response.ok) setStatus(await response.json());
      else await refresh();
    } catch {
      await refresh();
    } finally {
      setRequesting(false);
    }
  }, [tableId, requesting, refresh]);

  const value = useMemo<OrderStatusValue>(
    () => ({
      tableId,
      ticket: status?.ticket ?? null,
      requesting,
      requestBill,
      refresh,
    }),
    [tableId, status, requesting, requestBill, refresh]
  );

  return <OrderStatusContext.Provider value={value}>{children}</OrderStatusContext.Provider>;
}

/* ───────────────────── the receipt button ───────────────────── */

/**
 * May this guest call for the bill right now? Yes for any live order that has
 * not already asked and is not settled or cancelled. It is deliberately NOT
 * gated on the kitchen finishing: in a rush a guest often wants to pay while
 * the last dish is still cooking, and making them wave at a waiter instead is
 * exactly the problem this button removes.
 */
function canAskForBill(ticket: TableTicketStatus): boolean {
  return !ticket.receiptRequestedAt && ticket.phase !== "paid" && ticket.phase !== "cancelled";
}

/**
 * ONE BIG BUTTON: "Request the bill / receipt".
 *
 * It appears only when this table has a live order, the receipt has not been
 * requested yet, and the bill is not paid or cancelled (canAskForBill). While
 * the request is in flight it is disabled and says "Sending…"; afterwards it
 * is replaced by the confirmation line with the time, and it never comes back
 * for the same bill.
 */
export function RequestReceiptButton() {
  const { ticket, requestBill, requesting } = useOrderStatus();
  const t = useT();
  if (!ticket) return null;

  const billRequested = Boolean(ticket.receiptRequestedAt);
  const canAsk = canAskForBill(ticket);
  if (!canAsk && !billRequested) return null;

  return (
    <div
      className={`w-full rounded-2xl border px-3.5 py-3 shadow-sm ${
        billRequested ? "bg-emerald-50 border-emerald-300" : "bg-white border-[#C9A227]/40"
      }`}
    >
      {canAsk && (
        <button
          type="button"
          onClick={requestBill}
          disabled={requesting}
          className="w-full bg-[#4E342E] text-amber-200 font-black text-sm uppercase py-3.5 rounded-xl flex items-center justify-center gap-2 disabled:opacity-60 active:scale-[0.99] transition"
        >
          {requesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Receipt className="w-5 h-5" />}
          {requesting ? t("os_sending") : t("os_request_bill")}
        </button>
      )}
      {billRequested && (
        <div className="space-y-1">
          <p className="text-[11px] font-black text-emerald-800 flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4 shrink-0" /> {t("os_bill_requested")}
          </p>
          <p className="text-[11px] text-emerald-700 font-semibold pl-5">
            {t("os_bill_requested_at")} {formatClock(ticket.receiptRequestedAt)}
          </p>
        </div>
      )}
    </div>
  );
}

/* ───────────────────── the floating status dock ───────────────────── */

/** One sentence per phase, in the guest's language. */
const PHASE_SENTENCE = {
  none: "os_phase_none",
  waiting: "os_phase_waiting",
  confirmed: "os_phase_confirmed",
  preparing: "os_phase_preparing",
  ready: "os_phase_ready",
  bill: "os_phase_bill",
  paid: "os_phase_paid",
  cancelled: "os_phase_cancelled",
} as const;

/** Pill dot + phase banner accent per phase. */
const PHASE_STYLE: Record<CustomerOrderPhase, { dot: string; banner: string }> = {
  none: { dot: "bg-stone-400", banner: "bg-stone-50 text-stone-700 border border-stone-200" },
  waiting: { dot: "bg-amber-400", banner: "bg-amber-50 text-amber-900 border border-amber-200" },
  confirmed: { dot: "bg-sky-400", banner: "bg-sky-50 text-sky-900 border border-sky-200" },
  preparing: { dot: "bg-orange-500", banner: "bg-orange-50 text-orange-900 border border-orange-200" },
  ready: { dot: "bg-emerald-500", banner: "bg-emerald-50 text-emerald-900 border border-emerald-200" },
  bill: { dot: "bg-violet-500", banner: "bg-violet-50 text-violet-900 border border-violet-200" },
  paid: { dot: "bg-emerald-600", banner: "bg-emerald-50 text-emerald-900 border border-emerald-200" },
  cancelled: { dot: "bg-rose-500", banner: "bg-rose-50 text-rose-900 border border-rose-200" },
};

type LineChip = "accepted" | "preparing" | "ready";

const CHIP_STYLE: Record<LineChip, string> = {
  accepted: "bg-sky-100 text-sky-900",
  preparing: "bg-amber-100 text-amber-900",
  ready: "bg-emerald-100 text-emerald-900",
};

/**
 * The chip one dish row shows. The crew's `pending → accepted → done` maps to
 * the guest's Accepted / Preparing / Ready — and buna lines ALWAYS read
 * Accepted, because the buna makers do not watch their phones (display-only;
 * the database row is untouched).
 */
function chipOf(line: TableTicketLine): LineChip {
  if (line.station === "buna") return "accepted";
  const state = String(line.stationStatus ?? "pending");
  if (state === "done") return "ready";
  if (state === "accepted") return "preparing";
  return "accepted";
}

/** Sent = 0, Preparing = 1, Done = 2. Kitchen/barista Accept moves to 1, Done to 2. */
function stepOf(line: TableTicketLine): 0 | 1 | 2 {
  const chip = chipOf(line);
  if (chip === "ready") return 2;
  if (chip === "preparing") return 1;
  return 0;
}

/**
 * Food name + a 3-stop line: Sent -> Preparing -> Done.
 * The line fills as the kitchen, barista or juice maker tap Accept / Done.
 */
function LineTimeline({ line, compact = false }: { line: TableTicketLine; compact?: boolean }) {
  const t = useT();
  const step = stepOf(line);
  const steps = [
    { key: "sent", label: t("os_step_sent") },
    { key: "preparing", label: t("os_step_preparing") },
    { key: "done", label: t("os_step_done") },
  ];
  const chip = chipOf(line);
  const chipLabel =
    chip === "ready" ? t("os_line_done") : chip === "preparing" ? t("os_line_preparing") : t("os_line_accepted");

  return (
    <li className={compact ? "space-y-1.5" : "space-y-2.5 bg-white rounded-2xl border border-[#C9A227]/30 p-3.5 shadow-sm"}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={`font-bold text-[#2C1B17] leading-snug ${compact ? "text-xs" : "text-sm"}`}>
            {line.name} <span className="text-stone-400 font-semibold">×{line.quantity}</span>
          </p>
          {line.notes ? <p className="text-[10px] text-stone-500 leading-snug mt-0.5">{line.notes}</p> : null}
        </div>
        <span className={`shrink-0 text-[10px] font-black px-2 py-0.5 rounded-full ${CHIP_STYLE[chip]}`}>
          {chipLabel}
        </span>
      </div>
      <div className="flex items-start pt-0.5" aria-label={`${line.name}: ${steps[step].label}`}>
        {steps.map((s, i) => {
          const reached = i <= step;
          const current = i === step;
          return (
            <div key={s.key} className="flex items-start flex-1 last:flex-none">
              <div className="flex flex-col items-center min-w-[3.25rem]">
                <span
                  className={`w-3.5 h-3.5 rounded-full border-2 ${
                    reached
                      ? current && step < 2
                        ? "bg-orange-500 border-orange-600 animate-pulse"
                        : "bg-emerald-500 border-emerald-600"
                      : "bg-white border-stone-300"
                  }`}
                />
                <span
                  className={`mt-1 text-[9px] font-black uppercase tracking-wide text-center leading-tight ${
                    reached ? (current && step < 2 ? "text-orange-700" : "text-emerald-700") : "text-stone-400"
                  }`}
                >
                  {s.label}
                </span>
              </div>
              {i < steps.length - 1 && (
                <div
                  className={`flex-1 h-1 rounded-full mt-[5px] ${i < step ? "bg-emerald-500" : "bg-stone-200"}`}
                />
              )}
            </div>
          );
        })}
      </div>
    </li>
  );
}

function OrderStatusBody({
  ticket,
  compact,
}: {
  ticket: TableTicketStatus;
  compact?: boolean;
}) {
  const { refresh } = useOrderStatus();
  const t = useT();
  const lines = Array.isArray(ticket.lines) ? ticket.lines : [];
  const style = PHASE_STYLE[ticket.phase] ?? PHASE_STYLE.none;

  return (
    <>
      <p className={`rounded-xl px-3 py-2 text-[11px] font-bold ${style.banner} ${compact ? "mx-3" : ""}`}>
        {t(PHASE_SENTENCE[ticket.phase] ?? PHASE_SENTENCE.none)}
      </p>
      <ul className={`${compact ? "max-h-56 px-3.5 py-2" : "max-h-[55vh] py-1"} overflow-y-auto space-y-2.5`}>
        {lines.map((line, i) => (
          <LineTimeline key={`${line.name}-${i}`} line={line} compact={compact} />
        ))}
      </ul>
      <div className={`flex items-center justify-between ${compact ? "px-3.5 py-2 border-t border-stone-100" : "pt-2"}`}>
        <span className="text-[11px] font-black text-stone-500 uppercase">{t("os_total")}</span>
        <span className="text-sm font-black text-[#4E342E]">{ticket.totalAmount} ETB</span>
      </div>
      <div className={`flex items-center justify-between ${compact ? "px-3.5 pb-3 pt-0.5" : "pt-1"}`}>
        <span className="text-[10px] text-stone-400 font-semibold">{t("os_auto_refresh")}</span>
        <button
          type="button"
          onClick={() => void refresh()}
          className="flex items-center gap-1 text-[11px] font-bold text-[#4E342E] active:opacity-60"
        >
          <RefreshCw className="w-3 h-3" /> {t("os_refresh_now")}
        </button>
      </div>
    </>
  );
}

/**
 * Full-page status after the guest taps "Check your order status": each dish
 * with a Sent → Preparing → Done line that moves when the crew taps Accept/Done.
 */
export function OrderStatusPage({
  onBack,
  onBackToMenu,
}: {
  onBack?: () => void;
  onBackToMenu?: () => void;
}) {
  const { ticket } = useOrderStatus();
  const t = useT();

  return (
    <div className="min-h-screen bg-[#FAF6F0] flex flex-col">
      <header className="sticky top-0 z-20 bg-[#2C1B17] text-white px-4 py-3 flex items-center gap-3 shadow-xl">
        {onBack && (
          <button type="button" onClick={onBack} className="p-1.5 -ml-1 text-amber-200" aria-label={t("close")}>
            <ArrowLeft className="w-5 h-5" />
          </button>
        )}
        <div className="min-w-0">
          <h1 className="font-serif font-black text-lg text-amber-100 leading-tight">{t("os_status_heading")}</h1>
          {ticket && (
            <p className="text-[10px] text-[#C9A227] font-bold">
              {ticket.orderNumber ? `#${ticket.orderNumber} • ` : ""}
              {t("os_arrived")} {formatClock(ticket.createdAt)}
            </p>
          )}
        </div>
      </header>
      <div className="flex-1 max-w-lg mx-auto w-full p-4 pb-24 space-y-4">
        {!ticket ? (
          <div className="bg-white rounded-2xl border border-[#C9A227]/40 p-6 text-center space-y-2">
            <Loader2 className="w-6 h-6 text-[#C9A227] animate-spin mx-auto" />
            <p className="text-sm font-bold text-[#2C1B17]">{t("os_no_order")}</p>
          </div>
        ) : (
          <div className="space-y-3">
            <OrderStatusBody ticket={ticket} />
          </div>
        )}
        {onBackToMenu && (
          <button
            type="button"
            onClick={onBackToMenu}
            className="w-full bg-[#4E342E] text-amber-200 font-bold text-sm py-3.5 rounded-xl"
          >
            {t("back_to_menu")}
          </button>
        )}
      </div>
      <LanguageToggle />
    </div>
  );
}

/**
 * THE FLOATING PILL + PANEL, above the language button.
 *
 * Renders nothing until this table has a live order (whoever sent it). The
 * orange Fana pill shows the order phase at a glance; tapping it opens the
 * panel with each dish and a Sent → Preparing → Done line that moves when
 * the kitchen, barista or juice maker taps Accept/Done.
 */
export function OrderStatusDock() {
  const { ticket } = useOrderStatus();
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!ticket) return null;

  const lines = Array.isArray(ticket.lines) ? ticket.lines : [];
  const units = lines.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);
  const style = PHASE_STYLE[ticket.phase] ?? PHASE_STYLE.none;
  const live = ticket.phase === "waiting" || ticket.phase === "preparing";

  return (
    <div className="fixed bottom-[76px] right-5 z-40 w-[calc(100vw-2.5rem)] max-w-xs flex flex-col items-end gap-2">
      {open && (
        <div className="w-full rounded-2xl border-2 border-[#C9A227] bg-white shadow-xl overflow-hidden">
          <div className="flex items-center gap-2 px-3.5 pt-3 pb-2">
            <Receipt className="w-4 h-4 text-orange-600 shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-black text-[#4E342E] leading-tight">{t("os_no_order_title")}</p>
              <p className="text-[10px] text-stone-500 font-semibold leading-tight">
                {t("os_arrived")} {formatClock(ticket.createdAt)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t("close")}
              className="ml-auto p-1.5 -m-1 text-stone-400 active:text-stone-700"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          </div>
          <OrderStatusBody ticket={ticket} compact />
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-2 rounded-2xl bg-gradient-to-r from-orange-500 to-[#C9A227] text-[#2C1B17] font-black pl-3.5 pr-3 py-2.5 shadow-xl border-2 border-[#C9A227] active:scale-[0.98] transition"
      >
        <span className={`w-2.5 h-2.5 rounded-full ${style.dot} ${live ? "animate-pulse" : ""}`} />
        <span className="text-xs font-black whitespace-nowrap uppercase tracking-wide">
          {t("order_status")} · {units}
        </span>
        <ChevronDown className={`w-4 h-4 transition-transform ${open ? "" : "rotate-180"}`} />
      </button>
    </div>
  );
}
