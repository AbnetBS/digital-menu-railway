import { NextResponse } from "next/server";
import { db } from "@/db";
import { attendanceFreeSchedules, attendanceMembers } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { and, asc, eq } from "drizzle-orm";
import { parseHHMM } from "@/lib/attendance";
import { ethiopianDateToGregorian, gregorianDateToEthiopian } from "@/lib/payroll";
import { ANNUAL_LEAVE_MAX_DAYS, FREE_SCHEDULE_TYPES, leaveDays } from "@/lib/free-schedule";

/**
 * THE FREE SCHEDULE (owner, Oct 2026)
 *
 * Three kinds, one table:
 *
 *   weekly   a repeating free weekday (his "repeating free week day")
 *   dated    one specific free date
 *   annual   "ye amet ereft": yearly free days, given as from-to so the run
 *            and the number of days can differ per person
 *
 * A free day is never an absence, so no absence money is taken for it. A
 * ye amet ereft day is also paid as if the person worked it (the owner:
 * "their payment is safe like they work"), which is why it is stored as a
 * paid run instead of being counted day by day.
 */

type FreeRow = {
  freeDate: string | null;
  freeUntil: string | null;
  scheduleType: string;
};

function withEthiopianDates<T extends FreeRow>(row: T) {
  return {
    ...row,
    freeDateEc: row.freeDate ? gregorianDateToEthiopian(row.freeDate) : null,
    freeUntilEc: row.freeUntil ? gregorianDateToEthiopian(row.freeUntil) : null,
    days: row.scheduleType === "annual" ? leaveDays(row.freeDate, row.freeUntil) : null,
  };
}

export async function GET(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  const id = Number(new URL(request.url).searchParams.get("memberId"));
  if (!id) return NextResponse.json({ error: "memberId required" }, { status: 400 });
  const rows = await db
    .select()
    .from(attendanceFreeSchedules)
    .where(eq(attendanceFreeSchedules.memberId, id))
    .orderBy(asc(attendanceFreeSchedules.id));
  return NextResponse.json(rows.map(withEthiopianDates));
}

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();

  const body = await request.json().catch(() => ({}));
  const memberId = Number(body.memberId);
  const scheduleType = String(body.scheduleType || "");
  const weekday = body.weekday === undefined || body.weekday === null ? null : Number(body.weekday);
  const freeDateInput = String(body.freeDate || "").trim();
  const freeUntilInput = String(body.freeUntil || "").trim();
  const startTime = String(body.startTime || "00:00");
  const endTime = String(body.endTime || "23:59");
  const note = String(body.note || "").trim();

  if (!memberId || !(FREE_SCHEDULE_TYPES as readonly string[]).includes(scheduleType))
    return NextResponse.json({ error: "Employee and free day type required" }, { status: 400 });
  if (parseHHMM(startTime) === null || parseHHMM(endTime) === null)
    return NextResponse.json({ error: "Valid start and end times required" }, { status: 400 });
  if (scheduleType === "weekly" && (!Number.isInteger(weekday) || Number(weekday) < 0 || Number(weekday) > 6))
    return NextResponse.json({ error: "Select a weekday" }, { status: 400 });

  let freeDate: string | null = null;
  let freeUntil: string | null = null;

  if (scheduleType === "dated") {
    try {
      freeDate = ethiopianDateToGregorian(freeDateInput);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Select an Ethiopian date" }, { status: 400 });
    }
  }
  if (scheduleType === "annual") {
    // THE RUN: both ends are his, because the leave and its length differ per
    // person. A run of one day is allowed (a single yearly day).
    try {
      freeDate = ethiopianDateToGregorian(freeDateInput);
      freeUntil = ethiopianDateToGregorian(freeUntilInput || freeDateInput);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Give the first and the last Ethiopian date of the leave" },
        { status: 400 }
      );
    }
    if (freeUntil < freeDate)
      return NextResponse.json({ error: "The last day of the leave cannot be before the first day" }, { status: 400 });
    if (leaveDays(freeDate, freeUntil) > ANNUAL_LEAVE_MAX_DAYS)
      return NextResponse.json({ error: `One leave entry can cover at most ${ANNUAL_LEAVE_MAX_DAYS} days` }, { status: 400 });
  }

  const exists = await db.select({ id: attendanceMembers.id }).from(attendanceMembers).where(eq(attendanceMembers.id, memberId)).limit(1);
  if (!exists.length) return NextResponse.json({ error: "Employee not found" }, { status: 404 });

  const row = (
    await db
      .insert(attendanceFreeSchedules)
      .values({
        memberId,
        scheduleType,
        weekday: scheduleType === "weekly" ? weekday : null,
        freeDate,
        freeUntil: scheduleType === "annual" ? freeUntil : null,
        // Ye amet ereft is whole days: the whole day is free, so the salary
        // stays safe from 00:00 to 23:59 and no hour can be "missed".
        startTime: scheduleType === "annual" ? "00:00" : startTime,
        endTime: scheduleType === "annual" ? "23:59" : endTime,
        note,
      })
      .returning()
  )[0];

  return NextResponse.json(withEthiopianDates(row as unknown as FreeRow));
}

export async function DELETE(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));
  const memberId = Number(url.searchParams.get("memberId"));
  if (!id || !memberId) return NextResponse.json({ error: "id and memberId required" }, { status: 400 });
  await db
    .delete(attendanceFreeSchedules)
    .where(and(eq(attendanceFreeSchedules.id, id), eq(attendanceFreeSchedules.memberId, memberId)));
  return NextResponse.json({ success: true });
}
