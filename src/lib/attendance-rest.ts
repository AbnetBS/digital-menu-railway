import { db } from "@/db";
import { attendanceEnrollJobs, siteSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { REST_WAKE_KEY, restSliceSeconds } from "@/lib/attendance";

/**
 * "START WORKING NOW" for a scanner that is allowed to sleep (owner, Oct 2026).
 *
 * The owner's words: "i want the system to start working if he changes the time
 * for that particular person to register". A board in its rest hours cannot
 * hear a push, a socket or a knock, so this module leaves one small sign that a
 * resting board reads the next time it wakes: a stamp saying the hours were just
 * changed. While the stamp is young the device shortens its own sleep to about
 * 45 seconds instead of ten minutes, which is how an edit reaches the door in
 * well under a minute without adding hardware, a second channel or a wire.
 *
 * Nothing here can fail a request: the stamp is a hint, not a record. If it
 * cannot be written, the board simply takes its normal long sleep and the change
 * still lands at the next wake.
 */

export type RestWakeHint = {
  /** When an admin last changed the hours, if at all. */
  wakeRequestedAt: string | null;
  /** Whether somebody is expected at the sensor to register a finger. */
  jobWaiting: boolean;
  /** What the device is told to sleep for, in seconds, already clamped. */
  sliceSeconds: number;
};

/** Leave the sign. Called by every write on the Activity panel and by an
 * "Add Fingerprint" job, which is the case the owner named. */
export async function markRestWakeRequested(): Promise<void> {
  const value = new Date().toISOString();
  try {
    await db
      .insert(siteSettings)
      .values({ key: REST_WAKE_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: new Date() } });
  } catch {
    // A stamp is a hint about eagerness, never a reason to fail a save.
  }
}

/** Read the sign, plus whether a finger job is waiting, for a device answer. */
export async function readRestWakeHint(now: Date = new Date()): Promise<RestWakeHint> {
  let wakeRequestedAt: string | null = null;
  let jobWaiting = false;
  try {
    const stamped = await db
      .select({ value: siteSettings.value })
      .from(siteSettings)
      .where(eq(siteSettings.key, REST_WAKE_KEY))
      .limit(1);
    wakeRequestedAt = stamped[0]?.value ?? null;
  } catch {
    // No settings row, no table: the device sleeps its normal length.
  }
  try {
    const waiting = await db
      .select({ id: attendanceEnrollJobs.id })
      .from(attendanceEnrollJobs)
      .where(eq(attendanceEnrollJobs.status, "pending"))
      .limit(1);
    jobWaiting = waiting.length > 0;
  } catch {
    // The job table is not there yet: nothing is waiting as far as we know.
  }
  return {
    wakeRequestedAt,
    jobWaiting,
    sliceSeconds: restSliceSeconds({ wakeRequestedAt: jobWaiting ? null : wakeRequestedAt, jobWaiting, now }),
  };
}
