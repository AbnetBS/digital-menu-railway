import { pool } from "@/db";
import { ensureTablesExist } from "@/db/migrate";
import { monthAttendanceEvents } from "@/lib/attendance-month-events";
import { gregorianDateToEthiopian } from "@/lib/payroll";
import { sendPushToEndpoint, type PushPayload } from "@/lib/push";
import { etDayKey, etDayKeyDaysAgo } from "@/lib/timezone";

export const REMINDER_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DECIDE_URL = "/admin?tab=attendance&view=decisions";

/** How many items of one Gregorian day still wait for a decision (same rule as the Decide screen). */
export async function waitingDecisionCount(day: string): Promise<number> {
  const period = gregorianDateToEthiopian(day).slice(0, 7);
  const month = await monthAttendanceEvents(period);
  return month.events.filter((e) => e.date === day && e.type !== "shortage" && e.status === "pending").length;
}

/** HH:MM in Addis Ababa, 24-hour. */
export function addisHhmm(now: Date): string {
  return now.toLocaleTimeString("en-GB", {
    timeZone: "Africa/Addis_Ababa",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Sends each due reminder once per day, when its time has come, and only when
 * yesterday still has items waiting. Nothing waiting = nothing sent, the day is
 * marked done. A send that the push service refuses is tried again next minute.
 */
export async function runDueDecisionReminders(now: Date = new Date()): Promise<{ checked: number; sent: number }> {
  await ensureTablesExist();
  const today = etDayKey(now) as string;
  const yesterday = etDayKeyDaysAgo(1) as string;
  const due = await pool.query<{ endpoint: string }>(
    `SELECT endpoint FROM attendance_decision_reminders
      WHERE enabled = true AND time_hhmm <= $1 AND (last_sent_on IS NULL OR last_sent_on <> $2)`,
    [addisHhmm(now), today]
  );
  if (due.rows.length === 0) return { checked: 0, sent: 0 };

  const waiting = await waitingDecisionCount(yesterday);
  let sent = 0;
  for (const row of due.rows) {
    if (waiting === 0) {
      await pool.query("UPDATE attendance_decision_reminders SET last_sent_on=$2 WHERE endpoint=$1", [row.endpoint, today]);
      continue;
    }
    const payload: PushPayload = {
      title: "Decide deductions",
      body: `${waiting} action${waiting === 1 ? "" : "s"} to decide from yesterday. Tap to review.`,
      tag: "attendance-decide",
      url: DECIDE_URL,
      urgent: true,
    };
    const result = await sendPushToEndpoint(row.endpoint, payload);
    // Done for today when the phone accepted it, or when it has no live
    // subscription any more (retrying every minute would never succeed).
    if (result.sent > 0 || result.noSubscribers) {
      await pool.query("UPDATE attendance_decision_reminders SET last_sent_on=$2 WHERE endpoint=$1", [row.endpoint, today]);
    }
    if (result.sent > 0) sent++;
  }
  return { checked: due.rows.length, sent };
}
