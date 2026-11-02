import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { db } from '../src/db';
import { ensureTablesExist, SCHEMA_VERSION } from '../src/db/migrate';
import { installStoreSchema, STORE_SCHEMA_SQL, STORE_SCHEMA_VERSION } from '../src/lib/store/schema';
import { insertRequestLines, loadRequestItems, validateRequestLines } from '../src/lib/store/request-lines';

async function checkWarmMigration() {
  const mutableDb = db as unknown as { execute: (sql: unknown) => Promise<unknown> };
  const original = mutableDb.execute;
  const state = globalThis as typeof globalThis & {
    __fanaMigrateDone?: boolean;
    __fanaMigratePromise?: Promise<unknown> | null;
  };
  delete state.__fanaMigrateDone;
  delete state.__fanaMigratePromise;
  let queries = 0;
  mutableDb.execute = async () => {
    queries++;
    // A current schema must execute this one probe and no CREATE/ALTER at all.
    return { rows: [{ value: SCHEMA_VERSION }] };
  };
  try {
    const results = await Promise.all(Array.from({ length: 12 }, () => ensureTablesExist()));
    assert.ok(results.every((r) => r.success));
    assert.equal(queries, 1, 'concurrent warm starts must share a single version probe');
    await ensureTablesExist();
    assert.equal(queries, 1, 'subsequent requests must not rerun the migration');
  } finally {
    mutableDb.execute = original;
    delete state.__fanaMigrateDone;
    delete state.__fanaMigratePromise;
  }
}

