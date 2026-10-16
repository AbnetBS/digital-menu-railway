import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  attendanceBiometrics,
  attendanceLogs,
  attendanceMembers,
  attendanceRoleShifts,
} from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { verifySecret } from "@/lib/auth";
import { deviceAllowed } from "@/lib/attendance-device";
import { requireSupervisor } from "@/lib/session";
import { publish, CHANNELS } from "@/lib/realtime";
import { and, eq } from "drizzle-orm";
import { etDayKey } from "@/lib/timezone";
import {
  REPEAT_SCAN_LOCK_MINUTES,
  clockLabel,
  etMinutes,
  hoursLabel,
  isEarlyOut,
  lateMinutesFor,
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
 *   • LATE: 15 minutes after the entrance time of the role he belongs to
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
 * the one-hour repeat lock. Only the DEVICE may say when a scan happened, and
 * only inside the limits in src/lib/attendance.ts (never in the future, never
 * older than three days); a PIN typed in a browser always counts as now. The
 * arrival time is written to `updated_at` and to the notes, so nothing hides.
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
async function roleShiftsOf(roleId: number | null): Promise<RoleShift[]> {
  if (!roleId) return [];
  try {
    const rows = await db.select().from(attendanceRoleShifts).where(eq(attendanceRoleShifts.roleId, roleId));
    return rows
      .map((r) => ({ label: r.label, startTime: r.startTime, endTime: r.endTime }))
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
    } = body;

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
      const rows = await db.select().from(attendanceMembers).where(eq(attendanceMembers.id, id)).limit(1);
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
      const mapping = await db
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
      const rows = await db
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

    /* ── the times of his role ─────────────────────────────────────────── */
    const member = await db.select().from(attendanceMembers).where(eq(attendanceMembers.id, memberId)).limit(1);
    const roleId = member[0]?.roleId ?? null;
    const shifts = await roleShiftsOf(roleId);

    /* Only the door device may back-date a scan: it is the one that keeps a
     * scan through an outage. A PIN typed in a browser (or a correction typed
     * by the admin) always counts as now, so nobody can write history by
     * sending a time. deviceAllowed() is the same check the rest of the
     * device routes use, and scannedTimeOf() refuses a future moment and one
     * older than three days. */
    const scan = scannedTimeOf(
      method === "fingerprint" && deviceAllowed(request) ? scannedAt : undefined
    );
    const arrivedAt = scan.arrivedAt;
    const offlineNote = offlineScanNote(scan);

    const todayKey = dayKeyOf(scan.time);
    // `now` is the moment this scan happened: the device's own time when it can
    // be trusted, otherwise the arrival. Everything below - the day row, the
    // IN, the OUT, the late minutes - is counted on it.
    const now = scan.time;
    const nowMinutes = etMinutes(now);
    const clockInShift = pickShift(shifts, nowMinutes);

    const existingLogs = await db
      .select()
      .from(attendanceLogs)
      .where(and(eq(attendanceLogs.memberId, memberId), eq(attendanceLogs.date, todayKey)))
      .limit(1);

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
          ? (await db.insert(attendanceLogs).values(values).returning())[0]
          : (await db.update(attendanceLogs).set(values).where(eq(attendanceLogs.id, existingLogs[0].id)).returning())[0];

      // A scan just happened: tell the kiosk/admin sheets to refresh (SSE).
      publish(CHANNELS.attendance);

      return NextResponse.json({
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
        publish(CHANNELS.attendance);
        return NextResponse.json({
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
      const status = early ? "early_out" : "completed";

      const row = (
        await db
          .update(attendanceLogs)
          .set({
            clockOut: now,
            clockOutMethod: method,
            totalMinutes,
            status,
            earlyOut: early,
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

      publish(CHANNELS.attendance);

      return NextResponse.json({
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
        isOvertime: Boolean(row.isOvertime),
        status,
        message: `${memberName} OUT ${outTime} • ${hours}${early ? " • Early out" : ""}`,
        oled: {
          line1: memberName.substring(0, 20),
          line2: `OUT ${outTime}`,
          line3: early ? `Early out ${hours}` : hours,
        },
        buzzer: "success_out",
        led: "green",
      });
    }

    /* ── the day is already closed ─────────────────────────────────────── */
    const totalMinutes = existing.totalMinutes || 0;
    publish(CHANNELS.attendance);
    return NextResponse.json({
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
