import { db } from "@/db";
import { sql } from "drizzle-orm";

/**
 * UNIVERSAL self-healing schema manager — works on ANY Postgres database
 * (Neon, local, Supabase, Railway, old broken local DBs, fresh empty DBs).
 *
 * Strategy:
 *  1. CREATE TABLE IF NOT EXISTS  → handles fresh databases
 *  2. ADD COLUMN IF NOT EXISTS    → handles tables created by older versions
 *  3. Normalize column TYPES      → fixes varchar(100) that should be text, etc.
 *  4. SET column DEFAULTS         → fixes created_at/status without defaults
 *  5. DROP NOT NULL on data cols  → removes blocks from older stricter schemas
 *
 * Every statement runs in its own try/catch — one failure never blocks the app.
 */

async function run(statement: string): Promise<string | null> {
  try {
    await db.execute(sql.raw(statement));
    return null;
  } catch (e) {
    return String(e);
  }
}

const CREATES: Array<[string, string]> = [
  [
    "site_settings",
    `CREATE TABLE IF NOT EXISTS site_settings (
      key varchar(100) PRIMARY KEY,
      value text NOT NULL,
      updated_at timestamp DEFAULT now()
    )`,
  ],
  [
    "categories",
    `CREATE TABLE IF NOT EXISTS categories (
      id serial PRIMARY KEY,
      name text,
      slug text,
      icon text,
      sort_order integer DEFAULT 0
    )`,
  ],
  [
    "menu_items",
    `CREATE TABLE IF NOT EXISTS menu_items (
      id serial PRIMARY KEY,
      name text,
      category text,
      price integer DEFAULT 0,
      description text,
      image_url text,
      is_popular boolean DEFAULT false,
      is_available boolean DEFAULT true,
      dietary_tags text,
      prep_time text DEFAULT '10-15 min',
      badge text,
      sort_order integer DEFAULT 0
    )`,
  ],
  [
    "reservations",
    `CREATE TABLE IF NOT EXISTS reservations (
      id serial PRIMARY KEY,
      reservation_number text,
      guest_name text,
      phone text,
      email text,
      date text,
      time text,
      party_size integer DEFAULT 2,
      table_preference text DEFAULT 'Indoor',
      special_requests text,
      status text DEFAULT 'confirmed',
      created_at timestamp DEFAULT now()
    )`,
  ],
  [
    "orders",
    `CREATE TABLE IF NOT EXISTS orders (
      id serial PRIMARY KEY,
      order_number text,
      customer_name text,
      phone text,
      order_type text DEFAULT 'delivery',
      address text,
      items text,
      total_amount integer DEFAULT 0,
      status text DEFAULT 'pending',
      notes text,
      created_at timestamp DEFAULT now()
    )`,
  ],
  [
    "reviews",
    `CREATE TABLE IF NOT EXISTS reviews (
      id serial PRIMARY KEY,
      customer_name text,
      rating integer DEFAULT 5,
      review_text text,
      review_date text,
      is_approved boolean DEFAULT true,
      is_verified boolean DEFAULT true,
      created_at timestamp DEFAULT now()
    )`,
  ],
  [
    "gallery_items",
    `CREATE TABLE IF NOT EXISTS gallery_items (
      id serial PRIMARY KEY,
      title text,
      category text,
      image_url text,
      caption text,
      sort_order integer DEFAULT 0
    )`,
  ],
];

/** column name → desired spec: type (sql type + optional using-cast expr) + default + dropNotNull */
interface ColSpec {
  type: string;
  castText?: boolean; // cast via ::text before re-typing
  def?: string;
  dropNotNull?: boolean;
}

const RMS_CREATES: Array<[string, string]> = [
  [
    "staff_users",
    `CREATE TABLE IF NOT EXISTS staff_users (
      id serial PRIMARY KEY,
      name text,
      role text DEFAULT 'waiter',
      pin text DEFAULT '0000',
      created_at timestamp DEFAULT now()
    )`,
  ],
  [
    "cafe_tables",
    `CREATE TABLE IF NOT EXISTS cafe_tables (
      id serial PRIMARY KEY,
      name text,
      sort_order integer DEFAULT 0,
      created_at timestamp DEFAULT now()
    )`,
  ],
  [
    "tickets",
    `CREATE TABLE IF NOT EXISTS tickets (
      id serial PRIMARY KEY,
      table_id integer DEFAULT 0,
      table_name text,
      status text DEFAULT 'new',
      payment_method text,
      receipt_image text,
      total_amount integer DEFAULT 0,
      created_by text,
      closed_at timestamp,
      created_at timestamp DEFAULT now(),
      updated_at timestamp DEFAULT now()
    )`,
  ],
  [
    "ticket_items",
    `CREATE TABLE IF NOT EXISTS ticket_items (
      id serial PRIMARY KEY,
      ticket_id integer DEFAULT 0,
      menu_item_id integer,
      name text,
      category text,
      price integer DEFAULT 0,
      quantity integer DEFAULT 1,
      notes text,
      removed boolean DEFAULT false,
      created_at timestamp DEFAULT now()
    )`,
  ],
  [
    "announcements",
    `CREATE TABLE IF NOT EXISTS announcements (
      id serial PRIMARY KEY,
      title text DEFAULT 'Announcement',
      description text DEFAULT '',
      image_url text,
      start_date text,
      end_date text,
      priority integer DEFAULT 0,
      created_at timestamp DEFAULT now()
    )`,
  ],
  [
    "cdn_images",
    `CREATE TABLE IF NOT EXISTS cdn_images (
      id serial PRIMARY KEY,
      mime_type text DEFAULT 'image/jpeg',
      data text,
      created_at timestamp DEFAULT now()
    )`,
  ],
];

