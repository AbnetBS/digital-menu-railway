import { NextResponse } from "next/server";
import { db } from "@/db";
import { staffUsers } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { and, eq } from "drizzle-orm";
import { verifySecret, hashSecret, isHashed } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { signToken, getSessionSecret, STAFF_COOKIE } from "@/lib/session";

// Brute-force protection for 4-digit PINs. Higher than admin because many
// staff share the cafe's single IP; still far below what an attacker needs to
// exhaust even a small PIN space quickly.
const STAFF_LOGIN_LIMIT = 30;
const STAFF_LOGIN_WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rl = checkRateLimit(`staff-login:${ip}`, STAFF_LOGIN_LIMIT, STAFF_LOGIN_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { success: false, error: "Too many login attempts. Please try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } }
    );
  }

  await ensureTablesExist();
  try {
    const { name, pin, role } = await request.json();

    const matches = await db
      .select()
      .from(staffUsers)
      .where(and(eq(staffUsers.name, String(name || "")), eq(staffUsers.role, String(role || "waiter"))));

    const staff = matches[0];
    const input = String(pin ?? "");
    const ok = staff ? await verifySecret(input, staff.pin) : false;

    if (staff && ok) {
      // Transparent migration: upgrade a legacy plaintext PIN to a bcrypt hash.
      if (!isHashed(staff.pin)) {
        try {
          const hashed = await hashSecret(input);
          await db.update(staffUsers).set({ pin: hashed }).where(eq(staffUsers.id, staff.id));
        } catch (e) {
          console.warn("Failed to upgrade staff PIN to hash:", e);
        }
      }

      const secret = getSessionSecret();
      if (!secret) {
        console.error("[staff-login] Refusing login: SESSION_SECRET is not configured.");
        return NextResponse.json(
          { success: false, error: "Staff login is not configured. The site owner must set SESSION_SECRET." },
          { status: 503 }
        );
      }

      const response = NextResponse.json({
        success: true,
        staff: { id: staff.id, name: staff.name, role: staff.role },
      });
      response.cookies.set(
        STAFF_COOKIE,
        signToken({ kind: "staff", staffId: staff.id, name: staff.name, role: staff.role, iat: Date.now() }, secret),
        {
          httpOnly: true,
          path: "/",
          maxAge: 60 * 60 * 12, // 12 hours (one shift)
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
        }
      );
      return response;
    }

    return NextResponse.json({ success: false, error: "Invalid name or PIN" }, { status: 401 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// Logout: clear the staff session cookie (called by the staff apps' logout button).
export async function DELETE() {
  const response = NextResponse.json({ success: true, message: "Logged out" });
  response.cookies.delete(STAFF_COOKIE);
  return response;
}
