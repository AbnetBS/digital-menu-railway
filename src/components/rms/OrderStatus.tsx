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
import { CheckCircle2, Loader2, Receipt } from "lucide-react";
import { useT } from "@/lib/i18n";
import { formatClock, type CustomerOrderPhase } from "@/lib/order-lines";

/**
 * THE GUEST'S RECEIPT BUTTON.
 *
 * The live order-status feature (the pill, the panel with the dish list, the
 * kitchen progress bar and the phase timeline) is gone for now. The one thing
 * a guest needs after ordering is to call for the bill, so this module keeps
 * only two halves:
 *
 *   • <OrderStatusProvider/>   — keeps polling the public, table-scoped
 *                                `/api/table-status` endpoint so the page
 *                                knows whether THIS table has a live order
 *                                and whether the receipt was already asked
 *                                for (plus the `requestBill` call).
 *   • <RequestReceiptButton/>  — one big button with a receipt icon. One tap
 *                                and the waiter's phone rings for ~3 seconds
 *                                and shows WHICH table. After the request it
 *                                is replaced by a confirmation line with the
 *                                time. No status words, no progress bar.
 *
 * The provider must keep polling even though nothing else is displayed: the
 * button has to appear the moment an order exists (whoever sent it), and it
 * must never come back once the receipt was requested or the bill was
 * settled/cancelled.
 */

/** How often the guest's phone asks for an update while the menu is open. */
const POLL_MS = 12_000;

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
    }),
    [tableId, status, requesting, requestBill]
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
