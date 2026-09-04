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
  const onAlertRef = useRef(onAlert);
  useEffect(() => {
    onAlertRef.current = onAlert;
  }, [onAlert]);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await pocketAlertsStatus());
    } catch {
      /* ignore */
    }
  }, []);

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
        markPushHandled();
        try {
          playAlarm();
        } catch {
          /* ignore */
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

  return { status, busy, arm, test, refreshStatus };
}
