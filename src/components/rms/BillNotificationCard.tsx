"use client";

import React from "react";
import { X } from "lucide-react";
import { useStaffT } from "@/lib/staff-i18n";

export interface BillNotification {
  id: string;
  ticketId: number;
  tableName: string;
  waiterName: string;
  receiptRequestedAt?: string | null;
}

interface BillNotificationCardProps {
  notification: BillNotification;
  onDismiss: (id: string) => void;
}

/**
 * Format table name in cafe style, e.g. "Table 2" -> "የTABLE 2"
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
  if (/^group\s*/i.test(trimmed)) {
    const num = trimmed.replace(/^group\s*/i, "").trim().toUpperCase();
    return `የGROUP ${num}`;
  }
  return `የ${trimmed.toUpperCase()}`;
}

/**
 * Waiter "need the bill" slip — a vertical 3:4 note, NOT the guest
 * full-screen "BILL REQUESTED" overlay.
 */
export default function BillNotificationCard({
  notification,
  onDismiss,
}: BillNotificationCardProps) {
  const { t: L } = useStaffT();
  const formattedTable = formatTableBillNotice(notification.tableName);
  const waiterName = (notification.waiterName || L("Waiter")).trim();

  return (
    <div
      role="alert"
      className="relative w-[13.5rem] sm:w-60 aspect-[3/4] rounded-[1.25rem] overflow-hidden flex flex-col text-[#1A120E] shadow-[0_18px_40px_rgba(0,0,0,0.55)] animate-in fade-in zoom-in-95 duration-300"
      style={{
        background:
          "linear-gradient(165deg, #F3E6C8 0%, #E8D4A4 42%, #DCC48A 100%)",
        boxShadow:
          "0 18px 40px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.45)",
      }}
    >
      {/* torn-note edge */}
      <div
        className="absolute inset-y-0 left-0 w-3 opacity-40"
        style={{
          backgroundImage:
            "repeating-linear-gradient(180deg, transparent, transparent 10px, #8B5A2B 10px, #8B5A2B 11px)",
        }}
      />
      <div className="absolute top-0 left-0 right-0 h-1.5 bg-[#8B4513]/30" />

      <button
        type="button"
        onClick={() => onDismiss(notification.id)}
        className="absolute top-2 right-2 z-10 w-8 h-8 rounded-full bg-[#2C1B17]/85 text-[#F3E6C8] flex items-center justify-center active:scale-95"
        aria-label={L("Close")}
      >
        <X className="w-4 h-4" />
      </button>

      <div className="flex-1 flex flex-col items-center justify-center text-center px-5 pt-8 pb-3">
        <p className="w-full font-black text-lg sm:text-xl uppercase tracking-wide text-[#2C1B17] leading-tight">
          {waiterName}
        </p>

        <p className="mt-3 w-full font-black text-3xl sm:text-[2.1rem] leading-none tracking-wide text-[#1A120E]">
          {formattedTable}
        </p>

        <p className="mt-5 w-full font-extrabold text-[15px] sm:text-base leading-snug text-[#3D1F14]">
          ደረሰኝ አሁኑኑ ይፈልጋሉ ስሪላቸው!!!
        </p>
      </div>

      <div className="px-4 pb-4">
        <button
          type="button"
          onClick={() => onDismiss(notification.id)}
          className="w-full py-3 rounded-xl bg-[#2C1B17] text-[#F3E6C8] font-black text-sm tracking-widest uppercase active:scale-[0.98]"
        >
          {L("Okay")}
        </button>
      </div>
    </div>
  );
}
