import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";

/**
 * Safe, database-only storage report for the owner dashboard.
 * It does not delete or modify anything. Host Docker/log storage cannot be
 * inspected from the app container, but this identifies whether the database
 * is actually responsible for the VPS growth.
 */
export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();

  const tables = await db.execute(sql`
    SELECT c.relname AS table_name,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
           pg_size_pretty(pg_relation_size(c.oid)) AS table_size,
           pg_size_pretty(pg_indexes_size(c.oid)) AS index_size,
           c.reltuples::bigint AS estimated_rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND n.nspname = 'public'
    ORDER BY pg_total_relation_size(c.oid) DESC
  `);

  const counts = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM tickets) AS tickets,
      (SELECT count(*) FROM ticket_items) AS ticket_items,
      (SELECT count(*) FROM ticket_events) AS ticket_events,
      (SELECT count(*) FROM order_submissions) AS order_submissions,
      (SELECT count(*) FROM push_subscriptions) AS push_subscriptions,
      (SELECT count(*) FROM cdn_images) AS cdn_images,
      (SELECT COALESCE(sum(length(data)), 0) FROM cdn_images) AS cdn_image_chars
  `);

  const rows = (tables as unknown as { rows?: unknown[] }).rows ?? tables;
  const countRows = (counts as unknown as { rows?: unknown[] }).rows ?? counts;
  return NextResponse.json({
    success: true,
    generatedAt: new Date().toISOString(),
    warning: "This report covers PostgreSQL only. Docker, Coolify logs, backups and host files require a VPS audit.",
    tables: rows,
    counts: countRows[0] ?? {},
  }, { headers: { "Cache-Control": "no-store" } });
}
