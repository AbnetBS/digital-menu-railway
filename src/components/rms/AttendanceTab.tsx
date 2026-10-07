"use client";

import { useState, useEffect } from "react";
import { Users, Clock, Plus, Trash2, RefreshCw, Calendar, CheckCircle2, AlertCircle, LogOut, Fingerprint, Settings, Printer } from "lucide-react";
import { useStaffT } from "@/lib/staff-i18n";

interface StaffUser {
  id: number;
  name: string;
  role: string;
}

interface Biometric {
  id: number;
  staffId: number;
  fingerprintId: number;
  fingerName: string;
  staffName: string;
  enrolledAt: string;
}

interface AttendanceLog {
  id: number;
  staffId: number;
  staffName: string;
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  clockInTime: string | null;
  clockOutTime: string | null;
  totalHours: string | null;
  totalMinutes: number | null;
  lateMinutes: number;
  status: string;
  fingerprintId: number | null;
}

interface Shift {
  id: number;
  name: string;
  startTime: string;
  endTime: string;
  graceMinutes: number;
}

export default function AttendanceTab() {
  const { t: Lraw } = useStaffT();
  // Allow any string for attendance custom labels (not all in dictionary yet)
  const L = (s: string) => {
    try {
      return (Lraw as any)(s) || s;
    } catch {
      return s;
    }
  };
  const [activeView, setActiveView] = useState<"today" | "sheet" | "staff" | "shifts">("today");
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [biometrics, setBiometrics] = useState<Biometric[]>([]);
  const [todayLogs, setTodayLogs] = useState<any>(null);
  const [sheetData, setSheetData] = useState<any>(null);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(false);
  
  // Sheet view dates
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return d.toISOString().slice(0, 10);
  });
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  
  // Enroll form
  const [enrollStaffId, setEnrollStaffId] = useState<number | "">("");
  const [enrollFingerId, setEnrollFingerId] = useState("");
  const [enrollFingerName, setEnrollFingerName] = useState("Right Index");
  const [msg, setMsg] = useState("");
  
  // Shift form
  const [shiftName, setShiftName] = useState("");
  const [shiftStart, setShiftStart] = useState("08:00");
  const [shiftEnd, setShiftEnd] = useState("17:00");
  const [shiftGrace, setShiftGrace] = useState("15");

  const loadStaff = async () => {
    const r = await fetch("/api/staff");
    if (r.ok) setStaff(await r.json());
  };

  const loadBiometrics = async () => {
    const r = await fetch("/api/attendance/biometrics");
    if (r.ok) setBiometrics(await r.json());
  };

  const loadToday = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/attendance/today");
      if (r.ok) setTodayLogs(await r.json());
    } finally {
      setLoading(false);
    }
  };

  const loadSheet = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/attendance/logs?from=${fromDate}&to=${toDate}`);
      if (r.ok) setSheetData(await r.json());
    } finally {
      setLoading(false);
    }
  };

  const loadShifts = async () => {
    const r = await fetch("/api/attendance/shifts");
    if (r.ok) setShifts(await r.json());
  };

  useEffect(() => {
    loadStaff();
    loadBiometrics();
    loadToday();
    loadShifts();
  }, []);

  useEffect(() => {
    if (activeView === "sheet") loadSheet();
    if (activeView === "today") loadToday();
  }, [activeView, fromDate, toDate]);

  const handleEnroll = async () => {
    if (!enrollStaffId || !enrollFingerId) {
      setMsg("Staff and Fingerprint ID required");
      return;
    }
    try {
      const r = await fetch("/api/attendance/biometrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: Number(enrollStaffId),
          fingerprintId: Number(enrollFingerId),
          fingerName: enrollFingerName,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setMsg(d.error || "Failed");
      } else {
        setMsg(`✓ ${d.message}`);
        setEnrollFingerId("");
        loadBiometrics();
      }
    } catch {
      setMsg("Network error");
    }
  };

  const handleDeleteBio = async (id: number) => {
    if (!confirm("Delete this fingerprint? Employee will need to re-enroll on device.")) return;
    try {
      const r = await fetch(`/api/attendance/biometrics?id=${id}`, { method: "DELETE" });
      if (r.ok) {
        setMsg("Fingerprint deleted");
        loadBiometrics();
      } else {
        setMsg("Failed to delete fingerprint");
      }
    } catch {
      setMsg("Network error: failed to delete fingerprint");
    }
  };

  const handleAddShift = async () => {
    if (!shiftName || !shiftStart || !shiftEnd) return;
    try {
      const r = await fetch("/api/attendance/shifts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: shiftName, startTime: shiftStart, endTime: shiftEnd, graceMinutes: Number(shiftGrace) }),
      });
      if (r.ok) {
        setShiftName("");
        setMsg("Shift added");
        loadShifts();
      } else {
        setMsg("Failed to add shift");
      }
    } catch {
      setMsg("Network error: failed to add shift");
    }
  };

  const handleDeleteShift = async (id: number) => {
    if (!confirm("Delete shift?")) return;
    try {
      const r = await fetch(`/api/attendance/shifts?id=${id}`, { method: "DELETE" });
      if (r.ok) {
        setMsg("Shift deleted");
        loadShifts();
      } else {
        setMsg("Failed to delete shift");
      }
    } catch {
      setMsg("Network error: failed to delete shift");
    }
  };

  // Group biometrics by staff
  const bioByStaff = new Map<number, Biometric[]>();
  for (const b of biometrics) {
    if (!bioByStaff.has(b.staffId)) bioByStaff.set(b.staffId, []);
    bioByStaff.get(b.staffId)!.push(b);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-serif font-bold text-amber-100 flex items-center gap-2">
            <Fingerprint className="w-5 h-5 text-[#C9A227]" /> {L("Attendance System")}
          </h2>
          <p className="text-xs text-stone-400">{L("FPC1020A + ESP32 WROOM - Fingerprint attendance like paper sheet, but digital")}</p>
        </div>
        <button onClick={() => { loadToday(); loadBiometrics(); loadStaff(); }} className="p-2 bg-white/10 hover:bg-white/20 text-amber-200 rounded-xl">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* View Switcher */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        {[
          { key: "today", label: "Today Live", icon: <Clock className="w-4 h-4" /> },
          { key: "sheet", label: "Paper Sheet View", icon: <Calendar className="w-4 h-4" /> },
          { key: "staff", label: "Staff Fingerprints", icon: <Fingerprint className="w-4 h-4" /> },
          { key: "shifts", label: "Shifts", icon: <Settings className="w-4 h-4" /> },
        ].map(v => (
          <button
            key={v.key}
            onClick={() => setActiveView(v.key as any)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold whitespace-nowrap transition ${activeView === v.key ? "bg-[#C9A227] text-[#2C1B17]" : "bg-[#2C1B17] text-stone-300 hover:bg-white/10"}`}
          >
            {v.icon} {L(v.label)}
          </button>
        ))}
        <a href="/attendance" target="_blank" className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold bg-emerald-800 hover:bg-emerald-700 text-white whitespace-nowrap">
          <Clock className="w-4 h-4" /> {L("Open Kiosk /attendance")}
        </a>
      </div>

      {/* TODAY LIVE */}
      {activeView === "today" && todayLogs && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div className="bg-[#2C1B17] p-4 rounded-2xl border border-[#C9A227]/30">
              <p className="text-[10px] text-stone-400 uppercase font-bold">Present Today</p>
              <p className="text-2xl font-black text-emerald-400">{todayLogs.stats.present}</p>
            </div>
            <div className="bg-[#2C1B17] p-4 rounded-2xl border border-stone-800">
              <p className="text-[10px] text-stone-400 uppercase font-bold">Completed</p>
              <p className="text-2xl font-black text-white">{todayLogs.stats.completed}</p>
            </div>
            <div className="bg-[#2C1B17] p-4 rounded-2xl border border-stone-800">
              <p className="text-[10px] text-stone-400 uppercase font-bold">Still In</p>
              <p className="text-2xl font-black text-amber-300">{todayLogs.stats.stillIn}</p>
            </div>
            <div className="bg-[#2C1B17] p-4 rounded-2xl border border-amber-900/50">
              <p className="text-[10px] text-stone-400 uppercase font-bold">Late</p>
              <p className="text-2xl font-black text-amber-400">{todayLogs.stats.late}</p>
            </div>
            <div className="bg-[#2C1B17] p-4 rounded-2xl border border-rose-900/50">
              <p className="text-[10px] text-stone-400 uppercase font-bold">Absent</p>
              <p className="text-2xl font-black text-rose-400">{todayLogs.stats.absent}</p>
            </div>
          </div>

          <div className="bg-[#2C1B17] rounded-2xl border border-[#C9A227]/30 overflow-hidden">
            <div className="p-4 border-b border-stone-800 flex items-center justify-between">
              <h3 className="font-bold text-amber-100">Today - {todayLogs.date} - Live</h3>
              <span className="text-[10px] bg-emerald-900/50 text-emerald-300 px-2 py-1 rounded-full border border-emerald-700">Auto refresh every 8 sec</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#3D2314] text-amber-200 uppercase text-[10px] font-bold">
                  <tr>
                    <th className="p-3">Employee Name</th>
                    <th className="p-3">IN (Time & Finger)</th>
                    <th className="p-3">OUT (Time & Finger)</th>
                    <th className="p-3">Total Hours</th>
                    <th className="p-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-800">
                  {todayLogs.logs.map((log: any) => (
                    <tr key={log.id} className="hover:bg-white/5">
                      <td className="p-3 font-bold text-white">{log.staffName} <span className="text-[10px] text-stone-500">({log.staffRole})</span></td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <Clock className="w-3 h-3 text-emerald-400" />
                          <span className="font-mono text-emerald-300">{log.clockInTime || "-"}</span>
                          {log.fingerprintId && <span className="text-[10px] bg-[#3D2314] px-1.5 py-0.5 rounded">ID {log.fingerprintId}</span>}
                        </div>
                        {log.lateMinutes > 0 && <p className="text-[10px] text-amber-400 mt-1">Late {log.lateMinutes}m</p>}
                      </td>
                      <td className="p-3">
                        {log.clockOutTime ? (
                          <div className="flex items-center gap-2">
                            <LogOut className="w-3 h-3 text-stone-400" />
                            <span className="font-mono text-stone-300">{log.clockOutTime}</span>
                          </div>
                        ) : (
                          <span className="text-[10px] bg-amber-900/30 text-amber-300 px-2 py-1 rounded-full">Still In</span>
                        )}
                      </td>
                      <td className="p-3 font-mono font-bold text-[#C9A227]">{log.totalHours || "-"}</td>
                      <td className="p-3">
                        {log.status === "late" && <span className="bg-amber-900/50 text-amber-300 border border-amber-700 px-2 py-1 rounded-full text-[10px] font-bold">Late</span>}
                        {log.status === "on_time" && <span className="bg-emerald-900/50 text-emerald-300 border border-emerald-700 px-2 py-1 rounded-full text-[10px] font-bold">On Time</span>}
                        {log.status === "completed" && <span className="bg-white/10 text-white border border-white/20 px-2 py-1 rounded-full text-[10px] font-bold">Completed</span>}
                      </td>
                    </tr>
                  ))}
                  {todayLogs.logs.length === 0 && (
                    <tr><td colSpan={5} className="p-8 text-center text-stone-500">No attendance today yet. Staff will appear here when they scan fingerprint.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {todayLogs.absent.length > 0 && (
              <div className="p-4 bg-rose-950/20 border-t border-rose-900/30">
                <p className="text-xs font-bold text-rose-300 mb-2">Absent Today ({todayLogs.absent.length}):</p>
                <div className="flex flex-wrap gap-2">
                  {todayLogs.absent.map((a: any) => (
                    <span key={a.staffId} className="text-[11px] bg-rose-900/30 text-rose-200 px-2.5 py-1 rounded-full border border-rose-800">{a.staffName}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* PAPER SHEET VIEW - Like the photo you sent */}
      {activeView === "sheet" && (
        <div className="space-y-4">
          <div className="bg-[#2C1B17] p-4 rounded-2xl border border-[#C9A227]/30 flex flex-wrap gap-3 items-end print:hidden">
            <div>
              <label className="block text-[10px] font-bold text-amber-200 mb-1">From Date</label>
              <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="bg-[#3D2314] border border-stone-700 rounded-xl p-2.5 text-xs text-white" />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-amber-200 mb-1">To Date</label>
              <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="bg-[#3D2314] border border-stone-700 rounded-xl p-2.5 text-xs text-white" />
            </div>
            <button onClick={loadSheet} className="bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-black text-xs px-5 py-2.5 rounded-xl">Load Sheet</button>
            {sheetData && (
              <button onClick={() => window.print()} className="bg-[#3D2314] hover:bg-white/10 border border-[#C9A227]/40 text-amber-200 font-black text-xs px-5 py-2.5 rounded-xl flex items-center gap-2">
                <Printer className="w-4 h-4" /> Print Hard Copy
              </button>
            )}
            <p className="text-[11px] text-stone-400">Shows like your paper: Employee Name | Date | IN Time & Finger | OUT Time & Finger | Total Hours • Print button creates hard copy like normal paper.</p>
          </div>

          {sheetData && (
            <div id="attendance-print-area" className="bg-white text-black rounded-2xl overflow-hidden shadow-xl print:shadow-none print:rounded-none print:border print:border-black">
              <div className="p-4 bg-[#1C120F] text-white text-center border-b-4 border-[#C9A227]">
                <h2 className="font-serif font-black text-lg">FANA CAFÉ & RESTAURANT</h2>
                <p className="text-xs text-amber-200">Attendance Sheet - {fromDate} to {toDate}</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[11px] border-collapse">
                  <thead>
                    <tr className="bg-stone-100 border-b-2 border-black">
                      <th className="p-2 border border-black font-black">Employee Name</th>
                      {sheetData.dates.map((d: string) => (
                        <th key={d} colSpan={2} className="p-2 border border-black font-black text-center bg-amber-100">
                          {d}<br/><span className="text-[9px] font-normal">{new Date(d).toLocaleDateString('en-US', { weekday: 'short' })} Day</span>
                        </th>
                      ))}
                    </tr>
                    <tr className="bg-stone-50 border-b border-black">
                      <th className="p-2 border border-black"></th>
                      {sheetData.dates.map((d: string) => (
                        <>
                          <th key={`${d}-in`} className="p-1 border border-black text-[9px] text-center">IN (TIME & SGN.)</th>
                          <th key={`${d}-out`} className="p-1 border border-black text-[9px] text-center">OUT (TIME & SGN.)</th>
                        </>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sheetData.staffList.map((s: any) => (
                      <tr key={s.id} className="border-b border-black hover:bg-amber-50">
                        <td className="p-2 border border-black font-bold whitespace-nowrap">{s.name}</td>
                        {sheetData.dates.map((d: string) => {
                          const log = sheetData.matrix[s.id]?.[d];
                          return (
                            <>
                              <td key={`${s.id}-${d}-in`} className="p-1 border border-black text-center font-mono text-[10px]">
                                {log?.clockInTime ? (
                                  <div>
                                    <div className="font-bold">{log.clockInTime}</div>
                                    <div className="text-[8px] text-stone-600">ID {log.fingerprintId || 'PIN'}</div>
                                    {log.lateMinutes > 0 && <div className="text-[8px] text-rose-600">Late {log.lateMinutes}m</div>}
                                  </div>
                                ) : <span className="text-stone-400">-</span>}
                              </td>
                              <td key={`${s.id}-${d}-out`} className="p-1 border border-black text-center font-mono text-[10px]">
                                {log?.clockOutTime ? (
                                  <div>
                                    <div className="font-bold">{log.clockOutTime}</div>
                                    <div className="text-[8px] text-emerald-700">{log.totalHours}</div>
                                  </div>
                                ) : log?.clockInTime ? (
                                  <span className="text-[8px] bg-amber-200 px-1 rounded">Still In</span>
                                ) : <span className="text-stone-400">-</span>}
                              </td>
                            </>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="p-3 bg-stone-100 text-[10px] text-stone-600 text-center">
                Digital signature = Fingerprint scan (ID verified) • Late calculated automatically • Total hours = OUT - IN
              </div>
            </div>
          )}
        </div>
      )}

      {/* STAFF FINGERPRINTS */}
      {activeView === "staff" && (
        <div className="space-y-4">
          <div className="bg-[#2C1B17] p-5 rounded-2xl border border-[#C9A227]/30">
            <h3 className="text-sm font-bold text-amber-200 mb-3">Enroll New Fingerprint (FPC1020A)</h3>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <select value={enrollStaffId} onChange={e => setEnrollStaffId(e.target.value ? Number(e.target.value) : "")} className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white">
                <option value="">Select Staff</option>
                {staff.map(s => <option key={s.id} value={s.id}>{s.name} ({s.role}) - {bioByStaff.get(s.id)?.length || 0}/5 fingers</option>)}
              </select>
              <input value={enrollFingerId} onChange={e => setEnrollFingerId(e.target.value)} placeholder="Fingerprint ID (1-1000) - from device" type="number" className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white" />
              <select value={enrollFingerName} onChange={e => setEnrollFingerName(e.target.value)} className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white">
                <option>Right Index</option><option>Right Middle</option><option>Right Thumb</option><option>Left Index</option><option>Left Middle</option><option>Left Thumb</option>
              </select>
              <button onClick={handleEnroll} className="bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-black text-xs uppercase rounded-xl flex items-center justify-center gap-2">
                <Plus className="w-4 h-4" /> Enroll
              </button>
            </div>
            {msg && <p className="mt-3 text-xs font-bold text-emerald-400">{msg}</p>}
            <p className="mt-3 text-[11px] text-stone-400">Steps: 1) On ESP32 device, enroll finger with ID (e.g., ID 12) via Serial/OLED, 2) Come here, select staff, enter same ID 12, click Enroll - links fingerprint to staff.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {staff.map(s => {
              const bios = bioByStaff.get(s.id) || [];
              return (
                <div key={s.id} className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className="font-bold text-white text-sm">{s.name}</p>
                      <p className="text-[10px] text-stone-400 uppercase">{s.role} • {bios.length}/5 fingers</p>
                    </div>
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center ${bios.length > 0 ? "bg-emerald-900 text-emerald-300" : "bg-stone-800 text-stone-500"}`}>
                      <Fingerprint className="w-4 h-4" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    {bios.map(b => (
                      <div key={b.id} className="flex items-center justify-between bg-[#3D2314] rounded-xl p-2.5">
                        <div>
                          <p className="text-xs font-bold text-amber-100">ID {b.fingerprintId} - {b.fingerName}</p>
                          <p className="text-[10px] text-stone-500">{new Date(b.enrolledAt).toLocaleDateString()}</p>
                        </div>
                        <button onClick={() => handleDeleteBio(b.id)} className="p-1.5 bg-rose-500/20 text-rose-300 hover:bg-rose-500 hover:text-white rounded-lg">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                    {bios.length === 0 && <p className="text-[11px] text-stone-500 text-center py-3">No fingerprints enrolled</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* SHIFTS */}
      {activeView === "shifts" && (
        <div className="space-y-4">
          <div className="bg-[#2C1B17] p-5 rounded-2xl border border-[#C9A227]/30">
            <h3 className="text-sm font-bold text-amber-200 mb-3">Add Shift</h3>
            <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
              <input value={shiftName} onChange={e => setShiftName(e.target.value)} placeholder="Morning" className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white" />
              <input value={shiftStart} onChange={e => setShiftStart(e.target.value)} type="time" className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white" />
              <input value={shiftEnd} onChange={e => setShiftEnd(e.target.value)} type="time" className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white" />
              <input value={shiftGrace} onChange={e => setShiftGrace(e.target.value)} placeholder="Grace min" type="number" className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white" />
              <button onClick={handleAddShift} className="bg-[#C9A227] text-[#2C1B17] font-black text-xs uppercase rounded-xl">Add Shift</button>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {shifts.map(sh => (
              <div key={sh.id} className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-4 flex items-center justify-between">
                <div>
                  <p className="font-bold text-white">{sh.name}</p>
                  <p className="text-xs text-stone-400">{sh.startTime} - {sh.endTime} (Grace {sh.graceMinutes}m)</p>
                </div>
                <button onClick={() => handleDeleteShift(sh.id)} className="p-2 bg-rose-500/20 text-rose-300 rounded-lg">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Print styles for hard copy like paper sheet */}
      <style jsx global>{`
        @media print {
          body * {
            visibility: hidden;
          }
          #attendance-print-area,
          #attendance-print-area * {
            visibility: visible;
          }
          #attendance-print-area {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            background: white !important;
            color: black !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          @page {
            size: landscape;
            margin: 10mm;
          }
        }
      `}</style>
    </div>
  );
}