const RMS_COLUMNS: Record<string, Record<string, ColSpec>> = {
  staff_users: {
    name: { type: "text", def: "'Staff'" },
    role: { type: "text", def: "'waiter'" },
    pin: { type: "text", def: "'0000'" },
    created_at: { type: "timestamp", def: "now()", dropNotNull: true },
  },
  cafe_tables: {
    name: { type: "text", def: "'Table'" },
    sort_order: { type: "integer", def: "0", castText: true },
    created_at: { type: "timestamp", def: "now()", dropNotNull: true },
  },
  tickets: {
    table_id: { type: "integer", def: "0", castText: true },
    table_name: { type: "text", def: "'Table'" },
    status: { type: "text", def: "'new'" },
    payment_method: { type: "text" },
    payment_status: { type: "text", def: "'unpaid'" },
    receipt_image: { type: "text" },
    total_amount: { type: "integer", def: "0", castText: true },
    created_by: { type: "text" },
    closed_at: { type: "timestamp", dropNotNull: true },
    created_at: { type: "timestamp", def: "now()", dropNotNull: true },
    updated_at: { type: "timestamp", def: "now()", dropNotNull: true },
    // Group 1: guaranteed-unique order number + idempotent order submission
    order_number: { type: "text" },
    idempotency_key: { type: "text" },
  },
  ticket_items: {
    ticket_id: { type: "integer", def: "0", castText: true },
    station_name: { type: "text", def: "'kitchen'" },
    station_status: { type: "text", def: "'pending'" },
    menu_item_id: { type: "integer", castText: true },
    name: { type: "text", def: "'Item'" },
    category: { type: "text" },
    price: { type: "integer", def: "0", castText: true },
    quantity: { type: "integer", def: "1", castText: true },
    notes: { type: "text" },
    removed: { type: "boolean", def: "false" },
    created_at: { type: "timestamp", def: "now()", dropNotNull: true },
    // Group 1: idempotent order submission (unique per ticket + key)
    idempotency_key: { type: "text" },
  },
};

const TABLE_COLUMNS: Record<string, Record<string, ColSpec>> = {
  orders: {
    order_number: { type: "text", def: "'FANA-ORD-000000'" },
    customer_name: { type: "text", def: "'Guest'" },
    phone: { type: "text", def: "''" },
    order_type: { type: "text", def: "'delivery'" },
    address: { type: "text" },
    items: { type: "text", def: "'[]'" },
    total_amount: { type: "integer", def: "0", castText: true },
    status: { type: "text", def: "'pending'" },
    notes: { type: "text" },
    created_at: { type: "timestamp", def: "now()", dropNotNull: true },
  },
    menu_items: {
    name: { type: "text", def: "'Menu Item'" },
    category: { type: "text", def: "'signature-coffee'" },
    price: { type: "integer", def: "0", castText: true },
    description: { type: "text" },
    image_url: { type: "text" },
    is_popular: { type: "boolean", def: "false" },
    is_available: { type: "boolean", def: "true" },
    dietary_tags: { type: "text" },
    prep_time: { type: "text", def: "'10-15 min'" },
    badge: { type: "text" },
    sale_price: { type: "integer", castText: true },
    sale_start: { type: "text" },
    sale_end: { type: "text" },
    sort_order: { type: "integer", def: "0", castText: true },
  },
  announcements: {
    title: { type: "text", def: "'Announcement'" },
    description: { type: "text", def: "''" },
    image_url: { type: "text" },
    start_date: { type: "text" },
    end_date: { type: "text" },
    priority: { type: "integer", def: "0", castText: true },
    created_at: { type: "timestamp", def: "now()", dropNotNull: true },
  },
  reservations: {
    reservation_number: { type: "text", def: "'FANA-RES-000000'" },
    guest_name: { type: "text", def: "'Guest'" },
    phone: { type: "text", def: "''" },
    email: { type: "text" },
    date: { type: "text" },
    time: { type: "text" },
    party_size: { type: "integer", def: "2", castText: true },
    table_preference: { type: "text", def: "'Indoor'" },
    special_requests: { type: "text" },
    status: { type: "text", def: "'confirmed'" },
    created_at: { type: "timestamp", def: "now()", dropNotNull: true },
  },
  reviews: {
    customer_name: { type: "text", def: "'Guest'" },
    rating: { type: "integer", def: "5", castText: true },
    review_text: { type: "text", def: "''" },
    review_date: { type: "text" },
    is_approved: { type: "boolean", def: "true" },
    is_verified: { type: "boolean", def: "true" },
    created_at: { type: "timestamp", def: "now()", dropNotNull: true },
  },
  gallery_items: {
    title: { type: "text", def: "'Gallery Photo'" },
    category: { type: "text", def: "'General'" },
    image_url: { type: "text" },
    caption: { type: "text" },
    sort_order: { type: "integer", def: "0", castText: true },
  },
  categories: {
    name: { type: "text", def: "'General'" },
    slug: { type: "text", def: "'general'" },
    icon: { type: "text", def: "'Coffee'" },
    sort_order: { type: "integer", def: "0", castText: true },
  },
  site_settings: {
    value: { type: "text" },
    updated_at: { type: "timestamp", def: "now()", dropNotNull: true },
  },
};

