"use client";

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Calendar,
  Clock,
  Fingerprint,
  LogOut,
  Plus,
  Printer,
  RefreshCw,
  Settings,
  Timer,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useStaffT } from "@/lib/staff-i18n";

/**
 * ADMIN -> ATTENDANCE (owner, Oct 2026).
 *
 * The order of the buttons is the owner's: Today Live first, Open Kiosk last,
 * everything else in between. The Shifts tab is gone - the times live on the
 * roles now (Role & Time), which is what decides who is late.
 *
 * The people on this page are the ATTENDANCE list (Staff Members), not the
 * station logins: a cleaner or a chef clocks in with a finger and never logs in
 * anywhere, so he must be addable here without creating a login.
 */

type ViewKey = "today" | "roles" | "members" | "sheet" | "prints";

interface RoleShift {
  id?: number;
  label: string;
  startTime: string;
  endTime: string;
}

interface Role {
  id: number;
  name: string;
  shifts: RoleShift[];
}

interface Finger {
  id: number;
  fingerprintId: number;
  fingerName: string | null;
  enrolledAt: string | null;
}

interface Member {
  id: number;
  name: string;
  roleId: number | null;
  roleName: string;
  pinSet: boolean;
  active: boolean;
  fingers: Finger[];
}

interface EnrollJob {
  jobId: number;
  fingerprintId: number;
  status: "pending" | "done" | "cancelled";
}

/* The colours of the paper sheet, in one place: IN is green / yellow / red,
 * OUT is green / amber (still in) / blue (early out) / violet (overtime). */
const IN_STYLE: Record<string, string> = {
  on_time: "bg-emerald-200 text-emerald-950",
  late: "bg-amber-200 text-amber-950",
  absent: "bg-rose-200 text-rose-950",
};
const OUT_STYLE: Record<string, string> = {
  none: "bg-rose-200 text-rose-950",
  still_in: "bg-amber-100 text-amber-950",
  completed: "bg-emerald-100 text-emerald-950",
  early_out: "bg-sky-200 text-sky-950",
  overtime: "bg-violet-200 text-violet-950",
};

const LEGEND = [
  { label: "On time", className: "bg-emerald-200 text-emerald-950 border-emerald-500" },
  { label: "Late (15 min+)", className: "bg-amber-200 text-amber-950 border-amber-500" },
  { label: "Absent", className: "bg-rose-200 text-rose-950 border-rose-500" },
  { label: "Still in", className: "bg-amber-100 text-amber-950 border-amber-400" },
  { label: "Early out", className: "bg-sky-200 text-sky-950 border-sky-500" },
  { label: "Overtime", className: "bg-violet-200 text-violet-950 border-violet-500" },
];

const SHEET_MAX_DAYS = 7;

