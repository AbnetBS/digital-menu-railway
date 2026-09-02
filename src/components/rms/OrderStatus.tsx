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
import {
  CheckCircle2, ChefHat, Clock, Coffee, Loader2, Receipt, Star, UtensilsCrossed, X,
} from "lucide-react";
import { useT, useMenuText, type StringKey } from "@/lib/i18n";
import {
  formatClock,
  formatDateTime,
  minutesSince,
  type CustomerOrderPhase,
  type StationProgress,
} from "@/lib/order-lines";

/**
 * LIVE ORDER STATUS ON THE GUEST'S OWN PHONE (Group 8).
 *
 * The kitchen and barista already move every item through pending → accepted →
 * done, but until now the guest could not see any of it — they had to wave at a
 * waiter and ask. This reads the same data through the public, table-scoped
 * `/api/table-status` endpoint and shows it as one line a guest understands:
 * "your food is being prepared" → "your food is ready".
 *
 * Three pieces, all rendered by the customer menu page:
 *   • <OrderStatusFab/>    — the pill above the አማርኛ toggle. It only appears once
 *                            THIS TABLE has an order, and it is the same order
 *                            whether the guest sent it or the waiter did.
 *   • <OrderStatusBanner/> — the slim always-visible status bar under the search.
 *   • <OrderStatusSheet/>  — the full panel: timeline, every dish, the bill
 *                            request button and the review shortcut.
 *
 * Barista items (coffee, juice, cake) are listed but deliberately get NO progress
 * bar — they are handed over in seconds, so a "preparing…" state would be noise.
 */

/** How often the guest's phone asks for an update while the menu is open. */
const POLL_MS = 12_000;

interface PublicLine {
  name: string;
  quantity: number;
  notes: string;
  station: "kitchen" | "barista";
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
  kitchen: StationProgress;
  barista: StationProgress;
  lines: PublicLine[];
}

export interface TableStatus {
  tableId: number;
  ticket: TableTicketStatus | null;
}

interface OrderStatusValue {
  tableId: number;
  status: TableStatus | null;
  ticket: TableTicketStatus | null;
  /** Bill request in flight. */
  requesting: boolean;
  requestBill: () => Promise<void>;
  refresh: () => Promise<void>;
  open: boolean;
  setOpen: (next: boolean) => void;
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
  /** Opens the existing review form at the bottom of the menu. */
  onOpenReview?: () => void;
  children?: ReactNode;
}

export function OrderStatusProvider({
  tableId,
  refreshKey = 0,
  onOpenReview,
  children,
}: OrderStatusProviderProps) {
  const [status, setStatus] = useState<TableStatus | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [open, setOpen] = useState(false);

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
      status,
      ticket: status?.ticket ?? null,
      requesting,
      requestBill,
      refresh,
      open,
      setOpen,
    }),
    [tableId, status, requesting, requestBill, refresh, open]
  );

  return (
    <OrderStatusContext.Provider value={value}>
      {children}
      {/* Rendered once, at the page level, so the panel is never clipped by a
          scrolling or overflow-hidden container. */}
      <OrderStatusSheet onOpenReview={onOpenReview} />
    </OrderStatusContext.Provider>
  );
}

/* ───────────────────── phase presentation ───────────────────── */

interface PhaseStyle {
  labelKey: StringKey;
  icon: typeof Clock;
  chip: string;
  bar: string;
}

const PHASE_STYLE: Record<CustomerOrderPhase, PhaseStyle> = {
  none: { labelKey: "os_phase_none", icon: Clock, chip: "bg-stone-200 text-stone-600", bar: "bg-stone-300" },
  waiting: { labelKey: "os_phase_waiting", icon: Clock, chip: "bg-violet-100 text-violet-800", bar: "bg-violet-500" },
  confirmed: { labelKey: "os_phase_confirmed", icon: ChefHat, chip: "bg-amber-100 text-amber-800", bar: "bg-amber-500" },
  preparing: { labelKey: "os_phase_preparing", icon: ChefHat, chip: "bg-orange-100 text-orange-800", bar: "bg-orange-500" },
  ready: { labelKey: "os_phase_ready", icon: CheckCircle2, chip: "bg-emerald-100 text-emerald-800", bar: "bg-emerald-500" },
  drinks_only: { labelKey: "os_phase_drinks", icon: Coffee, chip: "bg-sky-100 text-sky-800", bar: "bg-sky-500" },
  bill: { labelKey: "os_phase_bill", icon: Receipt, chip: "bg-purple-100 text-purple-800", bar: "bg-purple-500" },
  paid: { labelKey: "os_phase_paid", icon: CheckCircle2, chip: "bg-emerald-100 text-emerald-800", bar: "bg-emerald-600" },
  cancelled: { labelKey: "os_phase_cancelled", icon: X, chip: "bg-rose-100 text-rose-800", bar: "bg-rose-500" },
};

