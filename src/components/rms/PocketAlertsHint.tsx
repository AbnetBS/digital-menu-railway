"use client";

import { useEffect, useState } from "react";
import { X, Smartphone } from "lucide-react";
import { iosPocketHintNeeded } from "@/lib/push-client";

/**
 * GROUP 10 — iPhone "pocket mode" instruction.
 *
 * Android Chrome receives system notifications with the browser closed,
 * automatically. Apple only allows that for apps INSTALLED to the Home Screen
 * (iOS 16.4+). Rather than letting iPhone waiters discover this the hard way —
 * phone in pocket, order missed — we show this one-time banner telling them
 * exactly what to do. Dismissed once, it never comes back.
 */
export default function PocketAlertsHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem("fana_ios_hint_done") === "1") return;
      if (iosPocketHintNeeded()) setShow(true);
    } catch {
      /* private mode etc. */
    }
  }, []);

  if (!show) return null;

  const dismiss = () => {
    try {
      localStorage.setItem("fana_ios_hint_done", "1");
    } catch {
      /* ignore */
    }
    setShow(false);
  };

  return (
    <div className="bg-sky-950/60 border border-sky-700/70 rounded-2xl p-4 flex items-start gap-3">
      <Smartphone className="w-5 h-5 text-sky-300 shrink-0 mt-0.5" />
      <div className="flex-1 space-y-1">
        <p className="text-xs font-bold text-sky-200">📱 Make your iPhone ring in your pocket</p>
        <p className="text-[11px] text-sky-300/80 leading-relaxed">
          Tap <strong>Share</strong> → <strong>Add to Home Screen</strong>, then always open Fana from the home screen
          icon. Apple only allows pocket notifications for installed apps. (Android phones work automatically.)
        </p>
      </div>
      <button onClick={dismiss} className="p-1.5 rounded-lg bg-white/10 text-sky-200 shrink-0" title="Got it">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
