import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { SUPERVISOR_IDLE_TIMEOUT_MS } from "@/lib/attendance-supervisor";

/**
 * Stateless, cryptographically-signed session tokens (HMAC-SHA256).
 *
 * No database lookup is required to verify a request — the cookie carries a
 * base64url JSON payload plus an HMAC signature. This keeps every API request
 * cheap (no extra query) while making tokens unforgeable without the secret.
 *
 * Two independent sessions:
 *   - ADMIN (owner): set by /api/admin/login  → cookie "fana_admin_auth"
 *   - STAFF (waiter/cashier/kitchen/barista): set by /api/staff/login
 *                                                → cookie "fana_staff_auth"
 *   - ATTENDANCE SUPERVISOR (the door tablet): set by
 *     /api/attendance/supervisor → cookie "fana_attendance_supervisor". A
 *     deliberately SHORT third one: it unlocks the backup PIN keypad on
 *     /attendance for two minutes of activity and then dies by itself. Its
 *     `exp` is checked on every read, so a copied or a leftover cookie is
 *     refused even before the browser drops it.
 */

export const ADMIN_COOKIE = "fana_admin_auth";
export const STAFF_COOKIE = "fana_staff_auth";
export const SUPERVISOR_COOKIE = "fana_attendance_supervisor";

export type AdminSession = { kind: "admin"; iat: number };
export type StaffSession = { kind: "staff"; staffId: number; name: string; role: string; iat: number };
/** Who unlocked the door tablet, and the instant that unlock stops counting. */
export type SupervisorSession = {
  kind: "attendance_supervisor";
  staffId: number;
  name: string;
  iat: number;
  /** Epoch ms: two minutes after the last unlock/renewal. */
  exp: number;
};

const DEV_SECRET = "fana-dev-session-secret-do-not-use-in-production";

/**
 * The signing secret. In production this MUST come from SESSION_SECRET — if it
 * is missing we return null and every session is treated as invalid (fail
 * closed). In development a fixed fallback is used so local dev still works.
 */
export function getSessionSecret(): string | null {
  const configured = process.env.SESSION_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") return null;
  return DEV_SECRET;
}

function hmac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signToken(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(body, secret)}`;
}

function verifyToken(token: string, secret: string): Record<string, unknown> | null {
  const dot = token.indexOf(".");
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(body, secret);

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function readAdminSession(): Promise<AdminSession | null> {
  const secret = getSessionSecret();
  if (!secret) return null;
  const store = await cookies();
  const value = store.get(ADMIN_COOKIE)?.value;
  if (!value) return null;
  const obj = verifyToken(value, secret);
  if (obj?.kind === "admin") return obj as unknown as AdminSession;
  return null;
}

export async function readStaffSession(): Promise<StaffSession | null> {
  const secret = getSessionSecret();
  if (!secret) return null;
  const store = await cookies();
  const value = store.get(STAFF_COOKIE)?.value;
  if (!value) return null;
  const obj = verifyToken(value, secret);
  if (obj?.kind === "staff" && typeof obj.staffId === "number") {
    return obj as unknown as StaffSession;
  }
  return null;
}

/**
 * The payload of a fresh supervisor unlock: two minutes of allowed inactivity,
 * counted from `now`. The route signs this; every reader checks `exp`.
 */
export function supervisorPayload(staffId: number, name: string, now: number = Date.now()): SupervisorSession {
  return {
    kind: "attendance_supervisor",
    staffId,
    name,
    iat: now,
    exp: now + SUPERVISOR_IDLE_TIMEOUT_MS,
  };
}

export async function readSupervisorSession(): Promise<SupervisorSession | null> {
  const secret = getSessionSecret();
  if (!secret) return null;
  const store = await cookies();
  const value = store.get(SUPERVISOR_COOKIE)?.value;
  if (!value) return null;
  const obj = verifyToken(value, secret);
  if (obj?.kind !== "attendance_supervisor" || typeof obj.staffId !== "number") return null;
  const exp = Number(obj.exp);
  // The two minutes are enforced HERE and not only on the tablet: a cookie that
  // outlived the idle window is dead wherever it is presented.
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  return obj as unknown as SupervisorSession;
}

/** Seconds left of the two-minute unlock, for the tablet's countdown. */
export function supervisorSecondsLeft(session: SupervisorSession | null, now: number = Date.now()): number {
  if (!session) return 0;
  return Math.max(0, Math.round((Number(session.exp) - now) / 1000));
}

type GuardResult<T> =
  | { ok: true; session: T }
  | { ok: false; response: NextResponse };

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/** Require a valid owner/admin session. */
export async function requireAdmin(): Promise<GuardResult<AdminSession>> {
  const session = await readAdminSession();
  if (!session) return { ok: false, response: unauthorized() };
  return { ok: true, session };
}

/** Require a valid staff session (any staff role). */
export async function requireStaff(): Promise<GuardResult<StaffSession>> {
  const session = await readStaffSession();
  if (!session) return { ok: false, response: unauthorized() };
  return { ok: true, session };
}

/**
 * Require an unlocked door tablet (the attendance supervisor logged in less
 * than two minutes ago). The answer says WHY, so the tablet can go straight
 * back to its login card instead of showing a bare "Unauthorized".
 */
export async function requireSupervisor(): Promise<GuardResult<SupervisorSession>> {
  const session = await readSupervisorSession();
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Supervisor login required", needsSupervisor: true },
        { status: 403 }
      ),
    };
  }
  return { ok: true, session };
}

/** Require a staff session OR an admin session (admin may perform staff ops). */
export async function requireStaffOrAdmin(): Promise<
  GuardResult<{ kind: "staff" | "admin" }>
> {
  const staff = await readStaffSession();
  if (staff) return { ok: true, session: { kind: "staff" } };
  const admin = await readAdminSession();
  if (admin) return { ok: true, session: { kind: "admin" } };
  return { ok: false, response: unauthorized() };
}
