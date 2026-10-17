import { db } from "@/db";
import { attendanceOvertime } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { shiftOtMinutesFor, type OvertimeSource, type OvertimeType, type RoleShift } from "@/lib/attendance";

/**
 * THE OVERTIME ROWS (owner, Oct 2026) — the one place that writes
 * `attendance_overtime`, so the admin tab, the door tablet and the clock-out
 * scan cannot disagree about what "the same overtime twice" means.
 *
 * A row is (member, day, kind, shift). Writing that same row again UPDATES it
 * instead of counting the hours a second time, which is what makes the
 * tablet's Overtime button safe to tap twice and what lets an admin correct a
 * number without hunting for the old one.
 *
 * An "auto" row — the Shift OT the device stamps when a person is still in the
 * building more than an hour and a half after his shift ends — never overwrites
 * a number a person typed for that day: a supervisor standing at the tablet
 * knows something the stopwatch does not. The other way round an auto row
 * freely replaces its own previous value, because a re-scan of the same OUT is
 * the same measurement.
 *
 * There is no approval column on purpose (owner: the row must "list
 * immediately"). A row is the decision.
 */

export type OvertimeRow = typeof attendanceOvertime.$inferSelect;

export type SaveOvertimeInput = {
  memberId: number;
  /** YYYY-MM-DD in Africa/Addis_Ababa, the same key the sheet uses. */
  date: string;
  type: OvertimeType;
  /** The shift the hours belong to, or null for "the day as a whole". */
  shiftLabel: string | null;
  minutes: number;
  source: OvertimeSource;
  enteredBy?: string | null;
  logId?: number | null;
  note?: string | null;
};

/** Every row of this exact (member, day, kind) — the shift part is decided by
 *  the caller, because "no shift picked" also means "whatever shift I wrote
 *  before is the same thing". */
async function rowsOfSameKind(key: {
  memberId: number;
  date: string;
  type: OvertimeType;
}): Promise<OvertimeRow[]> {
  return db
    .select()
    .from(attendanceOvertime)
    .where(
      and(
        eq(attendanceOvertime.memberId, key.memberId),
        eq(attendanceOvertime.date, key.date),
        eq(attendanceOvertime.type, key.type)
      )
    )
    .orderBy(desc(attendanceOvertime.id))
    .limit(8);
}

/**
 * Write one overtime row. `replaced` says whether an existing row was updated
 * rather than a new one inserted, which is what the tablet shows as
 * "corrected to …" instead of "saved …".
 */
export async function saveOvertimeRow(
  input: SaveOvertimeInput
): Promise<{ row: OvertimeRow; replaced: boolean }> {
  const existing = await rowsOfSameKind(input);
  const same =
    existing.find((r) => (r.shiftLabel ?? null) === input.shiftLabel) ??
    // "no shift picked" replaces whatever the same kind already had, so a tap
    // at the door after a scan never leaves two rows for the same thing.
    (input.shiftLabel === null ? existing[0] : undefined);

  if (same) {
    const row = (
      await db
        .update(attendanceOvertime)
        .set({
          minutes: input.minutes,
          source: input.source,
          enteredBy: input.enteredBy ?? null,
          note: input.note ?? null,
          logId: input.logId ?? null,
        })
        .where(eq(attendanceOvertime.id, same.id))
        .returning()
    )[0];
    return { row, replaced: true };
  }

  const row = (
    await db
      .insert(attendanceOvertime)
      .values({
        memberId: input.memberId,
        date: input.date,
        type: input.type,
        minutes: input.minutes,
        shiftLabel: input.shiftLabel,
        logId: input.logId ?? null,
        source: input.source,
        enteredBy: input.enteredBy ?? null,
        note: input.note ?? null,
        createdAt: new Date(),
      })
      .returning()
  )[0];
  return { row, replaced: false };
}

/**
 * THE AUTOMATIC SHIFT OT (owner, Oct 2026: "if someone stay after his shift
 * 1.30 it is overtime"). Called with the OUT the clock route just wrote: the
 * overtime is the minutes past the end of the shift, and nothing is written
 * when the person was away within the hour and a half.
 *
 * Returns the minutes it recorded, so the device's answer can say
 * "Overtime 2h 10m" on the same tap.
 */
export async function recordShiftOvertimeAtClockOut(args: {
  memberId: number;
  date: string;
  logId: number;
  shift: RoleShift | null | undefined;
  clockOutAt: Date;
}): Promise<number> {
  const minutes = shiftOtMinutesFor(args.shift, args.clockOutAt);
  if (!args.memberId || minutes <= 0) return 0;

  const shiftLabel = args.shift?.label ?? null;
  const existing = await rowsOfSameKind({ memberId: args.memberId, date: args.date, type: "shift" });

  // Somebody typed this day already? His number stands: a supervisor at the
  // tablet knows more than the stopwatch does.
  const typed = existing.find((r) => r.source !== "auto" && (r.shiftLabel ?? null) === shiftLabel);
  if (typed) return 0;

  // Ourselves from a moment ago (the same OUT measured again): restate it.
  const mine = existing.find((r) => r.source === "auto" && (r.shiftLabel ?? null) === shiftLabel);
  if (mine) {
    await db
      .update(attendanceOvertime)
      .set({ minutes, logId: args.logId, enteredBy: "clock-out scan" })
      .where(eq(attendanceOvertime.id, mine.id));
    return minutes;
  }

  await db.insert(attendanceOvertime).values({
    memberId: args.memberId,
    date: args.date,
    type: "shift",
    minutes,
    shiftLabel,
    logId: args.logId,
    source: "auto",
    enteredBy: "clock-out scan",
    note: null,
    createdAt: new Date(),
  });
  return minutes;
}
