/**
 * THE DOOR DEVICE (ESP32 + FPC1020A) AND THE SERVER.
 *
 * The scanner has no browser and no login: it posts scans to
 * /api/attendance/clock, asks /api/attendance/biometrics?pending who is waiting
 * for a finger, and reports the fingerprint it stored back to
 * /api/attendance/mappings. Those three reads/writes cannot carry an admin
 * cookie, exactly like the clock endpoint that already ships open.
 *
 * If the owner sets ATTENDANCE_DEVICE_TOKEN, the device must send it back in
 * the `x-attendance-device` header (or ?device=) and every other caller is
 * refused. With no token configured the endpoints stay as open as the clock
 * endpoint, so an already-flashed scanner keeps working after an update.
 */
export const DEVICE_HEADER = "x-attendance-device";

/** True when this request is allowed to speak as the door scanner. */
export function deviceAllowed(request: Request): boolean {
  const expected = (process.env.ATTENDANCE_DEVICE_TOKEN || "").trim();
  if (!expected) return true;
  const header = request.headers.get(DEVICE_HEADER);
  if (header && header === expected) return true;
  try {
    return new URL(request.url).searchParams.get("device") === expected;
  } catch {
    return false;
  }
}