/** 0-100 progress of the food (drinks excluded on purpose). */
function kitchenPercent(kitchen: StationProgress): number {
  if (kitchen.units === 0) return 0;
  // "accepted" counts as half done: the crew has started but not finished.
  return Math.round(((kitchen.done + kitchen.accepted * 0.5) / kitchen.units) * 100);
}

/* ───────────────────── the pill above the language toggle ───────────────────── */

/**
 * Floating "Order status" pill, stacked directly ABOVE the አማርኛ/English toggle
 * (which sits at bottom-5 right-5). It appears only once this table has an order
 * — the same order whether the guest or the waiter sent it.
 */
export function OrderStatusFab() {
  const { ticket, setOpen } = useOrderStatus();
  const t = useT();
  if (!ticket) return null;

  const style = PHASE_STYLE[ticket.phase] ?? PHASE_STYLE.none;
  const Icon = style.icon;
  const live = ticket.phase === "preparing" || ticket.phase === "waiting" || ticket.phase === "confirmed";

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="fixed bottom-[88px] right-5 z-40 flex items-center gap-2 bg-[#2C1B17] text-white border-2 border-[#C9A227] pl-3 pr-4 py-2.5 rounded-full shadow-2xl hover:scale-105 active:scale-95 transition-transform"
      aria-label={t("order_status")}
      title={t("order_status")}
    >
      <span className="relative flex items-center justify-center">
        <Icon className={`w-4 h-4 text-[#C9A227] ${live ? "animate-pulse" : ""}`} />
      </span>
      <span className="text-xs font-black tracking-wide">{t("order_status")}</span>
      {ticket.receiptRequestedAt ? (
        <span className="w-2 h-2 rounded-full bg-emerald-400" aria-hidden="true" />
      ) : ticket.phase === "ready" ? (
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" aria-hidden="true" />
      ) : null}
    </button>
  );
}

/* ───────────────────── the slim status bar ───────────────────── */

/**
 * One-line status bar shown under the search/category bar while the table has an
 * order. Tapping it opens the full panel. Hidden for drinks-only bills, exactly
 * as requested: a macchiato does not need a progress bar.
 */
export function OrderStatusBanner() {
  const { ticket, setOpen } = useOrderStatus();
  const t = useT();
  if (!ticket) return null;
  if (ticket.phase === "drinks_only" || ticket.phase === "none") return null;

  const style = PHASE_STYLE[ticket.phase] ?? PHASE_STYLE.none;
  const Icon = style.icon;
  const percent = kitchenPercent(ticket.kitchen);
  const showBar = ticket.kitchen.units > 0 && percent > 0 && percent < 100;

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className={`w-full text-left rounded-2xl border px-3.5 py-2.5 shadow-sm transition active:scale-[0.99] ${
        ticket.phase === "ready"
          ? "bg-emerald-50 border-emerald-300"
          : ticket.receiptRequestedAt
          ? "bg-purple-50 border-purple-300"
          : "bg-white border-[#C9A227]/40"
      }`}
    >
      <span className="flex items-center gap-2">
        <Icon
          className={`w-4 h-4 shrink-0 ${
            ticket.phase === "preparing" ? "text-orange-600 animate-pulse" : "text-[#C9A227]"
          }`}
        />
        <span className="flex-1 min-w-0">
          <span className="block text-xs font-extrabold text-[#2C1B17] truncate">
            {t(style.labelKey)}
          </span>
          <span className="block text-[10px] text-stone-500 font-semibold truncate">
            {ticket.orderNumber ? `#${ticket.orderNumber} • ` : ""}
            {t("os_arrived")} {formatClock(ticket.createdAt)}
            {ticket.receiptRequestedAt ? ` • ${t("os_bill_requested_short")}` : ""}
          </span>
        </span>
        <span className="text-[10px] font-black text-[#C9A227] shrink-0">{t("os_view")}</span>
      </span>
      {showBar && (
        <span className="mt-2 block h-1.5 w-full rounded-full bg-stone-200 overflow-hidden">
          <span
            className={`block h-full rounded-full transition-all duration-700 ${style.bar}`}
            style={{ width: `${percent}%` }}
          />
        </span>
      )}
    </button>
  );
}

