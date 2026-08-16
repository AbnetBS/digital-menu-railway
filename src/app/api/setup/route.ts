import { NextResponse } from "next/server";
import { ensureTablesExist, checkTablesReport, insertSmokeTest } from "@/db/migrate";
import { ensureDbSeeded } from "@/lib/seed-db";
import { requireAdmin } from "@/lib/session";

/**
 * One-click database initializer/repair/verification.
 * Visit https://your-site.vercel.app/api/setup once after deploying.
 * It creates missing tables, repairs old broken columns, seeds default data,
 * then PROVES inserts work with a live insert+delete smoke test.
 */
export async function GET() {
  const __auth = await requireAdmin();
  if (!__auth.ok) return __auth.response;
  const migrateResult = await ensureTablesExist();
  const seedResult = await ensureDbSeeded();

  // One-time data normalizer: undo the historical "FanaQueen" naming in saved settings.
  // The business is called "Fana Cafe & Restaurant" — any stored mention gets corrected.
  let normalized = 0;
  try {
    const { siteSettings } = await import("@/db/schema");
    const { db } = await import("@/db");
    const { eq } = await import("drizzle-orm");
    const { fixBrandText } = await import("@/lib/brand");
    const rows = await db.select().from(siteSettings);
    for (const row of rows) {
      const fixed = fixBrandText(row.value);
      if (fixed !== row.value && (row.value.includes("FanaQueen") || /Cafe\s+Cafe/i.test(row.value))) {
        await db.update(siteSettings).set({ value: fixed }).where(eq(siteSettings.key, row.key));
        normalized++;
      }
    }
  } catch (e) {
    console.error("Settings normalizer error:", e);
  }

  const tableReport = await checkTablesReport();
  const insertTest = await insertSmokeTest();

  const insertsOk = Object.values(insertTest).every((v) => v.includes("OK"));
  const tablesOk = Object.values(tableReport).every((v) => v === "OK");
  const allOk = migrateResult.success && seedResult.success && tablesOk && insertsOk;

  return NextResponse.json(
    {
      status: allOk ? "ready" : "needs_attention",
      message: allOk
        ? "Database fully initialized and verified — orders, reservations and menu inserts all work."
        : "Some steps need attention. See details below.",
      migration_errors: migrateResult.errors ?? [],
      seed_result: seedResult,
      settings_normalized_fanaqueen_to_fana_cafe: normalized,
      tables: tableReport,
      insert_smoke_test: insertTest,
      next_step: allOk
        ? "Open /admin and log in with your admin password (the ADMIN_PASSWORD environment variable)."
        : "Fix your DATABASE_URL (set in your host's environment variables, e.g. Railway → Variables or Supabase connection string) to a working PostgreSQL connection string, then visit this URL again.",
    },
    { status: allOk ? 200 : 500 }
  );
}

export async function POST() {
  const __auth = await requireAdmin();
  if (!__auth.ok) return __auth.response;
  return GET();
}
