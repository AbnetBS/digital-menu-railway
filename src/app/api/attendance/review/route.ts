import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  attendanceBiometrics,
  attendanceLogs,
  attendanceMembers,
  attendanceReviewQueue,
  attendanceRoleShifts,
  attendanceRoles,
  payrollHolidays,
} from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { deviceAllowed } from "@/lib/attendance-device";
import { recordScannerHeartbeat } from "@/lib/scanner-status";
import { publish, CHANNELS } from "@/lib/realtime";
import { and, asc, eq, sql } from "drizzle-orm";
import { etDayKey } from "@/lib/timezone";
import { recognizedOtMinutes } from "@/lib/payroll";
import {
  LATE_GRACE_MINUTES,
  REPEAT_SCAN_LOCK_MINUTES,
  clockLabel,
  earlyOutMinutesFor,
  etMinutes,
  isEarlyOut,
  lateMinutesFor,
  parseHHMM,
  pickShift,
  type RoleShift,
} from "@/lib/attendance";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function getTodayKey(): string {
  return etDayKey(new Date()) || new Date().toISOString().slice(0, 10);
}

function buildEtTimestamp(date: string, hhmm: string): Date | null {
  if (!DATE_RE.test(date) || !TIME_RE.test(hhmm)) return null;
  const parsed = new Date(`${date}T${hhmm}:00+03:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function reasonLabelOf(reason: string): string {
  switch (reason) {
    case "unknown_time":
      return "Scanned before device clock synced (power turned off before Wi-Fi)";
    case "server_conflict":
      return "Earlier offline scan or changed fingerprint mapping";
    case "invalid_scan_time":
      return "Device clock differed from server time when scanned";
    case "unmapped_finger":
      return "Sensor template was not linked to a staff member yet";
    default:
      return "Needs admin confirmation";
  }
}

async function roleShiftsMap() {
  const shiftRows = await db
    .select()
    .from(attendanceRoleShifts)
    .orderBy(asc(attendanceRoleShifts.sortOrder), asc(attendanceRoleShifts.id));
  const byRole = new Map<number, RoleShift[]>();
  for (const s of shiftRows) {
    const list = byRole.get(s.roleId) || [];
    list.push({
      label: s.label,
      startTime: s.startTime,
      endTime: s.endTime,
      lateGraceMinutes: Number(s.lateGraceMinutes ?? LATE_GRACE_MINUTES),
      earlyLeaveGraceMinutes: Number(s.earlyLeaveGraceMinutes ?? 0),
    });
    byRole.set(s.roleId, list);
  }
  return byRole;
}

export async function loadPendingReviewItems() {
  const [rows, members, roles, biometrics, shiftsByRole] = await Promise.all([
    db
      .select()
      .from(attendanceReviewQueue)
      .where(eq(attendanceReviewQueue.status, "pending"))
      .orderBy(asc(attendanceReviewQueue.id)),
    db.select().from(attendanceMembers),
    db.select().from(attendanceRoles),
    db.select().from(attendanceBiometrics),
    roleShiftsMap(),
  ]);

  const memberById = new Map(members.map((m) => [m.id, m]));
  const roleById = new Map(roles.map((r) => [r.id, r.name]));
  const memberByFinger = new Map(biometrics.map((b) => [b.fingerprintId, b.memberId]));
  const today = getTodayKey();

  return rows.map((r) => {
    const resolvedMemberId =
      (r.memberId && memberById.has(r.memberId) ? r.memberId : null) ??
      memberByFinger.get(r.fingerprintId) ??
      null;
    const member = resolvedMemberId ? memberById.get(resolvedMemberId) : undefined;
    const roleId = member?.roleId ?? null;
    const shifts = roleId ? shiftsByRole.get(roleId) || [] : [];
    const scannedValid =
      r.scannedAt && new Date(r.scannedAt).getTime() >= Date.UTC(2020, 0, 1)
        ? new Date(r.scannedAt)
        : null;
    const suggestedDate = scannedValid
      ? etDayKey(scannedValid) || today
      : etDayKey(new Date(r.receivedAt)) || today;
    const suggestedInTime =
      (scannedValid ? clockLabel(scannedValid) : null) ||
      shifts[0]?.startTime ||
      "06:00";

    return {
      id: r.id,
      eventId: r.eventId,
      reason: r.reason,
      reasonLabel: reasonLabelOf(r.reason),
      fingerprintId: r.fingerprintId,
      memberId: resolvedMemberId,
      memberName: member?.name || r.staffName || `Finger ID ${r.fingerprintId}`,
      roleName: roleId ? roleById.get(roleId) || "No role" : "No role",
      uptimeSeconds: r.uptimeSeconds,
      scannedAt: scannedValid ? scannedValid.toISOString() : null,
      receivedAt: r.receivedAt,
      suggestedDate,
      suggestedInTime,
    };
  });
}

async function applyVerifiedAttendanceRow(params: {
  memberId: number;
  date: string;
  clockInTime: string;
  clockOutTime?: string | null;
  keepExistingIn?: boolean;
  fingerprintId?: number | null;
  method: "fingerprint" | "manual";
  auditNote: string;
  smartMergeScan?: boolean;
}) {
  const inDate = buildEtTimestamp(params.date, params.clockInTime);
  if (!inDate) {
    throw new Error("Valid date (YYYY-MM-DD) and IN time (HH:MM) are required");
  }
  let outDate: Date | null = null;
  if (params.clockOutTime && params.clockOutTime.trim()) {
    const rawOut = buildEtTimestamp(params.date, params.clockOutTime.trim());
    if (!rawOut) throw new Error("Valid OUT time (HH:MM) is required");
    const inMin = parseHHMM(params.clockInTime) ?? 0;
    const outMin = parseHHMM(params.clockOutTime.trim()) ?? 0;
    outDate = outMin < inMin ? new Date(rawOut.getTime() + 86400000) : rawOut;
  }

  return db.transaction(async (tx) => {
    const [member] = await tx
      .select()
      .from(attendanceMembers)
      .where(eq(attendanceMembers.id, params.memberId))
      .limit(1);
    if (!member) throw new Error("Staff member not found");

    await tx.execute(sql`SELECT pg_advisory_xact_lock(17268102, ${member.id})`);

    const roleId = member.roleId ?? null;
    const shiftRows = roleId
      ? await tx.select().from(attendanceRoleShifts).where(eq(attendanceRoleShifts.roleId, roleId))
      : [];
    const shifts: RoleShift[] = shiftRows
      .map((s) => ({
        label: s.label,
        startTime: s.startTime,
        endTime: s.endTime,
        lateGraceMinutes: Number(s.lateGraceMinutes ?? LATE_GRACE_MINUTES),
        earlyLeaveGraceMinutes: Number(s.earlyLeaveGraceMinutes ?? 0),
      }))
      .sort((a, b) => a.startTime.localeCompare(b.startTime));

    const existingRows = await tx
      .select()
      .from(attendanceLogs)
      .where(and(eq(attendanceLogs.memberId, member.id), eq(attendanceLogs.date, params.date)))
      .limit(1);
    const existing = existingRows[0] ?? null;

    let finalIn =
      params.keepExistingIn && existing?.clockIn ? new Date(existing.clockIn) : inDate;
    if (params.clockOutTime && params.clockOutTime.trim()) {
      const rawOut = buildEtTimestamp(params.date, params.clockOutTime.trim());
      if (rawOut) {
        const finalInLabel = clockLabel(finalIn) || params.clockInTime;
        const inMin = parseHHMM(finalInLabel) ?? 0;
        const outMin = parseHHMM(params.clockOutTime.trim()) ?? 0;
        outDate = outMin < inMin ? new Date(rawOut.getTime() + 86400000) : rawOut;
      }
    }
    let finalOut = outDate ?? (existing?.clockOut ? new Date(existing.clockOut) : null);

    // When confirming a single recovered scan onto a day that already has an IN:
    // if the recovered scan is >= 1 hour after existing IN and no OUT was typed,
    // treat it as the day's OUT; if it is earlier than existing IN, promote it
    // to IN so the employee gets credit for their real arrival time.
    if (params.smartMergeScan && existing?.clockIn && !outDate) {
      const existingIn = new Date(existing.clockIn);
      if (inDate.getTime() < existingIn.getTime()) {
        finalIn = inDate;
      } else if (
        !existing.clockOut &&
        inDate.getTime() - existingIn.getTime() >= REPEAT_SCAN_LOCK_MINUTES * 60000
      ) {
        finalIn = existingIn;
        finalOut = inDate;
      }
    }

    const inMinutes = etMinutes(finalIn);
    const inShift = pickShift(shifts, inMinutes);
    const lateMinutes = lateMinutesFor(inShift, inMinutes);

    let totalMinutes: number | null = null;
    let early = false;
    let earlyMinutes = 0;
    let overtimeMinutes = 0;
    if (finalOut && finalOut.getTime() > finalIn.getTime()) {
      totalMinutes = Math.round((finalOut.getTime() - finalIn.getTime()) / 60000);
      const outMinutes = etMinutes(finalOut);
      early = isEarlyOut(inShift, outMinutes);
      earlyMinutes = earlyOutMinutesFor(inShift, outMinutes);
      const holidayRow = (
        await tx
          .select({ id: payrollHolidays.id })
          .from(payrollHolidays)
          .where(eq(payrollHolidays.holidayDate, params.date))
      )[0];
      overtimeMinutes = holidayRow
        ? recognizedOtMinutes(inShift, { clockIn: finalIn, clockOut: finalOut, totalMinutes })
        : 0;
    } else {
      finalOut = null;
    }

    const status = finalOut
      ? early
        ? "early_out"
        : "completed"
      : lateMinutes > 0
        ? "late"
        : "on_time";

    const mergedNote = [existing?.notes || "", params.auditNote].filter(Boolean).join(" • ");
    const now = new Date();

    if (!existing) {
      const [inserted] = await tx
        .insert(attendanceLogs)
        .values({
          memberId: member.id,
          roleId,
          fingerprintId: params.fingerprintId ?? null,
          date: params.date,
          clockIn: finalIn,
          clockOut: finalOut,
          clockInMethod: params.method,
          clockOutMethod: finalOut ? params.method : null,
          totalMinutes,
          lateMinutes,
          status,
          earlyOut: early,
          earlyOutMinutes: earlyMinutes,
          isOvertime: overtimeMinutes > 0,
          deviceId: params.method === "manual" ? "admin_manual" : "entrance_review",
          notes: mergedNote || null,
          updatedAt: now,
        })
        .returning();
      return { log: inserted, memberName: member.name };
    }

    const [updated] = await tx
      .update(attendanceLogs)
      .set({
        roleId: existing.roleId ?? roleId,
        fingerprintId: existing.fingerprintId ?? params.fingerprintId ?? null,
        clockIn: finalIn,
        clockOut: finalOut,
        clockInMethod: existing.clockInMethod || params.method,
        clockOutMethod: finalOut ? existing.clockOutMethod || params.method : null,
        totalMinutes,
        lateMinutes,
        status,
        earlyOut: early,
        earlyOutMinutes: earlyMinutes,
        isOvertime: Boolean(existing.isOvertime) || overtimeMinutes > 0,
        notes: mergedNote || null,
        updatedAt: now,
      })
      .where(eq(attendanceLogs.id, existing.id))
      .returning();
    return { log: updated, memberName: member.name };
  });
}

/**
 * A registered employee's scanner scan goes straight onto Today Live and the
 * Paper Sheet, with no supervisor step. The date and IN time are the same
 * suggestions the review list shows: the scan's own time when the device had
 * a valid clock, otherwise the upload day and the role's first shift start.
 * Only items with a known staff member are applied. Unmapped fingers stay
 * pending for an admin to link. Safe to run repeatedly: applied rows leave
 * the pending state.
 */
export async function autoApplyReviewItems(): Promise<number> {
  const [rows, biometrics, members] = await Promise.all([
    db
      .select()
      .from(attendanceReviewQueue)
      .where(eq(attendanceReviewQueue.status, "pending"))
      .orderBy(asc(attendanceReviewQueue.id)),
    db.select().from(attendanceBiometrics),
    db.select().from(attendanceMembers),
  ]);
  if (rows.length === 0) return 0;
  const memberByFinger = new Map(biometrics.map((b) => [b.fingerprintId, b.memberId]));
  const memberById = new Map(members.map((m) => [m.id, m]));

  let applied = 0;
  for (const r of rows) {
    const memberId =
      (r.memberId && memberById.has(r.memberId) ? r.memberId : null) ??
      memberByFinger.get(r.fingerprintId) ??
      null;
    if (!memberId) continue;
    const scannedValid =
      r.scannedAt && new Date(r.scannedAt).getTime() >= Date.UTC(2020, 0, 1)
        ? new Date(r.scannedAt)
        : null;
    // A scan with no time is never guessed. It stays pending until someone
    // types its arrival time (guessing paired the wrong IN and OUT).
    if (!scannedValid) continue;
    const date = etDayKey(scannedValid);
    const time = clockLabel(scannedValid);
    if (!date || !time) continue;
    try {
      const { log } = await applyVerifiedAttendanceRow({
        memberId,
        date,
        clockInTime: time,
        clockOutTime: null,
        fingerprintId: r.fingerprintId,
        method: "fingerprint",
        auditNote: `Scanner scan added automatically (${r.reason})`,
        smartMergeScan: true,
      });
      await db
        .update(attendanceReviewQueue)
        .set({ memberId, status: "resolved", resolvedLogId: log.id, resolvedAt: new Date() })
        .where(eq(attendanceReviewQueue.id, r.id));
      applied++;
    } catch (error) {
      // Leave it pending; the admin list still shows it.
      console.error("Attendance auto-apply failed for review item", r.id, error);
    }
  }
  return applied;
}

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  await ensureTablesExist();

  try {
    await autoApplyReviewItems();
    const items = await loadPendingReviewItems();
    return NextResponse.json({ count: items.length, items }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

export async function POST(request: Request) {
  const device = deviceAllowed(request);
  const auth = await requireAdmin();
  if (!device && !auth.ok) return auth.response;

  await ensureTablesExist();

  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    // Admin manual attendance entry (supports recording 1 or multiple employees at once)
    if (body.action === "manual_record") {
      if (!auth.ok) return auth.response;

      const rawIds = Array.isArray(body.memberIds)
        ? body.memberIds
        : body.memberId !== undefined
          ? [body.memberId]
          : [];
      const memberIds = Array.from(
        new Set(rawIds.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))
      );
      if (memberIds.length === 0) {
        return NextResponse.json({ error: "Select at least one staff member" }, { status: 400, headers: NO_STORE_HEADERS });
      }
      const date = typeof body.date === "string" && DATE_RE.test(body.date) ? body.date : getTodayKey();
      const useRoleStart = Boolean(body.useRoleStart);
      const useRoleEnd = Boolean(body.useRoleEnd);
      const keepExistingIn = body.keepExistingIn === undefined ? true : Boolean(body.keepExistingIn);
      const customIn = typeof body.clockInTime === "string" ? body.clockInTime.trim() : "";
      const customOut = typeof body.clockOutTime === "string" ? body.clockOutTime.trim() : "";

      if (!useRoleStart && !TIME_RE.test(customIn)) {
        return NextResponse.json({ error: "Enter a valid IN time (HH:MM)" }, { status: 400, headers: NO_STORE_HEADERS });
      }
      if (!useRoleEnd && customOut && !TIME_RE.test(customOut)) {
        return NextResponse.json({ error: "Enter a valid OUT time (HH:MM)" }, { status: 400, headers: NO_STORE_HEADERS });
      }

      const [members, shiftsByRole] = await Promise.all([
        db.select().from(attendanceMembers),
        roleShiftsMap(),
      ]);
      const memberMap = new Map(members.map((m) => [m.id, m]));

      const savedNames: string[] = [];
      for (const memberId of memberIds) {
        const m = memberMap.get(memberId);
        if (!m) continue;
        const firstShift = m.roleId ? shiftsByRole.get(m.roleId)?.[0] : undefined;
        const inTime = useRoleStart ? firstShift?.startTime || customIn || "06:00" : customIn;
        const outTime = useRoleEnd
          ? firstShift?.endTime || customOut || null
          : customOut || null;
        const { memberName } = await applyVerifiedAttendanceRow({
          memberId,
          date,
          clockInTime: inTime,
          clockOutTime: outTime,
          keepExistingIn,
          method: "manual",
          auditNote: "Recorded by admin",
        });
        savedNames.push(memberName);
      }

      if (savedNames.length === 0) {
        return NextResponse.json({ error: "No matching staff members found" }, { status: 404, headers: NO_STORE_HEADERS });
      }

      publish(CHANNELS.attendance);
      return NextResponse.json(
        {
          ok: true,
          count: savedNames.length,
          message:
            savedNames.length === 1
              ? `Recorded attendance for ${savedNames[0]}`
              : `Recorded attendance for ${savedNames.length} employees`,
        },
        { headers: NO_STORE_HEADERS }
      );
    }

    // Device upload from ESP32 /queue.review.jsonl
    recordScannerHeartbeat("review_sync");
    const defaultDeviceId =
      typeof body.deviceId === "string" && body.deviceId.trim()
        ? body.deviceId.trim().slice(0, 50)
        : "entrance";
    const rawItems = Array.isArray(body.items) ? body.items : [body];
    if (rawItems.length === 0 || rawItems.length > 50) {
      return NextResponse.json({ error: "Provide 1 to 50 review items" }, { status: 400, headers: NO_STORE_HEADERS });
    }

    const [biometrics, members] = await Promise.all([
      db.select().from(attendanceBiometrics),
      db.select().from(attendanceMembers),
    ]);
    const memberByFinger = new Map(biometrics.map((b) => [b.fingerprintId, b.memberId]));
    const nameById = new Map(members.map((m) => [m.id, m.name]));

    const acceptedEventIds: string[] = [];
    let anyInserted = false;

    for (const raw of rawItems) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const record =
        item.record && typeof item.record === "object"
          ? (item.record as Record<string, unknown>)
          : item;

      const rawEventId = String(record.eventId ?? item.eventId ?? "").trim().toLowerCase();
      const fingerprintId = Number(record.fingerprintId ?? item.fingerprintId ?? 0);
      if (!rawEventId || rawEventId.length > 64 || !Number.isInteger(fingerprintId) || fingerprintId <= 0) {
        continue;
      }

      const reason = String(item.reason ?? "unknown_time").trim().slice(0, 40) || "unknown_time";
      const capturedMember = Number(record.memberId ?? item.memberId ?? 0);
      const resolvedMemberId =
        Number.isInteger(capturedMember) && capturedMember > 0
          ? capturedMember
          : memberByFinger.get(fingerprintId) ?? null;
      const rawStaffName = String(record.staffName ?? item.staffName ?? "").trim();
      const staffName =
        (resolvedMemberId ? nameById.get(resolvedMemberId) : null) ||
        rawStaffName ||
        null;
      const bootId = typeof record.bootId === "string" ? record.bootId.slice(0, 32) : null;
      const uptimeNum = Number(record.uptimeSeconds ?? item.uptimeSeconds);
      const uptimeSeconds = Number.isFinite(uptimeNum) && uptimeNum >= 0 ? Math.round(uptimeNum) : null;
      const rawScanned = Number(record.scannedAt ?? item.scannedAt ?? 0);
      const scannedAt =
        Number.isFinite(rawScanned) && rawScanned >= 1577836800 && rawScanned < 4102444800
          ? new Date(rawScanned * 1000)
          : null;

      const inserted = await db
        .insert(attendanceReviewQueue)
        .values({
          eventId: rawEventId,
          reason,
          fingerprintId,
          memberId: resolvedMemberId,
          staffName,
          deviceId:
            typeof record.deviceId === "string" && record.deviceId.trim()
              ? record.deviceId.trim().slice(0, 50)
              : defaultDeviceId,
          bootId,
          uptimeSeconds,
          scannedAt,
          status: "pending",
        })
        .onConflictDoNothing({ target: attendanceReviewQueue.eventId })
        .returning({ id: attendanceReviewQueue.id });

      if (inserted.length > 0) anyInserted = true;
      acceptedEventIds.push(rawEventId);
    }

    const autoApplied = await autoApplyReviewItems();
    if (anyInserted || autoApplied > 0) publish(CHANNELS.attendance);
    return NextResponse.json(
      { ok: true, count: acceptedEventIds.length, acceptedEventIds },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    console.error("Attendance review POST error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  await ensureTablesExist();

  try {
    const body = (await request.json().catch(() => ({}))) as {
      entries?: Array<{
        id: number;
        memberId?: number;
        date: string;
        clockInTime: string;
        clockOutTime?: string;
      }>;
    };

    const entries = Array.isArray(body.entries) ? body.entries : [];
    if (entries.length === 0) {
      return NextResponse.json({ error: "No review entries provided" }, { status: 400, headers: NO_STORE_HEADERS });
    }

    let resolvedCount = 0;
    for (const entry of entries) {
      const reviewId = Number(entry.id);
      if (!Number.isInteger(reviewId) || reviewId <= 0) continue;

      const [reviewRow] = await db
        .select()
        .from(attendanceReviewQueue)
        .where(eq(attendanceReviewQueue.id, reviewId))
        .limit(1);
      if (!reviewRow || reviewRow.status !== "pending") continue;

      const memberId = Number(entry.memberId ?? reviewRow.memberId ?? 0);
      if (!Number.isInteger(memberId) || memberId <= 0) {
        return NextResponse.json(
          { error: `Select a staff member for finger ID ${reviewRow.fingerprintId} before confirming` },
          { status: 400, headers: NO_STORE_HEADERS }
        );
      }

      const { log } = await applyVerifiedAttendanceRow({
        memberId,
        date: entry.date,
        clockInTime: entry.clockInTime,
        clockOutTime: entry.clockOutTime || null,
        fingerprintId: reviewRow.fingerprintId,
        method: "fingerprint",
        auditNote: `Confirmed scanner scan (${reviewRow.reason})`,
        smartMergeScan: true,
      });

      await db
        .update(attendanceReviewQueue)
        .set({
          memberId,
          status: "resolved",
          resolvedLogId: log.id,
          resolvedAt: new Date(),
        })
        .where(eq(attendanceReviewQueue.id, reviewId));

      resolvedCount++;
    }

    if (resolvedCount > 0) publish(CHANNELS.attendance);
    return NextResponse.json(
      {
        ok: true,
        resolvedCount,
        message:
          resolvedCount === 1
            ? "Scan confirmed and added to the attendance sheet"
            : `${resolvedCount} scans confirmed and added to the attendance sheet`,
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 400, headers: NO_STORE_HEADERS });
  }
}

export async function DELETE(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  await ensureTablesExist();

  try {
    const id = Number(new URL(request.url).searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "Valid review ID required" }, { status: 400, headers: NO_STORE_HEADERS });
    }
    await db
      .update(attendanceReviewQueue)
      .set({ status: "dismissed", resolvedAt: new Date() })
      .where(eq(attendanceReviewQueue.id, id));
    publish(CHANNELS.attendance);
    return NextResponse.json({ ok: true, message: "Dismissed" }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
