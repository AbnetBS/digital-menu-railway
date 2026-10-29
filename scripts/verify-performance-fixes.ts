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
  } finally {
    await pg.close();
  }

  const api = readFileSync('src/app/api/store/route.ts', 'utf8');
  const ui = readFileSync('src/app/(internal)/store/page.tsx', 'utf8');
  const photo = readFileSync('src/app/api/store/images/[id]/route.ts', 'utf8');
  assert.ok(api.includes("'/api/store/images/' || id") && api.includes('publish(CHANNELS.store)'));
  assert.ok(ui.includes('!document.hidden && (!connected') && ui.includes('refreshAgain.current'));
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
