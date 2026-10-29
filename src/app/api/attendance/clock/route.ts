import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  attendanceBiometrics,
  attendanceLogs,
  attendanceMembers,
  attendanceRoleShifts,
  attendanceScanEvents,
} from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { recordShiftOvertimeAtClockOut } from "@/lib/attendance-overtime";
import { verifySecret } from "@/lib/auth";
import { deviceAllowed } from "@/lib/attendance-device";
import { requireSupervisor } from "@/lib/session";
import { publish, CHANNELS } from "@/lib/realtime";
import { and, eq, sql } from "drizzle-orm";
import { etDayKey } from "@/lib/timezone";
import {
  LATE_GRACE_MINUTES,
  OFFLINE_SCAN_MAX_AGE_DAYS,
  REPEAT_SCAN_LOCK_MINUTES,
  clockLabel,
  etMinutes,
  hoursLabel,
  earlyOutMinutesFor,
  isEarlyOut,
  lateMinutesFor,
  workedShiftOtMinutes,
  offlineScanNote,
  pickShift,
  rescanAction,
  scannedTimeOf,
  type RoleShift,
} from "@/lib/attendance";

/**
 * ONE SCAN = ONE LINE ON THE PAPER SHEET.
 *
 * Called by the ESP32 (fingerprintId), by the door tablet (backup PIN) and by
 * the admin (a manual correction). The person is looked up on the ATTENDANCE
 * list (Attendance -> Staff Members), never on the staff login list.
 *
 * The owner's three rules live here and nowhere else:
 *   • LATE: 30 minutes after the entrance time of the role he belongs to
 *     (role Morning 12:30 -> late from 12:46). src/lib/attendance.ts.
 *   • SCAN TWICE: a second scan inside one hour of the IN only answers
 *     "already registered" - a wet finger must not close the day. After the
 *     hour the next scan is the OUT.
 *   • EARLY OUT: leaving before the time out of that role is written down, so
 *     the sheet can colour that box.
 *
 * AN OFFLINE SCAN KEEPS ITS OWN TIME (owner, Oct 2026: "if someone place his
 * finger it will store it and put it in list in that scanned time when the
 * connection is back"). The device stores a scan it could not deliver and
 * sends it again when the internet is back, with `scannedAt` - the moment of
 * the finger. That moment decides the day row, the IN, the OUT and the late
 * minutes, so a person who scanned on time during an outage is not written
 * down late, and an IN and an OUT that were both queued are not swallowed by
 * the one-hour repeat lock. A device may send an older recorded time only with
 * its configured token after three days; invalid times are refused, never
 * replaced by arrival. A PIN in a browser always counts as now. Receipt,
 * attendance and automatic overtime are committed in one transaction.
 *
 * THE PIN IS LOCKED (owner, Oct 2026: "it is risky since someone can write for
 * them"): a PIN clock-in only works while an ATTENDANCE SUPERVISOR has the door
 * tablet open, which lasts two minutes from his last touch. The check is here,
 * on the server, so hiding the keypad in the browser would not be enough. The
 * fingerprint branch is untouched - the scanner keeps posting straight in.
 */

/** The Ethiopian calendar day a moment falls on, as the sheet's date key. */
function dayKeyOf(d: Date): string {
  return etDayKey(d) || d.toISOString().slice(0, 10);
}

function getTodayKey(): string {
  return dayKeyOf(new Date());
}

/** The periods of the member's role, ordered by their entrance time. */
async function roleShiftsOf(roleId: number | null, client: Pick<typeof db, "select"> = db): Promise<RoleShift[]> {
  if (!roleId) return [];
  try {
    const rows = await client.select().from(attendanceRoleShifts).where(eq(attendanceRoleShifts.roleId, roleId));
    // The shift's OWN grace minutes travel with it (owner, Oct 2026: "the
    // deduction starts if they come after their maximum late time, and the
    // leaving hour, until that nothing happens"). Dropping them here made the
    // door read every role's Maximum Late Time as the global 30 and every
    // Leaving Grace as 0, so a role that allowed 30 minutes of leaving still
    // had those minutes deducted.
    return rows
      .map((r) => ({
        label: r.label,
        startTime: r.startTime,
        endTime: r.endTime,
        lateGraceMinutes: Number(r.lateGraceMinutes ?? LATE_GRACE_MINUTES),
        earlyLeaveGraceMinutes: Number(r.earlyLeaveGraceMinutes ?? 0),
      }))
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  } catch {
    return [];
  }
}

