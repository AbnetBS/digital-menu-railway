"use client";

import { useState, useEffect, useRef } from "react";
import { Clock, Fingerprint, CheckCircle2, AlertCircle, Users, Wifi, Battery } from "lucide-react";

interface TodayData {
  date: string;
  logs: Array<{
    id: number;
    staffId: number;
    staffName: string;
    staffRole: string;
    date: string;
    clockIn: string | null;
    clockOut: string | null;
    clockInTime: string | null;
    clockOutTime: string | null;
    totalHours: string | null;
    lateMinutes: number;
    status: string;
    fingerprintId: number | null;
  }>;
  absent: Array<any>;
  stats: {
    present: number;
    completed: number;
    stillIn: number;
    late: number;
    absent: number;
    totalStaff: number;
  };
}

export default function AttendanceKiosk() {
  const [todayData, setTodayData] = useState<TodayData | null>(null);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [lastScan, setLastScan] = useState<any>(null);
  const [scanStatus, setScanStatus] = useState<"idle" | "success" | "error">("idle");
  const [pinInput, setPinInput] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [deviceStatus, setDeviceStatus] = useState({ wifi: true, battery: 98 });
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchToday = async () => {
    try {
      const r = await fetch("/api/attendance/today");
      if (r.ok) {
        const data = await r.json();
        setTodayData(data);
      }
    } catch {}
  };

  useEffect(() => {
    fetchToday();
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    const poll = setInterval(fetchToday, 8000);
    
    // Try to get ESP32 local status if on same network
    const checkDevice = async () => {
      try {
        // Try common ESP32 IPs
        const ips = ["192.168.1.50", "192.168.1.100", "192.168.0.50"];
        for (const ip of ips) {
          try {
            const r = await fetch(`http://${ip}/status`, { signal: AbortSignal.timeout(1000) });
            if (r.ok) {
              const d = await r.json();
              setDeviceStatus({ wifi: true, battery: d.battery || 98 });
              break;
            }
          } catch {}
        }
      } catch {}
    };
    checkDevice();
    
    return () => {
      clearInterval(timer);
      clearInterval(poll);
    };
  }, []);

  const handlePinClock = async () => {
    if (!pinInput) return;
    
    // Find staff by PIN - we need to get staff list and try to match
    // For now, try to find staff by PIN via API
    try {
      const staffRes = await fetch("/api/staff?public=1");
      const staffList = await staffRes.json();
      
      // We need to verify PIN via staff login API
      // Try each staff? Better to have dedicated endpoint
      // For now, try clock with PIN method - server will need staffId
      // We'll attempt to login first to get staffId
      
      // Simple: try to call clock with staffId from PIN input if it's numeric ID
      // Or we can have a PIN lookup endpoint
      const r = await fetch("/api/attendance/clock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "pin",
          staffId: Number(pinInput), // For now assume PIN input is staff ID, will improve
          deviceId: "tablet_kiosk",
        }),
      });
      
      const d = await r.json();
      if (r.ok) {
        setLastScan(d);
        setScanStatus("success");
        setPinInput("");
        fetchToday();
        setTimeout(() => setScanStatus("idle"), 4000);
      } else {
        setLastScan(d);
        setScanStatus("error");
        setTimeout(() => setScanStatus("idle"), 3000);
      }
    } catch (e) {
      setLastScan({ error: String(e) });
      setScanStatus("error");
    }
  };

  const handleManualFingerprint = async (fingerprintId: number) => {
    // For testing without hardware - simulate fingerprint scan
    try {
      const r = await fetch("/api/attendance/clock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fingerprintId,
          deviceId: "tablet_kiosk_test",
          method: "fingerprint",
        }),
      });
      const d = await r.json();
      setLastScan(d);
      setScanStatus(r.ok ? "success" : "error");
      fetchToday();
      setTimeout(() => setScanStatus("idle"), 4000);
    } catch (e) {
      setLastScan({ error: String(e) });
      setScanStatus("error");
    }
  };

  return (
    <div className="min-h-screen bg-[#0F0A08] text-white flex flex-col">
      {/* Header */}
      <div className="bg-[#1C120F] border-b border-[#C9A227]/30 p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#C9A227] flex items-center justify-center">
            <Fingerprint className="w-6 h-6 text-[#2C1B17]" />
          </div>
          <div>
            <h1 className="font-serif font-black text-xl text-amber-100">FANA CAFÉ - Attendance</h1>
            <p className="text-xs text-amber-200/70">FPC1020A + ESP32 WROOM - Tap fingerprint to clock IN/OUT</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-xs">
            <Wifi className={`w-4 h-4 ${deviceStatus.wifi ? "text-emerald-400" : "text-rose-400"}`} />
            <span className={deviceStatus.wifi ? "text-emerald-300" : "text-rose-300"}>{deviceStatus.wifi ? "Online" : "Offline"}</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <Battery className="w-4 h-4 text-amber-300" />
            <span className="text-amber-200">{deviceStatus.battery}%</span>
          </div>
          <a href="/admin" className="text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-xl">Admin</a>
        </div>
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-4 p-4 max-w-7xl mx-auto w-full">
        {/* Left - Clock and Last Scan */}
        <div className="lg:col-span-1 space-y-4">
          {/* Big Clock */}
          <div className="bg-[#1C120F] rounded-3xl border-2 border-[#C9A227]/50 p-6 text-center shadow-2xl">
            <p className="text-5xl font-mono font-black text-white tracking-wider">
              {currentTime.toLocaleTimeString('en-US', { hour12: false })}
            </p>
            <p className="text-sm text-amber-200/70 mt-2">
              {currentTime.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
            </p>
            <p className="text-xs text-stone-500 mt-1">Africa/Addis_Ababa (EAT)</p>
            
            <div className="mt-6 p-4 bg-black/30 rounded-2xl border border-[#C9A227]/20">
              <Fingerprint className="w-12 h-12 mx-auto text-[#C9A227] mb-3 animate-pulse" />
              <p className="text-sm font-bold text-amber-100">Place finger on FPC1020A</p>
              <p className="text-[11px] text-stone-400 mt-1">Device will beep + green light on success</p>
            </div>
          </div>

          {/* Last Scan Result */}
          {lastScan && (
            <div className={`rounded-3xl border-2 p-5 text-center transition-all duration-500 ${scanStatus === "success" ? "bg-emerald-950/50 border-emerald-500/50" : scanStatus === "error" ? "bg-rose-950/50 border-rose-500/50" : "bg-[#1C120F] border-stone-800"}`}>
              {scanStatus === "success" ? (
                <>
                  <CheckCircle2 className="w-10 h-10 mx-auto text-emerald-400 mb-2" />
                  <p className="font-black text-lg text-white">{lastScan.staffName}</p>
                  <p className="text-sm text-emerald-300 font-mono">{lastScan.action === "clock_in" ? `IN ${lastScan.clockIn ? new Date(lastScan.clockIn).toLocaleTimeString() : ""}` : `OUT ${lastScan.clockOut ? new Date(lastScan.clockOut).toLocaleTimeString() : ""}`}</p>
                  {lastScan.lateMinutes > 0 && <p className="text-xs bg-amber-900/50 text-amber-300 px-2 py-1 rounded-full mt-2 inline-block">Late {lastScan.lateMinutes}m</p>}
                  {lastScan.totalHours && <p className="text-xs text-[#C9A227] mt-1 font-bold">Worked {lastScan.totalHours}</p>}
                </>
              ) : (
                <>
                  <AlertCircle className="w-10 h-10 mx-auto text-rose-400 mb-2" />
                  <p className="font-bold text-rose-200">{lastScan.error || "Not found"}</p>
                  <p className="text-xs text-stone-400 mt-1">Try again, clean finger</p>
                </>
              )}
            </div>
          )}

          {/* PIN Fallback */}
          <div className="bg-[#1C120F] rounded-2xl border border-stone-800 p-4">
            <button onClick={() => setShowPin(!showPin)} className="w-full text-xs font-bold text-stone-300 hover:text-white flex items-center justify-center gap-2">
              <Users className="w-4 h-4" /> {showPin ? "Hide" : "PIN Fallback (if finger dirty)"}
            </button>
            {showPin && (
              <div className="mt-3 flex gap-2">
                <input
                  value={pinInput}
                  onChange={e => setPinInput(e.target.value)}
                  placeholder="Staff ID or PIN"
                  className="flex-1 bg-black/30 border border-stone-700 rounded-xl p-3 text-sm text-white"
                />
                <button onClick={handlePinClock} className="bg-[#C9A227] text-[#2C1B17] font-black text-xs px-4 rounded-xl">Clock</button>
              </div>
            )}
          </div>

          {/* Test buttons for demo without hardware */}
          <div className="bg-[#1C120F] rounded-2xl border border-dashed border-stone-700 p-3">
            <p className="text-[10px] text-stone-500 uppercase font-bold mb-2">Test without hardware (demo)</p>
            <div className="grid grid-cols-4 gap-2">
              {[1,2,3,4,5,6,7,8].map(id => (
                <button key={id} onClick={() => handleManualFingerprint(id)} className="bg-white/10 hover:bg-[#C9A227] hover:text-black text-white text-xs p-2 rounded-xl font-mono">
                  ID {id}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right - Live Today List */}
        <div className="lg:col-span-2 space-y-4">
          {todayData && (
            <>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                <div className="bg-[#1C120F] p-3 rounded-2xl border border-emerald-900/30 text-center">
                  <p className="text-[10px] text-stone-400 uppercase">Present</p>
                  <p className="text-xl font-black text-emerald-400">{todayData.stats.present}</p>
                </div>
                <div className="bg-[#1C120F] p-3 rounded-2xl border border-stone-800 text-center">
                  <p className="text-[10px] text-stone-400 uppercase">Done</p>
                  <p className="text-xl font-black text-white">{todayData.stats.completed}</p>
                </div>
                <div className="bg-[#1C120F] p-3 rounded-2xl border border-amber-900/30 text-center">
                  <p className="text-[10px] text-stone-400 uppercase">Still In</p>
                  <p className="text-xl font-black text-amber-300">{todayData.stats.stillIn}</p>
                </div>
                <div className="bg-[#1C120F] p-3 rounded-2xl border border-amber-900/30 text-center">
                  <p className="text-[10px] text-stone-400 uppercase">Late</p>
                  <p className="text-xl font-black text-amber-400">{todayData.stats.late}</p>
                </div>
                <div className="bg-[#1C120F] p-3 rounded-2xl border border-rose-900/30 text-center">
                  <p className="text-[10px] text-stone-400 uppercase">Absent</p>
                  <p className="text-xl font-black text-rose-400">{todayData.stats.absent}</p>
                </div>
              </div>

              <div className="bg-[#1C120F] rounded-3xl border border-[#C9A227]/30 overflow-hidden">
                <div className="p-4 border-b border-stone-800 flex items-center justify-between">
                  <h3 className="font-bold text-amber-100 flex items-center gap-2">
                    <Clock className="w-4 h-4" /> Today Live - {todayData.date}
                  </h3>
                  <span className="text-[10px] bg-emerald-900/30 text-emerald-300 px-2 py-1 rounded-full border border-emerald-800 animate-pulse">Live - Auto refresh 8s</span>
                </div>
                
                {/* Paper sheet style header */}
                <div className="bg-white text-black p-2 text-center border-b-2 border-black">
                  <p className="font-black text-sm">FANA CAFÉ & RESTAURANT</p>
                  <p className="text-[11px]">Attendance - {todayData.date} - {new Date(todayData.date).toLocaleDateString('en-US', { weekday: 'long' })} Day</p>
                </div>

                <div className="overflow-auto max-h-[60vh]">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#3D2314] text-amber-200 uppercase text-[10px] font-bold sticky top-0">
                      <tr>
                        <th className="p-3 border border-[#C9A227]/20">Employee Name</th>
                        <th className="p-3 border border-[#C9A227]/20 text-center">IN (TIME & SGN.)</th>
                        <th className="p-3 border border-[#C9A227]/20 text-center">OUT (TIME & SGN.)</th>
                        <th className="p-3 border border-[#C9A227]/20 text-center">Total Hours</th>
                        <th className="p-3 border border-[#C9A227]/20 text-center">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-800 bg-[#1C120F]">
                      {todayData.logs.map((log) => (
                        <tr key={log.id} className="hover:bg-white/5">
                          <td className="p-3 border border-stone-800 font-bold text-white">
                            {log.staffName}
                            <div className="text-[10px] text-stone-500 font-normal">{log.staffRole} • ID {log.fingerprintId || "PIN"}</div>
                          </td>
                          <td className="p-3 border border-stone-800 text-center">
                            <div className="font-mono font-bold text-emerald-300">{log.clockInTime || "-"}</div>
                            <div className="text-[9px] text-stone-500">FP ID {log.fingerprintId || "PIN"}</div>
                            {log.lateMinutes > 0 && <div className="text-[9px] bg-amber-900/50 text-amber-300 px-1 rounded mt-1 inline-block">Late {log.lateMinutes}m</div>}
                          </td>
                          <td className="p-3 border border-stone-800 text-center">
                            {log.clockOutTime ? (
                              <>
                                <div className="font-mono font-bold text-stone-300">{log.clockOutTime}</div>
                                <div className="text-[9px] text-stone-500">OUT</div>
                              </>
                            ) : (
                              <span className="text-[10px] bg-amber-900/30 text-amber-300 px-2 py-1 rounded-full">Still In</span>
                            )}
                          </td>
                          <td className="p-3 border border-stone-800 text-center font-mono font-black text-[#C9A227]">
                            {log.totalHours || "-"}
                          </td>
                          <td className="p-3 border border-stone-800 text-center">
                            {log.status === "late" && <span className="bg-amber-900/50 text-amber-300 border border-amber-700 px-2 py-1 rounded-full text-[10px] font-bold">Late</span>}
                            {log.status === "on_time" && <span className="bg-emerald-900/50 text-emerald-300 border border-emerald-700 px-2 py-1 rounded-full text-[10px] font-bold">On Time</span>}
                            {log.status === "completed" && <span className="bg-white/10 text-white border border-white/20 px-2 py-1 rounded-full text-[10px] font-bold">Completed</span>}
                          </td>
                        </tr>
                      ))}
                      {todayData.logs.length === 0 && (
                        <tr><td colSpan={5} className="p-12 text-center text-stone-500">No attendance yet today. Scan fingerprint on FPC1020A device.<br/>Green light + beep = success, Red = try again.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {todayData.absent.length > 0 && (
                  <div className="p-4 bg-rose-950/20 border-t border-rose-900/30">
                    <p className="text-xs font-bold text-rose-300 mb-2">Absent Today ({todayData.absent.length}):</p>
                    <div className="flex flex-wrap gap-2">
                      {todayData.absent.map((a: any) => (
                        <span key={a.staffId} className="text-[11px] bg-rose-900/30 text-rose-200 px-2.5 py-1 rounded-full border border-rose-800">{a.staffName}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="p-3 text-center text-[10px] text-stone-600 border-t border-stone-800">
        FPC1020A Fingerprint = Digital Signature • Green light + beep = verified • Red = error • Total Hours = OUT - IN • Late auto calculated
      </div>
    </div>
  );
}
