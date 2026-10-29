// Optional integration test against a disposable PostgreSQL database.
// TEST_DATABASE_URL=postgresql://... npm run test:store-postgres
// Creates and drops only a uniquely named test schema; never point tests at production.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { installStoreSchema, STORE_SCHEMA_SQL, STORE_SCHEMA_VERSION } from '../src/lib/store/schema';
import { insertRequestLines, loadRequestItems, validateRequestLines } from '../src/lib/store/request-lines';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database, never production.');
const schema = `fana_test_${randomBytes(8).toString('hex')}`;
const control = new Pool({ connectionString: url });
const db = new Pool({ connectionString: url, max: 16, options: `-c search_path=${schema}` });

async function withClient<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try { return await fn(client); } finally { client.release(); }
}

async function main() {
  try {
    await control.query(`CREATE SCHEMA ${schema}`);
    await db.query(`CREATE TABLE ticket_items(id serial PRIMARY KEY,station_status text,station_name text,menu_item_id integer,name text,category text,quantity integer,station_done_by text,removed boolean DEFAULT false)`);
    // Different connections represent different app processes starting at once.
    await Promise.all(Array.from({ length: 12 }, () => withClient(installStoreSchema)));
    const meta = await db.query('SELECT version FROM store_schema_meta WHERE id=1');
    assert.equal(meta.rows[0].version, STORE_SCHEMA_VERSION);
    const triggers = await db.query("SELECT oid,tgname FROM pg_trigger WHERE tgrelid='ticket_items'::regclass AND NOT tgisinternal");
    assert.equal(triggers.rowCount, 1);
    let queries = 0;
    await withClient(async (client) => {
      const wrapped = { query: (query: string, params?: unknown[]) => { queries++; return client.query(query, params); } } as unknown as PoolClient;
      await installStoreSchema(wrapped);
    });
    assert.equal(queries, 1, 'warm install must only read schema version');
    const triggersAfter = await db.query("SELECT oid,tgname FROM pg_trigger WHERE tgrelid='ticket_items'::regclass AND NOT tgisinternal");
    assert.deepEqual(triggersAfter.rows, triggers.rows, 'warm startup must not replace a live trigger');

    // Failure during an upgrade must roll back both its DDL and the version.
    await db.query("UPDATE store_schema_meta SET version='old' WHERE id=1");
    await assert.rejects(() => withClient(async (client) => {
      const wrapped = { query: (query: string, params?: unknown[]) => {
        if (query === STORE_SCHEMA_SQL) throw new Error('injected failure');
        return client.query(query, params);
      } } as unknown as PoolClient;
      await installStoreSchema(wrapped);
    }), /injected failure/);
    assert.equal((await db.query('SELECT version FROM store_schema_meta WHERE id=1')).rows[0].version, 'old');
    await Promise.all(Array.from({ length: 8 }, () => withClient(installStoreSchema)));
    assert.equal((await db.query('SELECT version FROM store_schema_meta WHERE id=1')).rows[0].version, STORE_SCHEMA_VERSION);

    await db.query("INSERT INTO store_items(name,dimension,balance) VALUES ('Milk','volume',5000),('Egg','count',100)");
    await db.query("INSERT INTO store_requests(requester_id,requester_name,station) VALUES (7,'Test','kitchen'),(7,'Test','juice')");
    await withClient(async (client) => {
      const raw = [{ itemId: 1, amount: 2, unit: 'L' }, { itemId: 2, amount: 10, unit: 'pcs' }, { itemId: 1, amount: 1, unit: 'L' }];
      const catalog = await loadRequestItems(client, raw);
      const first = validateRequestLines(raw.slice(0, 2), catalog);
      const second = validateRequestLines(raw.slice(2), catalog);
      await insertRequestLines(client, [...first.map((line) => ({ requestId: 1, ...line })), ...second.map((line) => ({ requestId: 2, ...line }))]);
    });
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM store_request_lines')).rows[0].n), 3);
    assert.equal(Number((await db.query('SELECT balance FROM store_items WHERE id=1')).rows[0].balance), 5000);
    // Real PostgreSQL trigger fires once when a station marks a line done.
    await db.query('INSERT INTO store_recipes(menu_item_id,item_id,amount) VALUES (42,1,500)');
    await db.query("INSERT INTO ticket_items(station_status,station_name,menu_item_id,name,category,quantity,station_done_by) VALUES ('pending','kitchen',42,'Test','Food',2,'Cook')");
    await db.query("UPDATE ticket_items SET station_status='done' WHERE menu_item_id=42");
    await db.query("UPDATE ticket_items SET station_status='done' WHERE menu_item_id=42");
    assert.equal(Number((await db.query("SELECT balance FROM store_station_balances WHERE station='kitchen' AND item_id=1")).rows[0].balance), -1000);
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM store_movements WHERE kind='usage'")).rows[0].n), 1);
    console.log('PostgreSQL integration passed: 12 concurrent cold starts, warm trigger stability, failed upgrade rollback/retry, batched requests and exactly-once stock trigger.');
  } finally {
    await db.end();
    await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await control.end();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
