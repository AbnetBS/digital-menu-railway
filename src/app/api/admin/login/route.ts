import { NextResponse } from "next/server";
import { db } from "@/db";
import { siteSettings } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq } from "drizzle-orm";
import { verifySecret, hashSecret, isHashed } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { signToken, getSessionSecret, ADMIN_COOKIE } from "@/lib/session";

// Brute-force protection: 10 attempts per 15 minutes per IP. Generous enough
// for a real owner (including a few typos) but blocks automated guessing.
const ADMIN_LOGIN_LIMIT = 10;
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rl = checkRateLimit(`admin-login:${ip}`, ADMIN_LOGIN_LIMIT, ADMIN_LOGIN_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { success: false, error: "Too many login attempts. Please try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } }
    );
  }

  await ensureTablesExist();
  try {
    const { password } = await request.json();

    // Password priority: environment variable > database setting.
    // There is NO production default — a predictable fallback password would be a
    // security hole if the owner forgets to configure ADMIN_PASSWORD.
    const isProduction = process.env.NODE_ENV === "production";
    let storedPassword = process.env.ADMIN_PASSWORD || "";
    let source: "env" | "db" = "env";
    let dbRecord: { value: string } | null = null;

    if (!storedPassword) {
      try {
        // Read the owner-chosen password from settings WITHOUT running any seeding.
        // site_settings is created by ensureTablesExist above.
        const pwdRecord = await db
          .select()
          .from(siteSettings)
          .where(eq(siteSettings.key, "admin_password"));
        if (pwdRecord.length > 0 && pwdRecord[0].value) {
          storedPassword = pwdRecord[0].value;
          source = "db";
          dbRecord = pwdRecord[0];
        }
      } catch (dbErr) {
        console.warn("DB password read failed:", dbErr);
      }
    }

    if (!storedPassword) {
      if (isProduction) {
        // Fail closed in production: never authenticate against a predictable
        // credential when no password is configured. This forces the owner to set
        // ADMIN_PASSWORD before the dashboard becomes usable.
        console.error(
          "[admin-login] Refusing login: ADMIN_PASSWORD is not set and no admin_password exists in the database."
        );
        return NextResponse.json(
          { success: false, error: "Administrator login is not configured. The site owner must set ADMIN_PASSWORD." },
          { status: 503 }
        );
      }
      // Development only: a documented local bootstrap password.
      storedPassword = "fana2026";
    }

    const input = typeof password === "string" ? password : "";
    const ok = await verifySecret(input, storedPassword);

    if (ok) {
      // Transparent migration: if a DB-stored PLAINTEXT password just matched,
      // upgrade it to a bcrypt hash so plaintext never stays at rest.
      if (source === "db" && dbRecord && !isHashed(storedPassword)) {
        try {
          const hashed = await hashSecret(input);
          await db
            .update(siteSettings)
            .set({ value: hashed, updatedAt: new Date() })
            .where(eq(siteSettings.key, "admin_password"));
        } catch (e) {
          console.warn("Failed to upgrade admin password to hash:", e);
        }
      }

      const secret = getSessionSecret();
      if (!secret) {
        console.error("[admin-login] Refusing login: SESSION_SECRET is not configured.");
        return NextResponse.json(
          { success: false, error: "Administrator login is not configured. The site owner must set SESSION_SECRET." },
          { status: 503 }
        );
      }

      const response = NextResponse.json({ success: true, message: "Authentication successful" });
      response.cookies.set(ADMIN_COOKIE, signToken({ kind: "admin", iat: Date.now() }, secret), {
        httpOnly: true,
        path: "/",
        maxAge: 60 * 60 * 24 * 7, // 7 days
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
      });
      return response;
    }

    return NextResponse.json({ success: false, error: "Invalid admin password" }, { status: 401 });
  } catch (error) {
    console.error("Admin login error:", error);
    return NextResponse.json({ error: "Login failed. Please try again." }, { status: 500 });
  }
}