async function checkStoreSchemaAndBatch() {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE ticket_items(id serial PRIMARY KEY,station_status text,station_name text,menu_item_id integer,name text,category text,quantity integer,station_done_by text,removed boolean DEFAULT false)`);
    const calls: string[] = [];
    let failDdl = false;
    const client = {
      query: async (query: string, params?: unknown[]) => {
        calls.push(query);
        // PGlite runs one SQL statement in query(); the production pg client
        // accepts this idempotent multi-statement DDL as a simple query.
        if (query === STORE_SCHEMA_SQL) {
          if (failDdl) throw new Error('injected schema failure');
          await pg.exec(query);
          return { rows: [], rowCount: 0 };
        }
        if (query.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
        const result = await pg.query(query, params);
        return { ...result, rowCount: result.affectedRows ?? result.rows.length };
      },
    } as unknown as PoolClient;

    await installStoreSchema(client);
    assert.equal(calls.filter((q) => q === STORE_SCHEMA_SQL).length, 1, 'first install runs DDL once');
    assert.equal((await pg.query<{ version: string }>('SELECT version FROM store_schema_meta')).rows[0].version, STORE_SCHEMA_VERSION);
    calls.length = 0;
    await installStoreSchema(client);
    assert.deepEqual(calls, ['SELECT version FROM store_schema_meta WHERE id=1'], 'warm process must not lock or replace the trigger');

    // A failed upgrade must roll back the version and be retried later.
    await pg.query("UPDATE store_schema_meta SET version='old' WHERE id=1");
    failDdl = true;
    await assert.rejects(() => installStoreSchema(client), /injected schema failure/);
    assert.equal((await pg.query<{ version: string }>('SELECT version FROM store_schema_meta')).rows[0].version, 'old');
    failDdl = false;
    await installStoreSchema(client);
    assert.equal((await pg.query<{ version: string }>('SELECT version FROM store_schema_meta')).rows[0].version, STORE_SCHEMA_VERSION);

    await pg.exec(`INSERT INTO store_items(name,dimension,balance) VALUES ('Milk','volume',5000),('Egg','count',100);
      INSERT INTO store_requests(requester_id,requester_name,station) VALUES (7,'A','kitchen'),(7,'A','juice');`);
    const raw = [
      { itemId: 1, amount: 2, unit: 'L', station: 'kitchen' },
      { itemId: 2, amount: 10, unit: 'pcs', station: 'kitchen' },
      { itemId: 1, amount: 1, unit: 'L', station: 'juice' },
    ];
    calls.length = 0;
    const catalog = await loadRequestItems(client, raw);
    const kitchen = validateRequestLines(raw.slice(0, 2), catalog);
    const juice = validateRequestLines(raw.slice(2), catalog);
    assert.deepEqual(kitchen, [{ id: 1, amount: 2000 }, { id: 2, amount: 10 }]);
    assert.deepEqual(juice, [{ id: 1, amount: 1000 }]);
    assert.throws(() => validateRequestLines([raw[0], raw[0]], catalog), /only once/);
    assert.throws(() => validateRequestLines([{ itemId: 1, amount: 6, unit: 'L' }], catalog), /not enough/);
    assert.throws(() => validateRequestLines([{ itemId: 999, amount: 1, unit: 'pcs' }], catalog), /not found/);
    await insertRequestLines(client, [
      ...kitchen.map((line) => ({ requestId: 1, ...line })),
      ...juice.map((line) => ({ requestId: 2, ...line })),
    ]);
    assert.equal(calls.filter((q) => q.includes('FROM store_items WHERE id=ANY')).length, 1);
    assert.equal(calls.filter((q) => q.includes('INSERT INTO store_request_lines')).length, 1);
    assert.equal((await pg.query('SELECT * FROM store_request_lines')).rows.length, 3);
    assert.equal((await pg.query<{ balance: string }>('SELECT balance FROM store_items WHERE id=1')).rows[0].balance, '5000.000', 'requesting does not reserve or deduct stock');

    // Verify TOAST-slicing image projection, bounded recent_requests CTE, batched accept, and batched recipe against real PostgreSQL.
    await pg.query("UPDATE store_items SET image='data:image/jpeg;base64,/9j/4AAQSkZJRg==' WHERE id=1");
    const itemsProj = await pg.query<{ id: number; image: string }>(`SELECT id,name,dimension,balance,low_at,created_at,
      CASE WHEN left(image, 11) = 'data:image/' THEN '/api/store/images/' || id ELSE image END AS image
      FROM store_items ORDER BY id`);
    assert.equal(itemsProj.rows[0].image, '/api/store/images/1');
    assert.equal(itemsProj.rows[1].image, '');

    // Batched accept SQL (single-query item lock, unnest balance seed, unnest deduct/credit/movement)
    const acceptIds = [1, 2];
    const acceptAmounts = [2000, 10];
    await pg.query(
      'INSERT INTO store_station_balances(station,item_id,balance) SELECT $1, unnest($2::int[]), 0 ON CONFLICT DO NOTHING',
      ['kitchen', acceptIds],
    );
    await pg.query(
      'UPDATE store_items AS s SET balance=s.balance-v.amount FROM unnest($1::int[],$2::numeric[]) AS v(item_id,amount) WHERE s.id=v.item_id',
      [acceptIds, acceptAmounts],
    );
    await pg.query(
      'INSERT INTO store_station_balances(station,item_id,balance) SELECT $1,v.item_id,v.amount FROM unnest($2::int[],$3::numeric[]) AS v(item_id,amount) ON CONFLICT(station,item_id) DO UPDATE SET balance=store_station_balances.balance+EXCLUDED.balance',
      ['kitchen', acceptIds, acceptAmounts],
    );
    await pg.query(
      "INSERT INTO store_movements(item_id,station,kind,amount,actor,request_id) SELECT v.item_id,$1,'issue',v.amount,$2,$3 FROM unnest($4::int[],$5::numeric[]) AS v(item_id,amount)",
      ['kitchen', 'Manager', 1, acceptIds, acceptAmounts],
    );
    await pg.query("UPDATE store_requests SET status='accepted',accepted_at=now(),accepted_by=$2 WHERE id=$1", [1, 'Manager']);

    assert.equal(Number((await pg.query<{ balance: string }>('SELECT balance FROM store_items WHERE id=1')).rows[0].balance), 3000);
    assert.equal(Number((await pg.query<{ balance: string }>('SELECT balance FROM store_items WHERE id=2')).rows[0].balance), 90);
    assert.equal(Number((await pg.query<{ balance: string }>("SELECT balance FROM store_station_balances WHERE station='kitchen' AND item_id=1")).rows[0].balance), 2000);
    assert.equal(Number((await pg.query<{ balance: string }>("SELECT balance FROM store_station_balances WHERE station='kitchen' AND item_id=2")).rows[0].balance), 10);

    // Bounded recent_requests CTE returns both pending and accepted requests with aggregated lines.
    const recentReqs = await pg.query<{ id: number; status: string; lines: unknown[] }>(
      `WITH recent_requests AS (
        (SELECT * FROM store_requests WHERE status='pending' AND ($1::boolean OR requester_id=$2) ORDER BY created_at DESC)
        UNION ALL
        (SELECT * FROM store_requests WHERE status='accepted' AND ($1::boolean OR requester_id=$2) ORDER BY created_at DESC LIMIT 150)
      )
      SELECT r.*, COALESCE(json_agg(json_build_object('item_id',l.item_id,'name',i.name,'dimension',i.dimension,'amount',l.amount) ORDER BY i.name) FILTER (WHERE l.item_id IS NOT NULL),'[]') AS lines
      FROM recent_requests r LEFT JOIN store_request_lines l ON l.request_id=r.id LEFT JOIN store_items i ON i.id=l.item_id
      GROUP BY r.id,r.requester_id,r.requester_name,r.station,r.status,r.created_at,r.accepted_at,r.accepted_by
      ORDER BY r.created_at DESC`,
      [true, 0],
    );
    assert.equal(recentReqs.rows.length, 2);
    assert.ok(recentReqs.rows.some((r) => r.status === 'pending') && recentReqs.rows.some((r) => r.status === 'accepted'));

    // Batched recipe SQL
    await pg.query(
      'INSERT INTO store_recipes(menu_item_id,item_id,amount) SELECT $1,v.item_id,v.amount FROM unnest($2::int[],$3::numeric[]) AS v(item_id,amount)',
      [99, [1, 2], [250, 2]],
    );
    assert.equal((await pg.query('SELECT * FROM store_recipes WHERE menu_item_id=99')).rows.length, 2);
  } finally {
    await pg.close();
  }

  const api = readFileSync('src/app/api/store/route.ts', 'utf8');
  const ui = readFileSync('src/app/(internal)/store/page.tsx', 'utf8');
  const photo = readFileSync('src/app/api/store/images/[id]/route.ts', 'utf8');
  assert.ok(api.includes("left(image, 11) = 'data:image/'") && api.includes("'/api/store/images/' || id") && api.includes('publish(CHANNELS.store)'));
  assert.ok(api.includes('WITH recent_requests AS') && api.includes('unnest($1::int[],$2::numeric[])'));
  assert.ok(ui.includes('!document.hidden && (!connected') && ui.includes('refreshAgain.current'));
  assert.ok(ui.includes('applyOptimisticCommit(action, payload)'));
  assert.ok(ui.includes('setNotice(success);\n      void load(true);'), 'success does not wait for a second full fetch');
  assert.ok(photo.includes('readStaffSession()') && photo.includes('session_valid_after') && photo.includes("'private, max-age=1800'"));
  for (const source of ['src/app/api/station-items/route.ts', 'src/app/api/tickets/route.ts', 'src/app/api/buna-notes/pay/route.ts']) {
    assert.ok(readFileSync(source, 'utf8').includes('publish(CHANNELS.store)'), `${source} must notify Store after trigger-backed stock changes`);
  }
}

async function main() {
  await checkWarmMigration();
  await checkStoreSchemaAndBatch();
  console.log('Performance regression tests passed: warm schema probe, versioned Store DDL, rollback, batched request validation and photo/refresh guards');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