export default function AttendanceTab() {
  const { t: Lraw } = useStaffT();
  // The attendance words are not all in the hand-written dictionary yet, so a
  // missing key falls back to the English label instead of breaking the tab.
  const L = (s: string) => {
    try {
      return (Lraw as any)(s) || s;
    } catch {
      return s;
    }
  };

  const [activeView, setActiveView] = useState<ViewKey>("today");
  const [msg, setMsg] = useState("");
  const [msgBad, setMsgBad] = useState(false);

  const [roles, setRoles] = useState<Role[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [todayLogs, setTodayLogs] = useState<any>(null);
  const [sheetData, setSheetData] = useState<any>(null);

  // Sheet range: this week, at most 7 days.
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return d.toISOString().slice(0, 10);
  });
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));

  // Role form
  const [roleFormOpen, setRoleFormOpen] = useState(false);
  const [editingRoleId, setEditingRoleId] = useState<number | null>(null);
  const [roleName, setRoleName] = useState("");
  const [roleShifts, setRoleShifts] = useState<RoleShift[]>([
    { label: "Morning", startTime: "08:00", endTime: "14:00" },
    { label: "Afternoon", startTime: "14:00", endTime: "22:00" },
  ]);

  // Member form
  const [memberFormOpen, setMemberFormOpen] = useState(false);
  const [editingMemberId, setEditingMemberId] = useState<number | null>(null);
  const [memberName, setMemberName] = useState("");
  const [memberRoleId, setMemberRoleId] = useState<number | "">("");
  const [memberPin, setMemberPin] = useState("");

  // Enroll jobs, one per member being enrolled right now
  const [jobs, setJobs] = useState<Record<number, EnrollJob>>({});

  // Manual enroll (Staff Fingerprints tab)
  const [manualMemberId, setManualMemberId] = useState<number | "">("");
  const [manualFingerId, setManualFingerId] = useState("");
  const [manualFingerName, setManualFingerName] = useState("Right Index");

  const say = (text: string, bad = false) => {
    setMsg(text);
    setMsgBad(bad);
  };

  const loadRoles = useCallback(async () => {
    try {
      const r = await fetch("/api/attendance/roles");
      if (r.ok) setRoles(await r.json());
    } catch {
      /* the list simply stays as it was */
    }
  }, []);

  const loadMembers = useCallback(async () => {
    try {
      const r = await fetch("/api/attendance/members");
      if (r.ok) setMembers(await r.json());
    } catch {
      /* the list simply stays as it was */
    }
  }, []);

  const loadToday = useCallback(async () => {
    try {
      const r = await fetch("/api/attendance/today");
      if (r.ok) setTodayLogs(await r.json());
    } catch {
      /* the table simply stays as it was */
    }
  }, []);

  const loadSheet = useCallback(async () => {
    try {
      const r = await fetch(`/api/attendance/logs?from=${fromDate}&to=${toDate}`);
      if (r.ok) {
        setSheetData(await r.json());
      } else {
        const d = await r.json().catch(() => ({}));
        say(d.error || "Could not load the sheet", true);
      }
    } catch {
      say("Network error. Try again.", true);
    }
  }, [fromDate, toDate]);

  useEffect(() => {
    loadRoles();
    loadMembers();
    loadToday();
  }, [loadRoles, loadMembers, loadToday]);

  // Today Live refreshes in real time: the server pushes the moment a scan
  // is clocked in/out (SSE), so there is no polling. Falls back to the old
  // 8-second refresh if the stream cannot be opened.
  useEffect(() => {
    if (activeView !== "today") return;
    let es: EventSource | null = null;
    let t: ReturnType<typeof setInterval> | null = null;
    if (typeof EventSource !== "undefined") {
      es = new EventSource("/api/realtime?channel=attendance");
      es.onmessage = () => loadToday();
      es.onerror = () => {
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          es = null;
          t = setInterval(loadToday, 8000);
        }
        // otherwise EventSource reconnects by itself
      };
    } else {
      t = setInterval(loadToday, 8000);
    }
    return () => {
      if (es) es.close();
      if (t) clearInterval(t);
    };
  }, [activeView, loadToday]);

  useEffect(() => {
    if (activeView === "sheet") loadSheet();
  }, [activeView, loadSheet]);

  /* ── the "place your finger" jobs: real time, no polling ─────────────── */
  const pendingIds = Object.entries(jobs)
    .filter(([, j]) => j.status === "pending")
    .map(([memberId]) => Number(memberId));

  // The refresh reads the jobs through a ref: the effect itself only depends
  // on WHICH people are waiting, so an unchanged answer never re-arms it.
  const jobsRef = useRef<Record<number, EnrollJob>>({});
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  useEffect(() => {
    if (pendingIds.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      for (const memberId of pendingIds) {
        const job = jobsRef.current[memberId];
        if (!job || job.status !== "pending") continue;
        try {
          const r = await fetch(`/api/attendance/biometrics?job=${job.jobId}`);
          if (!r.ok) continue;
          const d = await r.json();
          if (cancelled || d.job.status === job.status) continue;
          setJobs((prev) => ({ ...prev, [memberId]: { ...job, status: d.job.status } }));
          if (d.job.status === "done") {
            say(`Fingerprint Added ✓ ${d.job.memberName || ""}`);
            loadMembers();
          }
        } catch {
          /* keep waiting: the device may simply be offline for a moment */
        }
      }
    };
    tick();
    // Real time: the device channel fires when a fingerprint mapping lands
    // (the ESP32 finished enrolling), so "Fingerprint Added ✓" is instant.
    // Falls back to the old 2-second poll if the stream cannot be opened.
    let es: EventSource | null = null;
    let t: ReturnType<typeof setInterval> | null = null;
    if (typeof EventSource !== "undefined") {
      es = new EventSource("/api/realtime?channel=device");
      es.onmessage = () => {
        tick();
      };
      es.onerror = () => {
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          es = null;
          t = setInterval(tick, 2000);
        }
        // otherwise EventSource reconnects by itself
      };
    } else {
      t = setInterval(tick, 2000);
    }
    return () => {
      cancelled = true;
      if (es) es.close();
      if (t) clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(pendingIds), loadMembers]);

  /* ── roles ────────────────────────────────────────────────────────────── */
  const openRoleForm = (role?: Role) => {
    setEditingRoleId(role?.id ?? null);
    setRoleName(role?.name ?? "");
    setRoleShifts(
      role && role.shifts.length > 0
        ? role.shifts.map((s) => ({ label: s.label, startTime: s.startTime, endTime: s.endTime }))
        : [
            { label: "Morning", startTime: "08:00", endTime: "14:00" },
            { label: "Afternoon", startTime: "14:00", endTime: "22:00" },
          ]
    );
    setRoleFormOpen(true);
    say("");
  };

  const saveRole = async () => {
    if (!roleName.trim()) {
      say("Type the role name first", true);
      return;
    }
    try {
      const r = await fetch("/api/attendance/roles", {
        method: editingRoleId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingRoleId ?? undefined,
          name: roleName.trim(),
          shifts: roleShifts,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        say(d.error || "Could not save the role", true);
        return;
      }
      say(editingRoleId ? "Role saved" : `Role ${roleName.trim()} added`);
      setRoleFormOpen(false);
      setEditingRoleId(null);
      loadRoles();
    } catch {
      say("Network error. Try again.", true);
    }
  };

  const deleteRole = async (id: number, name: string) => {
    if (!confirm(`Delete the role ${name}? The people who have it keep their history.`)) return;
    try {
      const r = await fetch(`/api/attendance/roles?id=${id}`, { method: "DELETE" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        say(d.error || "Could not delete the role", true);
        return;
      }
      say("Role deleted");
      loadRoles();
    } catch {
      say("Network error. Try again.", true);
    }
  };

  /* ── members ──────────────────────────────────────────────────────────── */
  const openMemberForm = (member?: Member) => {
    setEditingMemberId(member?.id ?? null);
    setMemberName(member?.name ?? "");
    setMemberRoleId(member?.roleId ?? "");
    setMemberPin("");
    setMemberFormOpen(true);
    say("");
  };

  /** Save the form and give back the member id (used by Add Fingerprint). */
  const saveMember = async (): Promise<number | null> => {
    if (!memberName.trim()) {
      say("Type the name first", true);
      return null;
    }
    try {
      const r = await fetch("/api/attendance/members", {
        method: editingMemberId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingMemberId ?? undefined,
          name: memberName.trim(),
          roleId: memberRoleId || null,
          pin: memberPin || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        say(d.error || "Could not save the member", true);
        return null;
      }
      const id = Number(editingMemberId ?? d.id);
      say(d.message || "Member saved");
      setMemberPin("");
      setEditingMemberId(id);
      loadMembers();
      return id;
    } catch {
      say("Network error. Try again.", true);
      return null;
    }
  };

  const doneMember = async () => {
    const id = await saveMember();
    if (id) {
      setMemberFormOpen(false);
      setEditingMemberId(null);
      setMemberName("");
      setMemberRoleId("");
      setMemberPin("");
    }
  };

  const deleteMember = async (id: number, name: string) => {
    if (!confirm(`Remove ${name} from the attendance list? The fingerprints go with him.`)) return;
    try {
      const r = await fetch(`/api/attendance/members?id=${id}`, { method: "DELETE" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        say(d.error || "Could not remove the member", true);
        return;
      }
      say("Member removed");
      loadMembers();
    } catch {
      say("Network error. Try again.", true);
    }
  };

  /**
   * Add Fingerprint: the server opens a pending job, the ESP32 picks it up on
   * its 2 second poll and shows the name on its OLED, the person places his
   * finger, the device posts the mapping back and this card turns into
   * "Fingerprint Added ✓".
   */
  const startEnroll = async (memberId?: number | null) => {
    let id = memberId ?? null;
    if (!id) id = await saveMember();
    if (!id) return;
    try {
      const r = await fetch("/api/attendance/biometrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "enroll", memberId: id }),
      });
      const d = await r.json();
      if (!r.ok) {
        say(d.error || "Could not start the enrollment", true);
        return;
      }
      setJobs((prev) => ({
        ...prev,
        [id as number]: { jobId: d.job.id, fingerprintId: d.job.fingerprintId, status: "pending" },
      }));
      say(`${d.message} • the device shows his name now`);
    } catch {
      say("Network error. Try again.", true);
    }
  };

  const cancelEnroll = async (memberId: number) => {
    const job = jobs[memberId];
    if (!job) return;
    try {
      const r = await fetch("/api/attendance/biometrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", jobId: job.jobId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        say(d.error || "Could not cancel the enrollment", true);
        return;
      }
      setJobs((prev) => {
        const next = { ...prev };
        delete next[memberId];
        return next;
      });
      say("Enrollment cancelled");
    } catch {
      say("Network error. Try again.", true);
    }
  };

  const enrollManual = async () => {
    if (!manualMemberId || !manualFingerId) {
      say("Pick the person and type the fingerprint ID", true);
      return;
    }
    try {
      const r = await fetch("/api/attendance/biometrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberId: Number(manualMemberId),
          fingerprintId: Number(manualFingerId),
          fingerName: manualFingerName,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        say(d.error || "Could not add the fingerprint", true);
        return;
      }
      say(`✓ ${d.message}`);
      setManualFingerId("");
      loadMembers();
    } catch {
      say("Network error. Try again.", true);
    }
  };

  const deleteFinger = async (id: number) => {
    if (!confirm("Delete this fingerprint? He will need to enroll again on the device.")) return;
    try {
      const r = await fetch(`/api/attendance/biometrics?id=${id}`, { method: "DELETE" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        say(d.error || "Could not delete the fingerprint", true);
        return;
      }
      say("Fingerprint deleted");
      loadMembers();
    } catch {
      say("Network error. Try again.", true);
    }
  };

  /* ── the sheet range never grows past a week ──────────────────────────── */
  const setFromCapped = (value: string) => {
    setFromDate(value);
    const to = new Date(toDate);
    const from = new Date(value);
    const days = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
    if (days > SHEET_MAX_DAYS) {
      const cut = new Date(from);
      cut.setDate(cut.getDate() + SHEET_MAX_DAYS - 1);
      setToDate(cut.toISOString().slice(0, 10));
      say(`A sheet prints ${SHEET_MAX_DAYS} days at most: the To Date moved to ${cut.toISOString().slice(0, 10)}`);
    }
  };
  const setToCapped = (value: string) => {
    setToDate(value);
    const from = new Date(fromDate);
    const to = new Date(value);
    const days = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
    if (days > SHEET_MAX_DAYS) {
      const cut = new Date(to);
      cut.setDate(cut.getDate() - (SHEET_MAX_DAYS - 1));
      setFromDate(cut.toISOString().slice(0, 10));
      say(`A sheet prints ${SHEET_MAX_DAYS} days at most: the From Date moved to ${cut.toISOString().slice(0, 10)}`);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-serif font-bold text-amber-100 flex items-center gap-2">
          <Fingerprint className="w-5 h-5 text-[#C9A227]" /> {L("Attendance System")}
        </h2>
        <button
          onClick={() => {
            loadToday();
            loadRoles();
            loadMembers();
            say("");
          }}
          className="p-2 bg-white/10 hover:bg-white/20 text-amber-200 rounded-xl"
          aria-label={L("Refresh")}
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* View switcher: Today Live first, Open Kiosk last */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        {(
          [
            { key: "today", label: "Today Live", icon: <Clock className="w-4 h-4" /> },
            { key: "roles", label: "Role & Time", icon: <Timer className="w-4 h-4" /> },
            { key: "members", label: "Staff Members", icon: <Users className="w-4 h-4" /> },
            { key: "sheet", label: "Paper Sheet View", icon: <Calendar className="w-4 h-4" /> },
            { key: "prints", label: "Staff Fingerprints", icon: <Fingerprint className="w-4 h-4" /> },
          ] as Array<{ key: ViewKey; label: string; icon: ReactNode }>
        ).map((v) => (
          <button
            key={v.key}
            onClick={() => setActiveView(v.key)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold whitespace-nowrap transition ${
              activeView === v.key ? "bg-[#C9A227] text-[#2C1B17]" : "bg-[#2C1B17] text-stone-300 hover:bg-white/10"
            }`}
          >
            {v.icon} {L(v.label)}
          </button>
        ))}
        <a
          href="/attendance"
          target="_blank"
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold bg-emerald-800 hover:bg-emerald-700 text-white whitespace-nowrap"
        >
          <Clock className="w-4 h-4" /> {L("Open Kiosk /attendance")}
        </a>
      </div>

      {msg && (
        <div
          className={`text-xs font-bold px-4 py-3 rounded-xl border ${
            msgBad
              ? "bg-rose-950/40 text-rose-200 border-rose-800"
              : "bg-emerald-950/40 text-emerald-200 border-emerald-800"
          }`}
        >
          {msg}
        </div>
      )}

      {/* ── TODAY LIVE ─────────────────────────────────────────────────── */}
      {activeView === "today" && (
        <div className="space-y-4">
          {todayLogs && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div className="bg-[#2C1B17] p-4 rounded-2xl border border-[#C9A227]/30">
                <p className="text-[10px] text-stone-400 uppercase font-bold">Present Today</p>
                <p className="text-2xl font-black text-emerald-400">{todayLogs.stats.present}</p>
              </div>
              <div className="bg-[#2C1B17] p-4 rounded-2xl border border-stone-800">
                <p className="text-[10px] text-stone-400 uppercase font-bold">Done</p>
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
              <div className="bg-[#2C1B17] p-4 rounded-2xl border border-violet-900/50">
                <p className="text-[10px] text-stone-400 uppercase font-bold">Overtime</p>
                <p className="text-2xl font-black text-violet-300">{todayLogs.stats.overtime}</p>
              </div>
            </div>
          )}

          <div className="bg-[#2C1B17] rounded-2xl border border-[#C9A227]/30 overflow-hidden">
            <div className="p-4 border-b border-stone-800 flex items-center justify-between">
              <h3 className="font-bold text-amber-100">Today {todayLogs ? `- ${todayLogs.date} -` : ""} Live</h3>
              <span className="text-[10px] bg-emerald-900/50 text-emerald-300 px-2 py-1 rounded-full border border-emerald-700">
                Auto refresh every 8 sec
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-[#3D2314] text-amber-200 uppercase text-[11px] font-black">
                  <tr>
                    <th className="p-3">Employee Name</th>
                    <th className="p-3">IN (Time & Finger)</th>
                    <th className="p-3">OUT (Time & Finger)</th>
                    <th className="p-3">Total Hours</th>
                    <th className="p-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-800">
                  {(todayLogs?.logs ?? []).map((log: any) => (
                    <tr key={log.id} className="hover:bg-white/5">
                      <td className="p-3 font-bold text-white">
                        {log.memberName} <span className="text-[11px] text-stone-500">({log.roleName})</span>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <Clock className="w-3 h-3 text-emerald-400" />
                          <span className="font-mono text-emerald-300 font-bold">{log.clockInTime || "-"}</span>
                          {log.fingerprintId ? (
                            <span className="text-[10px] bg-[#3D2314] px-1.5 py-0.5 rounded">ID {log.fingerprintId}</span>
                          ) : (
                            <span className="text-[10px] bg-[#3D2314] px-1.5 py-0.5 rounded">PIN</span>
                          )}
                        </div>
                        {log.lateMinutes > 0 && (
                          <p className="text-[11px] text-amber-400 mt-1 font-bold">Late {log.lateMinutes}m</p>
                        )}
                      </td>
                      <td className="p-3">
                        {log.clockOutTime ? (
                          <div className="flex items-center gap-2">
                            <LogOut className="w-3 h-3 text-stone-400" />
                            <span className="font-mono text-stone-300 font-bold">{log.clockOutTime}</span>
                          </div>
                        ) : (
                          <span className="text-[10px] bg-amber-900/30 text-amber-300 px-2 py-1 rounded-full">Still In</span>
                        )}
                      </td>
                      <td className="p-3 font-mono font-black text-[#C9A227]">{log.totalHours || "-"}</td>
                      <td className="p-3">
                        <div className="flex flex-wrap gap-1.5">
                          {log.status === "late" && (
                            <span className="bg-amber-900/50 text-amber-300 border border-amber-700 px-2 py-1 rounded-full text-[10px] font-bold">
                              Late
                            </span>
                          )}
                          {(log.status === "on_time" || (!log.clockOut && log.status !== "late")) && (
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
                  {(!todayLogs || todayLogs.logs.length === 0) && (
                    <tr>
                      <td colSpan={5} className="p-8 text-center text-stone-500">
                        No attendance today yet. People appear here the moment they scan on the device.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── ROLE & TIME ────────────────────────────────────────────────── */}
      {activeView === "roles" && (
        <div className="space-y-4">
          {!roleFormOpen && (
            <button
              onClick={() => openRoleForm()}
              className="bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-black text-xs uppercase rounded-xl px-5 py-3 flex items-center gap-2"
            >
              <Plus className="w-4 h-4" /> Add Role
            </button>
          )}

          {roleFormOpen && (
            <div className="bg-[#2C1B17] p-5 rounded-2xl border border-[#C9A227]/30 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-amber-200">
                  {editingRoleId ? "Edit Role" : "Add Role"}
                </h3>
                <button
                  onClick={() => {
                    setRoleFormOpen(false);
                    setEditingRoleId(null);
                  }}
                  className="p-1.5 text-stone-400 hover:text-white rounded-lg"
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-amber-200 mb-1">Role Name</label>
                <input
                  value={roleName}
                  onChange={(e) => setRoleName(e.target.value)}
                  placeholder="Cleaner, Chef, Waiter, Manager ..."
                  className="w-full sm:w-80 bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-sm text-white"
                />
              </div>

              <div className="space-y-3">
                {roleShifts.map((s, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-3">
                    <div>
                      <label className="block text-[11px] font-bold text-amber-200 mb-1">Shift</label>
                      <input
                        value={s.label}
                        onChange={(e) =>
                          setRoleShifts(roleShifts.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                        }
                        placeholder="Morning"
                        className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-sm text-white w-40"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold text-amber-200 mb-1">Time of Entrance</label>
                      <input
                        type="time"
                        value={s.startTime}
                        onChange={(e) =>
                          setRoleShifts(roleShifts.map((x, j) => (j === i ? { ...x, startTime: e.target.value } : x)))
                        }
                        className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-sm text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold text-amber-200 mb-1">Time Out</label>
                      <input
                        type="time"
                        value={s.endTime}
                        onChange={(e) =>
                          setRoleShifts(roleShifts.map((x, j) => (j === i ? { ...x, endTime: e.target.value } : x)))
                        }
                        className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-sm text-white"
                      />
                    </div>
                    {roleShifts.length > 1 && (
                      <button
                        onClick={() => setRoleShifts(roleShifts.filter((_, j) => j !== i))}
                        className="p-3 bg-rose-500/20 text-rose-300 hover:bg-rose-500 hover:text-white rounded-xl"
                        aria-label="Remove this shift"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
                <button
                  onClick={() => setRoleShifts([...roleShifts, { label: "", startTime: "08:00", endTime: "17:00" }])}
                  className="text-xs font-bold text-amber-200 hover:text-white flex items-center gap-2"
                >
                  <Plus className="w-4 h-4" /> Add another shift
                </button>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={saveRole}
                  className="bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-black text-xs uppercase rounded-xl px-6 py-3"
                >
                  Done
                </button>
                <button
                  onClick={() => {
                    setRoleFormOpen(false);
                    setEditingRoleId(null);
                  }}
                  className="bg-[#3D2314] hover:bg-white/10 text-stone-300 font-bold text-xs uppercase rounded-xl px-6 py-3"
                >
                  {L("Cancel")}
                </button>
              </div>
              <p className="text-[11px] text-stone-400">
                Late is 15 minutes after the time of entrance of the role. A person is an early out when he leaves
                before the time out.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {roles.map((role) => (
              <div key={role.id} className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-bold text-white">{role.name}</p>
                    <p className="text-[10px] text-stone-500 uppercase">
                      {role.shifts.length} shift{role.shifts.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => openRoleForm(role)}
                      className="p-2 bg-white/10 text-amber-200 hover:bg-white/20 rounded-lg"
                      aria-label={`Edit ${role.name}`}
                    >
                      <Settings className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => deleteRole(role.id, role.name)}
                      className="p-2 bg-rose-500/20 text-rose-300 hover:bg-rose-500 hover:text-white rounded-lg"
                      aria-label={`Delete ${role.name}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <div className="space-y-2">
                  {role.shifts.map((s, i) => (
                    <div key={i} className="flex items-center justify-between bg-[#3D2314] rounded-xl px-3 py-2">
                      <span className="text-xs font-bold text-amber-100">{s.label || "Shift"}</span>
                      <span className="text-xs font-mono font-bold text-white">
                        {s.startTime} <span className="text-stone-500">→</span> {s.endTime}
                      </span>
                    </div>
                  ))}
                  {role.shifts.length === 0 && (
                    <p className="text-[11px] text-stone-500 text-center py-2">No times yet</p>
                  )}
                </div>
              </div>
            ))}
            {roles.length === 0 && !roleFormOpen && (
              <p className="text-xs text-stone-500">
                No roles yet. Add Cleaner, Chef, Waiter ... with the time of entrance and the time out of each.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── STAFF MEMBERS (the attendance listing) ─────────────────────── */}
      {activeView === "members" && (
        <div className="space-y-4">
          {!memberFormOpen && (
            <button
              onClick={() => openMemberForm()}
              className="bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-black text-xs uppercase rounded-xl px-5 py-3 flex items-center gap-2"
            >
              <UserPlus className="w-4 h-4" /> Add Member
            </button>
          )}

          {memberFormOpen && (
            <div className="bg-[#2C1B17] p-5 rounded-2xl border border-[#C9A227]/30 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-amber-200">
                  {editingMemberId ? "Edit Member" : "Add Member"}
                </h3>
                <button
                  onClick={() => {
                    setMemberFormOpen(false);
                    setEditingMemberId(null);
                  }}
                  className="p-1.5 text-stone-400 hover:text-white rounded-lg"
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] font-bold text-amber-200 mb-1">Name</label>
                  <input
                    value={memberName}
                    onChange={(e) => setMemberName(e.target.value)}
                    placeholder="Abebe"
                    className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-sm text-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-amber-200 mb-1">Role</label>
                  <select
                    value={memberRoleId}
                    onChange={(e) => setMemberRoleId(e.target.value ? Number(e.target.value) : "")}
                    className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-sm text-white"
                  >
                    <option value="">Select role</option>
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-amber-200 mb-1">
                    Backup PIN {editingMemberId ? "(leave empty to keep it)" : ""}
                  </label>
                  <input
                    value={memberPin}
                    onChange={(e) => setMemberPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
                    inputMode="numeric"
                    placeholder="1234"
                    className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-sm text-white"
                  />
                </div>
              </div>

              {roles.length === 0 && (
                <p className="text-[11px] text-amber-300">
                  No roles yet: open Role & Time first, so this person gets his entrance and exit times.
                </p>
              )}

              <div className="flex flex-wrap gap-3">
                <button
                  onClick={() => startEnroll(editingMemberId)}
                  className="bg-[#3D2314] hover:bg-white/10 border border-[#C9A227]/40 text-amber-200 font-black text-xs uppercase rounded-xl px-5 py-3 flex items-center gap-2"
                >
                  <Fingerprint className="w-4 h-4" /> Add Fingerprint
                </button>
                <button
                  onClick={doneMember}
                  className="bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-black text-xs uppercase rounded-xl px-6 py-3"
                >
                  Done
                </button>
              </div>
              <p className="text-[11px] text-stone-400">
                Add Fingerprint saves the person and sends the job to the device: the scanner shows his name, he
                places his finger, and this page prints Fingerprint Added ✓.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {members.map((m) => {
              const job = jobs[m.id];
              return (
                <div key={m.id} className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-4 space-y-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="font-bold text-white text-sm">{m.name}</p>
                      <p className="text-[10px] text-stone-400 uppercase">
                        {m.roleName} • {m.fingers.length}/5 fingers • PIN {m.pinSet ? "set" : "none"}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => openMemberForm(m)}
                        className="p-2 bg-white/10 text-amber-200 hover:bg-white/20 rounded-lg"
                        aria-label={`Edit ${m.name}`}
                      >
                        <Settings className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => deleteMember(m.id, m.name)}
                        className="p-2 bg-rose-500/20 text-rose-300 hover:bg-rose-500 hover:text-white rounded-lg"
                        aria-label={`Remove ${m.name}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    {m.fingers.map((f) => (
                      <div key={f.id} className="flex items-center justify-between bg-[#3D2314] rounded-xl p-2.5">
                        <div>
                          <p className="text-xs font-bold text-amber-100">
                            ID {f.fingerprintId} - {f.fingerName || "Finger"}
                          </p>
                          <p className="text-[10px] text-stone-500">
                            {f.enrolledAt ? new Date(f.enrolledAt).toLocaleDateString() : ""}
                          </p>
                        </div>
                        <button
                          onClick={() => deleteFinger(f.id)}
                          className="p-1.5 bg-rose-500/20 text-rose-300 hover:bg-rose-500 hover:text-white rounded-lg"
                          aria-label={`Delete fingerprint ${f.fingerprintId}`}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                    {m.fingers.length === 0 && !job && (
                      <p className="text-[11px] text-stone-500 text-center py-2">No fingerprint yet</p>
                    )}
                  </div>

                  {job?.status === "pending" ? (
                    <div className="bg-amber-950/40 border border-amber-700 rounded-xl p-3">
                      <p className="text-xs font-bold text-amber-200 flex items-center gap-2">
                        <RefreshCw className="w-3 h-3 animate-spin" /> Waiting for the finger • ID {job.fingerprintId}
                      </p>
                      <p className="text-[10px] text-amber-300/80 mt-1">
                        The device shows his name now. He places his finger on the scanner.
                      </p>
                      <button
                        onClick={() => cancelEnroll(m.id)}
                        className="mt-2 text-[10px] font-bold text-stone-400 hover:text-white underline"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : job?.status === "done" ? (
                    <p className="text-xs font-black text-emerald-300 bg-emerald-950/40 border border-emerald-800 rounded-xl p-3">
                      Fingerprint Added ✓
                    </p>
                  ) : (
                    <button
                      onClick={() => startEnroll(m.id)}
                      className="w-full bg-[#3D2314] hover:bg-white/10 border border-[#C9A227]/40 text-amber-200 font-black text-[11px] uppercase rounded-xl px-4 py-2.5 flex items-center justify-center gap-2"
                    >
                      <Fingerprint className="w-4 h-4" /> Add Fingerprint
                    </button>
                  )}
                </div>
              );
            })}
            {members.length === 0 && !memberFormOpen && (
              <p className="text-xs text-stone-500">
                Nobody on the attendance list yet. This list is separate from the staff logins: add everyone who
                clocks in, even if he never logs in to a station.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── PAPER SHEET VIEW ───────────────────────────────────────────── */}
      {activeView === "sheet" && (
        <div className="space-y-4">
          <div className="bg-[#2C1B17] p-4 rounded-2xl border border-[#C9A227]/30 flex flex-wrap gap-3 items-end print:hidden">
            <div>
              <label className="block text-[10px] font-bold text-amber-200 mb-1">From Date</label>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromCapped(e.target.value)}
                className="bg-[#3D2314] border border-stone-700 rounded-xl p-2.5 text-xs text-white"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-amber-200 mb-1">To Date</label>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToCapped(e.target.value)}
                className="bg-[#3D2314] border border-stone-700 rounded-xl p-2.5 text-xs text-white"
              />
            </div>
            <button
              onClick={loadSheet}
              className="bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-black text-xs px-5 py-2.5 rounded-xl"
            >
              Load Sheet
            </button>
            {sheetData && (
              <button
                onClick={() => window.print()}
                className="bg-[#3D2314] hover:bg-white/10 border border-[#C9A227]/40 text-amber-200 font-black text-xs px-5 py-2.5 rounded-xl flex items-center gap-2"
              >
                <Printer className="w-4 h-4" /> Print Hard Copy
              </button>
            )}
            <p className="text-[11px] text-stone-400">
              One box per person per day, {SHEET_MAX_DAYS} days at most: green = on time, yellow = late (15 minutes
              after his role starts), red = did not come.
            </p>
          </div>

          <div className="flex flex-wrap gap-2 print:hidden">
            {LEGEND.map((l) => (
              <span
                key={l.label}
                className={`text-[11px] font-bold px-3 py-1.5 rounded-full border ${l.className}`}
              >
                {l.label}
              </span>
            ))}
          </div>

          {sheetData && (
            <div
              id="attendance-print-area"
              className="bg-white text-black rounded-2xl overflow-hidden shadow-xl print:shadow-none print:rounded-none print:border print:border-black"
            >
              <div className="p-4 bg-[#1C120F] text-white text-center border-b-4 border-[#C9A227]">
                <h2 className="font-serif font-black text-lg">FANA CAFÉ & RESTAURANT</h2>
                <p className="text-xs text-amber-200">
                  Attendance Sheet - {sheetData.from} to {sheetData.to}
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="bg-stone-100 border-b-2 border-black">
                      <th className="p-2 border border-black font-black text-[15px]">Employee Name</th>
                      {sheetData.dates.map((d: string) => (
                        <th
                          key={d}
                          colSpan={2}
                          className="p-2 border border-black font-black text-center bg-amber-100 text-[15px]"
                        >
                          {d}
                          <br />
                          <span className="text-[12px] font-bold">
                            {new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { weekday: "short" })} Day
                          </span>
                        </th>
                      ))}
                    </tr>
                    <tr className="bg-stone-50 border-b border-black">
                      <th className="p-2 border border-black" />
                      {sheetData.dates.map((d: string) => (
                        <Fragment key={`${d}-sub`}>
                          <th className="p-1 border border-black text-[12px] font-black text-center">
                            IN (TIME & SGN.)
                          </th>
                          <th className="p-1 border border-black text-[12px] font-black text-center">
                            OUT (TIME & SGN.)
                          </th>
                        </Fragment>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sheetData.staffList.map((s: any) => (
                      <tr key={s.id} className="border-b border-black">
                        <td className="p-2 border border-black font-black text-[15px] whitespace-nowrap">
                          {s.name}
                          <span className="block text-[11px] font-bold text-stone-600">{s.role}</span>
                        </td>
                        {sheetData.dates.map((d: string) => {
                          const cell = sheetData.matrix[s.id]?.[d] ?? null;
                          const inClass = IN_STYLE[cell ? cell.inStatus : "absent"] || "";
                          const outClass = OUT_STYLE[cell ? cell.outStatus : "none"] || "";
                          return (
                            <Fragment key={`${s.id}-${d}`}>
                              <td
                                className={`p-2 border border-black text-center font-mono font-black text-[14px] ${inClass}`}
                              >
                                {cell?.clockInTime ? (
                                  <>
                                    <div>{cell.clockInTime}</div>
                                    <div className="text-[11px] font-bold">
                                      {cell.fingerprintId ? `ID ${cell.fingerprintId}` : "PIN"}
                                    </div>
                                    {cell.lateMinutes > 0 && (
                                      <div className="text-[11px] font-black">Late {cell.lateMinutes}m</div>
                                    )}
                                  </>
                                ) : (
                                  <span className="text-[12px] font-black">Absent</span>
                                )}
                              </td>
                              <td
                                className={`p-2 border border-black text-center font-mono font-black text-[14px] ${outClass}`}
                              >
                                {cell?.clockOutTime ? (
                                  <>
                                    <div>{cell.clockOutTime}</div>
                                    <div className="text-[11px] font-bold">{cell.totalHours}</div>
                                    {cell.isOvertime && <div className="text-[11px] font-black">Overtime</div>}
                                    {!cell.isOvertime && cell.earlyOut && (
                                      <div className="text-[11px] font-black">Early out</div>
                                    )}
                                  </>
                                ) : cell?.clockInTime ? (
                                  <span className="text-[12px] font-black">Still In</span>
                                ) : (
                                  <span className="text-[12px] font-black">-</span>
                                )}
                              </td>
                            </Fragment>
                          );
                        })}
                      </tr>
                    ))}
                    {sheetData.staffList.length === 0 && (
                      <tr>
                        <td colSpan={1 + sheetData.dates.length * 2} className="p-6 text-center text-stone-500">
                          Nobody on the attendance list yet. Add the people in Staff Members and they appear here.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="p-3 bg-stone-100 text-[11px] text-stone-700 text-center font-bold">
                Digital signature = fingerprint scan • Green = on time • Yellow = late (15 minutes after his role
                starts) • Red = absent • Blue = early out • Violet = overtime • Total hours = OUT - IN
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── STAFF FINGERPRINTS (the manual way, kept on purpose) ───────── */}
      {activeView === "prints" && (
        <div className="space-y-4">
          <div className="bg-[#2C1B17] p-5 rounded-2xl border border-[#C9A227]/30">
            <h3 className="text-sm font-bold text-amber-200 mb-3">Add a fingerprint by its ID (FPC1020A)</h3>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <select
                value={manualMemberId}
                onChange={(e) => setManualMemberId(e.target.value ? Number(e.target.value) : "")}
                className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white"
              >
                <option value="">Select person</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.roleName}) - {m.fingers.length}/5 fingers
                  </option>
                ))}
              </select>
              <input
                value={manualFingerId}
                onChange={(e) => setManualFingerId(e.target.value.replace(/\D/g, "").slice(0, 4))}
                inputMode="numeric"
                placeholder="Fingerprint ID (1-1000)"
                className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white"
              />
              <select
                value={manualFingerName}
                onChange={(e) => setManualFingerName(e.target.value)}
                className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white"
              >
                <option>Right Index</option>
                <option>Right Middle</option>
                <option>Right Thumb</option>
                <option>Left Index</option>
                <option>Left Middle</option>
                <option>Left Thumb</option>
              </select>
              <button
                onClick={enrollManual}
                className="bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-black text-xs uppercase rounded-xl flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" /> Add
              </button>
            </div>
            <p className="mt-3 text-[11px] text-stone-400">
              Use this when the finger is already stored on the device and you know its ID. Otherwise press Add
              Fingerprint on the person in Staff Members and let the scanner do it.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {members.map((m) => (
              <div key={m.id} className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="font-bold text-white text-sm">{m.name}</p>
                    <p className="text-[10px] text-stone-400 uppercase">
                      {m.roleName} • {m.fingers.length}/5 fingers
                    </p>
                  </div>
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      m.fingers.length > 0 ? "bg-emerald-900 text-emerald-300" : "bg-stone-800 text-stone-500"
                    }`}
                  >
                    <Fingerprint className="w-4 h-4" />
                  </div>
                </div>
                <div className="space-y-2">
                  {m.fingers.map((f) => (
                    <div key={f.id} className="flex items-center justify-between bg-[#3D2314] rounded-xl p-2.5">
                      <div>
                        <p className="text-xs font-bold text-amber-100">
                          ID {f.fingerprintId} - {f.fingerName || "Finger"}
                        </p>
                        <p className="text-[10px] text-stone-500">
                          {f.enrolledAt ? new Date(f.enrolledAt).toLocaleDateString() : ""}
                        </p>
                      </div>
                      <button
                        onClick={() => deleteFinger(f.id)}
                        className="p-1.5 bg-rose-500/20 text-rose-300 hover:bg-rose-500 hover:text-white rounded-lg"
                        aria-label={`Delete fingerprint ${f.fingerprintId}`}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  {m.fingers.length === 0 && (
                    <p className="text-[11px] text-stone-500 text-center py-3">No fingerprints enrolled</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Print styles: only the sheet, colours included, landscape paper */}
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
          #attendance-print-area td,
          #attendance-print-area th,
          #attendance-print-area div {
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
