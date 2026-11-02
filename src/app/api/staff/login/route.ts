import { NextResponse } from "next/server";
import { db, pool } from "@/db";
import { staffUsers } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { ensureStoreSchema } from "@/lib/store/schema";
import { and, eq } from "drizzle-orm";
import { verifySecret, hashSecret, isHashed } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { signToken, getSessionSecret, STAFF_COOKIE, STATION_STOCK_COOKIE } from "@/lib/session";

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
    const { name, pin, role, stationStock, expectedStation } = await request.json();
    const targetRole = stationStock ? "stock_accepter" : String(role || "waiter");

    const matches = await db
      .select()
      .from(staffUsers)
      .where(and(eq(staffUsers.name, String(name || "")), eq(staffUsers.role, targetRole)));

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

      // Dedicated Stock Accepter login on /station-stock: verifies store_accounts
      // and sets STATION_STOCK_COOKIE so the station KDS (STAFF_COOKIE) stays signed in.
      if (stationStock) {
        await ensureStoreSchema();
        const acc = await pool.query<{ station: string }>(
          "SELECT station FROM store_accounts WHERE staff_id = $1",
          [staff.id]
        );
        const assignedStation = acc.rows[0]?.station;
        if (!assignedStation) {
          return NextResponse.json({ success: false, error: "Invalid name or PIN" }, { status: 401 });
        }
        const wanted = String(expectedStation || "").trim();
        if (wanted && assignedStation !== wanted) {
          return NextResponse.json(
            { success: false, error: `This Stock Accepter account is for ${assignedStation}, not ${wanted}.` },
            { status: 403 }
          );
        }
        const response = NextResponse.json({
          success: true,
          staff: { id: staff.id, name: staff.name, role: staff.role, station: assignedStation },
        });
        response.cookies.set(
          STATION_STOCK_COOKIE,
          signToken(
            {
              kind: "station_stock",
              staffId: staff.id,
              name: staff.name,
              station: assignedStation,
              iat: Date.now(),
            },
            secret
          ),
          {
            httpOnly: true,
            path: "/",
            maxAge: 60 * 60 * 24 * 400,
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production",
          }
        );
        return response;
      }

      // POCKET OFF-DUTY SWITCH: signing in IS starting a shift. If this
      // person switched their alerts off yesterday evening, switch them back
      // on now - a shift must never start silent because somebody forgot.
      // (The phone that stayed at home never signs in again, so it stays
      // quiet until its owner is truly back at work.)
      try {
        await db
          .update(staffUsers)
          .set({ notificationsEnabled: true })
          .where(eq(staffUsers.id, staff.id));
      } catch (e) {
        console.warn("[staff-login] Could not re-enable pocket alerts:", e);
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
          // Store and station staff asked to stay signed in between visits. Browsers
          // cap persistent cookies; 400 days is refreshed by the session endpoint.
          maxAge: ["store_manager", "stock_accepter", "kitchen", "barista", "juice"].includes(staff.role)
            ? 60 * 60 * 24 * 400 : 60 * 60 * 12,
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

// Logout: clear the staff session cookie (or only station_stock cookie when scope=station_stock).
export async function DELETE(request: Request) {
  const scope = new URL(request.url).searchParams.get("scope");
  const response = NextResponse.json({ success: true, message: "Logged out" });
  response.cookies.delete(scope === "station_stock" ? STATION_STOCK_COOKIE : STAFF_COOKIE);
  return response;
}
