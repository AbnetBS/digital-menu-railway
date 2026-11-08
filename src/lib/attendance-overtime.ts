import { db } from "@/db";
import { attendanceOvertime } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { shiftOtMinutesFor, workedShiftOtMinutes, type OvertimeSource, type OvertimeType, type RoleShift } from "@/lib/attendance";

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
 * building more than an hour after his shift ends — never overwrites
 * a number a person typed for that day: a supervisor standing at the tablet
 * knows something the stopwatch does not. The other way round an auto row
 * freely replaces its own previous value, because a re-scan of the same OUT is
 * the same measurement.
 *
 * There is no approval column on purpose (owner: the row must "list
 * immediately"). A row is the decision.
 */

export type OvertimeRow = typeof attendanceOvertime.$inferSelect;
// A Drizzle transaction has the same query methods needed by this module.
// The clock route supplies one so attendance, overtime and its receipt commit
// (or roll back) as a single unit.
type OvertimeDb = Pick<typeof db, "select" | "update" | "insert">;

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
}, client: OvertimeDb = db): Promise<OvertimeRow[]> {
  return client
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
 * THE AUTOMATIC SHIFT OT (owner, 2026-10-28, TURNED OFF 2026-11-07).
 *
 * It used to write a paid Shift OT row by itself at clock-out. The owner
 * changed that rule: "i dont want the system to add overtime but the paper
 * sheet ... when someone works and goes out at a certain time and that time is
 * closer to the afternoon leaving time the system will make it current ot
 * status which is purple just to identify that person stayed up to the next
 * shift ... only made the box ot color only, it is given by manually ot".
 *
 * So the function stays as the one place a caller could still record it, but
 * it writes NOTHING unless AUTO_SHIFT_OT is switched on again. The violet mark
 * on the paper sheet is produced by stayedIntoNextShift() in lib/attendance.ts
 * and costs no money. Overtime that is paid is the overtime the owner (or a
 * supervisor on the keypad) types in Attendance > Overtime or in the payroll.
 */
export const AUTO_SHIFT_OT_ENABLED = false;

/**
 * Called with the IN and OUT the clock route just wrote. With
 * AUTO_SHIFT_OT_ENABLED false it records nothing and returns 0, so the scans
 * and the salary can never be changed behind the owner's back.
 */
export async function recordShiftOvertimeAtClockOut(args: {
  memberId: number;
  date: string;
  logId: number;
  shift: RoleShift | null | undefined;
  clockInAt?: Date | null;
  clockOutAt: Date;
}, client: OvertimeDb = db): Promise<number> {
  if (!AUTO_SHIFT_OT_ENABLED) return 0;
  const minutes = args.clockInAt
    ? workedShiftOtMinutes(args.shift, args.clockInAt, args.clockOutAt)
    : shiftOtMinutesFor(args.shift, args.clockOutAt);
  if (!args.memberId || minutes <= 0) return 0;

  const shiftLabel = args.shift?.label ?? null;
  const existing = await rowsOfSameKind({ memberId: args.memberId, date: args.date, type: "shift" }, client);

  // Somebody typed this day already? His number stands: a supervisor at the
  // tablet knows more than the stopwatch does.
  const typed = existing.find((r) => r.source !== "auto" && (r.shiftLabel ?? null) === shiftLabel);
  if (typed) return 0;

  // Ourselves from a moment ago (the same OUT measured again): restate it.
  const mine = existing.find((r) => r.source === "auto" && (r.shiftLabel ?? null) === shiftLabel);
  if (mine) {
    await client
      .update(attendanceOvertime)
      .set({ minutes, logId: args.logId, enteredBy: "clock-out scan" })
      .where(eq(attendanceOvertime.id, mine.id));
    return minutes;
  }

  await client.insert(attendanceOvertime).values({
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
