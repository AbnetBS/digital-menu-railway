import { NextResponse } from "next/server";
import { db } from "@/db";
import { siteSettings } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq } from "drizzle-orm";
import { fixBrandText } from "@/lib/brand";

export async function GET() {
  await ensureTablesExist();
  try {
    const allSettings = await db.select().from(siteSettings);
    const settingsMap: Record<string, string> = {};
    allSettings.forEach((s) => {
      // Brand guard: business is Fana Cafe & Restaurant — never serve the
      // historical "FanaQueen"/double-Cafe text to any client, even if the DB holds it.
      settingsMap[s.key] = fixBrandText(s.value);
    });
    return NextResponse.json(settingsMap, { status: 200, headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  await ensureTablesExist();
  try {
    const body = await request.json();
    const entries = Object.entries(body);
    for (const [key, val] of entries) {
      const stringVal = typeof val === "object" ? JSON.stringify(val) : String(val);

      const existing = await db.select().from(siteSettings).where(eq(siteSettings.key, key));
      if (existing.length > 0) {
        await db
          .update(siteSettings)
          .set({ value: stringVal, updatedAt: new Date() })
          .where(eq(siteSettings.key, key));
      } else {
        await db.insert(siteSettings).values({ key, value: stringVal });
      }
    }
    return NextResponse.json({ success: true, message: "Settings updated successfully" });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
