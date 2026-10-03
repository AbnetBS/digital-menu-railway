"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Printer, RefreshCw, BellRing, BellOff, CheckCircle2, Clock, Save, Send } from "lucide-react";
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
  ensurePocketAlerts,
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
 *   • the date list includes recent daily sales and every saved day-close record,
 *     so the owner can inspect dates before yesterday (including last week) and
 *     keep the history as it accumulates;
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
 *
 * "I ALLOWED NOTIFICATIONS BUT NEVER RECEIVED THE TOTAL" (owner, 3 Oct 2026).
 * Three things were wrong with that, and all three are fixed here:
 *   1. this page never re-synced the device with the server, so a pruned row,
 *      a rotated endpoint or a regenerated VAPID key left a green
 *      "Notifications on" chip over a phone the server could not reach. It now
 *      syncs on mount, on visibility, on reconnect and every 5 minutes, and
 *      "on" means the server acknowledged this device;
 *   2. there was no way to try it without waiting for the evening. The "send
 *      today's total to my phone" button runs the real send on demand and
 *      reports how many phones the push service accepted;
 *   3. the page never said that sending the total does not CLOSE the day: the
 *      bills printed after the tap keep counting and the same button sends the
 *      bigger number. It says so now.
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
  /** When the system already sent today's final number by itself (or null). */
  autoSentAt?: string | null;
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

  /**
   * SELF-HEAL, so "Notifications on" is a fact and not a hope (3 Oct 2026).
   *
   * This page is the ONLY place in the cafe that arms a phone, so it is also
   * the only place that can REPAIR one. Having browser permission is not
   * enough: the server pruned the row after a 410, the push service rotated
   * the endpoint, the VAPID keys were regenerated with a fresh database, or the
   * admin session expired. The staff hook has re-synced on mount, visibility,
   * reconnect and a timer for years; this page never did, so an owner's phone
   * could sit on a green "Notifications on" and still never receive the total.
   */
  useEffect(() => {
    if (!pushSupported()) {
      // Browsers that cannot do push at all still get an honest status card.
      const t = setTimeout(() => void refreshPushStatus(), 0);
      return () => clearTimeout(t);
    }
    let cancelled = false;
    const heal = async () => {
      if (cancelled) return;
      try {
        await ensurePocketAlerts();
      } catch {
        /* offline: keep the last known state */
      }
      if (!cancelled) void refreshPushStatus();
    };
    // A timer keeps setState out of the synchronous effect body
    // (react-hooks/set-state-in-effect): the first sync is a network round trip.
    const first = setTimeout(() => void heal(), 0);
    const timer = setInterval(heal, 5 * 60 * 1000);
    const onVisible = () => {
      if (!document.hidden) void heal();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", heal);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", heal);
      window.removeEventListener("focus", onVisible);
    };
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

  const testPhone = async () => {
    setPushBusy(true);
    const res = await sendTestPush(0);
    await refreshPushStatus();
    setPushBusy(false);
    if (!res.ok) showToast(Ld(res.error) || tNow("The test could not be sent."));
    else showToast(tNow("Test sent • this device should ring now"));
  };

  /**
   * SEND TODAY'S TOTAL TO MY PHONE, RIGHT NOW (owner, 3 Oct 2026).
   *
   * "I already allowed notification on my site but still he did not receive
   * total sale." This button is the answer he can act on: it runs the exact
   * same server send as the cashier's tap and reports what the push service
   * did, so the screen says "reached your phone" or "no phone is registered
   * for this login" instead of leaving him to guess. It writes nothing: no
   * close record, no automatic-send latch, so using it never changes the
   * day's numbers.
   */
  const sendTotalToMyPhone = async () => {
    setPushBusy(true);
    try {
      const r = await fetch("/api/reports/daily-sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send-total" }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) {
        showToast(body?.error ? Ld(body.error) : tNow("Network error. Try again."));
      } else if (body?.ok) {
        showToast(tNow("✓ Today's total is on your phone • {value}", { value: staffEtb(Number(body?.total || 0)) }));
      } else {
        showToast(
          Ld(body?.error) ||
            tNow("Nothing is registered to receive it. Turn on notifications on this page, then send again."),
        );
        await refreshPushStatus();
      }
    } catch {
      showToast(tNow("Network error. Try again."));
    }
    setPushBusy(false);
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
  // Permission alone is not armed: the SERVER must hold this device too.
  const allowedButUnregistered =
    !!pushStatus?.supported && pushStatus.permission === "granted" && !!pushStatus.subscribed && !pushStatus.registered;
  const todayRow = data?.today;
  // The two exact moments, to the minute the owner chose ("20:03" / "21:03").
  const cutoff = data?.cutoffAt || `${String(data?.cutoffHour ?? 20).padStart(2, "0")}:00`;
  const notify = data?.notifyAt || `${String(data?.notifyHour ?? 21).padStart(2, "0")}:00`;
  const nowClock = data
    ? `${String(data.currentHour).padStart(2, "0")}:${String(data.currentMinute ?? 0).padStart(2, "0")}`
    : "";
  // "21:04" — when the system sent today's final number by itself, if it did.
  const autoSentClock = data?.autoSentAt ? clockOf(data.autoSentAt) : "";

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
          {autoSentClock && (
            <p className="text-[11px] text-emerald-300 font-bold">
              {L("The system already sent today's total by itself at {time}.", { time: autoSentClock })}
            </p>
          )}
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
              onClick={() => void testPhone()}
              disabled={pushBusy}
              className="text-[11px] font-black uppercase px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-amber-200 disabled:opacity-50"
            >
              {L("Test ring sound")}
            </button>
            <button
              onClick={() => void armPhone()}
              disabled={pushBusy || armed}
              className={`text-[11px] font-black uppercase px-4 py-2.5 rounded-xl disabled:opacity-50 ${armed ? "bg-emerald-700 text-white" : "bg-gradient-to-r from-[#C9A227] to-amber-500 text-[#2C1B17]"}`}
            >
              {armed ? L("✓ Notifications on") : L("Turn on notifications")}
            </button>
          </div>
        </div>

        {/* THE HONEST WARNING (3 Oct 2026): the browser says "allowed" and this
            device says "subscribed", but if the server does not hold the row
            the total has nowhere to go. Say so instead of showing green. */}
        {allowedButUnregistered && (
          <p className="text-[11px] font-bold text-amber-300 bg-amber-500/10 border border-amber-500/40 rounded-xl p-2.5">
            {L("This device is not registered on the server, so the total cannot reach it.")}
          </p>
        )}

        {/* SEND IT NOW: the same send the cashier's button makes, on demand,
            so the owner can prove the pipeline without waiting for the
            evening (and without touching the day's close record). */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void sendTotalToMyPhone()}
            disabled={pushBusy}
            className="flex items-center gap-2 text-[11px] font-black uppercase px-4 py-2.5 rounded-xl bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] disabled:opacity-50"
          >
            <Send className="w-3.5 h-3.5" />
            {L("Send today's total to my phone")}
          </button>
          <span className="text-[11px] text-stone-400 min-w-0">
            {todayRow ? L("Right now that is {value}.", { value: staffEtb(todayRow.total) }) : ""}
          </span>
        </div>
        <p className="text-[11px] text-stone-400">
          {L("Sending the total does not close the day. Sales after that moment keep counting, and the total can be sent again.")}
        </p>
        <p className="text-[11px] text-stone-400">
          {L("Turn on notifications asks for browser permission if needed. The daily total arrives when the cashier ends the shift, or automatically at {time} if nobody closes; tapping it opens Admin → Sales. Android can ring with the screen off. On iPhone, add this page to the Home Screen first.", { time: notify })}
        </p>
      </section>

      {/* THE LIST — one line per date, newest first (recent sales plus every
          saved day-close record, including dates before yesterday) */}
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
