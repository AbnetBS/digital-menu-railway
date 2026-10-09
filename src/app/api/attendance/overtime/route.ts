import { NextResponse } from "next/server";
import { db } from "@/db";
import { attendanceLogs, attendanceMembers } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { deviceAllowed } from "@/lib/attendance-device";
import { and, desc, eq } from "drizzle-orm";
import { etDayKey } from "@/lib/timezone";
import { clockLabel } from "@/lib/attendance";

/**
 * THE OVERTIME BUTTON (owner, Oct 2026: "when someone scans his fingerprint,
 * if it is overtime they click that button, then the system knows").
 *
 * The person scans as usual, then presses Overtime on the door tablet; today's
 * line is flagged, and the paper sheet colours that box in its own colour
 * (violet) next to late, on time and early out.
 *
 * Who may call it: the door tablet, which has no login of its own (exactly
 * like /api/attendance/clock), or an admin session. If the owner sets
 * ATTENDANCE_DEVICE_TOKEN, the tablet must carry it.
 */

function getTodayKey(): string {
  return etDayKey(new Date()) || new Date().toISOString().slice(0, 10);
}

export async function POST(request: Request) {
  const device = deviceAllowed(request);
  const auth = await requireAdmin();
  if (!device && !auth.ok) return auth.response;

  await ensureTablesExist();

  try {
    const body = await request.json().catch(() => ({}));
    const clear = String(body.action ?? "") === "clear";
    const todayKey = String(body.date ?? "") || getTodayKey();

    // Which line? The one the tablet knows (logId), or the person's line today.
    let log = null as (typeof attendanceLogs.$inferSelect) | null;

    const logId = Number(body.logId ?? 0);
    const memberId = Number(body.memberId ?? 0);

    if (logId) {
      const rows = await db.select().from(attendanceLogs).where(eq(attendanceLogs.id, logId)).limit(1);
      log = rows[0] ?? null;
    } else if (memberId) {
      const rows = await db
        .select()
        .from(attendanceLogs)
        .where(and(eq(attendanceLogs.memberId, memberId), eq(attendanceLogs.date, todayKey)))
        .orderBy(desc(attendanceLogs.id))
        .limit(1);
      log = rows[0] ?? null;
    } else {
      return NextResponse.json({ error: "memberId or logId required" }, { status: 400 });
    }

    if (!log) {
      return NextResponse.json(
        { error: "No scan for today yet. Scan the fingerprint first, then press Overtime." },
        { status: 404 }
      );
    }

    const updated = (
      await db
        .update(attendanceLogs)
        .set({ isOvertime: !clear, updatedAt: new Date() })
        .where(eq(attendanceLogs.id, log.id))
        .returning()
    )[0];

    const members = await db.select().from(attendanceMembers);
    const nameOf = new Map(members.map((m) => [m.id, m.name]));
    const memberName = updated.memberId ? nameOf.get(updated.memberId) || `Member ${updated.memberId}` : "Member";

    return NextResponse.json({
      success: true,
      logId: updated.id,
      memberId: updated.memberId,
      memberName,
      isOvertime: Boolean(updated.isOvertime),
      clockInLabel: clockLabel(updated.clockIn),
      clockOutLabel: clockLabel(updated.clockOut),
      message: clear
        ? `${memberName} is no longer marked as overtime`
        : `Overtime saved for ${memberName}`,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
