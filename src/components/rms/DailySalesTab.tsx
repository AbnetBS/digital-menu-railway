"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Printer, RefreshCw, BellRing, BellOff, CheckCircle2, Clock, Save } from "lucide-react";
import PrintLetterhead from "@/components/rms/PrintLetterhead";
import { useStaffT, tNow, staffEtb } from "@/lib/staff-i18n";
import {
  dayKeyLabel,
  formatEtb,
  localLabelForHour,
  localLabelForTime,
  parseClockTime,
  NOTIFY_HOUR_CHOICES,
  type DayCloseRecord,
} from "@/lib/daily-sales";
import {
  enablePocketAlerts,
  pocketAlertsStatus,
  pushSupported,
  sendTestPush,
  type PocketAlertsStatus,
} from "@/lib/push-client";

/**
 * DAILY SALES — the owner's page (owner's decisions, 29 Sept 2026).
 *
 * WHAT HE ASKED FOR:
 *   • "whenever the owner opens that page it shows him the total price that got
 *     printed up to that time" — the figure is LIVE (recomputed on every read,
 *     never cached) and this tab refreshes itself every minute while he looks;
 *   • "for now only todays and yesterday total sale because before that it isnt
 *     full report but starting from tomorrow it started listed" — the list
 *     shows TODAY and YESTERDAY, plus every day closed since this feature
 *     started, so the daily history grows one day at a time;
 *   • "in that tab add choose time to notify button ... as default I choose 3
 *     lt but he can choose it there" — the notify-hour chooser sits on this
 *     page (21:00 / 22:00 / 23:00 EAT), and the cashier's button appears one
 *     hour before it;
 *   • the cashier's tap (or the system's automatic send) puts a NORMAL
 *     notification on his phone; tapping it lands him right here.
 *
 * This page also holds the ONLY phone-alert switch left in the cafe: every
 * staff notification was removed, so arming this device is how he hears the
 * daily total.
 */

interface DailySalesDay {
  dayKey: string;
  total: number;
  bills: number;
  closed: DayCloseRecord | null;
}

interface DailySalesData {
  serverTime: string;
  notifyHour: number;
  /** The minute of the owner's own choosing ("any time like 3:03"). */
  notifyMinute: number;
  /** "21:03" — the exact moment his phone rings. */
  notifyAt: string;
  cutoffHour: number;
  cutoffMinute: number;
  /** "20:03" — the exact moment the cashier's button opens. */
  cutoffAt: string;
  currentHour: number;
  currentMinute: number;
  canClose: boolean;
  dueNow: boolean;
  todayKey: string;
  today: { total: number; bills: number; closed: DayCloseRecord | null };
  days: DailySalesDay[];
}

