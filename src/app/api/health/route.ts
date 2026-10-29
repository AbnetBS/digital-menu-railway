import { db } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = performance.now();
  try {
    // Includes connection-pool wait and the round trip, but not heavier queries.
    await db.execute(sql`select 1`);
    const dbMs = Math.round(performance.now() - started);
    return Response.json({ ok: true, dbMs }, {
      headers: { "Cache-Control": "no-store", "Server-Timing": `db;dur=${dbMs}` },
    });
  } catch {
    return Response.json({ ok: false }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
