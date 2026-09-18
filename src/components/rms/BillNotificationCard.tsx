"use client";

import React from "react";
import { X, Receipt } from "lucide-react";

export interface BillNotification {
  id: string;
  ticketId: number;
  tableName: string;
  waiterName: string;
  receiptRequestedAt?: string | null;
  totalAmount?: number;
}

interface BillNotificationCardProps {
  notification: BillNotification;
  onDismiss: (id: string) => void;
}

/**
 * Format table name in authentic cafe style, e.g. "Table 2" -> "የTABLE 2"
 */
export function formatTableBillNotice(tableName: string): string {
  const trimmed = String(tableName || "").trim();
  if (!trimmed) return "የTABLE";
  if (trimmed.startsWith("የ")) return trimmed;
  if (/^\d+$/.test(trimmed)) return `የTABLE ${trimmed}`;
  if (/^table\s*/i.test(trimmed)) {
    const num = trimmed.replace(/^table\s*/i, "").trim().toUpperCase();
    return `የTABLE ${num}`;
  }
  return `የ${trimmed.toUpperCase()}`;
}

export default function BillNotificationCard({
  notification,
  onDismiss,
}: BillNotificationCardProps) {
  const formattedTable = formatTableBillNotice(notification.tableName);
  const waiterName = notification.waiterName || "Waiter";

  return (
    <div
      role="alert"
      className="relative w-72 sm:w-80 aspect-[3/4] bg-[#16100E]/95 backdrop-blur-xl border-2 border-[#C9A227]/60 rounded-3xl p-5 sm:p-6 shadow-2xl shadow-black/90 flex flex-col justify-between text-white overflow-hidden animate-in fade-in slide-in-from-top-4 duration-300"
    >
      {/* Background ambient lighting */}
      <div className="absolute -top-12 -right-12 w-32 h-32 bg-[#C9A227]/15 rounded-full blur-2xl pointer-events-none" />
      <div className="absolute -bottom-12 -left-12 w-32 h-32 bg-amber-600/15 rounded-full blur-2xl pointer-events-none" />

      {/* Top Header: Badge & Close X */}
      <div className="flex items-center justify-between w-full relative z-10">
        <span className="text-[10px] font-black tracking-widest uppercase px-2.5 py-1 rounded-full bg-[#C9A227]/20 text-[#D8B93E] border border-[#C9A227]/40 flex items-center gap-1.5">
          <Receipt className="w-3.5 h-3.5 text-[#C9A227]" />
          <span>BILL REQUEST</span>
        </span>
        <button
          type="button"
          onClick={() => onDismiss(notification.id)}
          className="p-1.5 text-stone-400 hover:text-white hover:bg-white/10 rounded-full transition active:scale-95"
          aria-label="Close notification"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Main Content: Central, Vertical, Modern */}
      <div className="flex flex-col items-center justify-center text-center my-auto py-2 relative z-10 space-y-3">
        {/* Name of the waiter at the top (bold and central top) */}
        <div className="w-full">
          <p className="text-[10px] font-extrabold uppercase tracking-widest text-stone-400 mb-0.5">
            Waiter
          </p>
          <p className="text-xl sm:text-2xl font-black text-amber-300 tracking-wide uppercase drop-shadow">
            {waiterName}
          </p>
        </div>

        {/* Table number bigger and bold size (central and 2nd line) */}
        <div className="w-full py-1">
          <h3 className="font-serif font-black text-4xl sm:text-5xl text-amber-200 tracking-wider text-center drop-shadow-xl">
            {formattedTable}
          </h3>
          {notification.totalAmount ? (
            <p className="text-xs font-bold text-[#C9A227] mt-1.5">
              {notification.totalAmount} ETB
            </p>
          ) : null}
        </div>

        {/* Common Amharic instruction (central) */}
        <div className="w-full bg-[#2C1B17]/90 border border-[#C9A227]/30 rounded-2xl py-3 px-3 shadow-inner">
          <p className="text-sm sm:text-base font-black text-amber-100 leading-snug">
            ደረሰኝ አሁኑኑ ይፈልጋሉ ስሪላቸው!!!
          </p>
        </div>
      </div>

      {/* Bottom Action: Okay button */}
      <div className="w-full relative z-10 pt-2">
        <button
          type="button"
          onClick={() => onDismiss(notification.id)}
          className="w-full py-3.5 px-4 bg-gradient-to-r from-[#C9A227] to-amber-500 hover:from-amber-400 hover:to-amber-300 text-[#1E110D] font-black text-sm uppercase tracking-wider rounded-2xl shadow-lg shadow-amber-950/60 transition active:scale-95 flex items-center justify-center gap-2"
        >
          Okay
        </button>
      </div>
    </div>
  );
}