export default function DailySalesTab() {
  const { t: L, td: Ld } = useStaffT();
  const [data, setData] = useState<DailySalesData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState("");
  const [pushStatus, setPushStatus] = useState<PocketAlertsStatus | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [savingHour, setSavingHour] = useState(false);
  const loadRef = useRef<() => void>(() => {});

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 4000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/reports/daily-sales", { cache: "no-store" });
      if (r.status === 401) {
        setError(tNow("Your admin session ended. Reload the page and log in again to see fresh figures."));
        return;
      }
      if (!r.ok) throw new Error(String(r.status));
      setData((await r.json()) as DailySalesData);
      setError("");
    } catch {
      setError(tNow("Could not load the daily sales. Tap refresh to try again."));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    // Async loader behind a fetch; the lint rule cannot see through the
    // function boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    // LIVE: the owner watches today's number grow as the cashier prints bills.
    const timer = setInterval(() => void loadRef.current(), 60 * 1000);
    return () => clearInterval(timer);
  }, [load]);

  const refreshPushStatus = useCallback(async () => {
    try {
      setPushStatus(await pocketAlertsStatus());
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void refreshPushStatus(), 0);
    return () => clearTimeout(t);
  }, [refreshPushStatus]);

  /**
   * ARM THIS DEVICE. Only the owner receives notifications now, and this page
   * is where his device registers: permission, subscription and the server row
   * are all taken care of by the shared push client (a staff session is not
   * needed; the admin session is enough).
   */
  const armPhone = async () => {
    if (!pushSupported()) {
      showToast(tNow("This browser cannot show phone alerts. Use Chrome on Android."));
      return;
    }
    setPushBusy(true);
    const res = await enablePocketAlerts();
    await refreshPushStatus();
    setPushBusy(false);
    if (res === "denied") showToast(tNow("Notifications are blocked. Allow them in your browser settings."));
    else if (res === "unsupported") showToast(tNow("This browser cannot show phone alerts. Use Chrome on Android."));
    else if (res === "error") showToast(tNow("Could not arm phone alerts. Check the internet connection and try again."));
    else showToast(tNow("✓ Phone alerts armed on this device"));
  };

  const testPhone = async (delaySeconds: number) => {
    setPushBusy(true);
    const res = await sendTestPush(delaySeconds);
    await refreshPushStatus();
    setPushBusy(false);
    if (!res.ok) showToast(Ld(res.error) || tNow("The test could not be sent."));
    else if (delaySeconds > 0) showToast(tNow("Test sent • lock the phone now, it rings in {seconds} seconds", { seconds: delaySeconds }));
    else showToast(tNow("Test sent • this device should ring now"));
  };

  /**
   * THE OWNER PICKS THE EXACT MINUTE HIS PHONE RINGS (30 Sept 2026).
   *
   * "can you make the time change button on the sales cathagory customizable
   * not only 3 hours 3,4,5 make it look like i can add any time like 3:03 or
   * any other make it changable to any then add save button on the right after
   * i change it" — so the field takes any clock time in the evening, the three
   * old hours are only quick picks that fill the same field, and NOTHING is
   * stored until he presses Save on its right.
   *
   * An empty draft means "unchanged": the input simply shows the saved time, so
   * the field can never fight the minute-by-minute refresh of this page.
   */
  const [draftTime, setDraftTime] = useState("");
  const savedTime = data ? data.notifyAt : "";
  const draftValue = draftTime || savedTime;
  const timeChanged = !!draftTime && draftTime !== savedTime;

  const saveNotifyTime = async () => {
    const picked = parseClockTime(draftValue);
    if (!picked) {
      showToast(tNow("Type a time like 21:03."));
      return;
    }
    setSavingHour(true);
    try {
      const r = await fetch("/api/reports/daily-sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-notify-time", hour: picked.hour, minute: picked.minute }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) showToast(body?.error ? Ld(body.error) : tNow("Could not save the time. Try again."));
      else {
        // Snap back to the server's own value: what he reads is what is stored.
        setDraftTime("");
        showToast(tNow("✓ Your phone will ring at {time}", { time: localLabelForTime(picked.hour, picked.minute) }));
        await load();
      }
    } catch {
      showToast(tNow("Network error. Try again."));
    }
    setSavingHour(false);
  };

  /** A quick pick only FILLS the field — Save on the right is what stores it. */
  const chooseHour = (hour: number) => setDraftTime(`${String(hour).padStart(2, "0")}:00`);

  /** "21:04" — the moment a close record was written (the cafe clock). */
  const clockOf = (iso: string | null | undefined) => {
    const d = new Date(String(iso || ""));
    return Number.isFinite(d.getTime())
      ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
      : "";
  };

  const days = data?.days ?? [];
  const armed = !!pushStatus?.armed;
  const todayRow = data?.today;
  // The two exact moments, to the minute the owner chose ("20:03" / "21:03").
  const cutoff = data?.cutoffAt || `${String(data?.cutoffHour ?? 20).padStart(2, "0")}:00`;
  const notify = data?.notifyAt || `${String(data?.notifyHour ?? 21).padStart(2, "0")}:00`;
  const nowClock = data
    ? `${String(data.currentHour).padStart(2, "0")}:${String(data.currentMinute ?? 0).padStart(2, "0")}`
    : "";

  return (
    <div id="fana-daily-sales" className="space-y-6">
      {/* PRINT STYLES: the owner prints this page on the office computer. The
          dark cafe theme flattens to black-on-white, controls hide. */}
      <style>{`
        .print-only { display: none; }
        @media print {
          @page { margin: 12mm; }
          body { background: #fff !important; }
          #fana-admin { background: #fff !important; padding: 0 !important; }
          .no-print { display: none !important; }
          .print-only { display: block !important; }
          #fana-daily-sales, #fana-daily-sales * {
            background-color: #fff !important;
            background-image: none !important;
            color: #000 !important;
            border-color: #888 !important;
            box-shadow: none !important;
            text-shadow: none !important;
          }
        }
      `}</style>

      {toast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-emerald-600 text-white text-xs font-bold px-4 py-2.5 rounded-full shadow-2xl max-w-[90vw] text-center no-print">
          {toast}
        </div>
      )}

      {error && (
        <div className="bg-rose-900/60 border border-rose-500 text-rose-200 text-xs p-3 rounded-xl font-bold no-print">{error}</div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-serif font-bold text-amber-100">{L("Daily Sales")}</h2>
          <p className="text-xs text-stone-400 max-w-2xl">
            {L("Every bill the cashier printed, day by day. Match these totals with the money in the drawer and the system printer (EFD) receipts.")}
          </p>
        </div>
        <div className="flex items-center gap-2 no-print">
          <button
            onClick={() => window.print()}
            className="bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-black text-xs uppercase px-4 py-2.5 rounded-xl flex items-center gap-2"
            title={L("Print this sales list")}
          >
            <Printer className="w-4 h-4" /> {L("Print")}
          </button>
          <button onClick={() => void load()} className="p-2.5 bg-white/10 hover:bg-white/20 text-amber-200 rounded-xl" title={L("Refresh")}>
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* OFFICIAL LETTERHEAD, print only */}
      <div className="print-only mb-4">
        <PrintLetterhead />
      </div>

      {/* TODAY (LIVE) + THE TWO MOMENTS */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-gradient-to-br from-[#C9A227] to-[#8C6D18] rounded-2xl p-4 text-[#2C1B17] sm:col-span-2">
          <p className="text-[10px] font-extrabold uppercase tracking-wider opacity-80">
            {L("Today • {day}", { day: dayKeyLabel(data?.todayKey || "") })}
          </p>
          <p className="font-serif font-black text-3xl">{todayRow ? formatEtb(todayRow.total) : "…"}</p>
          <p className="text-[11px] font-bold">
            {todayRow ? L("{bills} printed bill(s)", { bills: todayRow.bills }) : ""}
            {todayRow?.closed ? ` • ${L("closed {clock} by {name}", { clock: clockOf(todayRow.closed.at), name: todayRow.closed.by })}` : ""}
          </p>
          <p className="text-[10px] font-bold opacity-80 mt-1">{L("Live • it grows as the cashier prints bills")}</p>
        </div>
        <div className="bg-[#2C1B17] border border-stone-800 rounded-2xl p-4 space-y-1">
          <p className="text-[10px] font-extrabold uppercase tracking-wider text-stone-400">{L("Today's shift end")}</p>
          <p className="text-xs font-bold text-amber-100">
            {data
              ? data.canClose
                ? L("Open • the cashier can close the day now")
                : L("Opens at {time}", { time: cutoff })
              : "…"}
          </p>
          <p className="text-[11px] text-stone-500">
            {L("The cashier taps it to send the total to your phone. The button disappears after midnight, and the next day starts its own evening window.")}
          </p>
          <p className="text-[11px] text-stone-500">
            {L("If she forgets, the system sends it by itself at {time}.", { time: notify })}
          </p>
        </div>
      </div>

      {/* THE OWNER PICKS WHEN HIS PHONE RINGS */}
      <section className="bg-[#2C1B17] border border-[#C9A227]/40 rounded-2xl p-4 space-y-3 no-print">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-[#C9A227]" />
          <div>
            <p className="text-xs font-black uppercase tracking-wider text-amber-200">{L("When should your phone ring?")}</p>
            <p className="text-[11px] text-stone-400">
              {L("Choose ANY time, down to the minute (for example 9:03 PM). The cashier's button appears one hour before it, and if she forgets the system sends the total by itself at exactly this time. Press Save when you are done.")}
            </p>
          </div>
        </div>

        {/* THE TIME FIELD, WITH SAVE ON ITS RIGHT (owner, 30 Sept 2026) */}
        <div className="flex flex-wrap items-center gap-3">
          <label
            className={`flex items-center gap-2 rounded-xl border px-3 py-2 transition ${
              timeChanged ? "border-[#C9A227] bg-[#C9A227]/10" : "border-stone-700 bg-black/30"
            }`}
          >
            <Clock className="w-4 h-4 text-[#C9A227] shrink-0" />
            <input
              type="time"
              value={draftValue}
              min="12:00"
              max="23:59"
              step={60}
              onChange={(e) => setDraftTime(e.target.value)}
              disabled={savingHour}
              aria-label={L("Time your phone rings (cafe time, EAT)")}
              className="bg-transparent text-sm font-black text-amber-100 tabular-nums focus:outline-none disabled:opacity-50"
            />
          </label>
          <span className="text-[11px] text-stone-400 min-w-0">
            {L("Cafe time (EAT)")}
            {draftValue ? ` • ${localLabelForTime(Number(draftValue.slice(0, 2)), Number(draftValue.slice(3, 5)))}` : ""}
          </span>
          <button
            onClick={() => void saveNotifyTime()}
            disabled={savingHour || !timeChanged}
            className="ml-auto shrink-0 bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-black text-xs uppercase px-5 py-3 rounded-xl flex items-center gap-2 disabled:opacity-40 disabled:hover:bg-[#C9A227]"
            title={L("Save the time your phone rings")}
          >
            <Save className="w-4 h-4" />
            {savingHour ? L("Saving...") : L("Save")}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-stone-500">{L("Quick picks:")}</span>
          {NOTIFY_HOUR_CHOICES.map((hour) => {
            const pick = `${String(hour).padStart(2, "0")}:00`;
            const selected = draftValue === pick;
            return (
              <button
                key={hour}
                onClick={() => chooseHour(hour)}
                disabled={savingHour}
                className={`text-[11px] font-black uppercase px-4 py-2.5 rounded-xl transition disabled:opacity-50 ${
                  selected
                    ? "bg-[#C9A227] text-[#2C1B17]"
                    : "bg-white/10 hover:bg-white/20 text-amber-200"
                }`}
                title={L("Send the daily total at {time}", { time: localLabelForHour(hour) })}
              >
                {selected ? "✓ " : ""}
                {localLabelForHour(hour)}
              </button>
            );
          })}
          {data && (
            <span className="text-[11px] text-stone-500">
              {L("Now: {now} • the button opens at {cutoff}", { now: nowClock, cutoff })}
            </span>
          )}
          {timeChanged && (
            <span className="text-[11px] font-black text-amber-300">{L("Not saved yet • press Save")}</span>
          )}
        </div>
      </section>

      {/* THE OWNER'S PHONE — the ONLY notification left in the cafe */}
      <section className="bg-[#2C1B17] border border-[#C9A227]/40 rounded-2xl p-4 space-y-3 no-print">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {armed ? <BellRing className="w-4 h-4 text-emerald-400" /> : <BellOff className="w-4 h-4 text-amber-300" />}
            <div>
              <p className="text-xs font-black uppercase tracking-wider text-amber-200">{L("My phone alerts")}</p>
              <p className="text-[11px] text-stone-400">
                {armed
                  ? L("Armed on this device. The cashier's day-close total will ring here.")
                  : L("Arm this device to receive the daily total when the cashier closes the day.")}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => void armPhone()}
              disabled={pushBusy}
              className={`text-[11px] font-black uppercase px-4 py-2.5 rounded-xl disabled:opacity-50 ${armed ? "bg-emerald-700 hover:bg-emerald-600 text-white" : "bg-gradient-to-r from-[#C9A227] to-amber-500 text-[#2C1B17]"}`}
            >
              {armed ? L("✓ Phone alerts on") : L("🔔 Arm my phone")}
            </button>
            <button
              onClick={() => void testPhone(0)}
              disabled={pushBusy}
              className="text-[11px] font-black uppercase px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-amber-200 disabled:opacity-50"
            >
              {L("Test ring now")}
            </button>
            <button
              onClick={() => void testPhone(10)}
              disabled={pushBusy}
              className="text-[11px] font-black uppercase px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-amber-200 disabled:opacity-50"
            >
              {L("Test ring in 10s (lock your phone)")}
            </button>
          </div>
        </div>
        <p className="text-[11px] text-stone-500">
          {L("Android rings with the screen off. iPhone must be added to the Home Screen first (Share → Add to Home Screen).")}
        </p>
      </section>

      {/* THE LIST — one line per date, newest first (today, yesterday, and
          every day closed since this feature started) */}
      <section className="bg-[#2C1B17] border border-stone-800 rounded-2xl p-4 space-y-3">
        <h3 className="text-xs font-black uppercase tracking-wider text-amber-200">{L("Total sales by date")}</h3>
        {!data ? (
          <p className="text-xs text-stone-500 py-6 text-center">{L("Loading daily sales...")}</p>
        ) : days.length === 0 ? (
          <p className="text-xs text-stone-500 py-6 text-center">{L("No printed sales yet. They appear here the moment the cashier prints a bill.")}</p>
        ) : (
          <div className="divide-y divide-stone-800">
            {days.map((d) => (
              <div key={d.dayKey} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-black text-amber-100">
                    {dayKeyLabel(d.dayKey)}
                    {d.dayKey === data.todayKey && (
                      <span className="ml-2 text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-emerald-600/25 border border-emerald-600/60 text-emerald-300">
                        {L("Today")}
                      </span>
                    )}
                  </p>
                  <p className="text-[11px] text-stone-400">
                    {L("{bills} printed bill(s)", { bills: d.bills })}
                    {d.closed && (
                      <span className="inline-flex items-center gap-1 ml-2">
                        <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                        {L("closed {clock} by {name}", { clock: clockOf(d.closed.at), name: d.closed.by })}
                        {d.closed.total !== d.total ? ` • ${L("sent {value}", { value: staffEtb(d.closed.total) })}` : ""}
                      </span>
                    )}
                  </p>
                </div>
                <p className="font-serif font-black text-lg text-white tabular-nums">{formatEtb(d.total)}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {data && days.length > 0 && (
        <p className="text-[11px] text-stone-500">
          {L("A sale is counted the moment the cashier prints the bill (the EFD receipt). Cancelled orders are never counted.")}
        </p>
      )}
    </div>
  );
}
