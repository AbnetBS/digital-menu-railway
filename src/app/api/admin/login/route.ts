import { NextResponse } from "next/server";
import { db } from "@/db";
import { siteSettings } from "@/db/schema";
import { ensureDbSeeded } from "@/lib/seed-db";
import { ensureTablesExist } from "@/db/migrate";
import { eq } from "drizzle-orm";

export async function POST(request: Request) {
  await ensureTablesExist();
  try {
    const { password } = await request.json();

    // Password priority: environment variable > database setting > built-in default
    let storedPassword = process.env.ADMIN_PASSWORD || "";

    if (!storedPassword) {
      try {
        await ensureDbSeeded();
        const pwdRecord = await db
          .select()
          .from(siteSettings)
          .where(eq(siteSettings.key, "admin_password"));
        if (pwdRecord.length > 0 && pwdRecord[0].value) {
          storedPassword = pwdRecord[0].value;
        }
      } catch (dbErr) {
        console.warn("DB password read failed:", dbErr);
      }
    }

    if (!storedPassword) {
      storedPassword = "fana2026";
    }

    // Generic verification — never reveal the stored/default password in any response
    if (password && password === storedPassword) {
      const response = NextResponse.json({ success: true, message: "Authentication successful" });
      response.cookies.set("fana_admin_auth", "authenticated", {
        httpOnly: true,
        path: "/",
        maxAge: 60 * 60 * 24 * 7, // 7 days
        sameSite: "lax",
      });
      return response;
    }

    return NextResponse.json({ success: false, error: "Invalid admin password" }, { status: 401 });
  } catch (error) {
    console.error("Admin login error:", error);
    return NextResponse.json({ error: "Login failed. Please try again." }, { status: 500 });
  }
}
