import { pool } from '@/db';

// Installed once, when the store is first opened. Past orders are deliberately
// not backfilled. The trigger runs in the same transaction as the Done tap.
export const STORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS store_accounts (
 staff_id integer PRIMARY KEY, station text NOT NULL, session_valid_after timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE store_accounts ADD COLUMN IF NOT EXISTS session_valid_after timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS store_items (
 id serial PRIMARY KEY, name text NOT NULL, dimension text NOT NULL CHECK (dimension IN ('mass','volume','count')),
 image text NOT NULL DEFAULT '', balance numeric(18,3) NOT NULL DEFAULT 0 CHECK(balance >= 0),
 low_at numeric(18,3) NOT NULL DEFAULT 0 CHECK(low_at >= 0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS store_items_name_key ON store_items(lower(trim(name)));
CREATE TABLE IF NOT EXISTS store_station_balances (
 station text NOT NULL, item_id integer NOT NULL REFERENCES store_items(id), balance numeric(18,3) NOT NULL DEFAULT 0,
 PRIMARY KEY(station,item_id)
);
CREATE TABLE IF NOT EXISTS store_requests (
 id serial PRIMARY KEY, requester_id integer NOT NULL, requester_name text NOT NULL, station text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted')),
 created_at timestamptz NOT NULL DEFAULT now(), accepted_at timestamptz, accepted_by text
);
-- A retry key makes a mixed-destination submission atomic and repeat-safe.
CREATE TABLE IF NOT EXISTS store_push_subscriptions (
 endpoint text PRIMARY KEY, p256dh text NOT NULL, auth text NOT NULL, staff_id integer, session_iat bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS store_request_batches (
 idempotency_key text PRIMARY KEY, requester_id integer NOT NULL, payload_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS store_request_edits (
 id bigserial PRIMARY KEY, request_id integer NOT NULL REFERENCES store_requests(id), actor text NOT NULL, before_lines jsonb NOT NULL, after_lines jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS store_request_lines (
 request_id integer NOT NULL REFERENCES store_requests(id) ON DELETE CASCADE,
 item_id integer NOT NULL REFERENCES store_items(id), amount numeric(18,3) NOT NULL CHECK(amount > 0),
 PRIMARY KEY(request_id,item_id)
);
CREATE TABLE IF NOT EXISTS store_recipes (
 menu_item_id integer NOT NULL, item_id integer NOT NULL REFERENCES store_items(id),
 amount numeric(18,3) NOT NULL CHECK(amount > 0), PRIMARY KEY(menu_item_id,item_id)
);
CREATE TABLE IF NOT EXISTS store_station_imports (
 idempotency_key text PRIMARY KEY, station text NOT NULL, item_id integer NOT NULL REFERENCES store_items(id),
 amount numeric(18,3) NOT NULL CHECK(amount>0), actor text NOT NULL, kind text NOT NULL DEFAULT 'import', reason text, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE store_station_imports ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'import';
ALTER TABLE store_station_imports ADD COLUMN IF NOT EXISTS reason text;
CREATE TABLE IF NOT EXISTS store_done_events (
 ticket_item_id integer PRIMARY KEY, menu_item_id integer, item_name text NOT NULL, category text,
 station text NOT NULL, quantity integer NOT NULL, done_at timestamptz NOT NULL DEFAULT now(), missing_recipe boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS store_done_events_date_idx ON store_done_events(done_at);
CREATE INDEX IF NOT EXISTS store_requests_requester_date_idx ON store_requests(requester_id, created_at DESC);
CREATE INDEX IF NOT EXISTS store_requests_date_idx ON store_requests(created_at DESC);
CREATE TABLE IF NOT EXISTS store_movements (
 id bigserial PRIMARY KEY, item_id integer NOT NULL REFERENCES store_items(id), station text,
 kind text NOT NULL CHECK(kind IN ('purchase','issue','usage','waste')), amount numeric(18,3) NOT NULL CHECK(amount > 0),
 actor text, reason text, request_id integer, ticket_item_id integer, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_movements_date_idx ON store_movements(created_at);
CREATE OR REPLACE FUNCTION store_record_done() RETURNS trigger AS $$
DECLARE r record; dest text; event_id integer;
BEGIN
 IF NEW.station_status = 'done' AND (TG_OP = 'INSERT' OR OLD.station_status IS DISTINCT FROM 'done') AND COALESCE(NEW.removed,false) = false AND COALESCE(NEW.quantity,0) > 0 THEN
  dest := COALESCE(NULLIF(NEW.station_name,''),'kitchen');
  INSERT INTO store_done_events(ticket_item_id,menu_item_id,item_name,category,station,quantity,done_at,missing_recipe)
  VALUES(NEW.id,NEW.menu_item_id,NEW.name,NEW.category,dest,NEW.quantity,now(),
    NOT EXISTS (SELECT 1 FROM store_recipes WHERE menu_item_id=NEW.menu_item_id))
  ON CONFLICT(ticket_item_id) DO NOTHING RETURNING ticket_item_id INTO event_id;
  IF event_id IS NOT NULL THEN
   FOR r IN SELECT item_id, amount FROM store_recipes WHERE menu_item_id=NEW.menu_item_id ORDER BY item_id LOOP
    INSERT INTO store_station_balances(station,item_id,balance) VALUES(dest,r.item_id,-r.amount*NEW.quantity)
    ON CONFLICT(station,item_id) DO UPDATE SET balance=store_station_balances.balance+EXCLUDED.balance;
    INSERT INTO store_movements(item_id,station,kind,amount,ticket_item_id,actor)
    VALUES(r.item_id,dest,'usage',r.amount*NEW.quantity,NEW.id,NEW.station_done_by);
   END LOOP;
  END IF;
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS store_done_trigger ON ticket_items;
CREATE TRIGGER store_done_trigger AFTER INSERT OR UPDATE OF station_status ON ticket_items
 FOR EACH ROW EXECUTE FUNCTION store_record_done();
`;
// Bump this when STORE_SCHEMA_SQL changes. A durable version prevents each
// route bundle or app restart from dropping/recreating the ticket_items trigger
// (which takes an exclusive table lock). No inventory/history is backfilled.
export const STORE_SCHEMA_VERSION = '2026-10-29-1';

/** Apply a schema version once across processes; exported for integration tests. */
export async function installStoreSchema(client: import('pg').PoolClient): Promise<void> {
  try {
    const current = await client.query('SELECT version FROM store_schema_meta WHERE id=1');
    if (current.rows[0]?.version === STORE_SCHEMA_VERSION) return;
  } catch (e) {
    // A new installation has no metadata table yet. Do not mistake a network,
    // permission or other database error for a first installation.
    if ((e as { code?: string }).code !== '42P01') throw e;
  }

  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [198204572]);
    await client.query('CREATE TABLE IF NOT EXISTS store_schema_meta (id integer PRIMARY KEY, version text NOT NULL)');
    // Another process may have installed it while this one waited for the lock.
    const current = await client.query('SELECT version FROM store_schema_meta WHERE id=1');
    if (current.rows[0]?.version !== STORE_SCHEMA_VERSION) {
      await client.query(STORE_SCHEMA_SQL);
      await client.query(
        'INSERT INTO store_schema_meta(id,version) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version',
        [STORE_SCHEMA_VERSION],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

const globalForStore = globalThis as typeof globalThis & {
  __fanaStoreSetup?: { version: string; promise: Promise<void> };
};

export function ensureStoreSchema(): Promise<void> {
  const existing = globalForStore.__fanaStoreSetup;
  if (existing?.version === STORE_SCHEMA_VERSION) return existing.promise;

  const promise = (async () => {
    const client = await pool.connect();
    try {
      await installStoreSchema(client);
    } finally {
      client.release();
    }
  })().catch((e) => {
    // Retry on a later request, but do not clear a newer version's setup.
    if (globalForStore.__fanaStoreSetup?.promise === promise) delete globalForStore.__fanaStoreSetup;
    throw e;
  });
  globalForStore.__fanaStoreSetup = { version: STORE_SCHEMA_VERSION, promise };
  return promise;
}
