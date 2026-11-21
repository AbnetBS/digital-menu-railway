"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { useStaffT } from "@/lib/staff-i18n";
import { enablePocketAlerts, pushSupported } from "@/lib/push-client";

/** This phone's push endpoint, once its alerts are on. Empty when not armed. */
async function currentEndpoint(): Promise<string> {
  if (!pushSupported()) return "";
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub?.endpoint || "";
  } catch {
    return "";
  }
}

/**
 * The bell beside "Decide deductions". Tap it, choose the time, then Turn on:
 * the phone is allowed to show notifications, and at that time each day it
 * shows how many yesterday items still need a decision. Tapping that
 * notification opens this screen.
 */
export default function DecideNotificationSetting() {
  const { t: Lraw } = useStaffT();
  const L = (s: string) => {
    try {
      return (Lraw as any)(s) || s;
    } catch {
      return s;
    }
  };
  const [open, setOpen] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [time, setTime] = useState("09:00");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [bad, setBad] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const ep = await currentEndpoint();
      if (cancelled) return;
      setEndpoint(ep);
      if (!ep) return;
      const res = await fetch(`/api/attendance/decision-reminder?endpoint=${encodeURIComponent(ep)}`, { cache: "no-store" });
      if (!res.ok || cancelled) return;
      const body = await res.json();
      setEnabled(!!body.enabled);
      setTime(String(body.time || "09:00"));
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const turnOn = async () => {
    setBusy(true);
    setMsg("");
    setBad(false);
    try {
      // 1. Allow notifications on this phone (asks the browser, subscribes).
      const armed = await enablePocketAlerts();
      if (armed === "denied") throw new Error(L("Notifications are blocked. Allow them in your browser settings."));
      if (armed === "unsupported") throw new Error(L("This browser cannot show phone alerts. Use Chrome on Android."));
      if (armed === "error") throw new Error(L("Could not turn on notifications. Check the internet connection and try again."));
      const ep = await currentEndpoint();
      if (!ep) throw new Error(L("Turn on phone notifications first, then set the time."));
      // 2. Save the time for this phone.
      const res = await fetch("/api/attendance/decision-reminder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: ep, time }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || L("Could not save"));
      setEndpoint(ep);
      setEnabled(true);
      setMsg(`${L("Notification on at")} ${time}`);
    } catch (e) {
      setBad(true);
      setMsg(e instanceof Error ? e.message : L("Could not save"));
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setMsg("");
    try {
      await fetch(`/api/attendance/decision-reminder?endpoint=${encodeURIComponent(endpoint)}`, { method: "DELETE" });
      setEnabled(false);
      setMsg(L("Notification off"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        title={L("Notify me when yesterday's items need a decision")}
        className={`flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs font-bold whitespace-nowrap transition ${
          open ? "bg-amber-700 text-white" : "bg-rose-900/60 hover:bg-rose-800 text-rose-100"
        }`}
      >
        {enabled ? <Bell className="w-4 h-4 text-amber-300" /> : <BellOff className="w-4 h-4" />}
        {L("Notification")}
      </button>
      {open && (
        <div className="basis-full bg-[#1C120F] border border-stone-700 rounded-xl p-3 flex flex-wrap items-center gap-2 text-[12px] text-stone-200">
          <span className="font-bold">{L("Remind me at")}</span>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="bg-[#2C1B17] border border-stone-600 rounded-lg px-2 py-1 text-white"
            aria-label={L("Remind me at")}
          />
          <button
            onClick={() => void turnOn()}
            disabled={busy}
            className="flex items-center gap-1 bg-amber-700 hover:bg-amber-600 text-white font-black px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Bell className="w-3 h-3" />}
            {enabled ? L("Save time") : L("Turn on notification")}
          </button>
          {enabled && (
            <button
              onClick={() => void turnOff()}
              disabled={busy}
              className="flex items-center gap-1 bg-stone-700 hover:bg-stone-600 text-white font-black px-3 py-1.5 rounded-lg disabled:opacity-50"
            >
              <BellOff className="w-3 h-3" /> {L("Turn off notification")}
            </button>
          )}
          {msg && <span className={bad ? "text-rose-300" : "text-amber-200"}>{msg}</span>}
        </div>
      )}
    </>
  );
}
