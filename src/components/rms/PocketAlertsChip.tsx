"use client";

import { BellRing, BellOff, Loader2, Volume2, Moon, BellPlus } from "lucide-react";
import { useState } from "react";
import type { PocketAlertsStatus } from "@/lib/push-client";
import { useStaffT, tNow } from "@/lib/staff-i18n";

/**
 * The "will my phone actually ring?" chip.
 *
 * Staff had no way to tell whether pocket alerts were armed, so a device that
 * quietly lost its subscription looked exactly like a device that worked. This
 * chip states it plainly and gives these actions:
 *   • OFF DUTY / BACK ON DUTY: the per-PERSON switch (Sept 2026). Staff phones
 *     kept ringing at home after the shift ended; one tap on "Off duty" now
 *     silences every device subscribed under their name, and signing in with
 *     the PIN next shift switches it back on automatically.
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
  notificationsEnabled,
  onSetNotificationsEnabled,
}: {
  status: PocketAlertsStatus | null;
  busy: boolean;
  onArm: () => Promise<unknown>;
  onTest: (delaySeconds: number) => Promise<{ ok: boolean; sent: number; error?: string }>;
  onToast: (msg: string) => void;
  /** Per-person off-duty switch from the server; null = no staff session here. */
  notificationsEnabled: boolean | null;
  onSetNotificationsEnabled: (value: boolean) => Promise<boolean>;
}) {
  const { t: L } = useStaffT();
  const [open, setOpen] = useState(false);
  const armed = !!status?.armed;
  const offDuty = notificationsEnabled === false;

  const handleArm = async () => {
    const res = await onArm();
    if (res === "subscribed" || res === "granted") onToast(tNow("🔔 Pocket alerts armed on this device"));
    else if (res === "denied") onToast(tNow("Notifications are blocked. Allow them in your browser settings."));
    else if (res === "unsupported") onToast(tNow("This browser cannot do pocket alerts. Use Chrome on Android."));
    else onToast(tNow("Could not arm pocket alerts. Check your connection and try again."));
  };

  const handleDuty = async () => {
    if (notificationsEnabled == null) return;
    const target = !notificationsEnabled;
    const ok = await onSetNotificationsEnabled(target);
    if (!ok) {
      onToast(tNow("Could not switch alerts. Check your connection and try again."));
      return;
    }
    onToast(
      target
        ? tNow("🔔 On duty: your phone rings again.")
        : tNow("🔕 Off duty: your phone will stay silent. Rest well!")
    );
  };

  const handleTest = async (delay: number) => {
    const res = await onTest(delay);
    if (res.ok) {
      onToast(
        delay > 0
          ? tNow("Test alert sent to {sent} device(s). Lock your phone now, it rings in {delay}s.", { sent: res.sent, delay })
          : tNow("Test alert sent to {sent} device(s).", { sent: res.sent })
      );
    } else {
      onToast(res.error || tNow("Test alert failed."));
    }
  };

  // The chip must tell the truth about TONIGHT: an off-duty person is silent
  // on purpose (calm amber, no alarm), a broken device is an emergency (red).
  const state = offDuty
    ? "offduty"
    : armed
      ? "on"
      : "off";

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-[11px] font-bold border transition ${
          state === "on"
            ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
            : state === "offduty"
              ? "bg-amber-500/15 border-amber-500/50 text-amber-300"
              : "bg-red-500/15 border-red-500/50 text-red-300 animate-pulse"
        }`}
        title={
          offDuty
            ? L("Off duty: your alerts stay silent until you switch them back on")
            : status?.reason || L("Pocket alerts")
        }
      >
        {busy ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : state === "offduty" ? (
          <Moon className="w-3.5 h-3.5" />
        ) : state === "on" ? (
          <BellRing className="w-3.5 h-3.5" />
        ) : (
          <BellOff className="w-3.5 h-3.5" />
        )}
        {state === "on" ? L("Pocket ON") : state === "offduty" ? L("Off duty") : L("Pocket OFF")}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-72 z-50 bg-[#2C1B17] border border-[#C9A227]/40 rounded-2xl p-3 space-y-2 shadow-2xl">
          {/* The per-person OFF-DUTY switch (silences every device of this staff member). */}
          {notificationsEnabled !== null && (
            <div
              className={`rounded-xl border p-2.5 space-y-2 ${
                offDuty ? "bg-amber-500/10 border-amber-500/40" : "bg-emerald-500/10 border-emerald-500/40"
              }`}
            >
              <p className={`text-[11px] font-bold leading-relaxed ${offDuty ? "text-amber-200" : "text-emerald-200"}`}>
                {offDuty
                  ? L("Off duty: your phone stays silent. No order alarms at home.")
                  : L("On duty: your phone rings for new orders, even at home.")}
              </p>
              <button
                onClick={handleDuty}
                disabled={busy}
                className={`w-full py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-50 ${
                  offDuty ? "bg-emerald-600 text-white" : "bg-[#C9A227] text-[#2C1B17]"
                }`}
              >
                {offDuty ? <BellPlus className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
                {offDuty ? L("Back on duty: ring my phone") : L("Off duty: silence my phone")}
              </button>
              <p className="text-[10px] text-stone-400 leading-relaxed">
                {offDuty
                  ? L("Tap this when your shift starts. Signing in with your PIN also turns alerts back on.")
                  : L("Tap this when your shift ends. This phone stays silent until you are back on duty.")}
              </p>
            </div>
          )}
          <p className={`text-[11px] leading-relaxed ${armed ? "text-emerald-200" : "text-amber-200"}`}>
            {status?.reason || L("Checking this device...")}
          </p>
          {!armed && (
            <button
              onClick={handleArm}
              disabled={busy}
              className="w-full py-2 rounded-xl bg-[#C9A227] text-[#2C1B17] text-xs font-bold disabled:opacity-50"
            >
              {L("Arm pocket alerts")}
            </button>
          )}
          <button
            onClick={() => handleTest(10)}
            disabled={busy}
            className="w-full py-2 rounded-xl bg-white/10 text-amber-100 text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            <Volume2 className="w-3.5 h-3.5" />
            {L("Test ring in 10s (lock your phone)")}
          </button>
          <button
            onClick={() => handleTest(0)}
            disabled={busy}
            className="w-full py-2 rounded-xl bg-white/10 text-amber-100 text-xs font-bold disabled:opacity-50"
          >
            {L("Test ring now")}
          </button>
          <p className="text-[10px] text-stone-400 leading-relaxed">
            {L("Keep the phone off silent mode. Notification sound uses the ringer volume, the in-app bell uses the media volume.")}
          </p>
          <p className="text-[10px] text-emerald-300/90 leading-relaxed">
            {L("Pressing the power button to switch the SCREEN off is fine, and it saves battery: the phone still rings, vibrates and shows the alert on the lock screen. Only a phone that is fully powered OFF (held the button and chose Power off) receives nothing until it is switched on again.")}
          </p>
        </div>
      )}
    </div>
  );
}
