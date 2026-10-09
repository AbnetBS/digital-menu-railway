"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, AlertCircle, Clock, Fingerprint, Timer } from "lucide-react";

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
 *   moment a scan is clocked in/out (SSE), so there is no polling at all.
 *
 * The fingerprint stays the main way: the ESP32 posts the scan straight to
 * /api/attendance/clock and this page picks it up instantly. The PIN
 * is only the second option.
 */

interface Member {
  id: number;
  name: string;
  role: string;
  hasPin: boolean;
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

export default function AttendanceKiosk() {
  const [today, setToday] = useState<TodayData | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [memberId, setMemberId] = useState<string>("");
  const [pin, setPin] = useState("");
  const [flash, setFlash] = useState<Flash>(null);
  const [busy, setBusy] = useState(false);

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

  useEffect(() => {
    fetchToday();
    fetchMembers();
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
  }, [fetchToday, fetchMembers]);

  // A message on the door must not stay there forever.
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(t);
  }, [flash]);

  /** The backup way in: name from the list + PIN. */
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
        setFlash({ kind: "bad", title: d.error || "Incorrect PIN" });
        setPin("");
        return;
      }
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

  return (
    <div className="min-h-screen bg-[#0F0A08] text-white flex flex-col">
      {/* Slim header */}
      <div className="bg-[#1C120F] border-b border-[#C9A227]/30 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[#C9A227] flex items-center justify-center">
            <Fingerprint className="w-5 h-5 text-[#2C1B17]" />
          </div>
          <h1 className="font-serif font-black text-lg text-amber-100">FANA CAFÉ - Attendance</h1>
        </div>
        <a href="/admin" className="text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-xl">
          Admin
        </a>
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-4 p-4 max-w-7xl mx-auto w-full">
        {/* LEFT: name + PIN + overtime */}
        <div className="lg:col-span-1 space-y-4">
          <div className="bg-[#1C120F] rounded-3xl border border-[#C9A227]/30 p-4 space-y-4">
            <div>
              <label className="block text-[11px] font-bold text-amber-200 mb-1 uppercase">Name</label>
              <select
                value={memberId}
                onChange={(e) => {
                  setMemberId(e.target.value);
                  setFlash(null);
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

            <div className="bg-black/40 border border-stone-700 rounded-2xl px-4 py-3 text-center">
              <span className="text-2xl tracking-[0.4em] font-mono text-amber-100">
                {pin ? "•".repeat(pin.length) : "\u00A0"}
              </span>
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
              onClick={submitPin}
              disabled={busy}
              className="w-full bg-[#C9A227] hover:bg-amber-400 disabled:opacity-60 text-[#2C1B17] font-black text-sm uppercase rounded-2xl py-4"
            >
              Submit
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