export async function POST(request: Request) {
  await ensureTablesExist();

  try {
    const body = await request.json();
    const {
      fingerprintId,
      memberId: directMemberId,
      deviceId = "entrance",
      method = "fingerprint",
      pin,
      scannedAt,
      eventId: rawEventId,
      capturedMemberId: rawCapturedMemberId,
      requireRecordedTime,
    } = body;

    if (method !== "pin" && method !== "fingerprint") {
      return NextResponse.json({ error: "Unsupported attendance method" }, { status: 400 });
    }
    if (typeof deviceId !== "string" || deviceId.length < 1 || deviceId.length > 50) {
      return NextResponse.json({ error: "Invalid deviceId" }, { status: 400 });
    }
    if (method === "fingerprint" && !deviceAllowed(request)) {
      return NextResponse.json({ error: "Attendance device authorization required" }, { status: 401 });
    }
    if (rawEventId !== undefined && (method !== "fingerprint" || typeof rawEventId !== "string" || !/^[a-f0-9]{32}$/i.test(rawEventId))) {
      return NextResponse.json({ error: "Invalid scan eventId" }, { status: 400 });
    }
    const eventId: string | null = rawEventId === undefined ? null : rawEventId.toLowerCase();
    const requestedFinger = Number(fingerprintId);
    const capturedMemberId = rawCapturedMemberId == null ? null : Number(rawCapturedMemberId);
    if (capturedMemberId !== null && (!Number.isSafeInteger(capturedMemberId) || capturedMemberId < 1 || capturedMemberId > 2147483647)) {
      return NextResponse.json({ error: "Invalid captured member" }, { status: 400 });
    }
    if (method === "fingerprint" && (!Number.isInteger(requestedFinger) || requestedFinger < 1 || requestedFinger > 65535)) {
      return NextResponse.json({ error: "fingerprintId required", led: "red", buzzer: "error" }, { status: 400 });
    }

    // Explicitly timestamped scans must never fall back to arrival. Old online
    // firmware with no timestamp can still clock at arrival; an offline queue
    // (including older firmware's `_offline` marker) must have a real time.
    const exactTime = method === "fingerprint" && (
      requireRecordedTime === true || eventId !== null || deviceId.endsWith("_offline") ||
      (scannedAt !== undefined && scannedAt !== null && scannedAt !== "")
    );
    const scan = scannedTimeOf(
      method === "fingerprint" && deviceAllowed(request) ? scannedAt : undefined,
      new Date(),
      { allowOlder: method === "fingerprint" }
    );
    if (exactTime && !scan.trusted) {
      return NextResponse.json({ error: `Scan time ${scan.reason}; retained on device for review`, status: "invalid_scan_time" }, { status: 422 });
    }

    const response = await db.transaction(async (tx) => {
      // Lock before checking a receipt. Duplicate requests for one event wait
      // for the first transaction and see either its committed result or its
      // rollback, including when the original HTTP acknowledgement was lost.
      if (eventId) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(17268101, hashtext(${eventId}))`);
        const [receipt] = await tx.select().from(attendanceScanEvents).where(eq(attendanceScanEvents.eventId, eventId)).limit(1);
        if (receipt) {
          if (receipt.fingerprintId !== requestedFinger || receipt.deviceId !== deviceId ||
              receipt.capturedMemberId !== capturedMemberId || receipt.scannedAt.getTime() !== scan.time.getTime()) {
            return NextResponse.json({ error: "Scan eventId reused with different data" }, { status: 409 });
          }
          // Receipts written by older releases may not contain the echo fields.
          // Include them on replay too, so the scanner can verify this exact
          // event and time before it removes anything from its local queue.
          return NextResponse.json({
            ...receipt.response,
            eventId,
            recordedAtEpoch: Math.floor(receipt.scannedAt.getTime() / 1000),
          });
        }
      }
      // Backdating beyond the old three-day limit is allowed only when a real
      // device token is configured. Otherwise an anonymous caller could alter
      // arbitrarily old attendance; never silently use arrival instead.
      if (scan.trusted && scan.time.getTime() < scan.arrivedAt.getTime() - OFFLINE_SCAN_MAX_AGE_DAYS * 86400000 &&
          !(process.env.ATTENDANCE_DEVICE_TOKEN || "").trim()) {
        return NextResponse.json({ error: "Configure ATTENDANCE_DEVICE_TOKEN to synchronize scans older than three days", status: "device_token_required" }, { status: 403 });
      }
      const respond = async (payload: Record<string, unknown>) => {
        const confirmed = eventId
          ? { ...payload, eventId, recordedAtEpoch: Math.floor(scan.time.getTime() / 1000) }
          : payload;
        if (eventId) {
          await tx.insert(attendanceScanEvents).values({
            eventId, fingerprintId: requestedFinger, capturedMemberId, deviceId,
            scannedAt: scan.time, response: confirmed, receivedAt: scan.arrivedAt,
          });
        }
        return NextResponse.json(confirmed);
      };

      /* ── who is scanning? ──────────────────────────────────────────────── */
      let memberId: number | null = null;
      let memberName = "";
      let fingerId: number | null = null;

      /* The supervisor who opened the door tablet's keypad. Only a PIN entry
       * needs one: the ESP32 posts fingerprints straight here, and that main way
       * in must never wait for a person with a password. */
      let supervisorName: string | null = null;

      if (method === "pin") {
        const supervisor = await requireSupervisor();
        if (!supervisor.ok) return supervisor.response;
        supervisorName = supervisor.session.name;

        // The backup for a wet or dirty finger: name from the dropdown + PIN.
        const id = Number(directMemberId);
        if (!id) return NextResponse.json({ error: "Select a name first", led: "red", buzzer: "error" }, { status: 400 });
        const rows = await tx.select().from(attendanceMembers).where(eq(attendanceMembers.id, id)).limit(1);
        if (rows.length === 0) {
          return NextResponse.json({ error: "That name is not on the attendance list", led: "red", buzzer: "error" }, { status: 404 });
        }
        if (!rows[0].pin) {
          return NextResponse.json(
            { error: `${rows[0].name} has no PIN. Ask the admin to add one.`, led: "red", buzzer: "error" },
            { status: 400 }
          );
        }
        const okPin = await verifySecret(String(pin ?? ""), rows[0].pin);
        if (!okPin) {
          return NextResponse.json({ error: "Incorrect PIN", led: "red", buzzer: "error" }, { status: 401 });
        }
        memberId = rows[0].id;
        memberName = rows[0].name;
      } else {
        if (fingerprintId === undefined || fingerprintId === null) {
          return NextResponse.json({ error: "fingerprintId required", led: "red", buzzer: "error" }, { status: 400 });
        }
        fingerId = Number(fingerprintId);
        const mapping = await tx
          .select()
          .from(attendanceBiometrics)
          .where(eq(attendanceBiometrics.fingerprintId, fingerId))
          .limit(1);
        if (mapping.length === 0) {
          return NextResponse.json(
            { error: "Fingerprint not enrolled", fingerprintId: fingerId, status: "not_found", led: "red", buzzer: "error" },
            { status: 404 }
          );
        }
        if (capturedMemberId !== null && capturedMemberId !== mapping[0].memberId) {
          return NextResponse.json({ error: "Fingerprint mapping changed since this scan; review it before applying", status: "mapping_changed" }, { status: 409 });
        }
        const rows = await tx
          .select()
          .from(attendanceMembers)
          .where(eq(attendanceMembers.id, mapping[0].memberId))
          .limit(1);
        if (rows.length === 0) {
          return NextResponse.json({ error: "Member not found for that fingerprint", led: "red", buzzer: "error" }, { status: 404 });
        }
        memberId = rows[0].id;
        memberName = rows[0].name;
      }

      if (!memberId) {
        return NextResponse.json({ error: "Member not resolved", led: "red", buzzer: "error" }, { status: 400 });
      }

      // Serialize this member's scans from all devices and PIN kiosks. This also
      // prevents two simultaneous first scans creating duplicate day rows.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(17268102, ${memberId})`);

      /* ── the times of his role ─────────────────────────────────────────── */
      const member = await tx.select().from(attendanceMembers).where(eq(attendanceMembers.id, memberId)).limit(1);
      const roleId = member[0]?.roleId ?? null;
      const shifts = await roleShiftsOf(roleId, tx);

      const arrivedAt = scan.arrivedAt;
      const offlineNote = offlineScanNote(scan);

      const todayKey = dayKeyOf(scan.time);
      // `now` is the moment this scan happened: the device's own time when it can
      // be trusted, otherwise the arrival. Everything below - the day row, the
      // IN, the OUT, the late minutes - is counted on it.
      const now = scan.time;
      const nowMinutes = etMinutes(now);
      const clockInShift = pickShift(shifts, nowMinutes);

      const existingLogs = await tx
        .select()
        .from(attendanceLogs)
        .where(and(eq(attendanceLogs.memberId, memberId), eq(attendanceLogs.date, todayKey)))
        .limit(1);

      if (exactTime && existingLogs[0]?.clockIn && now.getTime() < new Date(existingLogs[0].clockIn).getTime()) {
        return NextResponse.json({ error: "An earlier scan arrived after a later attendance entry; review before applying it", status: "out_of_order" }, { status: 409 });
      }

      const base = {
        success: true,
        memberId,
        // `staffName` stays in the answer: the flashed ESP32 reads that field.
        staffName: memberName,
        memberName,
        fingerprintId: fingerId,
        date: todayKey,
        // Who opened the keypad, when this line came in through the backup PIN.
        supervisor: supervisorName,
      };

      /* ── no line yet today: this scan is the IN ────────────────────────── */
      if (existingLogs.length === 0 || !existingLogs[0].clockIn) {
        const inNote = [
          supervisorName ? `PIN keypad opened by supervisor ${supervisorName}` : "",
          offlineNote || "",
        ]
          .filter(Boolean)
          .join(" • ");
        const lateMinutes = lateMinutesFor(clockInShift, nowMinutes);
        const status = lateMinutes > 0 ? "late" : "on_time";
        const inTime = clockLabel(now) || "";
        const values = {
          memberId,
          roleId,
          fingerprintId: fingerId,
          date: todayKey,
          clockIn: now,
          clockInMethod: method,
          lateMinutes,
          status,
          deviceId,
          updatedAt: arrivedAt,
          // The audit the owner asked for: a typed IN names the supervisor who
          // had the door tablet open at that moment, and a scan the device had
          // to keep through an outage names both of its times.
          ...(inNote ? { notes: inNote } : {}),
        };

        const row =
          existingLogs.length === 0
            ? (await tx.insert(attendanceLogs).values(values).returning())[0]
            : (await tx.update(attendanceLogs).set(values).where(eq(attendanceLogs.id, existingLogs[0].id)).returning())[0];

        return respond({
          ...base,
          logId: row.id,
          action: "clock_in",
          clockIn: row.clockIn,
          clockInLabel: inTime,
          lateMinutes,
          status,
          isOvertime: false,
          message: `${memberName} IN ${inTime}${lateMinutes > 0 ? ` • Late ${lateMinutes}m` : ""}`,
          oled: {
            line1: memberName.substring(0, 20),
            line2: `IN ${inTime}`,
            line3: lateMinutes > 0 ? `Late ${lateMinutes}m` : "On Time",
          },
          buzzer: "success_in",
          led: "green",
        });
      }

      const existing = existingLogs[0];

      /* ── already inside: an hour decides between "already" and the OUT ─── */
      if (!existing.clockOut) {
        const minutesSinceIn = Math.round((now.getTime() - new Date(existing.clockIn!).getTime()) / 60000);
        // The rule itself lives in src/lib/attendance.ts, where the guard tests it.
        if (rescanAction(existing.clockIn, now) === "already_registered") {
          const inTime = clockLabel(existing.clockIn) || "";
          const waitMinutes = REPEAT_SCAN_LOCK_MINUTES - minutesSinceIn;
          return respond({
            ...base,
            logId: existing.id,
            success: false,
            action: "already_registered",
            clockIn: existing.clockIn,
            clockInLabel: inTime,
            lateMinutes: existing.lateMinutes || 0,
            status: existing.status,
            message: `${memberName} already registered • IN ${inTime}`,
            oled: {
              line1: memberName.substring(0, 20),
              line2: "Already IN " + inTime,
              line3: `OUT after ${waitMinutes}m`,
            },
            buzzer: "already",
            led: "green",
          });
        }

        // One hour has passed: this scan is the OUT.
        const totalMinutes = Math.round((now.getTime() - new Date(existing.clockIn!).getTime()) / 60000);
        const outNote = [
          existing.notes || "",
          supervisorName ? `OUT by PIN, keypad opened by supervisor ${supervisorName}` : "",
          offlineNote || "",
        ]
          .filter(Boolean)
          .join(" • ");
        const inShift =
          pickShift(shifts, etMinutes(existing.clockIn!)) || clockInShift;
        const early = isEarlyOut(inShift, nowMinutes);
        // THE MINUTES, not only the flag. Payroll deducts an early departure per
        // minute, and until 2026-10-22 the column was never written, so the early
        // departure deduction could never fire. Inside the role's leaving grace
        // this is 0: leaving a few minutes before the end costs nothing.
        const earlyMinutes = earlyOutMinutesFor(inShift, nowMinutes);
        const status = early ? "early_out" : "completed";

        // THE AUTOMATIC SHIFT OT (owner, 2026-10-28: "the time more than 8 hour
        // is automatically considered shift ot"). The closing tap measures the
        // worked time BEYOND the person's own shift length, so covering a second
        // shift is paid even when the first IN was inside its late grace. The
        // first 1:15 past the shift is transfer / changing clothes, not work.
        // 0 means "he went home inside the 1:15 buffer".
        const shiftOtMinutes = workedShiftOtMinutes(inShift, existing.clockIn, now);

        const row = (
          await tx
            .update(attendanceLogs)
            .set({
              clockOut: now,
              clockOutMethod: method,
              totalMinutes,
              status,
              earlyOut: early,
              earlyOutMinutes: earlyMinutes,
              // Staying past the shift is overtime whether or not anybody pressed
              // the button, and the sheet's violet box follows the row.
              isOvertime: Boolean(existing.isOvertime) || shiftOtMinutes > 0,
              updatedAt: arrivedAt,
              // Same audit as the IN: an OUT typed on the keypad names the
              // supervisor, and keeps whatever the IN already recorded.
              ...(outNote ? { notes: outNote } : {}),
            })
            .where(eq(attendanceLogs.id, existing.id))
            .returning()
        )[0];

        const outTime = clockLabel(now) || "";
        const hours = hoursLabel(totalMinutes) || "";

        // The row itself is written after the line, and a number somebody typed
        // for that day is never overwritten by the stopwatch.
        const overtimeMinutes = await recordShiftOvertimeAtClockOut({
          memberId: row.memberId ?? 0,
          date: row.date,
          logId: row.id,
          shift: inShift,
          clockInAt: existing.clockIn,
          clockOutAt: now,
        }, tx);
        const otLabel = overtimeMinutes > 0 ? hoursLabel(overtimeMinutes) || "" : "";

        return respond({
          ...base,
          logId: row.id,
          action: "clock_out",
          clockIn: existing.clockIn,
          clockInLabel: clockLabel(existing.clockIn),
          clockOut: row.clockOut,
          clockOutLabel: outTime,
          totalMinutes,
          totalHours: hours,
          earlyOut: early,
          earlyOutMinutes: earlyMinutes,
          isOvertime: Boolean(row.isOvertime),
          overtimeMinutes,
          overtimeLabel: otLabel || null,
          status,
          message: `${memberName} OUT ${outTime} • ${hours}${otLabel ? ` • OT ${otLabel}` : ""}${early ? ` • Early out ${earlyMinutes}m` : ""}`,
          oled: {
            line1: memberName.substring(0, 20),
            line2: `OUT ${outTime}`,
            line3: otLabel ? `OT ${otLabel}` : early ? `Early out ${hours}` : hours,
          },
          buzzer: "success_out",
          led: "green",
        });
      }

      /* ── the day is already closed ─────────────────────────────────────── */
      const totalMinutes = existing.totalMinutes || 0;
      return respond({
        ...base,
        logId: existing.id,
        success: false,
        action: "already_registered",
        clockIn: existing.clockIn,
        clockInLabel: clockLabel(existing.clockIn),
        clockOut: existing.clockOut,
        clockOutLabel: clockLabel(existing.clockOut),
        totalMinutes,
        totalHours: hoursLabel(totalMinutes) || "",
        status: existing.status,
        message: `${memberName} already registered today`,
        oled: {
          line1: memberName.substring(0, 20),
          line2: "Already done",
          line3: hoursLabel(totalMinutes) || "",
        },
        buzzer: "already",
        led: "green",
      });
    });
    if (response.status === 200) publish(CHANNELS.attendance);
    return response;
  } catch (error) {
    console.error("Attendance clock error:", error);
    return NextResponse.json(
      { error: String(error), status: "error", led: "red", buzzer: "error" },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  await ensureTablesExist();
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") || getTodayKey();

  try {
    const logs = await db.select().from(attendanceLogs).where(eq(attendanceLogs.date, date));
    const members = await db.select().from(attendanceMembers);
    const nameOf = new Map(members.map((m) => [m.id, m.name]));

    return NextResponse.json(
      logs.map((l) => ({
        ...l,
        staffName: l.memberId ? nameOf.get(l.memberId) || `Member ${l.memberId}` : `Staff ${l.staffId}`,
        clockInLabel: clockLabel(l.clockIn),
        clockOutLabel: clockLabel(l.clockOut),
      }))
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
