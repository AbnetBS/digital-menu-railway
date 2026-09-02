import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

/**
 * Pool size. `pg` defaults to 10 connections for the WHOLE process, which is
 * tight once a room full of phones polls order status while the kitchen,
 * barista, waiter and cashier screens refresh — requests then queue behind the
 * pool (up to `connectionTimeoutMillis`) instead of hitting Postgres. 20 is
 * comfortable for one Railway instance and still far below a managed Postgres
 * `max_connections`; tune per environment with `PG_POOL_MAX`.
 */
const poolMax = Math.max(1, Number.parseInt(process.env.PG_POOL_MAX || "20", 10) || 20);

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString: databaseUrl,
    max: poolMax,
    connectionTimeoutMillis: 5000,
    // Release idle connections again after a quiet spell.
    idleTimeoutMillis: 30_000,
  });

// Graceful error handling for connection issues
pool.on("error", (err) => {
  console.warn("PostgreSQL pool error:", err);
});

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool);
