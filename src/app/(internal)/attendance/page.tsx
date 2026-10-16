"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, AlertCircle, Clock, Fingerprint, Lock, ShieldCheck, Timer } from "lucide-react";
import {
  ATTENDANCE_SUPERVISOR_ROLE,
  SUPERVISOR_IDLE_TIMEOUT_MS,
  countdownLabel,
} from "@/lib/attendance-supervisor";

/**
 * THE DOOR TABLET (/attendance).
 *
 * Clean on purpose (owner, Oct 2026): the big clock, the device chatter, the
 * demo buttons, the wall of absent names and the counters are gone. What stays
 * is the two things a person at the door needs:
 *
 *   LEFT (a third of the screen): his name from the list, the PIN keypad for
 *   the days his finger is wet or dirty, and the Overtime button.
 *   RIGHT: today, live, as the paper sheet - name, IN (time & signature), OUT
 *   (time & signature), total hours, status. Real time: the server pushes the
 * moment a scan is clocked in/out (SSE), so there is no polling at all.
 *
 * The fingerprint stays the main way: the ESP32 posts the scan straight to
 * /api/attendance/clock and this page picks it up instantly. The PIN
 * is only the second option.
 *
 * THE SUPERVISOR LOCK (owner, Oct 2026: "the 2nd option is good but it is
 * risky since someone can write for them"): the PIN keypad is locked until an
 * ATTENDANCE SUPERVISOR opens it with his own name and PIN - a normal Staff
 * Account with the role "Attendance Supervisor (/attendance)". Two minutes
 * after the last touch of the keypad the tablet locks itself again and asks for
 * the login once more. What the lock never touches:
 *
 *   • the fingerprint scanner (the ESP32 posts straight to the server, so the
 *     main way in needs no supervisor and never queues behind one),
 *   • the live sheet on the right,
 *   • the Overtime button, which is pressed right after a person's own scan.
 *
 * The two minutes are counted on the server too: /api/attendance/clock refuses
 * a PIN entry whose supervisor cookie has expired, so hiding the keypad in the
 * browser would not be enough.
 */

interface Member {
  id: number;
  name: string;
  role: string;
  hasPin: boolean;
}

interface Supervisor {
  id: number;
  name: string;
  role: string;
}

interface TodayLog {
  id: number;
  memberId: number | null;
  memberName: string;
  roleName: string;
  clockInTime: string | null;
  clockOutTime: string | null;
  totalHours: string | null;
  lateMinutes: number;
  status: string;
  isOvertime: boolean;
  earlyOut: boolean;
  fingerprintId: number | null;
}

interface TodayData {
  date: string;
  logs: TodayLog[];
  lastScan: {
    logId: number;
    memberId: number | null;
    memberName: string;
    action: string;
    secondsAgo: number;
    isOvertime: boolean;
  } | null;
  stats: Record<string, number>;
}

type Flash = { kind: "ok" | "bad" | "info"; title: string; detail?: string } | null;

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "ok"];

/** How often the tablet renews its two minutes on the server while in use. */
const TOUCH_EVERY_MS = 20000;