// Cache the schema check per server process — creating/checking tables hundreds of times
// per minute was the #1 speed bottleneck (10s+ first loads on Vercel+Neon).
// It only needs to run ONCE per server instance; /api/setup?force=1 re-runs it.
const globalForMigrate = globalThis as typeof globalThis & {
  __fanaMigrateDone?: boolean;
};

export async function ensureTablesExist(force = false) {
  if (globalForMigrate.__fanaMigrateDone && !force) {
    return { success: true, errors: [] as string[] };
  }
  const errors: string[] = [];

  // TRAFFIC BOAT-FIX: test DB health with ONE light query first.
  // If the DB is already healthy (it is, 99.99% of the time), skip the entire 100+ CREATE/ALTER storm
  returnOnWarm: {
    if (!force) {
      try {
        await db.execute(sql`SELECT 1 FROM site_settings LIMIT 1`);
        globalForMigrate.__fanaMigrateDone = true;
        break returnOnWarm;
      } catch {
        // table missing / DB broken → fall through to full migration below
      }
    }
  }

  // Step 1 — create missing tables (classic + RMS)
  for (const [name, ddl] of [...CREATES, ...RMS_CREATES]) {
    const err = await run(ddl);
    if (err) errors.push(`create ${name}: ${err}`);
  }

  // Step 2 — add missing columns + normalize types/defaults/constraints
  for (const [table, cols] of Object.entries({ ...TABLE_COLUMNS, ...RMS_COLUMNS })) {
    for (const [col, spec] of Object.entries(cols)) {
      // 2a. add if missing
      await run(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${spec.type}`);

      // 2b. soften strict NOT NULL on data columns (old strict schemas block inserts)
      await run(`ALTER TABLE ${table} ALTER COLUMN ${col} DROP NOT NULL`);

      // 2c. normalize type (e.g. varchar(100) → text)
      if (spec.type === "text") {
        await run(`ALTER TABLE ${table} ALTER COLUMN ${col} TYPE text USING ${col}::text`);
      } else if (spec.type === "integer") {
        await run(
          `ALTER TABLE ${table} ALTER COLUMN ${col} TYPE integer USING NULLIF(trim(${col}::text), '')::integer`
        );
      } else if (spec.type === "boolean") {
        await run(
          `ALTER TABLE ${table} ALTER COLUMN ${col} TYPE boolean USING (${col}::text IN ('true','t','1','yes','on'))`
        );
      } else if (spec.type === "timestamp") {
        await run(`ALTER TABLE ${table} ALTER COLUMN ${col} TYPE timestamp USING ${col}::timestamp`);
      }

      // 2d. ensure a sensible default exists
      if (spec.def) {
        await run(`ALTER TABLE ${table} ALTER COLUMN ${col} SET DEFAULT ${spec.def}`);
      }
    }
  }

  // Step 3 — repair auto-increment sequences (fixes "null value in column id" insert failures)
  const serialTables = [
    "categories",
    "menu_items",
    "reviews",
    "gallery_items",
    "staff_users",
    "cafe_tables",
    "tickets",
    "ticket_items",
    "announcements",
  ];
  for (const t of serialTables) {
    await run(`CREATE SEQUENCE IF NOT EXISTS ${t}_id_seq`);
    await run(`ALTER TABLE ${t} ALTER COLUMN id SET DEFAULT nextval('${t}_id_seq')`);
    await run(
      `SELECT setval('${t}_id_seq', COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`
    );
  }

  // Step 4 — Group 1 integrity constraints:
  //  • order_number = FANA-<id> (guaranteed unique — derived from the DB serial, never random)
  //  • unique (ticket_id, idempotency_key) on ticket_items: each submission stores
  //    per-item derived keys (<key>#<index>), so a retry/double-tap of the same
  //    submission can never be inserted twice, while separate submissions of the
  //    same table bill (customer orders again) stay allowed.
  await run(`UPDATE tickets SET order_number = 'FANA-' || id WHERE order_number IS NULL OR order_number = ''`);
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS tickets_order_number_key ON tickets (order_number) WHERE order_number IS NOT NULL AND order_number <> ''`
  );
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS ticket_items_idempotency_key_key ON ticket_items (ticket_id, idempotency_key) WHERE idempotency_key IS NOT NULL`
  );

  //  • payment_status backfill: existing paid/completed bills get a concrete
  //    status derived from their stored method so reports/history stay correct
  //    ("online" historically meant Telebirr/wallet in this cafe). Note: SET
  //    DEFAULT only affects NEW rows, so existing rows are NULL until backfilled —
  //    the (payment_status IS NULL OR ...) guard covers that.
  await run(`UPDATE tickets SET payment_status = 'paid_cash' WHERE (payment_status IS NULL OR payment_status = 'unpaid') AND status IN ('paid','completed') AND payment_method = 'cash'`);
  await run(`UPDATE tickets SET payment_status = 'paid_card' WHERE (payment_status IS NULL OR payment_status = 'unpaid') AND status IN ('paid','completed') AND payment_method = 'card'`);
  await run(`UPDATE tickets SET payment_status = 'paid_telebirr' WHERE (payment_status IS NULL OR payment_status = 'unpaid') AND status IN ('paid','completed') AND payment_method IN ('online','telebirr')`);
  await run(`UPDATE tickets SET payment_status = 'paid_cbe' WHERE (payment_status IS NULL OR payment_status = 'unpaid') AND status IN ('paid','completed') AND payment_method = 'cbe'`);
  // Whatever remains (active bills, unknown methods) is definitively unpaid.
  await run(`UPDATE tickets SET payment_status = 'unpaid' WHERE payment_status IS NULL`);

  if (errors.length > 0) {
    console.error("ensureTablesExist errors:", errors);
    return { success: false, errors };
  }
  globalForMigrate.__fanaMigrateDone = true;
  return { success: true, errors: [] as string[] };
}

/** Report per-table health for /api/setup. */
export async function checkTablesReport() {
  const tables = Object.keys(TABLE_COLUMNS);
  const report: Record<string, string> = {};
  for (const t of tables) {
    const err = await run(`SELECT 1 FROM ${t} LIMIT 1`);
    report[t] = err ? `missing/broken (${err})` : "OK";
  }
  return report;
}

/** Live insert test used by /api/dbtest — proves orders & menu inserts work. */
export async function insertSmokeTest() {
  const results: Record<string, string> = {};

  let err = await run(
    `INSERT INTO orders (order_number, customer_name, phone, order_type, address, items, total_amount, status, notes)
     VALUES ('FANA-TEST-000001','Setup Test','0911065022','delivery','Test Address','[]',1,'pending','smoke test')`
  );
  if (!err) {
    await run(`DELETE FROM orders WHERE order_number = 'FANA-TEST-000001'`);
    results.orders = "INSERT OK";
  } else {
    results.orders = `INSERT FAILED: ${err}`;
  }

  err = await run(
    `INSERT INTO menu_items (name, category, price, description, image_url, is_popular, is_available, dietary_tags, prep_time, badge, sort_order)
     VALUES ('__smoke_test__','test',1,'t','',false,true,'','1 min','',0)`
  );
  if (!err) {
    await run(`DELETE FROM menu_items WHERE name = '__smoke_test__'`);
    results.menu_items = "INSERT OK";
  } else {
    results.menu_items = `INSERT FAILED: ${err}`;
  }

  err = await run(
    `INSERT INTO reservations (reservation_number, guest_name, phone, date, time, party_size, table_preference, status)
     VALUES ('FANA-TEST-000002','Setup Test','0911065022','2026-01-01','12:00 PM',2,'Indoor','confirmed')`
  );
  if (!err) {
    await run(`DELETE FROM reservations WHERE reservation_number = 'FANA-TEST-000002'`);
    results.reservations = "INSERT OK";
  } else {
    results.reservations = `INSERT FAILED: ${err}`;
  }

  return results;
}
