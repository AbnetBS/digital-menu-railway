/**
 * THE ATTENDANCE SUPERVISOR (owner, Oct 2026).
 *
 * The owner's worry about the backup way in: "even tho the 2nd option is good
 * it is risky since someone can write for them". So the name + PIN keypad on
 * the door tablet (/attendance) is now behind a login of its own:
 *
 *   1. A person whose finger does not work asks the supervisor.
 *   2. The supervisor picks his own name, types the supervisor PIN, and the
 *      keypad unlocks for TWO MINUTES.
 *   3. Every touch of the keypad starts those two minutes again. When nothing
 *      happens for two minutes the tablet locks itself and asks again.
 *   4. The fingerprint scanner is untouched: the ESP32 posts its scans
 *      straight to /api/attendance/clock, so the main way in never needs a
 *      supervisor and the door never queues behind one.
 *
 * WHO IS A SUPERVISOR: a normal Staff Account (admin -> Staff Accounts) with
 * the role below. It is a station login like any other, so the owner hands the
 * PIN to one or two people he trusts and can take it away by editing the card.
 * The role is in STAFF_ROLES (src/lib/stations.ts), which is the whitelist the
 * staff API stores.
 *
 * This module is deliberately PURE: no database, no Next.js, no React. The
 * session itself is signed in src/lib/session.ts and checked by
 * /api/attendance/supervisor and by the PIN branch of /api/attendance/clock.
 */
import { SUPERVISOR_IDLE_TIMEOUT_MINUTES, countdownLabel, supervisorIdleExpired } from "@/lib/attendance";

/** The Staff Accounts role that may unlock the door tablet's PIN keypad. */
export const ATTENDANCE_SUPERVISOR_ROLE = "attendance_supervisor";

/** How the role reads on the door tablet and in the admin dropdown. */
export const ATTENDANCE_SUPERVISOR_LABEL = "Attendance Supervisor (/attendance)";

/** Two minutes, in milliseconds: the tablet locks after this much inactivity. */
export const SUPERVISOR_IDLE_TIMEOUT_MS = SUPERVISOR_IDLE_TIMEOUT_MINUTES * 60 * 1000;

/**
 * The cookie lives exactly as long as the idle window and is re-issued on
 * every unlock and on every activity the tablet reports, so the server refuses
 * a PIN clock-in the moment the tablet would have locked itself.
 */
export const SUPERVISOR_SESSION_TTL_SECONDS = Math.round(SUPERVISOR_IDLE_TIMEOUT_MS / 1000);

export { countdownLabel, supervisorIdleExpired };

/**
 * What the tablet shows next to the countdown. Kept here so the words on the
 * door and the words in the regression guard cannot drift apart.
 */
export const SUPERVISOR_LOCKED_TITLE = "Supervisor login required";
export const SUPERVISOR_LOCKED_HINT =
  "The fingerprint scanner keeps working. Only the backup PIN keypad is locked: ask the attendance supervisor.";
