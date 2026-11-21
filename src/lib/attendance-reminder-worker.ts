import { ensureTablesExist } from "@/db/migrate";
import { runDueDecisionReminders } from "@/lib/attendance-reminders";

/**
 * Decide-deductions notification worker. Same pattern as the day-close worker:
 * it runs in the server process every minute, so the notification arrives at
 * the chosen time even when nobody has the Attendance page open.
 */
const POLL_MS = 60 * 1000;

export function startAttendanceReminderWorker() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await ensureTablesExist();
      await runDueDecisionReminders();
    } catch (error) {
      console.error("[decide-reminder] check failed", error);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), POLL_MS);
  if (typeof timer.unref === "function") timer.unref();
}
