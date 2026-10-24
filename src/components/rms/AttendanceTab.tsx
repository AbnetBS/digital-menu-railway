"use client";

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Calendar,
  CalendarDays,
  Clock,
  Fingerprint,
  LogOut,
  Moon,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Settings,
  Sun,
  Timer,
  Trash2,
  Trophy,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import {
  OVERTIME_TYPE_HINTS,
  OVERTIME_TYPE_LABELS,
  SHEET_MAX_DAYS,
  SHEET_RANGE_MAX_DAYS,
  isAttendanceExpectedOnDate,
  overtimeHoursLabel,
  type OvertimeType,
} from "@/lib/attendance";
import { useStaffT } from "@/lib/staff-i18n";
import FreeScheduleDialog from "@/components/rms/FreeScheduleDialog";
import HolidayManagerDialog from "@/components/rms/HolidayManagerDialog";
import { currentEthiopianPeriod } from "@/lib/payroll";

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
 *
 * Two of the owner's later asks live here too:
 *   • PAPER SHEET VIEW reaches 30 days and splits itself into printed pages of
 *     7 days, with the page numbers below the sheet (only when there is more
 *     than one page) and a print that comes out divided the same way.
 *   • LEADERBOARD ranks the people of every role by the hours they spent at
 *     work in the chosen range.
 *   • ACTIVITY (owner, Oct 2026) previews scanner hours generated from every saved
 *     Role & Time shift, padded one hour on both ends and merged when they touch
 *     or overlap. The ESP32 sleeps only in the gaps; keep-awake overrides remain.
 *   • OVERTIME (owner, Oct 2026) sits beside the Leaderboard: three kinds
 *     (Holiday OT, Free week OT, Shift OT), one employee + date + shift per
 *     row, and a table of employee name / date / type / total hours. What is
 *     saved is the record: there is no approval queue.
 */

type ViewKey = "today" | "roles" | "members" | "sheet" | "leaderboard" | "overtime" | "activity" | "prints";

interface RoleShift {
  id?: number;
  label: string;
  startTime: string;
  endTime: string;
  lateGraceMinutes?: number;
  earlyLeaveGraceMinutes?: number;
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
  employmentStartedAt?: string | null;
  terminatedAt?: string | null;
  fingers: Finger[];
}

/** One overtime row, exactly as /api/attendance/overtime answers it. */
interface OvertimeRow {
  id: number;
  memberId: number;
  memberName: string;
  date: string;
  type: OvertimeType;
  typeLabel: string;
  minutes: number;
  hoursLabel: string;
  shiftLabel: string | null;
  logId: number | null;
  source: "admin" | "supervisor" | "self" | "auto";
  enteredBy: string | null;
  note: string | null;
  clockInLabel: string | null;
  clockOutLabel: string | null;
  workedLabel: string | null;
}

/** The Activity panel's whole picture, as /api/attendance/activity answers it. */
interface ActivityState {
  windows: Array<{ from: string; to: string; label: string | null; enabled: boolean }>;
  shiftCount: number;
  overflow: boolean;
  alwaysAwake: boolean;
  override: { mode: "schedule" | "awake" | "awake_until"; untilAt?: string };
  awakeNow: boolean;
  scheduleAwakeNow: boolean;
  at: string;
  changeInMinutes: number;
  changeTo: string;
  nextChangeLabel: string;
  // Sleep-slice cap sent to the device when it next fetches the schedule: 45 s
  // after a role-time edit or while a finger job waits, ten minutes when quiet.
  // A timer already running in deep sleep cannot be interrupted by the server.
  sliceSeconds: number;
  jobWaiting: boolean;
}

interface EnrollJob {
  jobId: number;
  fingerprintId: number;
  status: "pending" | "done" | "failed" | "cancelled";
  // The device's own words about this job: "Device is ready - place the
  // finger now" while it waits, or the exact scan and status it failed on.
  detail?: string | null;
  // Set once the ESP32 has the job, so the page can say whether the scanner
  // is waiting for a finger or never saw the job at all.
  startedAt?: string | null;
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
  { label: "Late (30 min+)", className: "bg-amber-200 text-amber-950 border-amber-500" },
  { label: "Absent", className: "bg-rose-200 text-rose-950 border-rose-500" },
  { label: "Still in", className: "bg-amber-100 text-amber-950 border-amber-400" },
  { label: "Early out", className: "bg-sky-200 text-sky-950 border-sky-500" },
  { label: "Overtime", className: "bg-violet-200 text-violet-950 border-violet-500" },
];

/** One ranked person of the leaderboard, as the API returns him. */
interface LeaderRow {
  rank: number;
  memberId: number;
  name: string;
  workedMinutes: number;
  openMinutes: number;
  totalMinutes: number;
  totalHours: string;
  wholeHours: number;
  days: number;
  overtimeDays: number;
  stillIn: boolean;
}

/** One role card of the leaderboard. */
interface LeaderGroup {
  roleId: number | null;
  roleName: string;
  rows: LeaderRow[];
  totalMinutes: number;
  totalHours: string | null;
  notSeen: number;
}

