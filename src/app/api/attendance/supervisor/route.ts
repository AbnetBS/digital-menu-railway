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
  supervisorSecondsLeft,
} from "@/lib/session";
import {
  ATTENDANCE_SUPERVISOR_ROLE,
  SUPERVISOR_IDLE_TIMEOUT_MS,
  SUPERVISOR_SESSION_TTL_SECONDS,
} from "@/lib/attendance-supervisor";
import { and, eq } from "drizzle-orm";

/**
 * THE DOOR TABLET'S SUPERVISOR LOGIN (owner, Oct 2026).
 *
 * "even tho the 2nd option is good he said it is risky since someone can write
 * for them" - so the name + PIN keypad on /attendance is locked until an
 * attendance supervisor opens it, and it locks itself again after two minutes
 * with no activity.
 *
 *   POST {name, pin}  a supervisor unlocks the keypad (2 minutes from now)
 *   POST {touch:true} the tablet says "somebody is still using it": the two
 *                     minutes start again. Needs the unlock it renews.
 *   GET               is the keypad open right now, and for how long still
 *   DELETE            lock it now (the supervisor's own "Lock" button)
 *
 * The accounts live in Staff Accounts with the role `attendance_supervisor`,
 * exactly like a waiter or a cashier login: name + PIN, hashed, editable and
 * removable from the admin. This route is the only place that turns one of
 * them into a two-minute cookie, and /api/attendance/clock refuses a PIN
 * clock-in without it - so the check is on the server, not in the tablet's
 * JavaScript.
 */

// Brute-force protection for a short PIN typed on a shared tablet. The cafe's
// whole door stands behind one IP, so the limit is the staff login's.
const SUPERVISOR_LOGIN_LIMIT = 30;
const SUPERVISOR_LOGIN_WINDOW_MS = 15 * 60 * 1000;

function cookieOptions() {
  return {
    httpOnly: true,
    path: "/",
    // The browser drops it when the two minutes are up, and the server refuses
    // it a moment earlier through the signed `exp` inside.
    maxAge: SUPERVISOR_SESSION_TTL_SECONDS,
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
    secondsLeft: supervisorSecondsLeft(session),
    idleTimeoutMs: SUPERVISOR_IDLE_TIMEOUT_MS,
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

  /* ── "somebody is still using it": start the two minutes again ────────── */
  if (String(body.touch ?? "") === "true" || body.touch === true) {
    const session = await readSupervisorSession();
    if (!session) {
      return NextResponse.json(
        { error: "Supervisor login required", needsSupervisor: true, active: false },
        { status: 403 }
      );
    }
    const response = NextResponse.json({
      success: true,
      active: true,
      name: session.name,
      secondsLeft: SUPERVISOR_SESSION_TTL_SECONDS,
      idleTimeoutMs: SUPERVISOR_IDLE_TIMEOUT_MS,
    });
    response.cookies.set(
      SUPERVISOR_COOKIE,
      signToken(supervisorPayload(session.staffId, session.name), secret),
      cookieOptions()
    );
    return response;
  }

  /* ── the unlock itself ────────────────────────────────────────────────── */
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
      secondsLeft: SUPERVISOR_SESSION_TTL_SECONDS,
      idleTimeoutMs: SUPERVISOR_IDLE_TIMEOUT_MS,
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

/** Lock now: the supervisor's own button, and what the tablet calls on timeout. */
export async function DELETE() {
  const response = NextResponse.json({ success: true, active: false, message: "Locked" });
  response.cookies.delete(SUPERVISOR_COOKIE);
  return response;
}
