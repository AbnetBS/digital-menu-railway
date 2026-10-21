import { NextResponse } from "next/server";
import { db } from "@/db";
import { staffUsers } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { hashSecret, isHashed, verifySecret } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  SUPERVISOR_COOKIE,
  getSessionSecret,
  readSupervisorSession,
  signToken,
  supervisorPayload,
} from "@/lib/session";
import {
  ATTENDANCE_SUPERVISOR_ROLE,
  SUPERVISOR_COOKIE_MAX_AGE_SECONDS,
} from "@/lib/attendance-supervisor";
import { and, eq } from "drizzle-orm";

/**
 * THE DOOR TABLET'S SUPERVISOR LOGIN (owner, Oct 2026).
 *
 * "even tho the 2nd option is good he said it is risky since someone can write
 * for them" - so the name + PIN keypad on /attendance is locked until an
 * attendance supervisor opens it. The unlock has no stopwatch on it (owner,
 * 2026-10-16: the two-minute window "doesnt have benefit") - the keypad stays
 * open until the supervisor presses "Lock now" on the tablet.
 *
 *   POST {name, pin}  a supervisor unlocks the keypad
 *   GET               is the keypad open right now, and who opened it
 *   DELETE            lock it now (the supervisor's own "Lock" button)
 *
 * The accounts live in Staff Accounts with the role `attendance_supervisor`,
 * exactly like a waiter or a cashier login: name + PIN, hashed, editable and
 * removable from the admin. This route is the only place that turns one of
 * them into a cookie, and /api/attendance/clock refuses a PIN clock-in
 * without it - so the check is on the server, not in the tablet's JavaScript.
 */

// Brute-force protection for a short PIN typed on a shared tablet. The cafe's
// whole door stands behind one IP, so the limit is the staff login's.
const SUPERVISOR_LOGIN_LIMIT = 30;
const SUPERVISOR_LOGIN_WINDOW_MS = 15 * 60 * 1000;

function cookieOptions() {
  return {
    httpOnly: true,
    path: "/",
    // No idle window: the browser keeps it, and "Lock now" deletes it here.
    maxAge: SUPERVISOR_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}

export async function GET() {
  await ensureTablesExist();
  const session = await readSupervisorSession();
  return NextResponse.json({
    active: Boolean(session),
    name: session?.name ?? null,
    openedAt: session ? new Date(Number(session.iat)).toISOString() : null,
  });
}

export async function POST(request: Request) {
  await ensureTablesExist();

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const secret = getSessionSecret();
  if (!secret) {
    console.error("[attendance-supervisor] Refusing login: SESSION_SECRET is not configured.");
    return NextResponse.json(
      { error: "The door tablet login is not configured. The site owner must set SESSION_SECRET." },
      { status: 503 }
    );
  }

  /* ── the unlock itself ────────────────────────────────────────────────── */
  // There is no "touch" renewal any more: nothing expires, so nothing needs
  // to be re-armed while a queue stands at the door.
  const ip = getClientIp(request);
  const rl = checkRateLimit(`attendance-supervisor:${ip}`, SUPERVISOR_LOGIN_LIMIT, SUPERVISOR_LOGIN_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later.", retryAfterSeconds: rl.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } }
    );
  }

  const name = String(body.name ?? "").trim();
  const pin = String(body.pin ?? "");
  if (!name || !pin) {
    return NextResponse.json({ error: "Choose your name and type your PIN" }, { status: 400 });
  }

  try {
    const matches = await db
      .select()
      .from(staffUsers)
      .where(and(eq(staffUsers.name, name), eq(staffUsers.role, ATTENDANCE_SUPERVISOR_ROLE)));
    const supervisor = matches[0];
    // One answer for "no such supervisor" and "wrong PIN": the door is a public
    // place, so this route never tells a stranger which names exist.
    const ok = supervisor ? await verifySecret(pin, supervisor.pin) : false;
    if (!supervisor || !ok) {
      return NextResponse.json({ error: "Incorrect name or PIN" }, { status: 401 });
    }

    // Transparent migration: a legacy plaintext PIN becomes a hash on first use.
    if (!isHashed(supervisor.pin)) {
      try {
        await db.update(staffUsers).set({ pin: await hashSecret(pin) }).where(eq(staffUsers.id, supervisor.id));
      } catch (e) {
        console.warn("[attendance-supervisor] Could not upgrade the PIN to a hash:", e);
      }
    }

    const response = NextResponse.json({
      success: true,
      active: true,
      name: supervisor.name,
      staffId: supervisor.id,
      openedAt: new Date().toISOString(),
      message: `${supervisor.name} unlocked the PIN keypad`,
    });
    response.cookies.set(
      SUPERVISOR_COOKIE,
      signToken(supervisorPayload(supervisor.id, supervisor.name), secret),
      cookieOptions()
    );
    return response;
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

/** Lock now: the supervisor's own button - the only thing that ends an unlock. */
export async function DELETE() {
  const response = NextResponse.json({ success: true, active: false, message: "Locked" });
  response.cookies.delete(SUPERVISOR_COOKIE);
  return response;
}
