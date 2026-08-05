import { NextResponse } from "next/server";
import { ensureTablesExist, checkTablesReport, insertSmokeTest } from "@/db/migrate";

/**
 * Browser-friendly live database diagnostic.
 * Open https://your-site.vercel.app/api/dbtest in the browser.
 * It runs schema repair, reports every table, and performs real test inserts
 * (then deletes the test rows) so you can see exactly which part fails.
 */
export async function GET() {
  const migrate = await ensureTablesExist();
  const tables = await checkTablesReport();
  const inserts = await insertSmokeTest();

  return NextResponse.json({
    diagnostic: "Fana Cafe Database Live Test",
    schema_repair_ok: migrate.success,
    repair_errors: migrate.errors ?? [],
    tables,
    insert_tests: inserts,
    everything_ok:
      migrate.success &&
      Object.values(tables).every((v) => v === "OK") &&
      Object.values(inserts).every((v) => v.includes("OK")),
  });
}

export async function POST() {
  return GET();
}
