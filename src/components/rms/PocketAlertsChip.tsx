"use client";

import { BellRing, BellOff, Loader2, Volume2 } from "lucide-react";
import { useState } from "react";
import type { PocketAlertsStatus } from "@/lib/push-client";

/**
 * The "will my phone actually ring?" chip.
 *
 * Staff had no way to tell whether pocket alerts were armed, so a device that
 * quietly lost its subscription looked exactly like a device that worked. This
 * chip states it plainly and gives two actions:
 *   • ARM: asks for notification permission and subscribes this device.
 *   • TEST: asks the SERVER to push this phone in 10 seconds, so the waiter can
 *     lock the screen, pocket the phone, and hear the real thing.
 */
export default function PocketAlertsChip({
  status,
  busy,
  onArm,
  onTest,
  onToast,
}: {
  status: PocketAlertsStatus | null;
  busy: boolean;
  onArm: () => Promise<unknown>;
  onTest: (delaySeconds: number) => Promise<{ ok: boolean; sent: number; error?: string }>;
  onToast: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const armed = !!status?.armed;

  const handleArm = async () => {
    const res = await onArm();
    if (res === "subscribed" || res === "granted") onToast("🔔 Pocket alerts armed on this device");
    else if (res === "denied") onToast("Notifications are blocked. Allow them in your browser settings.");
    else if (res === "unsupported") onToast("This browser cannot do pocket alerts. Use Chrome on Android.");
    else onToast("Could not arm pocket alerts. Check your connection and try again.");
  };

  const handleTest = async (delay: number) => {
    const res = await onTest(delay);
    if (res.ok) {
      onToast(
        delay > 0
          ? `Test alert sent to ${res.sent} device(s). Lock your phone now, it rings in ${delay}s.`
          : `Test alert sent to ${res.sent} device(s).`
      );
    } else {
      onToast(res.error || "Test alert failed.");
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-[11px] font-bold border transition ${
          armed
            ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
            : "bg-red-500/15 border-red-500/50 text-red-300 animate-pulse"
        }`}
        title={status?.reason || "Pocket alerts"}
      >
        {busy ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : armed ? (
          <BellRing className="w-3.5 h-3.5" />
        ) : (
          <BellOff className="w-3.5 h-3.5" />
        )}
        {armed ? "Pocket ON" : "Pocket OFF"}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-72 z-50 bg-[#2C1B17] border border-[#C9A227]/40 rounded-2xl p-3 space-y-2 shadow-2xl">
          <p className={`text-[11px] leading-relaxed ${armed ? "text-emerald-200" : "text-amber-200"}`}>
            {status?.reason || "Checking this device..."}
          </p>
          {!armed && (
            <button
              onClick={handleArm}
              disabled={busy}
              className="w-full py-2 rounded-xl bg-[#C9A227] text-[#2C1B17] text-xs font-bold disabled:opacity-50"
            >
              Arm pocket alerts
            </button>
          )}
          <button
            onClick={() => handleTest(10)}
            disabled={busy}
            className="w-full py-2 rounded-xl bg-white/10 text-amber-100 text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            <Volume2 className="w-3.5 h-3.5" />
            Test ring in 10s (lock your phone)
          </button>
          <button
            onClick={() => handleTest(0)}
            disabled={busy}
            className="w-full py-2 rounded-xl bg-white/10 text-amber-100 text-xs font-bold disabled:opacity-50"
          >
            Test ring now
          </button>
          <p className="text-[10px] text-stone-400 leading-relaxed">
            Keep the phone off silent mode. Notification sound uses the ringer volume, the in-app bell uses the media
            volume.
          </p>
        </div>
      )}
    </div>
  );
}
