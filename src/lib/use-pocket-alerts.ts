"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ensurePocketAlerts,
  enablePocketAlerts,
  onPushAlert,
  pocketAlertsStatus,
  pushSupported,
  registerWorker,
  sendTestPush,
  type PocketAlertsStatus,
  type PushAlertMessage,
} from "@/lib/push-client";
import { armAudioOnFirstGesture, playAlarm, unlockAudio } from "@/lib/sound";
import { markPushHandled } from "@/lib/notifications";

/**
 * ONE place that keeps a staff device armed for pocket alerts.
 *
 * Why a hook instead of "call enablePocketAlerts() at login" (the old design):
 *
 *   • Staff almost never log in twice. The app restores the saved session, so
 *     the login branch never ran again and a subscription that died overnight
 *     (expired endpoint, pruned row, regenerated VAPID keys, updated service
 *     worker) was never repaired. The phone looked logged in and rang for
 *     nobody. This hook re-arms on mount, whenever the tab becomes visible,
 *     when the network comes back, and every 5 minutes.
 *
 *   • A background tab gets its SSE stream throttled or frozen by the browser,
 *     so the in-page alarm could not be trusted on a pocketed phone. The
 *     service worker now relays EVERY push to its pages, and `onAlert` below
 *     turns that into the loud in-app alarm plus an immediate data refresh —
 *     a push is never throttled.
 */
export function usePocketAlerts(options: {
  /** Ring + refresh when a push lands while this page is open. */
  onAlert?: (msg: PushAlertMessage) => void;
  /** Set false before login so we do not subscribe without a session. */
  active: boolean;
}) {
  const { onAlert, active } = options;
  const [status, setStatus] = useState<PocketAlertsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * POCKET OFF-DUTY SWITCH: null = no staff session on this device (login
   * screen) or the state could not be read; the chip then hides the switch
   * and only shows the per-device arm/test controls.
   */
  const [notificationsEnabled, setNotificationsEnabledState] = useState<boolean | null>(null);
  const onAlertRef = useRef(onAlert);
  useEffect(() => {
    onAlertRef.current = onAlert;
  }, [onAlert]);

  const refreshServerSwitch = useCallback(async () => {
    try {
      const res = await fetch("/api/staff/notifications", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setNotificationsEnabledState(data.notificationsEnabled !== false);
      } else if (res.status === 401) {
        setNotificationsEnabledState(null);
      }
    } catch {
      /* offline - keep the last known state; the chip still shows the device */
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await pocketAlertsStatus());
    } catch {
      /* ignore */
    }
    void refreshServerSwitch();
  }, [refreshServerSwitch]);

  // Any tap on the page unlocks the audio engine (browsers demand a gesture).
  useEffect(() => {
    armAudioOnFirstGesture();
    // Register the worker even before login so the newest sw.js is installed
    // and pushes are handled from the very first order.
    if (pushSupported()) void registerWorker();
    const t = setTimeout(() => {
      void refreshStatus();
    }, 0);
    return () => clearTimeout(t);
  }, [refreshStatus]);

  // Self-heal: re-arm on mount, on visibility, on reconnect and on a timer.
  useEffect(() => {
    if (!active || !pushSupported()) return;
    let cancelled = false;

    const heal = async () => {
      if (cancelled) return;
      await ensurePocketAlerts();
      if (!cancelled) void refreshStatus();
    };

    void heal();
    const onVisible = () => {
      if (!document.hidden) void heal();
    };
    const timer = setInterval(heal, 5 * 60 * 1000);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", heal);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", heal);
      window.removeEventListener("focus", onVisible);
    };
  }, [active, refreshStatus]);

  // The service worker relays every push to open pages: ring here too.
  useEffect(() => {
    return onPushAlert((msg) => {
      if (msg.type === "fana-push") {
        // The OS just rang for this event: let the page skip its own duplicate
        // notification, but still play the loud in-app alarm.
        // Food-ready is the exception: the waiter's screen speaks
        // "Table X is ready" instead of the generic bell (WaiterApp
        // speakTableReady after the refresh). Playing the bell here would
        // talk over that announcement.
        markPushHandled();
        const tag = typeof msg.tag === "string" ? msg.tag : "";
        const foodReady = tag.startsWith("fana-ready-") || tag.startsWith("fana-outdoor-ready-");
        if (!foodReady) {
          try {
            playAlarm();
          } catch {
            /* ignore */
          }
        }
      }
      onAlertRef.current?.(msg);
    });
  }, []);

  /** Called from a real button tap: may prompt for permission. */
  const arm = useCallback(async () => {
    setBusy(true);
    unlockAudio();
    const result = await enablePocketAlerts();
    await refreshStatus();
    setBusy(false);
    return result;
  }, [refreshStatus]);

  /** Real server round-trip test (optionally delayed so the phone can be locked). */
  const test = useCallback(async (delaySeconds = 0) => {
    setBusy(true);
    unlockAudio();
    await ensurePocketAlerts();
    const res = await sendTestPush(delaySeconds);
    await refreshStatus();
    setBusy(false);
    return res;
  }, [refreshStatus]);

  /**
   * The per-person OFF-DUTY switch: false = this person's phones stay silent
   * (whatever device they tap it on) until they switch back or sign in with
   * their PIN again. Returns false when the server could not be reached.
   */
  const setNotificationsEnabled = useCallback(async (value: boolean) => {
    setBusy(true);
    try {
      const res = await fetch("/api/staff/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationsEnabled: value }),
      });
      if (res.ok) {
        const data = await res.json();
        setNotificationsEnabledState(data.notificationsEnabled !== false);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { status, busy, arm, test, refreshStatus, notificationsEnabled, setNotificationsEnabled };
}