interface Leaderboard {
  from: string;
  to: string;
  days: number;
  roles: Array<{ id: number; name: string }>;
  groups: LeaderGroup[];
  totals: { people: number; minutes: number; hours: string | null };
}

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
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState("");
  const [manualSubmitting, setManualSubmitting] = useState(false);
  const [todayLogs, setTodayLogs] = useState<any>(null);
  const [sheetData, setSheetData] = useState<any>(null);
  // Which printed page of the sheet is on screen (0-based). One page is 7 days
  // wide; the page numbers below the sheet appear only when there is more than
  // one, and printing emits every page whether it is on screen or not.
  const [sheetPage, setSheetPage] = useState(0);

  // Sheet range: up to a month, at most SHEET_RANGE_MAX_DAYS (30) days.
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return d.toISOString().slice(0, 10);
  });
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));

  // Leaderboard: its own range (a month by default) and its own role filter.
  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [leaderLoading, setLeaderLoading] = useState(false);
  const [leaderFrom, setLeaderFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - (SHEET_RANGE_MAX_DAYS - 1));
    return d.toISOString().slice(0, 10);
  });
  const [leaderTo, setLeaderTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [leaderRoleId, setLeaderRoleId] = useState<string>("");

  // OVERTIME: its own range, its own three buttons and one row being typed.
  // The owner's ask (Oct 2026): "a button beside Leaderboard, then three
  // buttons Holiday OT, Free week OT, Shift OT, then pick the employee, the
  // date and the shift, and it lists immediately" - no approval step.
  const [otFrom, setOtFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - (SHEET_RANGE_MAX_DAYS - 1));
    return d.toISOString().slice(0, 10);
  });
  const [otTo, setOtTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [otRows, setOtRows] = useState<OvertimeRow[]>([]);
  const [otTotalMinutes, setOtTotalMinutes] = useState(0);
  const [otLoading, setOtLoading] = useState(false);
  const [otSaving, setOtSaving] = useState(false);
  const [otType, setOtType] = useState<OvertimeType>("holiday");
  const [otMemberId, setOtMemberId] = useState<number | "">("");
  const [otDate, setOtDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [otShift, setOtShift] = useState<string>("");
  const [otHours, setOtHours] = useState("");
  const [otNote, setOtNote] = useState("");
  /** That person's own hours on that day, so the box can start at the truth.
   *  It carries member and date with it: a number is never shown under a
   *  name it was not fetched for. */
  const [otWorked, setOtWorked] = useState<{
    memberId: number;
    date: string;
    minutes: number;
    label: string;
  } | null>(null);

  // ACTIVITY: the scanner's daily hours are derived automatically from every
  // Role & Time shift, padded one hour before and after. Only awake overrides
  // are changed on this panel.
  const [activity, setActivity] = useState<ActivityState | null>(null);
  const [actLoading, setActLoading] = useState(false);
  const [actSaving, setActSaving] = useState(false);
  const [actWakeMinutes, setActWakeMinutes] = useState("15");

  // Role form
  const [roleFormOpen, setRoleFormOpen] = useState(false);
  const [editingRoleId, setEditingRoleId] = useState<number | null>(null);
  const [roleName, setRoleName] = useState("");
  const [roleShifts, setRoleShifts] = useState<RoleShift[]>([
    { label: "Morning", startTime: "08:00", endTime: "14:00", lateGraceMinutes: 30, earlyLeaveGraceMinutes: 0 },
    { label: "Afternoon", startTime: "14:00", endTime: "22:00", lateGraceMinutes: 30, earlyLeaveGraceMinutes: 0 },
  ]);

  // Member form
  const [memberFormOpen, setMemberFormOpen] = useState(false);
  const [editingMemberId, setEditingMemberId] = useState<number | null>(null);
  const [memberName, setMemberName] = useState("");
  const [memberRoleId, setMemberRoleId] = useState<number | "">("");
  const [memberPin, setMemberPin] = useState("");
  const [freeMember, setFreeMember] = useState<Member | null>(null);
  // The Holiday OT label opens the list of holiday dates (owner, Oct 2026),
  // because those dates are what turns a worked day into Holiday OT.
  const [holidayOpen, setHolidayOpen] = useState(false);

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
    setMembersLoading(true);
    setMembersError("");
    try {
      const r = await fetch("/api/attendance/members", { cache: "no-store" });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Could not load staff members");
      if (!Array.isArray(data)) throw new Error("The staff member list had an unexpected response");
      setMembers(data as Member[]);
    } catch (error) {
      setMembersError(error instanceof Error ? error.message : "Could not load staff members");
    } finally {
      setMembersLoading(false);
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
        // A fresh range starts on its first page: the page that was open may
        // not even exist any more (30 days -> 5 pages, 3 days -> 1 page).
        setSheetPage(0);
      } else {
        const d = await r.json().catch(() => ({}));
        say(d.error || "Could not load the sheet", true);
      }
    } catch {
      say("Network error. Try again.", true);
    }
  }, [fromDate, toDate]);

  const loadLeaderboard = useCallback(async () => {
    setLeaderLoading(true);
    try {
      const r = await fetch(`/api/attendance/leaderboard?from=${leaderFrom}&to=${leaderTo}`);
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        say(d?.error || "Could not load the leaderboard", true);
        return;
      }
      setLeaderboard(d as Leaderboard);
    } catch {
      say("Network error. Try again.", true);
    } finally {
      setLeaderLoading(false);
    }
  }, [leaderFrom, leaderTo]);

  const loadOvertime = useCallback(async () => {
    setOtLoading(true);
    try {
      const r = await fetch(`/api/attendance/overtime?from=${otFrom}&to=${otTo}`, { cache: "no-store" });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        say(d?.error || "Could not load the overtime", true);
        return;
      }
      setOtRows(Array.isArray(d?.rows) ? (d.rows as OvertimeRow[]) : []);
      setOtTotalMinutes(Number(d?.totalMinutes) || 0);
    } catch {
      say("Network error. Try again.", true);
    } finally {
      setOtLoading(false);
    }
  }, [otFrom, otTo]);

  // Opening the tab (the button below) and saving a row are what load the
  // list, both from an event handler - and a save comes straight back in the
  // table (owner: "the row lists immediately").

  const setOtRange = (days: number) => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - (days - 1));
    setOtTo(to.toISOString().slice(0, 10));
    setOtFrom(from.toISOString().slice(0, 10));
  };

  // The shift choices of the picked person: his role's own times, because an
  // overtime "belongs to" the shift he was called for.
  const otMember = members.find((m) => String(m.id) === String(otMemberId)) || null;
  const otRole = otMember?.roleId ? roles.find((r) => r.id === otMember.roleId) || null : null;
  const otShifts = otRole?.shifts ?? [];

  // What that day's scan says the person worked. Nothing is shown when there
  // is no line: then the admin types the hours, and the server asks for them
  // rather than inventing a number.
  useEffect(() => {
    if (!otMemberId || !otDate) return;
    const wanted = { memberId: Number(otMemberId), date: otDate };
    let cancelled = false;
    fetch(`/api/attendance/logs?from=${wanted.date}&to=${wanted.date}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        const log =
          ((d?.logs ?? []) as Array<Record<string, unknown>>).find(
            (l) => Number(l.memberId) === wanted.memberId && String(l.date) === wanted.date
          ) || null;
        const minutes = Number(log?.totalMinutes) || 0;
        setOtWorked(
          minutes > 0
            ? {
                ...wanted,
                minutes,
                label: String(log?.totalHours || "") || overtimeHoursLabel(minutes),
              }
            : null
        );
      })
      .catch(() => {
        /* the box simply stays empty, and an empty box means "use the scan" */
      });
    return () => {
      cancelled = true;
    };
  }, [otMemberId, otDate]);

  /** Only ever the number that belongs to the person and day now selected. */
  const otWorkedNow =
    otWorked && otWorked.memberId === Number(otMemberId) && otWorked.date === otDate ? otWorked : null;

  const saveOvertime = async () => {
    if (!otMemberId) {
      say("Pick the employee first", true);
      return;
    }
    if (!otDate) {
      say("Pick the date", true);
      return;
    }
    const hours = Number(otHours);
    if (otHours !== "" && (!Number.isFinite(hours) || hours <= 0)) {
      say("The hours must be a number, like 2 or 1.5", true);
      return;
    }
    setOtSaving(true);
    try {
      const r = await fetch("/api/attendance/overtime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberId: Number(otMemberId),
          date: otDate,
          type: otType,
          // Blank means "the hours he actually worked that day", which the
          // server reads off the scan (owner's default).
          hours: otHours === "" ? undefined : hours,
          shiftLabel: otShift || null,
          note: otNote || null,
        }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.success) {
        say(d?.error || "Could not save the overtime", true);
        return;
      }
      say(d.replaced ? `Corrected: ${d.message}` : d.message);
      setOtHours("");
      setOtNote("");
      await loadOvertime();
      loadToday();
    } catch {
      say("Network error. Try again.", true);
    } finally {
      setOtSaving(false);
    }
  };

  const loadActivity = useCallback(async () => {
    setActLoading(true);
    try {
      const r = await fetch("/api/attendance/activity", { cache: "no-store" });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        say(d?.error || "Could not load the activity hours", true);
        return;
      }
      setActivity(d as ActivityState);
    } catch {
      say("Network error. Try again.", true);
    } finally {
      setActLoading(false);
    }
  }, []);

  /** Every change goes through here: post it, then show the new truth. The
   *  device is told on its own event stream by the server, so there is no
   *  "apply" step for the admin to remember. */
  const postActivity = async (body: Record<string, unknown>) => {
    setActSaving(true);
    try {
      const r = await fetch("/api/attendance/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.success) {
        say(d?.error || "Could not save that", true);
        return false;
      }
      say(d.message || "Saved");
      await loadActivity();
      return true;
    } catch {
      say("Network error. Try again.", true);
      return false;
    } finally {
      setActSaving(false);
    }
  };

  const removeOvertime = async (id: number) => {
    try {
      const r = await fetch(`/api/attendance/overtime?id=${id}`, { method: "DELETE" });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        say(d?.error || "Could not remove that overtime", true);
        return;
      }
      say("Overtime removed");
      await loadOvertime();
      loadToday();
    } catch {
      say("Network error. Try again.", true);
    }
  };

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

  useEffect(() => {
    if (activeView === "leaderboard") loadLeaderboard();
  }, [activeView, loadLeaderboard]);

  // Refresh members whenever Staff Fingerprints is opened so the list and
  // dropdown reflect the latest server mappings, including manual additions.
  useEffect(() => {
    if (activeView === "prints") loadMembers();
  }, [activeView, loadMembers]);

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
          if (cancelled) continue;
          // The status is not the only thing that moves: while the job stays
          // pending the device still reports that it picked it up ("Device is
          // ready - place the finger now"), and that has to reach the screen.
          const next: EnrollJob = {
            ...job,
            status: d.job.status,
            detail: d.job.detail ?? job.detail ?? null,
            startedAt: d.job.startedAt ?? job.startedAt ?? null,
          };
          if (next.status !== job.status || next.detail !== job.detail || next.startedAt !== job.startedAt) {
            setJobs((prev) => ({ ...prev, [memberId]: { ...prev[memberId], ...next } }));
          }
          if (d.job.status === "done") {
            say(`Fingerprint Added ✓ ${d.job.memberName || ""}`);
            loadMembers();
          } else if (d.job.status === "failed") {
            say(
              d.job.detail
                ? `Fingerprint was not added: ${d.job.detail}`
                : "Fingerprint was not added. Check the device screen and try again.",
              true
            );
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
        ? role.shifts.map((s) => ({ label: s.label, startTime: s.startTime, endTime: s.endTime, lateGraceMinutes: s.lateGraceMinutes ?? 30, earlyLeaveGraceMinutes: s.earlyLeaveGraceMinutes ?? 0 }))
        : [
            { label: "Morning", startTime: "08:00", endTime: "14:00", lateGraceMinutes: 30, earlyLeaveGraceMinutes: 0 },
            { label: "Afternoon", startTime: "14:00", endTime: "22:00", lateGraceMinutes: 30, earlyLeaveGraceMinutes: 0 },
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
      void loadActivity();
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
      void loadActivity();
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

  const toggleMemberActive = async (member: Member) => {
    const next = !member.active;
    if (!confirm(`Mark ${member.name} ${next ? "onsite" : "offsite"}?`)) return;
    try {
      const response = await fetch("/api/attendance/members", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: member.id, active: next }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        say(data.error || "Could not change onsite status", true);
        return;
      }
      say(`${member.name} is now ${next ? "onsite" : "offsite"}`);
      await loadMembers();
    } catch {
      say("Network error. Onsite status was not changed.", true);
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
   * its 2 second poll and shows the name on its LCD, the person places his
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
        // detail/startedAt start empty: they belong to THIS attempt, so an old
        // failure message never shows up under a fresh job.
        [id as number]: {
          jobId: d.job.id,
          fingerprintId: d.job.fingerprintId,
          status: "pending",
          detail: null,
          startedAt: null,
        },
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
    const selectedMember = members.find((member) => member.id === Number(manualMemberId));
    const fingerprintId = Number(manualFingerId);
    if (!selectedMember || !manualFingerId) {
      say("Select a person and type the ID stored on the device", true);
      return;
    }
    if (!Number.isInteger(fingerprintId) || fingerprintId < 1 || fingerprintId > 1000) {
      say("Fingerprint ID must be a whole number from 1 to 1000", true);
      return;
    }

    setManualSubmitting(true);
    try {
      const r = await fetch("/api/attendance/biometrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // No action is sent intentionally: the route's default action is "map".
        body: JSON.stringify({
          memberId: selectedMember.id,
          fingerprintId,
          fingerName: manualFingerName,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        say(d.error || "Could not add the fingerprint", true);
        return;
      }
      say(`✓ Fingerprint Added for ${d.memberName || selectedMember.name} (ID ${fingerprintId})`);
      setManualFingerId("");
      await loadMembers();
    } catch {
      say("Network error. Try again.", true);
    } finally {
      setManualSubmitting(false);
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

  /* ── the sheet range never grows past a month ─────────────────────────── *
   * The owner asked for "up to 30 days": a longer ask is cut back here, in the
   * pickers, and the sheet itself is then shown and printed one page of
   * SHEET_MAX_DAYS (7) days at a time. Cutting from the date the admin moved
   * keeps the day he just chose on screen.
   * ──────────────────────────────────────────────────────────────────────── */
  const setFromCapped = (value: string) => {
    setFromDate(value);
    const to = new Date(toDate);
    const from = new Date(value);
    const days = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
    if (days > SHEET_RANGE_MAX_DAYS) {
      const cut = new Date(from);
      cut.setDate(cut.getDate() + SHEET_RANGE_MAX_DAYS - 1);
      setToDate(cut.toISOString().slice(0, 10));
      say(
        `A sheet covers ${SHEET_RANGE_MAX_DAYS} days at most (${SHEET_MAX_DAYS} per page): the To Date moved to ${cut.toISOString().slice(0, 10)}`
      );
    }
  };
  const setToCapped = (value: string) => {
    setToDate(value);
    const from = new Date(fromDate);
    const to = new Date(value);
    const days = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
    if (days > SHEET_RANGE_MAX_DAYS) {
      const cut = new Date(to);
      cut.setDate(cut.getDate() - (SHEET_RANGE_MAX_DAYS - 1));
      setFromDate(cut.toISOString().slice(0, 10));
      say(
        `A sheet covers ${SHEET_RANGE_MAX_DAYS} days at most (${SHEET_MAX_DAYS} per page): the From Date moved to ${cut.toISOString().slice(0, 10)}`
      );
    }
  };

  /** The printed pages of the sheet that is on screen right now. */
  const sheetPagesList: string[][] = Array.isArray(sheetData?.pages) && sheetData.pages.length > 0
    ? sheetData.pages
    : Array.isArray(sheetData?.dates) && sheetData.dates.length > 0
      ? [sheetData.dates]
      : [];
  const sheetPageCount = sheetPagesList.length;
  const safeSheetPage = Math.min(Math.max(0, sheetPage), Math.max(0, sheetPageCount - 1));

  /** One of the leaderboard's quick ranges: "last 7 days", "last 30 days". */
  const setLeaderRange = (days: number) => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - (days - 1));
    setLeaderFrom(from.toISOString().slice(0, 10));
    setLeaderTo(to.toISOString().slice(0, 10));
  };

  return (
    <div className="space-y-6">
      {freeMember && <FreeScheduleDialog member={freeMember} onClose={()=>setFreeMember(null)} />}
      {holidayOpen && <HolidayManagerDialog period={currentEthiopianPeriod()} onClose={()=>setHolidayOpen(false)} />}
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
            if (activeView === "leaderboard") loadLeaderboard();
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
            { key: "leaderboard", label: "Leaderboard", icon: <Trophy className="w-4 h-4" /> },
            { key: "overtime", label: "Overtime", icon: <Timer className="w-4 h-4" /> },
            { key: "activity", label: "Activity", icon: <Moon className="w-4 h-4" /> },
            { key: "prints", label: "Staff Fingerprints", icon: <Fingerprint className="w-4 h-4" /> },
          ] as Array<{ key: ViewKey; label: string; icon: ReactNode }>
        ).map((v) => (
          <button
            key={v.key}
            onClick={() => {
              setActiveView(v.key);
              // Overtime and Activity have no data of their own until they are
              // opened, so the tap that shows the tab is the tap that fills it.
              if (v.key === "overtime") void loadOvertime();
              if (v.key === "activity") void loadActivity();
            }}
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
          <p className="rounded-xl border border-amber-800/60 bg-amber-950/20 p-3 text-[11px] leading-relaxed text-stone-300">
            Scanner hours are automatic: it wakes 1 hour before each role shift and stays awake until 1 hour after
            that shift ends. Overlapping hours merge. These shifts repeat every day because this form has no weekday
            setting. Edit shift times here; the Activity tab shows the combined scanner hours.
          </p>
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
                    <div><label className="block text-[11px] font-bold text-amber-200 mb-1">Maximum Late Time (min)</label><input type="number" min="0" max="240" value={s.lateGraceMinutes ?? 30} onChange={(e)=>setRoleShifts(roleShifts.map((x,j)=>j===i?{...x,lateGraceMinutes:Number(e.target.value)}:x))} className="w-32 bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-sm"/></div>
                    <div><label className="block text-[11px] font-bold text-amber-200 mb-1">Leaving Grace (min)</label><input type="number" min="0" max="240" value={s.earlyLeaveGraceMinutes ?? 0} onChange={(e)=>setRoleShifts(roleShifts.map((x,j)=>j===i?{...x,earlyLeaveGraceMinutes:Number(e.target.value)}:x))} className="w-32 bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-sm"/></div>
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
                  onClick={() => setRoleShifts([...roleShifts, { label: "", startTime: "08:00", endTime: "17:00", lateGraceMinutes: 30, earlyLeaveGraceMinutes: 0 }])}
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
                Late is 30 minutes after the time of entrance of the role. A person is an early out when he leaves
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
                places the same finger for the three enrollment steps, and the device only prints Fingerprint Added ✓
                after it has scanned that finger once more and the sensor really found it. A finger the sensor cannot
                find again is reported as a failure here, never as added.
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
                        {m.roleName} • {m.fingers.length}/5 fingers • PIN {m.pinSet ? "set" : "none"} • {m.active ? "onsite" : "offsite"}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setFreeMember(m)}
                        title="Free day, free date, or ye amet ereft (yearly leave)"
                        className="px-2 py-1 bg-sky-700/40 text-sky-200 rounded-lg text-[10px] font-black"
                      >
                        FREE
                      </button>
                      <button onClick={() => toggleMemberActive(m)} className={`px-2 py-1 rounded-lg text-[10px] font-black ${m.active?'bg-emerald-700/40 text-emerald-200':'bg-rose-700/40 text-rose-200'}`}>{m.active?'ONSITE':'OFFSITE'}</button>
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
                        <RefreshCw className="w-3 h-3 animate-spin" />
                        {job.startedAt ? "Device is ready • " : "Waiting for the device • "}ID {job.fingerprintId}
                      </p>
                      <p className="text-[10px] text-amber-300/80 mt-1">
                        {job.startedAt
                          ? "The scanner is waiting. Lift the finger if it is on the glass, then follow the LCD: PLACE FINGER three times, lifting and placing the SAME finger for each step, and place it once more when it says CONFIRM."
                          : "Sending the job to the scanner. If this does not change in about 20 seconds the device is offline."}
                      </p>
                      {job.detail ? <p className="text-[10px] text-amber-200/90 mt-1 font-bold">{job.detail}</p> : null}
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
                  ) : job?.status === "failed" ? (
                    <div className="bg-rose-950/40 border border-rose-800 rounded-xl p-3">
                      <p className="text-xs font-bold text-rose-200">Fingerprint was not added</p>
                      <p className="text-[10px] text-rose-300/80 mt-1">
                        {job.detail || "No finger was placed, or the scanner could not read it. Try again."}
                      </p>
                      {!job.startedAt ? (
                        <p className="text-[10px] text-rose-300/70 mt-1">
                          The scanner never picked this job up. Check that it is powered on and on the same WiFi.
                        </p>
                      ) : null}
                      <button
                        onClick={() => startEnroll(m.id)}
                        className="mt-2 text-[10px] font-bold text-amber-200 hover:text-white underline"
                      >
                        Try again
                      </button>
                    </div>
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
            <div className="flex flex-wrap gap-2">
              {[
                { label: "Last 7 days", days: 7 },
                { label: "Last 14 days", days: 14 },
                { label: "Last 30 days", days: SHEET_RANGE_MAX_DAYS },
              ].map((preset) => (
                <button
                  key={preset.days}
                  onClick={() => {
                    const to = new Date();
                    const from = new Date();
                    from.setDate(from.getDate() - (preset.days - 1));
                    setFromDate(from.toISOString().slice(0, 10));
                    setToDate(to.toISOString().slice(0, 10));
                  }}
                  className="bg-[#3D2314] hover:bg-white/10 border border-stone-700 text-stone-300 font-bold text-[11px] px-3 py-2.5 rounded-xl"
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-stone-400">
              One box per person per day, up to {SHEET_RANGE_MAX_DAYS} days: {SHEET_MAX_DAYS} days per page. The page
              numbers below the sheet appear only when the range is wider than one page, and Print Hard Copy prints
              every page in order (the first {SHEET_MAX_DAYS} days, then the next {SHEET_MAX_DAYS}, ...). Green = on
              time, yellow = late, red = absent from registration through today.
              {" Dates before registration and after today stay blank."}
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
            <div id="attendance-print-area" className="space-y-4 print:space-y-0">
              {sheetPagesList.map((pageDates: string[], pageIndex: number) => (
                <section
                  key={pageDates[0] || pageIndex}
                  className={`sheet-page bg-white text-black rounded-2xl overflow-hidden shadow-xl print:shadow-none print:rounded-none print:border print:border-black ${
                    pageIndex === safeSheetPage ? "is-active" : ""
                  }`}
                >
                  <div className="p-4 bg-[#1C120F] text-white text-center border-b-4 border-[#C9A227]">
                    <h2 className="font-serif font-black text-lg">FANA CAFÉ & RESTAURANT</h2>
                    <p className="text-xs text-amber-200">
                      Attendance Sheet - {pageDates[0]} to {pageDates[pageDates.length - 1]}
                    </p>
                    {sheetPageCount > 1 && (
                      <p className="text-[11px] font-black text-amber-100 mt-0.5">
                        Page {pageIndex + 1} of {sheetPageCount} • days {pageIndex * SHEET_MAX_DAYS + 1}-
                        {Math.min((pageIndex + 1) * SHEET_MAX_DAYS, sheetData.dates.length)} of{" "}
                        {sheetData.dates.length}
                      </p>
                    )}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-sm">
                      <thead>
                        <tr className="bg-stone-100 border-b-2 border-black">
                          <th className="p-2 border border-black font-black text-[15px]">Employee Name</th>
                          {pageDates.map((d: string) => (
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
                          {pageDates.map((d: string) => (
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
                            {pageDates.map((d: string) => {
                              const attendanceExpected = isAttendanceExpectedOnDate(d, s.registeredOn, sheetData.today);
                              const cell = attendanceExpected ? sheetData.matrix[s.id]?.[d] ?? null : null;
                              const inClass = cell
                                ? IN_STYLE[cell.inStatus] || ""
                                : attendanceExpected
                                  ? IN_STYLE.absent
                                  : "";
                              const outClass = cell
                                ? OUT_STYLE[cell.outStatus] || ""
                                : attendanceExpected
                                  ? OUT_STYLE.none
                                  : "";
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
                                    ) : attendanceExpected ? (
                                      <span className="text-[12px] font-black">Absent</span>
                                    ) : null}
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
                                    ) : attendanceExpected && cell?.clockInTime ? (
                                      <span className="text-[12px] font-black">Still In</span>
                                    ) : attendanceExpected ? (
                                      <span className="text-[12px] font-black">-</span>
                                    ) : null}
                                  </td>
                                </Fragment>
                              );
                            })}
                          </tr>
                        ))}
                        {sheetData.staffList.length === 0 && (
                          <tr>
                            <td colSpan={1 + pageDates.length * 2} className="p-6 text-center text-stone-500">
                              Nobody on the attendance list yet. Add the people in Staff Members and they appear here.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="p-3 bg-stone-100 text-[11px] text-stone-700 text-center font-bold">
                    Digital signature = fingerprint scan • Green = on time • Yellow = late (30 minutes after his role
                    starts) • Red = absent from registration through today • Blank = before registration or future •
                    Blue = early out • Violet = overtime • Total hours = OUT - IN
                  </div>
                </section>
              ))}
            </div>
          )}

          {/* ── the page numbers: only when the range is wider than one page ── */}
          {sheetData && sheetPageCount > 1 && (
            <div className="print:hidden bg-[#2C1B17] border border-[#C9A227]/30 rounded-2xl p-3 flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-black uppercase text-amber-200">Page</span>
              <button
                onClick={() => setSheetPage(Math.max(0, safeSheetPage - 1))}
                disabled={safeSheetPage === 0}
                className="px-3 py-2 rounded-xl bg-[#3D2314] text-stone-200 text-[11px] font-bold hover:bg-white/10 disabled:opacity-40"
              >
                ‹ Prev
              </button>
              {sheetPagesList.map((pageDates: string[], i: number) => (
                <button
                  key={pageDates[0] || i}
                  onClick={() => setSheetPage(i)}
                  title={`${pageDates[0]} to ${pageDates[pageDates.length - 1]}`}
                  className={`min-w-10 px-3 py-2 rounded-xl text-[11px] font-black ${
                    i === safeSheetPage
                      ? "bg-[#C9A227] text-[#2C1B17]"
                      : "bg-[#3D2314] text-stone-300 hover:bg-white/10"
                  }`}
                >
                  {i + 1}
                </button>
              ))}
              <button
                onClick={() => setSheetPage(Math.min(sheetPageCount - 1, safeSheetPage + 1))}
                disabled={safeSheetPage >= sheetPageCount - 1}
                className="px-3 py-2 rounded-xl bg-[#3D2314] text-stone-200 text-[11px] font-bold hover:bg-white/10 disabled:opacity-40"
              >
                Next ›
              </button>
              <span className="text-[11px] text-stone-400 ml-auto">
                {sheetData.dates.length} days on {sheetPageCount} pages • page {safeSheetPage + 1} shows{" "}
                {sheetPagesList[safeSheetPage]?.[0]} to{" "}
                {sheetPagesList[safeSheetPage]?.[sheetPagesList[safeSheetPage].length - 1]} • Print Hard Copy prints
                every page, each on its own paper
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── LEADERBOARD: who spent the most time at work, by role ───────── */}
      {activeView === "leaderboard" && (
        <div className="space-y-4">
          <div className="bg-[#2C1B17] p-4 rounded-2xl border border-[#C9A227]/30 flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-[10px] font-bold text-amber-200 mb-1">From Date</label>
              <input
                type="date"
                value={leaderFrom}
                onChange={(e) => setLeaderFrom(e.target.value)}
                className="bg-[#3D2314] border border-stone-700 rounded-xl p-2.5 text-xs text-white"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-amber-200 mb-1">To Date</label>
              <input
                type="date"
                value={leaderTo}
                onChange={(e) => setLeaderTo(e.target.value)}
                className="bg-[#3D2314] border border-stone-700 rounded-xl p-2.5 text-xs text-white"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-amber-200 mb-1">Role</label>
              <select
                value={leaderRoleId}
                onChange={(e) => setLeaderRoleId(e.target.value)}
                className="bg-[#3D2314] border border-stone-700 rounded-xl p-2.5 text-xs text-white min-w-40"
              >
                <option value="">All roles</option>
                {(leaderboard?.roles ?? []).map((r) => (
                  <option key={r.id} value={String(r.id)}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={loadLeaderboard}
              disabled={leaderLoading}
              className="bg-[#C9A227] hover:bg-amber-400 disabled:opacity-60 text-[#2C1B17] font-black text-xs px-5 py-2.5 rounded-xl flex items-center gap-2"
            >
              <RefreshCw className={`w-4 h-4 ${leaderLoading ? "animate-spin" : ""}`} /> Load Leaderboard
            </button>
            <div className="flex flex-wrap gap-2">
              {[
                { label: "Today", days: 1 },
                { label: "Last 7 days", days: 7 },
                { label: "Last 30 days", days: SHEET_RANGE_MAX_DAYS },
              ].map((preset) => (
                <button
                  key={preset.days}
                  onClick={() => setLeaderRange(preset.days)}
                  className="bg-[#3D2314] hover:bg-white/10 border border-stone-700 text-stone-300 font-bold text-[11px] px-3 py-2.5 rounded-xl"
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-stone-400">
              The hours of every day in the range (IN → OUT), ranked inside each role. A day that is still open counts
              its time so far and is marked &quot;still in&quot;, so the board is right in the middle of a shift and
              not only after everybody scanned out.
            </p>
          </div>

          {leaderboard && (
            <div className="bg-[#2C1B17] border border-[#C9A227]/30 rounded-2xl p-4 flex flex-wrap items-center gap-4">
              <h3 className="font-bold text-amber-100 flex items-center gap-2">
                <Trophy className="w-4 h-4 text-[#C9A227]" /> Leaderboard • {leaderboard.from} to {leaderboard.to} (
                {leaderboard.days} day{leaderboard.days === 1 ? "" : "s"})
              </h3>
              <span className="text-[11px] text-stone-400">
                {leaderboard.totals.people} people • {leaderboard.totals.hours ?? "0h 00m"} worked in this range
              </span>
            </div>
          )}

          {leaderLoading && !leaderboard && <p className="text-xs text-stone-400">Loading the leaderboard...</p>}

          {leaderboard && (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {leaderboard.groups
                .filter((g) => !leaderRoleId || String(g.roleId ?? "") === leaderRoleId)
                .map((group) => (
                  <div key={`${group.roleId ?? "none"}-${group.roleName}`} className="bg-[#2C1B17] rounded-2xl border border-stone-800 overflow-hidden">
                    <div className="bg-[#3D2314] px-4 py-3 flex items-center justify-between border-b border-[#C9A227]/30">
                      <div>
                        <p className="text-[10px] uppercase font-black text-amber-200/70">Role</p>
                        <p className="font-black text-white text-sm">{group.roleName}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] uppercase font-black text-amber-200/70">Total</p>
                        <p className="font-mono font-black text-[#C9A227] text-sm">{group.totalHours ?? "0h 00m"}</p>
                      </div>
                    </div>
                    <div className="divide-y divide-stone-800">
                      {group.rows.map((row) => (
                        <div key={row.memberId} className="px-4 py-3 flex items-center gap-3">
                          <span
                            className={`w-8 h-8 shrink-0 rounded-xl flex items-center justify-center font-black text-xs ${
                              row.rank === 1
                                ? "bg-[#C9A227] text-[#2C1B17]"
                                : row.rank === 2
                                  ? "bg-stone-300 text-stone-800"
                                  : row.rank === 3
                                    ? "bg-amber-800 text-amber-100"
                                    : "bg-[#3D2314] text-stone-300"
                            }`}
                          >
                            {row.rank}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="font-bold text-white text-sm truncate">{row.name}</p>
                            <p className="text-[10px] text-stone-400 font-bold">
                              {row.days} day{row.days === 1 ? "" : "s"}
                              {row.overtimeDays > 0 ? ` • ${row.overtimeDays} overtime` : ""}
                              {row.stillIn ? " • still in now" : ""}
                            </p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="font-mono font-black text-[#C9A227] text-sm">{row.totalHours}</p>
                            <p className="text-[10px] text-stone-500 font-bold">
                              {row.wholeHours} hour{row.wholeHours === 1 ? "" : "s"}
                            </p>
                          </div>
                        </div>
                      ))}
                      {group.rows.length === 0 && (
                        <p className="p-4 text-[11px] text-stone-500 text-center">
                          Nobody of this role scanned in during this range.
                        </p>
                      )}
                    </div>
                    {group.notSeen > 0 && (
                      <p className="px-4 py-2 text-[10px] text-stone-500 border-t border-stone-800">
                        {group.notSeen} more {group.notSeen === 1 ? "person" : "people"} of this role had no scan in
                        this range.
                      </p>
                    )}
                  </div>
                ))}
              {leaderboard.groups.filter((g) => !leaderRoleId || String(g.roleId ?? "") === leaderRoleId).length ===
                0 && (
                <p className="text-xs text-stone-500 md:col-span-2 xl:col-span-3">
                  No roles yet. Add the roles in Role & Time and the people in Staff Members, and the board ranks them
                  here by the hours they worked.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── OVERTIME: the three kinds, typed here or tapped at the door ────
          * Owner's ask (Oct 2026): a button beside the Leaderboard, then three
          * type buttons, then the employee + date + shift, then the row in a
          * table of employee name / date / type of overtime / total hour. No
          * approval step anywhere in it: what is saved is the record. ────── */}
      {activeView === "overtime" && (
        <div className="space-y-4">
          <div className="bg-[#2C1B17] p-5 rounded-2xl border border-[#C9A227]/30 space-y-4">
            <div>
              <h3 className="text-sm font-bold text-amber-200">Add overtime</h3>
              <p className="text-[11px] text-stone-400 mt-1 leading-relaxed">
                Which kind of overtime, for whom, on which day. The row appears in the list below the moment it is
                saved, colours that day violet on the paper sheet and counts on the Leaderboard.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {(Object.keys(OVERTIME_TYPE_LABELS) as OvertimeType[]).map((t) => (
                // A div, not a button: the Holiday OT hint has its own small
                // button inside it (the owner's "make the label clickable"),
                // and a button inside a button is not allowed.
                <div
                  key={t}
                  role="button"
                  tabIndex={0}
                  onClick={() => setOtType(t)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setOtType(t);
                  }}
                  className={`text-left px-4 py-3 rounded-2xl border transition cursor-pointer ${
                    otType === t
                      ? "bg-[#C9A227] text-[#2C1B17] border-[#C9A227]"
                      : "bg-[#3D2314] text-stone-200 border-stone-700 hover:bg-white/10"
                  }`}
                >
                  <span className="block text-xs font-black uppercase">{L(OVERTIME_TYPE_LABELS[t])}</span>
                  {t === "holiday" ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOtType("holiday");
                        setHolidayOpen(true);
                      }}
                      title="Add the holiday dates the system must know"
                      className={`block text-[10px] mt-1 text-left underline decoration-dotted underline-offset-2 ${
                        otType === t ? "text-[#2C1B17]/80" : "text-amber-200"
                      }`}
                    >
                      {L(OVERTIME_TYPE_HINTS[t])} <CalendarDays className="w-3 h-3 inline" /> Holiday dates
                    </button>
                  ) : (
                    <span className={`block text-[10px] mt-1 ${otType === t ? "text-[#2C1B17]/80" : "text-stone-400"}`}>
                      {L(OVERTIME_TYPE_HINTS[t])}
                    </span>
                  )}
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[10px] text-stone-400">
              <button
                type="button"
                onClick={() => setHolidayOpen(true)}
                className="inline-flex items-center gap-1.5 bg-violet-900/50 border border-violet-700 text-violet-100 rounded-xl px-3 py-2 font-bold hover:bg-violet-800/60"
              >
                <CalendarDays className="w-3.5 h-3.5" /> Add holiday dates
              </button>
              <span>
                The payroll counts a registered holiday by itself. Leaving within one hour after the shift end is not
                overtime; after that, the whole time past the end is paid.
              </span>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 items-end">
              <div className="col-span-2 md:col-span-1">
                <label className="block text-[10px] font-bold text-amber-200 mb-1">Employee</label>
                <select
                  value={String(otMemberId)}
                  onChange={(e) => {
                    setOtMemberId(e.target.value ? Number(e.target.value) : "");
                    setOtShift("");
                  }}
                  className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-2.5 text-xs text-white"
                >
                  <option value="">Select the person</option>
                  {members
                    .filter((m) => m.active !== false)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} ({m.roleName || "no role"})
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-bold text-amber-200 mb-1">Date</label>
                <input
                  type="date"
                  value={otDate}
                  onChange={(e) => setOtDate(e.target.value)}
                  className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-2.5 text-xs text-white"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-amber-200 mb-1">Shift</label>
                <select
                  value={otShift}
                  onChange={(e) => setOtShift(e.target.value)}
                  className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-2.5 text-xs text-white"
                >
                  <option value="">The day as a whole</option>
                  {otShifts.map((sh) => (
                    <option key={sh.label} value={sh.label}>
                      {sh.label} ({sh.startTime}-{sh.endTime})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-bold text-amber-200 mb-1">Total hours</label>
                <input
                  type="number"
                  min="0"
                  step="0.25"
                  inputMode="decimal"
                  value={otHours}
                  onChange={(e) => setOtHours(e.target.value)}
                  placeholder={otWorkedNow ? otWorkedNow.label : "e.g. 2"}
                  className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-2.5 text-xs text-white"
                />
              </div>
              <div className="col-span-2 md:col-span-3">
                <label className="block text-[10px] font-bold text-amber-200 mb-1">Note (optional)</label>
                <input
                  value={otNote}
                  onChange={(e) => setOtNote(e.target.value)}
                  placeholder="Closing, the party, the delivery that came late..."
                  className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-2.5 text-xs text-white"
                />
              </div>
              <button
                onClick={saveOvertime}
                disabled={otSaving}
                className="bg-[#C9A227] hover:bg-amber-400 disabled:opacity-60 text-[#2C1B17] font-black text-xs px-5 py-2.5 rounded-xl flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" /> {otSaving ? "Saving..." : "Save overtime"}
              </button>
            </div>

            <p className="text-[10px] text-stone-500">
              {otWorkedNow
                ? `${otMember?.name ?? "This person"} worked ${otWorkedNow.label} on ${otDate}. Leaving the hours box empty saves exactly that; typing a number uses yours.`
                : otMember
                  ? `No scan found for ${otMember.name} on ${otDate}, so type how many hours were worked.`
                  : "Pick the person and the day. The hours default to what he actually worked that day when a scan exists."}
            </p>
          </div>

          <div className="bg-[#2C1B17] p-5 rounded-2xl border border-stone-700/60 space-y-3">
            <div className="flex flex-wrap gap-3 items-end">
              <div>
                <label className="block text-[10px] font-bold text-amber-200 mb-1">From Date</label>
                <input
                  type="date"
                  value={otFrom}
                  onChange={(e) => setOtFrom(e.target.value)}
                  className="bg-[#3D2314] border border-stone-700 rounded-xl p-2.5 text-xs text-white"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-amber-200 mb-1">To Date</label>
                <input
                  type="date"
                  value={otTo}
                  onChange={(e) => setOtTo(e.target.value)}
                  className="bg-[#3D2314] border border-stone-700 rounded-xl p-2.5 text-xs text-white"
                />
              </div>
              <button
                onClick={loadOvertime}
                disabled={otLoading}
                className="bg-[#3D2314] hover:bg-white/10 border border-stone-700 text-stone-200 font-bold text-xs px-4 py-2.5 rounded-xl flex items-center gap-2"
              >
                <RefreshCw className={`w-4 h-4 ${otLoading ? "animate-spin" : ""}`} /> Load overtime
              </button>
              {[
                { label: "This month", days: SHEET_RANGE_MAX_DAYS },
                { label: "Last 7 days", days: 7 },
                { label: "Today", days: 1 },
              ].map((preset) => (
                <button
                  key={preset.days}
                  onClick={() => setOtRange(preset.days)}
                  className="bg-[#3D2314] hover:bg-white/10 border border-stone-700 text-stone-300 font-bold text-[11px] px-3 py-2.5 rounded-xl"
                >
                  {preset.label}
                </button>
              ))}
              <p className="ml-auto text-[11px] text-stone-400">
                Total in range:{" "}
                <span className="font-black text-amber-300">{overtimeHoursLabel(otTotalMinutes)}</span>
              </p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase text-amber-200">
                    <th className="py-2 pr-3 font-black">Employee Name</th>
                    <th className="py-2 pr-3 font-black">Date</th>
                    <th className="py-2 pr-3 font-black">Type of overtime</th>
                    <th className="py-2 pr-3 font-black">Total Hour</th>
                    <th className="py-2 font-black text-right">Remove</th>
                  </tr>
                </thead>
                <tbody>
                  {otRows.map((row) => (
                    <tr key={row.id} className="border-t border-stone-700/60 align-top">
                      <td className="py-2 pr-3">
                        <p className="font-bold text-white">{row.memberName}</p>
                        <p className="text-[10px] text-stone-500">
                          {row.clockInLabel || "no IN"}
                          {" / "}
                          {row.clockOutLabel || "no OUT"}
                          {row.workedLabel ? ` • worked ${row.workedLabel}` : ""}
                        </p>
                      </td>
                      <td className="py-2 pr-3 text-stone-300 whitespace-nowrap">{row.date}</td>
                      <td className="py-2 pr-3">
                        <p className="font-bold text-amber-200 whitespace-nowrap">{L(row.typeLabel)}</p>
                        <p className="text-[10px] text-stone-500">
                          {row.shiftLabel ? `${row.shiftLabel} shift • ` : ""}
                          {row.source === "auto"
                            ? "from his clock-out scan"
                            : row.source === "admin"
                              ? "typed by an admin"
                              : row.source === "supervisor"
                                ? "typed at the door"
                                : `tapped at the door${row.enteredBy ? ` by ${row.enteredBy}` : ""}`}
                          {row.note ? ` • ${row.note}` : ""}
                        </p>
                      </td>
                      <td className="py-2 pr-3 font-black text-violet-300 whitespace-nowrap">{row.hoursLabel}</td>
                      <td className="py-2 text-right">
                        <button
                          onClick={() => removeOvertime(row.id)}
                          className="p-2 text-rose-400 hover:text-rose-300"
                          aria-label={L("Remove this overtime")}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {otRows.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-4 text-[11px] text-stone-500">
                        No overtime in this range. Pick the kind, the person and the day above and save it, or let a
                        person stay past his shift: the clock-out scan writes that one by itself.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── ACTIVITY: automatic scanner hours from role shifts ──────────── */}
      {activeView === "activity" && (
        <div className="space-y-4">
          <div className="bg-[#2C1B17] p-5 rounded-2xl border border-[#C9A227]/30 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-amber-200">Automatic scanner hours</h3>
                <p className="text-[11px] text-stone-400 mt-1 leading-relaxed max-w-2xl">
                  These hours are calculated from the shifts in <strong>Role &amp; Time</strong>. The scanner opens
                  one hour before a shift starts and stays open until one hour after it ends. Overlapping periods
                  join together; it sleeps in the gaps and wakes for the next one. These shift times repeat daily;
                  Role &amp; Time does not have weekday settings yet.
                </p>
              </div>
              <button
                onClick={loadActivity}
                disabled={actLoading}
                className="shrink-0 p-2 bg-white/10 hover:bg-white/20 text-amber-200 rounded-xl"
                aria-label={L("Refresh automatic scanner hours")}
                title="Refresh role-derived hours"
              >
                <RefreshCw className={`w-4 h-4 ${actLoading ? "animate-spin" : ""}`} />
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-3 bg-black/30 border border-stone-700 rounded-2xl px-4 py-3">
              {activity?.awakeNow ? (
                <Sun className="w-5 h-5 text-amber-300 shrink-0" />
              ) : (
                <Moon className="w-5 h-5 text-indigo-300 shrink-0" />
              )}
              <div className="text-xs text-stone-200">
                <p>
                  Now {activity?.at ?? "--:--"}: {" "}
                  <span className="font-black uppercase">{activity?.awakeNow ? "awake" : "resting"}</span>
                  {activity?.alwaysAwake
                    ? " • the schedule keeps the scanner awake all day"
                    : activity
                      ? ` • schedule ${activity.changeTo === "awake" ? "opens" : "closes"} in ${activity.changeInMinutes} min, at ${activity.nextChangeLabel}`
                      : ""}
                </p>
                {activity && !activity.alwaysAwake && activity.override.mode !== "schedule" && (
                  <p className="mt-1 text-[10px] text-amber-200">
                    The admin override is keeping the scanner awake beyond its role schedule.
                  </p>
                )}
              </div>
              {activity && activity.override.mode !== "schedule" && (
                <span className="text-[10px] font-black uppercase bg-amber-900/60 text-amber-200 border border-amber-700 rounded-full px-3 py-1">
                  {activity.override.mode === "awake"
                    ? "Kept awake by admin"
                    : `Kept awake until ${new Date(String(activity.override.untilAt)).toLocaleTimeString("en-GB", {
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZone: "Africa/Addis_Ababa",
                      })}`}
                </span>
              )}
              {activity && (
                <p className="w-full text-[10px] text-stone-400">
                  {activity.sliceSeconds <= 120
                    ? activity.jobWaiting
                      ? "A sleeping scanner checks for the fingerprint job at its next timer wake (up to 10 minutes if already asleep); then it uses 45-second rest slices while the job waits."
                      : "An awake scanner refreshes immediately. One already in deep sleep cannot be interrupted: it loads changed role times at its next timer wake (up to 10 minutes), then uses 45-second rest slices for a short while."
                    : `During a quiet rest, the device checks again at most every ${Math.round(activity.sliceSeconds / 60)} minutes.`}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-end gap-2">
              <button
                onClick={() => postActivity({ action: "override", mode: "awake" })}
                disabled={actSaving}
                className="bg-[#C9A227] hover:bg-amber-400 disabled:opacity-60 text-[#2C1B17] font-black text-xs px-4 py-2.5 rounded-xl"
              >
                Keep scanner awake
              </button>
              <div className="flex items-end gap-2">
                <div>
                  <label className="block text-[10px] font-bold text-amber-200 mb-1">Minutes</label>
                  <input
                    type="number"
                    min="1"
                    max="1440"
                    value={actWakeMinutes}
                    onChange={(e) => setActWakeMinutes(e.target.value)}
                    className="w-24 bg-[#3D2314] border border-stone-700 rounded-xl p-2.5 text-xs text-white"
                  />
                </div>
                <button
                  onClick={() => postActivity({ action: "override", mode: "minutes", minutes: Number(actWakeMinutes) })}
                  disabled={actSaving}
                  className="bg-[#3D2314] hover:bg-white/10 border border-stone-700 text-stone-200 font-bold text-xs px-4 py-2.5 rounded-xl"
                >
                  Keep awake this long
                </button>
              </div>
              <button
                onClick={() => postActivity({ action: "override", mode: "schedule" })}
                disabled={actSaving}
                className="bg-[#3D2314] hover:bg-white/10 border border-stone-700 text-stone-200 font-bold text-xs px-4 py-2.5 rounded-xl flex items-center gap-2"
              >
                <Moon className="w-4 h-4" /> Use role schedule again
              </button>
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[10px] font-black uppercase text-amber-200">Generated from Role &amp; Time</p>
                <p className="text-[10px] text-stone-400">
                  {activity ? `${activity.shiftCount} shift${activity.shiftCount === 1 ? "" : "s"} used · 1-hour buffer on both ends` : "Loading shifts…"}
                </p>
              </div>

              {activity?.alwaysAwake && activity.shiftCount === 0 && (
                <p className="rounded-xl border border-stone-700 bg-black/20 px-4 py-3 text-[11px] text-stone-300">
                  No role shift times are saved. For safety, the scanner stays awake all day. Add shift start and end
                  times under <strong>Role &amp; Time</strong> to let it sleep between shifts.
                </p>
              )}
              {activity?.alwaysAwake && activity.shiftCount > 0 && !activity.overflow && (
                <p className="rounded-xl border border-stone-700 bg-black/20 px-4 py-3 text-[11px] text-stone-300">
                  Role hours cover the whole day, so the scanner stays awake continuously.
                </p>
              )}
              {activity?.overflow && (
                <p className="rounded-xl border border-amber-700 bg-amber-950/30 px-4 py-3 text-[11px] text-amber-100">
                  There are too many separate shift periods for the device to store safely. It is staying awake all day
                  rather than risk missing a worker&apos;s shift.
                </p>
              )}

              {!activity?.alwaysAwake && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {(activity?.windows ?? []).map((w) => (
                    <div key={`${w.from}-${w.to}`} className="rounded-xl border border-emerald-800 bg-emerald-950/30 px-4 py-3">
                      <p className="font-mono font-black text-sm text-emerald-100">{w.from} – {w.to}</p>
                      <p className="mt-1 text-[10px] text-emerald-200/70">Scanner awake · Addis Ababa time</p>
                    </div>
                  ))}
                </div>
              )}

              <p className="text-[10px] leading-relaxed text-stone-500">
                Example: shifts at 06:00 and 08:00 are each padded by one hour. Their awake periods merge if they
                touch or overlap. The ESP32 sleeps only in the gaps. This schedule controls the fingerprint scanner;
                the tablet PIN clock-in and paper sheet remain available.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── STAFF FINGERPRINTS (the manual way, kept on purpose) ───────── */}
      {activeView === "prints" && (
        <div className="space-y-4">
          <div className="bg-[#2C1B17] p-5 rounded-2xl border border-[#C9A227]/30 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-bold text-amber-200">Staff fingerprints</h3>
              <button
                onClick={() => loadMembers()}
                disabled={membersLoading}
                className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-[11px] font-bold text-amber-100 hover:bg-white/20 disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${membersLoading ? "animate-spin" : ""}`} />
                {membersLoading ? "Loading..." : "Refresh people"}
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[11px]">
              <div className="rounded-xl border border-emerald-800 bg-emerald-950/30 p-3">
                <p className="font-black text-emerald-200">Automatic</p>
                <p className="mt-1 text-stone-300">
                  Attendance → Staff Members → edit the person → <strong>ADD FINGERPRINT</strong>. The device
                  chooses the ID, guides the finger, and sends the mapping back automatically.
                </p>
              </div>
              <div className="rounded-xl border border-amber-800 bg-amber-950/30 p-3">
                <p className="font-black text-amber-200">Manual</p>
                <p className="mt-1 text-stone-300">
                  On the device Serial Monitor at 115200 baud, type <code>enroll 7</code> using the ID you want.
                  After it says Stored, map the ID here in Staff Fingerprints: choose that same person and ID below, choose the finger name, then press Add.
                </p>
              </div>
            </div>

            {membersError && (
              <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-xs text-rose-200">
                Could not load the staff list: {membersError}. Use Refresh people to try again.
              </p>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <select
                value={manualMemberId}
                disabled={membersLoading || members.length === 0}
                onChange={(e) => setManualMemberId(e.target.value ? Number(e.target.value) : "")}
                aria-label="Select person for fingerprint mapping"
                className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white disabled:opacity-50"
              >
                <option value="">
                  {membersLoading ? "Loading people..." : members.length === 0 ? "No staff members yet" : "Select person"}
                </option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.roleName}) - {m.fingers.length}/5 fingers
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                max={1000}
                step={1}
                value={manualFingerId}
                onChange={(e) => setManualFingerId(e.target.value)}
                inputMode="numeric"
                autoComplete="off"
                aria-label="Fingerprint ID from 1 to 1000"
                placeholder="Fingerprint ID (1-1000)"
                className="bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white"
              />
              <select
                value={manualFingerName}
                onChange={(e) => setManualFingerName(e.target.value)}
                aria-label="Finger name"
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
                disabled={manualSubmitting || membersLoading || members.length === 0}
                aria-busy={manualSubmitting}
                className="bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-black text-xs uppercase rounded-xl flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {manualSubmitting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {manualSubmitting ? "Adding..." : "Add"}
              </button>
            </div>
            <p className="text-[11px] text-stone-400">
              The finger must already be stored on the device before using Manual. Choose the exact ID printed after
              <code> enroll &lt;id&gt;</code>; the form sends that ID to the attendance list.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {membersLoading && members.length === 0 && (
              <p className="text-xs text-stone-400">Loading staff members and their fingerprint IDs...</p>
            )}
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
            {members.length === 0 && !membersLoading && !membersError && (
              <p className="text-xs text-stone-400 md:col-span-2 lg:col-span-3">
                No staff members yet. Add people in Attendance → Staff Members first; each person and every mapped ID will appear here.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Print styles: only the sheet, colours included, landscape paper */}
      <style jsx global>{`
        /* On screen the sheet shows ONE page of 7 days at a time; the other
           pages stay in the document (hidden) so printing can emit them too. */
        #attendance-print-area .sheet-page {
          display: none;
        }
        #attendance-print-area .sheet-page.is-active {
          display: block;
        }

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
          /* The owner's rule: "when he wants to click print it will be printed
             divided like the 1st 7 days then next 7 days". Every page of the
             range comes out, in order, each starting on its own paper. */
          #attendance-print-area .sheet-page {
            display: block !important;
            break-after: page;
            page-break-after: always;
            break-inside: auto;
          }
          #attendance-print-area .sheet-page:last-child {
            break-after: auto;
            page-break-after: auto;
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