/* ───────────────────── the full panel ───────────────────── */

function SheetRow({ line }: { line: PublicLine }) {
  const t = useT();
  const menuText = useMenuText();
  const done = line.stationStatus === "done";
  const started = line.stationStatus === "accepted";
  return (
    <li className="flex items-center gap-2.5 py-2 border-b border-stone-100 last:border-0">
      <span
        className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
          done ? "bg-emerald-100 text-emerald-700" : started ? "bg-orange-100 text-orange-700" : "bg-stone-100 text-stone-500"
        }`}
      >
        {line.station === "barista" ? <Coffee className="w-3.5 h-3.5" /> : <UtensilsCrossed className="w-3.5 h-3.5" />}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-xs font-bold text-[#2C1B17] truncate">
          {menuText(line.name)} <span className="text-[#C9A227]">×{line.quantity}</span>
        </span>
        {line.notes && <span className="block text-[10px] text-stone-500 truncate">📝 {menuText(line.notes)}</span>}
      </span>
      <span
        className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full shrink-0 ${
          done ? "bg-emerald-100 text-emerald-700" : started ? "bg-orange-100 text-orange-700" : "bg-stone-100 text-stone-500"
        }`}
      >
        {done ? t("os_line_done") : started ? t("os_line_cooking") : t("os_line_queued")}
      </span>
    </li>
  );
}

