/**
 * THE ATTENDANCE SUPERVISOR (owner, Oct 2026).
 *
 * The owner's worry about the backup way in: "even tho the 2nd option is good
 * it is risky since someone can write for them". So the name + PIN keypad on
 * the door tablet (/attendance) sits behind a login of its own:
 *
 *   1. A person whose finger does not work asks the supervisor.
 *   2. The supervisor picks his own name, types the supervisor PIN, and the
 *      keypad opens.
 *   3. It stays open until somebody presses "Lock now" on the tablet.
 *   4. The fingerprint scanner is untouched: the ESP32 posts its scans
 *      straight to /api/attendance/clock, so the main way in never needs a
 *      supervisor and the door never queues behind one.
 *
 * STEP 3 USED TO BE "the keypad locks itself two minutes after the last
 * touch". The owner asked for that window to go (2026-10-16: "remove the 2 min
 * section in 2nd pin attendance option because it doesnt have benefit"): with a
 * queue at the door it only ever made people re-do a login, and it never was
 * the actual protection - the protection is that whoever types a name still has
 * to know that person's own PIN, and the supervisor standing there is the one
 * pressing "Lock now" when the shift is over.
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

/** The Staff Accounts role that may unlock the door tablet's PIN keypad. */
export const ATTENDANCE_SUPERVISOR_ROLE = "attendance_supervisor";

/** How the role reads on the door tablet and in the admin dropdown. */
export const ATTENDANCE_SUPERVISOR_LABEL = "Attendance Supervisor (/attendance)";

/**
 * How long an unlock is accepted by the server. There is no idle window any
 * more, so this is only the life of the cookie: long enough that a tablet
 * rebooted overnight does not ask for the supervisor PIN for no reason. What
 * ends an unlock is the "Lock now" button on the tablet (DELETE below), which
 * is a person's decision, not a stopwatch.
 */
export const SUPERVISOR_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * What the tablet shows while the keypad is locked. Kept here so the words on
 * the door and the words in the regression guard cannot drift apart.
 */
export const SUPERVISOR_LOCKED_TITLE = "Supervisor login required";
export const SUPERVISOR_LOCKED_HINT =
  "The fingerprint scanner keeps working. Only the backup PIN keypad is locked: ask the attendance supervisor.";