export default function AttendanceKiosk() {
  const [today, setToday] = useState<TodayData | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [supervisors, setSupervisors] = useState<Supervisor[]>([]);
  const [memberId, setMemberId] = useState<string>("");
  const [pin, setPin] = useState("");
  const [flash, setFlash] = useState<Flash>(null);
  const [busy, setBusy] = useState(false);

  /* ── the supervisor unlock ─────────────────────────────────────────────── */
  const [supervisorName, setSupervisorName] = useState<string | null>(null);
  const [supervisorId, setSupervisorId] = useState<string>("");
  const [supervisorPin, setSupervisorPin] = useState("");
  /** Epoch ms when the keypad locks itself again; null while it is locked. */
  const [unlockExpiresAt, setUnlockExpiresAt] = useState<number | null>(null);
  /** Ticks once a second: it drives the countdown and the automatic lock. */
  const [now, setNow] = useState(() => Date.now());
  const lastTouchSent = useRef(0);

  const locked = unlockExpiresAt === null || now >= unlockExpiresAt;

  const fetchToday = useCallback(async () => {
    try {
      const r = await fetch("/api/attendance/today");
      if (r.ok) setToday(await r.json());
    } catch {
      /* the board simply keeps the last good picture */
    }
  }, []);

  const fetchMembers = useCallback(async () => {
    try {
      const r = await fetch("/api/attendance/members?public=1");
      if (r.ok) setMembers(await r.json());
    } catch {
      /* the list simply stays as it was */
    }
  }, []);

  /** The supervisors are Staff Accounts with their own role; only their names
   *  are read here (the public login list never carries a PIN). */
  const fetchSupervisors = useCallback(async () => {
    try {
      const r = await fetch("/api/staff?public=1");
      if (!r.ok) return;
      const list = (await r.json()) as Supervisor[];
      setSupervisors(list.filter((s) => s.role === ATTENDANCE_SUPERVISOR_ROLE));
    } catch {
      /* the list simply stays as it was */
    }
  }, []);

  /** Lock now: the supervisor's own button, and what the timeout does. */
  const lockNow = useCallback((message?: Flash) => {
    setUnlockExpiresAt(null);
    setSupervisorName(null);
    setSupervisorId("");
    setSupervisorPin("");
    setPin("");
    if (message) setFlash(message);
    fetch("/api/attendance/supervisor", { method: "DELETE" }).catch(() => {
      /* the server cookie dies on its own two minutes after the last touch */
    });
  }, []);

  useEffect(() => {
    fetchToday();
    fetchMembers();
    fetchSupervisors();
    // A refresh of the page keeps whatever is left of the two minutes, so the
    // supervisor is not asked again for no reason.
    fetch("/api/attendance/supervisor")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.active) {
          setSupervisorName(d.name);
          setUnlockExpiresAt(Date.now() + Math.max(0, Number(d.secondsLeft) || 0) * 1000);
          lastTouchSent.current = Date.now();
        }
      })
      .catch(() => {
        /* no answer: stay locked, the keypad simply asks for the login */
      });
    // Real time: the server pushes when a scan is clocked in/out, so the
    // board updates instantly and there is no polling. If the stream cannot
    // be opened (e.g. an older server), fall back to the old 8 s refresh.
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    if (typeof EventSource !== "undefined") {
      es = new EventSource("/api/realtime?channel=attendance");
      es.onmessage = () => fetchToday();
      es.onerror = () => {
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          es = null;
          poll = setInterval(fetchToday, 8000);
        }
        // otherwise EventSource reconnects by itself
      };
    } else {
      poll = setInterval(fetchToday, 8000);
    }
    return () => {
      if (es) es.close();
      if (poll) clearInterval(poll);
    };
  }, [fetchToday, fetchMembers, fetchSupervisors]);

  // The countdown of the unlock, and the second counter that drives it.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Two minutes with no activity: the tablet locks itself and asks again.
  useEffect(() => {
    if (unlockExpiresAt === null || now < unlockExpiresAt) return;
    lockNow({
      kind: "info",
      title: "Locked again",
      detail: "Two minutes passed with nothing happening. Ask the supervisor to open the PIN keypad again.",
    });
  }, [now, unlockExpiresAt, lockNow]);

  // A message on the door must not stay there forever.
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(t);
  }, [flash]);

  /**
   * Any touch of the keypad starts the two minutes again - here, and on the
   * server (at most one renewal every 20 seconds, so a person typing his PIN
   * does not send a request per finger).
   */
  const noteActivity = useCallback(() => {
    const at = Date.now();
    setNow(at);
    setUnlockExpiresAt((prev) => (prev === null ? prev : at + SUPERVISOR_IDLE_TIMEOUT_MS));
    if (at - lastTouchSent.current < TOUCH_EVERY_MS) return;
    lastTouchSent.current = at;
    fetch("/api/attendance/supervisor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ touch: true }),
    })
      .then((r) => {
        if (r.status === 403) {
          lockNow({
            kind: "bad",
            title: "Supervisor login ended",
            detail: "The two minutes ran out on the server. Log in again to keep using the PIN keypad.",
          });
        }
      })
      .catch(() => {
        /* offline: the local two minutes still lock the keypad on time */
      });
  }, [lockNow]);

  /** The supervisor opens the keypad for the next two minutes. */
  const unlockKeypad = useCallback(async () => {
    const chosen = supervisors.find((s) => String(s.id) === supervisorId);
    if (!chosen) {
      setFlash({ kind: "bad", title: "Select the supervisor first" });
      return;
    }
    if (!supervisorPin) {
      setFlash({ kind: "bad", title: "Type your PIN" });
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/attendance/supervisor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: chosen.name, pin: supervisorPin }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.success) {
        setFlash({ kind: "bad", title: d?.error || "Incorrect name or PIN" });
        setSupervisorPin("");
        return;
      }
      const seconds = Number(d.secondsLeft) || Math.round(SUPERVISOR_IDLE_TIMEOUT_MS / 1000);
      setSupervisorName(d.name || chosen.name);
      setUnlockExpiresAt(Date.now() + seconds * 1000);
      lastTouchSent.current = Date.now();
      setSupervisorPin("");
      setMemberId("");
      setPin("");
      setNow(Date.now());
      setFlash({
        kind: "ok",
        title: `${d.name || chosen.name} opened the keypad`,
        detail: "It locks itself again after two minutes with no activity.",
      });
    } catch {
      setFlash({ kind: "bad", title: "Network error. Try again." });
    } finally {
      setBusy(false);
    }
  }, [supervisors, supervisorId, supervisorPin]);

  /** The backup way in: name from the list + PIN (supervisor unlocked only). */
  const submitPin = async () => {
    if (!memberId) {
      setFlash({ kind: "bad", title: "Select your name first" });
      return;
    }
    if (!pin) {
      setFlash({ kind: "bad", title: "Type your PIN" });
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/attendance/clock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "pin", memberId: Number(memberId), pin }),
      });
      const d = await r.json();
      if (!r.ok) {
        // The two minutes ran out while the person was typing: back to the
        // supervisor login instead of a bare "Incorrect PIN".
        if (r.status === 403 || d.needsSupervisor) {
          setPin("");
          lockNow({
            kind: "bad",
            title: "Supervisor login needed",
            detail: d.error || "The keypad locked itself. Ask the supervisor to open it again.",
          });
          return;
        }
        setFlash({ kind: "bad", title: d.error || "Incorrect PIN" });
        setPin("");
        return;
      }
      // A successful entry is activity too: the supervisor standing there with
      // a queue of wet fingers is not asked to log in again in the middle.
      noteActivity();
      // A second scan inside the hour is not an error: it says "already
      // registered" and leaves the IN alone.
      setFlash({
        kind: d.action === "already_registered" ? "info" : "ok",
        title: d.memberName,
        detail: d.message,
      });
      setPin("");
      fetchToday();
    } catch {
      setFlash({ kind: "bad", title: "Network error. Try again." });
    } finally {
      setBusy(false);
    }
  };

  const press = (key: string) => {
    setFlash(null);
    // One keypad, two jobs: while the tablet is locked it types the
    // SUPERVISOR's PIN, once it is open it types the person's backup PIN.
    if (locked) {
      if (key === "clear") {
        setSupervisorPin((p) => p.slice(0, -1));
        return;
      }
      if (key === "ok") {
        unlockKeypad();
        return;
      }
      setSupervisorPin((p) => (p.length >= 8 ? p : p + key));
      return;
    }
    noteActivity();
    if (key === "clear") {
      setPin((p) => p.slice(0, -1));
      return;
    }
    if (key === "ok") {
      submitPin();
      return;
    }
    setPin((p) => (p.length >= 8 ? p : p + key));
  };

  /** "It is overtime": pressed right after the scan of the same person. */
  const markOvertime = async () => {
    const target = today?.lastScan?.memberId ?? (memberId ? Number(memberId) : null);
    const logId = today?.lastScan?.logId;
    if (!target && !logId) {
      setFlash({ kind: "bad", title: "Scan first, or select your name, then press Overtime" });
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/attendance/overtime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logId: logId ?? undefined, memberId: target ?? undefined }),
      });
      const d = await r.json();
      if (!r.ok) {
        setFlash({ kind: "bad", title: d.error || "Could not save the overtime" });
        return;
      }
      setFlash({ kind: "ok", title: d.message });
      fetchToday();
    } catch {
      setFlash({ kind: "bad", title: "Network error. Try again." });
    } finally {
      setBusy(false);
    }
  };

  const lastScan = today?.lastScan ?? null;
  const typedPin = locked ? supervisorPin : pin;

  return (
    <div className="min-h-screen bg-[#0F0A08] text-white flex flex-col">
      {/* Slim header */}
      <div className="bg-[#1C120F] border-b border-[#C9A227]/30 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[#C9A227] flex items-center justify-center">
            <Fingerprint className="w-5 h-5 text-[#2C1B17]" />
          </div>
          <h1 className="font-serif font-black text-lg text-amber-100">Fana Cafe and restaurant plc - Attendance</h1>
        </div>
        <a href="/admin" className="text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-xl">
          Admin
        </a>
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-4 p-4 max-w-7xl mx-auto w-full">
        {/* LEFT: supervisor lock + name + PIN + overtime */}
        <div className="lg:col-span-1 space-y-4">
          <div className="bg-[#1C120F] rounded-3xl border border-[#C9A227]/30 p-4 space-y-4">
            {locked ? (
              <>
                <div className="flex items-start gap-3 bg-amber-950/40 border border-amber-700 rounded-2xl p-3">
                  <Lock className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-black uppercase text-amber-200">Supervisor login required</p>
                    <p className="text-[11px] text-stone-300 mt-1">
                      The fingerprint scanner keeps working. Only the backup PIN keypad is locked, so nobody can type
                      a day in for somebody else: the supervisor picks his own name, types his PIN, and the keypad
                      stays open for two minutes after the last touch.
                    </p>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-amber-200 mb-1 uppercase">Supervisor</label>
                  <select
                    value={supervisorId}
                    onChange={(e) => {
                      setSupervisorId(e.target.value);
                      setFlash(null);
                    }}
                    className="w-full bg-black/40 border border-stone-700 rounded-2xl p-4 text-base text-white"
                  >
                    <option value="">Select the supervisor</option>
                    {supervisors.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  {supervisors.length === 0 && (
                    <p className="text-[11px] text-rose-300 mt-2 font-bold">
                      No attendance supervisor yet. Admin → Staff Accounts → add the person with the role
                      &quot;Attendance Supervisor (/attendance)&quot;, then reload this page.
                    </p>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 bg-emerald-950/50 border border-emerald-700 rounded-2xl p-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <ShieldCheck className="w-5 h-5 text-emerald-300 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-[11px] font-black uppercase text-emerald-200 truncate">
                        Opened by {supervisorName}
                      </p>
                      <p className="text-[10px] text-stone-400">locks itself after 2 min with no activity</p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-mono font-black text-xl text-emerald-300 leading-none">
                      {countdownLabel((unlockExpiresAt ?? 0) - now)}
                    </p>
                    <button
                      onClick={() => lockNow({ kind: "info", title: "Keypad locked" })}
                      className="text-[10px] font-bold text-stone-300 hover:text-white underline mt-1"
                    >
                      Lock now
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-amber-200 mb-1 uppercase">Name</label>
                  <select
                    value={memberId}
                    onChange={(e) => {
                      setMemberId(e.target.value);
                      setFlash(null);
                      noteActivity();
                    }}
                    className="w-full bg-black/40 border border-stone-700 rounded-2xl p-4 text-base text-white"
                  >
                    <option value="">Select your name</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} - {m.role}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}

            <div className="bg-black/40 border border-stone-700 rounded-2xl px-4 py-3 text-center">
              <span className="text-2xl tracking-[0.4em] font-mono text-amber-100">
                {typedPin ? "•".repeat(typedPin.length) : "\u00A0"}
              </span>
              <p className="text-[10px] text-stone-500 mt-1 font-bold uppercase">
                {locked ? "Supervisor PIN" : "Staff backup PIN"}
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {KEYS.map((k) =>
                k === "clear" ? (
                  <button
                    key={k}
                    onClick={() => press(k)}
                    className="bg-[#3D2314] hover:bg-white/10 text-stone-300 rounded-2xl py-4 text-base font-bold"
                  >
                    ⌫
                  </button>
                ) : k === "ok" ? (
                  <button
                    key={k}
                    onClick={() => press(k)}
                    className="bg-emerald-800 hover:bg-emerald-700 text-white rounded-2xl py-4 text-base font-black"
                  >
                    ✓
                  </button>
                ) : (
                  <button
                    key={k}
                    onClick={() => press(k)}
                    className="bg-[#2C1B17] hover:bg-[#C9A227] hover:text-[#2C1B17] text-white rounded-2xl py-4 text-xl font-black"
                  >
                    {k}
                  </button>
                )
              )}
            </div>

            <button
              onClick={locked ? unlockKeypad : submitPin}
              disabled={busy}
              className="w-full bg-[#C9A227] hover:bg-amber-400 disabled:opacity-60 text-[#2C1B17] font-black text-sm uppercase rounded-2xl py-4"
            >
              {locked ? "Unlock the keypad" : "Submit"}
            </button>

            <button
              onClick={markOvertime}
              disabled={busy}
              className="w-full bg-violet-900/60 hover:bg-violet-800 disabled:opacity-60 border border-violet-600 text-violet-100 font-black text-sm uppercase rounded-2xl py-4 flex items-center justify-center gap-2"
            >
              <Timer className="w-4 h-4" /> Overtime
              {lastScan ? <span className="text-[11px] font-bold normal-case">• {lastScan.memberName}</span> : null}
            </button>

            <p className="text-[11px] text-stone-500 text-center">
              Fingerprint on the scanner is the main way. The PIN is for a wet or dirty finger.
            </p>
          </div>

          {/* What the last tap answered */}
          {flash && (
            <div
              className={`rounded-3xl border-2 p-5 text-center ${
                flash.kind === "ok"
                  ? "bg-emerald-950/50 border-emerald-500/50"
                  : flash.kind === "info"
                    ? "bg-amber-950/50 border-amber-500/50"
                    : "bg-rose-950/50 border-rose-500/50"
              }`}
            >
              {flash.kind === "bad" ? (
                <AlertCircle className="w-10 h-10 mx-auto text-rose-400 mb-2" />
              ) : (
                <CheckCircle2
                  className={`w-10 h-10 mx-auto mb-2 ${flash.kind === "info" ? "text-amber-300" : "text-emerald-400"}`}
                />
              )}
              <p className="font-black text-lg text-white">{flash.title}</p>
              {flash.detail && <p className="text-sm text-stone-300 mt-1">{flash.detail}</p>}
            </div>
          )}
        </div>

        {/* RIGHT: today, live, exactly like the paper sheet */}
        <div className="lg:col-span-2 space-y-4">
          {today && (
            <div className="bg-[#1C120F] rounded-3xl border border-[#C9A227]/30 overflow-hidden">
              <div className="p-4 border-b border-stone-800 flex items-center justify-between">
                <h3 className="font-bold text-amber-100 flex items-center gap-2">
                  <Clock className="w-4 h-4" /> Today Live - {today.date}
                </h3>
                <span className="text-[10px] bg-emerald-900/30 text-emerald-300 px-2 py-1 rounded-full border border-emerald-800 animate-pulse">
                  Live - Auto refresh 8s
                </span>
              </div>

              <div className="bg-white text-black p-2 text-center border-b-2 border-black">
                <p className="font-black text-sm">FANA CAFÉ & RESTAURANT</p>
                <p className="text-[11px]">
                  Attendance - {today.date} -{" "}
                  {new Date(`${today.date}T00:00:00`).toLocaleDateString("en-US", { weekday: "long" })} Day
                </p>
              </div>

              <div className="overflow-auto max-h-[70vh]">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#3D2314] text-amber-200 uppercase text-[10px] font-bold sticky top-0">
                    <tr>
                      <th className="p-3 border border-[#C9A227]/20">Employee Name</th>
                      <th className="p-3 border border-[#C9A227]/20 text-center">IN (Time & Sgn.)</th>
                      <th className="p-3 border border-[#C9A227]/20 text-center">OUT (Time & Sgn.)</th>
                      <th className="p-3 border border-[#C9A227]/20 text-center">Total Hours</th>
                      <th className="p-3 border border-[#C9A227]/20 text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-800 bg-[#1C120F]">
                    {today.logs.map((log) => (
                      <tr key={log.id} className="hover:bg-white/5">
                        <td className="p-3 border border-stone-800 font-bold text-white">
                          {log.memberName}
                          <div className="text-[10px] text-stone-500 font-normal">
                            {log.roleName} • {log.fingerprintId ? `ID ${log.fingerprintId}` : "PIN"}
                          </div>
                        </td>
                        <td className="p-3 border border-stone-800 text-center">
                          <div className="font-mono font-bold text-emerald-300">{log.clockInTime || "-"}</div>
                          {log.lateMinutes > 0 && (
                            <div className="text-[9px] bg-amber-900/50 text-amber-300 px-1 rounded mt-1 inline-block">
                              Late {log.lateMinutes}m
                            </div>
                          )}
                        </td>
                        <td className="p-3 border border-stone-800 text-center">
                          {log.clockOutTime ? (
                            <div className="font-mono font-bold text-stone-300">{log.clockOutTime}</div>
                          ) : (
                            <span className="text-[10px] bg-amber-900/30 text-amber-300 px-2 py-1 rounded-full">
                              Still In
                            </span>
                          )}
                        </td>
                        <td className="p-3 border border-stone-800 text-center font-mono font-black text-[#C9A227]">
                          {log.totalHours || "-"}
                        </td>
                        <td className="p-3 border border-stone-800 text-center">
                          <div className="flex flex-wrap gap-1 justify-center">
                            {log.status === "late" && (
                              <span className="bg-amber-900/50 text-amber-300 border border-amber-700 px-2 py-1 rounded-full text-[10px] font-bold">
                                Late
                              </span>
                            )}
                            {(log.status === "on_time" || (!log.clockOutTime && log.status !== "late")) && (
                              <span className="bg-emerald-900/50 text-emerald-300 border border-emerald-700 px-2 py-1 rounded-full text-[10px] font-bold">
                                On Time
                              </span>
                            )}
                            {log.status === "completed" && (
                              <span className="bg-white/10 text-white border border-white/20 px-2 py-1 rounded-full text-[10px] font-bold">
                                Completed
                              </span>
                            )}
                            {log.earlyOut && (
                              <span className="bg-sky-900/50 text-sky-300 border border-sky-700 px-2 py-1 rounded-full text-[10px] font-bold">
                                Early Out
                              </span>
                            )}
                            {log.isOvertime && (
                              <span className="bg-violet-900/50 text-violet-300 border border-violet-700 px-2 py-1 rounded-full text-[10px] font-bold">
                                Overtime
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {today.logs.length === 0 && (
                      <tr>
                        <td colSpan={5} className="p-12 text-center text-stone-500">
                          No attendance yet today. Scan a fingerprint on the device, or use the name and PIN on the
                          left.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