export function OrderStatusSheet({ onOpenReview }: { onOpenReview?: () => void }) {
  const { ticket, open, setOpen, requestBill, requesting, refresh } = useOrderStatus();
  const t = useT();

  if (!open) return null;
  const style = ticket ? (PHASE_STYLE[ticket.phase] ?? PHASE_STYLE.none) : PHASE_STYLE.none;
  const Icon = style.icon;
  const percent = ticket ? kitchenPercent(ticket.kitchen) : 0;
  const kitchenLines = ticket?.lines.filter((l) => l.station === "kitchen") ?? [];
  const baristaLines = ticket?.lines.filter((l) => l.station === "barista") ?? [];
  const billRequested = Boolean(ticket?.receiptRequestedAt);
  /**
   * "The customer has been served." The bill button is offered only once the
   * KITCHEN has finished every food item (or the bill never contained food —
   * coffee/juice/cake are handed over in seconds). Drinks are deliberately not
   * part of this gate: the crew does not track them item by item, and waiting on
   * a barista "done" tap would leave a guest unable to pay.
   */
  const served = Boolean(ticket) && (ticket!.kitchen.units === 0 || ticket!.kitchen.state === "ready");
  const canRequestBill =
    served && !billRequested && ticket!.phase !== "paid" && ticket!.phase !== "cancelled";
  // The review shortcut is the last thing a guest sees: after the bill request,
  // or once the bill is settled.
  const showReview = billRequested || ticket?.phase === "paid" || ticket?.phase === "bill";
  // "How long has the kitchen had my order?" — in the guest's own language.
  const arrivedMins = ticket ? minutesSince(ticket.createdAt) : 0;
  const arrivedAgo = arrivedMins < 1 ? t("os_just_now") : t("os_minutes_short", { n: String(arrivedMins) });

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label={t("order_status")}
    >
      <div
        className="bg-[#FAF6F0] rounded-t-3xl sm:rounded-3xl max-w-lg w-full max-h-[88vh] overflow-y-auto shadow-2xl animate-scaleUp"
        onClick={(event) => event.stopPropagation()}
      >
        {/* header */}
        <div className="sticky top-0 z-10 bg-[#2C1B17] text-white px-5 py-4 flex items-start justify-between gap-3 rounded-t-3xl">
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-widest text-[#C9A227]">{t("order_status")}</p>
            <p className="font-serif font-bold text-lg text-amber-100 leading-tight truncate">
              {ticket?.orderNumber ? `#${ticket.orderNumber}` : t("os_no_order_title")}
            </p>
            {ticket && (
              <p className="text-[10px] text-stone-400 font-semibold">
                {t("os_arrived")} {formatDateTime(ticket.createdAt)} • {arrivedAgo}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="w-9 h-9 shrink-0 rounded-full bg-white/10 flex items-center justify-center hover:bg-white/20"
            aria-label={t("close")}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {!ticket ? (
            <p className="text-sm text-stone-600 text-center py-6">{t("os_no_order")}</p>
          ) : (
            <>
              {/* phase + food progress */}
              <div className="bg-white rounded-2xl border border-[#C9A227]/25 p-4 space-y-3 shadow-sm">
                <div className="flex items-center gap-2.5">
                  <span className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${style.chip}`}>
                    <Icon className={`w-5 h-5 ${ticket.phase === "preparing" ? "animate-pulse" : ""}`} />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-black text-[#2C1B17] leading-tight">{t(style.labelKey)}</p>
                    <p className="text-[11px] text-stone-500 font-semibold">
                      {t("os_auto_refresh")} • {formatClock(ticket.updatedAt || ticket.createdAt)}
                    </p>
                  </div>
                </div>

                {ticket.kitchen.units > 0 && (
                  <div>
                    <div className="flex items-center justify-between text-[10px] font-black uppercase text-stone-500 mb-1">
                      <span className="flex items-center gap-1">
                        <ChefHat className="w-3 h-3 text-[#C9A227]" /> {t("os_kitchen")}
                      </span>
                      <span>
                        {ticket.kitchen.done}/{ticket.kitchen.units} {t("os_ready_label")}
                      </span>
                    </div>
                    <div className="h-2.5 w-full rounded-full bg-stone-200 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-700 ${style.bar}`}
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Drinks/cake: listed, but no progress bar — they are made in seconds. */}
                {ticket.barista.units > 0 && (
                  <p className="text-[11px] font-bold text-sky-800 bg-sky-50 border border-sky-200 rounded-xl px-3 py-2 flex items-center gap-1.5">
                    <Coffee className="w-3.5 h-3.5" />
                    {t("os_barista_note", { count: String(ticket.barista.units) })}
                  </p>
                )}
              </div>

              {/* items */}
              <div className="bg-white rounded-2xl border border-stone-200 p-4 shadow-sm">
                <p className="text-[10px] font-black uppercase tracking-widest text-stone-500 mb-1">
                  {t("os_your_items")} • {ticket.lines.reduce((sum, l) => sum + l.quantity, 0)}
                </p>
                {kitchenLines.length > 0 && (
                  <ul className="mb-2">
                    {kitchenLines.map((line, index) => (
                      <SheetRow key={`k-${index}`} line={line} />
                    ))}
                  </ul>
                )}
                {baristaLines.length > 0 && (
                  <ul>
                    {baristaLines.map((line, index) => (
                      <SheetRow key={`b-${index}`} line={line} />
                    ))}
                  </ul>
                )}
                <div className="flex items-center justify-between pt-3 mt-1 border-t border-stone-200">
                  <span className="text-xs font-bold text-stone-500">{t("os_total")}</span>
                  <span className="font-serif font-black text-lg text-[#4E342E]">{ticket.totalAmount} ETB</span>
                </div>
              </div>

              {/* ask for the bill once the food has arrived */}
              {canRequestBill && (
                <button
                  type="button"
                  onClick={requestBill}
                  disabled={requesting}
                  className="w-full bg-[#4E342E] text-amber-200 font-black text-sm uppercase py-3.5 rounded-xl flex items-center justify-center gap-2 disabled:opacity-60"
                >
                  {requesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Receipt className="w-4 h-4" />}
                  {requesting ? t("os_sending") : t("os_request_bill")}
                </button>
              )}
              {/* Still cooking: say WHEN the button will appear instead of
                  showing a dead control. */}
              {!served && !billRequested && ticket.phase !== "paid" && ticket.phase !== "cancelled" && (
                <p className="text-[11px] font-bold text-stone-500 bg-stone-100 border border-stone-200 rounded-xl px-3.5 py-2.5 flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5 shrink-0" /> {t("os_bill_after_food")}
                </p>
              )}
              {billRequested && (
                <div className="bg-emerald-50 border border-emerald-300 rounded-xl px-4 py-3 space-y-2">
                  <p className="text-xs font-black text-emerald-800 flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4" /> {t("os_bill_requested")}
                  </p>
                  <p className="text-[11px] text-emerald-700 font-semibold">
                    {t("os_bill_requested_at")} {formatClock(ticket.receiptRequestedAt)}
                  </p>
                </div>
              )}

              {/* review shortcut — the last step of the visit */}
              {showReview && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onOpenReview?.();
                  }}
                  className="w-full bg-[#C9A227] text-[#2C1B17] font-black text-sm uppercase py-3.5 rounded-xl flex items-center justify-center gap-2"
                >
                  <Star className="w-4 h-4" /> {t("os_rate_visit")}
                </button>
              )}

              <button
                type="button"
                onClick={refresh}
                className="w-full text-[11px] font-bold text-stone-500 py-2 flex items-center justify-center gap-1.5"
              >
                <Clock className="w-3.5 h-3.5" /> {t("os_refresh_now")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
