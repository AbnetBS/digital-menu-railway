import { db } from "@/db";
import { sql } from "drizzle-orm";

/**
 * SCHEMA VERSION GATE — bump this every time new columns/indexes are added.
 *
 * The old warm-path probe only checked that `site_settings` exists, which
 * meant databases created by an EARLIER version of the code silently SKIPPED
 * every new migration forever (e.g. `ticket_items.idempotency_key`,
 * `tickets.order_number`, `tickets.payment_status` were never added to a
 * pre-existing production DB → every order submission crashed with
 * "column does not exist").
 *
 * Now the fast path only skips when the recorded schema version matches this
 * constant; any older (or missing) version runs the full idempotent migration
 * once and stamps the new version. Existing DBs self-heal on the first
 * request after a deploy — no manual action needed.
 */
export const SCHEMA_VERSION = "2026-10-29-1";

/**
 * UNIVERSAL self-healing schema manager — works on ANY Postgres database
 * (Coolify PostgreSQL, local, old broken local DBs, fresh empty DBs).
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
      is_buna boolean DEFAULT false,
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
      order_type text DEFAULT 'dine_in',
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
  [
    "translations",
    `CREATE TABLE IF NOT EXISTS translations (
      id serial PRIMARY KEY,
      lang varchar(10) NOT NULL,
      source_hash varchar(64) NOT NULL,
      source_text text NOT NULL,
      translated_text text NOT NULL,
      created_at timestamp DEFAULT now()
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
      station_status_by text,
      station_status_at timestamp,
      -- RELEASE GATE (owner, Sept 2026): a guest top-up on a bill that was
      -- already sent waits here (false) until staff confirm it to the stations.
      released boolean DEFAULT true,
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
      promotion_items text,
      priority integer DEFAULT 0,
      created_at timestamp DEFAULT now()
    )`,
  ],
  [
    // Durable waiter send holds: the server releases due orders even when the
    // waiter leaves the app or closes the phone browser.
    "deferred_ticket_sends",
    `CREATE TABLE IF NOT EXISTS deferred_ticket_sends (
      idempotency_key varchar(64) PRIMARY KEY,
      payload text NOT NULL,
      due_at timestamp NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'pending',
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      created_by varchar(100) NOT NULL,
      created_at timestamp DEFAULT now(),
      updated_at timestamp DEFAULT now()
    )`,
  ],
  [
    // Group 8: one row per accepted order submission, so identical lines can be
    // folded into an existing row without losing the duplicate-submission guard.
    "order_submissions",
    `CREATE TABLE IF NOT EXISTS order_submissions (
      id serial PRIMARY KEY,
      ticket_id integer NOT NULL,
      idempotency_key varchar(64) NOT NULL,
      source varchar(20),
      waiter_name varchar(100),
      lines integer DEFAULT 0,
      merged_lines integer DEFAULT 0,
      created_at timestamp DEFAULT now()
    )`,
  ],
  [
    // Persistent bill audit for admin history/reporting: status changes,
    // cashier/waiter edits, prints and submission summaries.
    "ticket_events",
    `CREATE TABLE IF NOT EXISTS ticket_events (
      id serial PRIMARY KEY,
      ticket_id integer NOT NULL,
      event_type text NOT NULL,
      actor_name text,
      actor_role text,
      source text,
      item_id integer,
      item_name text,
      from_value text,
      to_value text,
      details text,
      created_at timestamp DEFAULT now()
    )`,
  ],
  [
    // Group 10 (pocket-mode alerts): one row per staff device subscribed to
    // Web Push. Unique endpoint = one row per device, re-subscribing refreshes it.
    "push_subscriptions",
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
      id serial PRIMARY KEY,
      endpoint text NOT NULL,
      p256dh text NOT NULL,
      auth text NOT NULL,
      role varchar(20) NOT NULL,
      name varchar(100),
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
  [
    // Coffee Note (owner's decision, Sept 2026): the cashier's held tab for
    // OUTDOOR buna sales. Rows live here while on hold (never in tickets, so
    // no station screen or outdoor card can see them); paying one creates the
    // real outdoor ticket straight into order history.
    "buna_notes",
    `CREATE TABLE IF NOT EXISTS buna_notes (
      id serial PRIMARY KEY,
      seq integer NOT NULL DEFAULT 1,
      menu_item_id integer,
      item_name varchar(200) NOT NULL,
      unit_price integer NOT NULL DEFAULT 0,
      quantity integer NOT NULL DEFAULT 1,
      place_note varchar(200),
      held_by varchar(100),
      held_at timestamp DEFAULT now(),
      paid_at timestamp,
      paid_by varchar(100),
      ticket_id integer
    )`,
  ],
  [
    // Attendance shifts (Morning, Afternoon) - owner config
    "attendance_shifts",
    `CREATE TABLE IF NOT EXISTS attendance_shifts (
      id serial PRIMARY KEY,
      name varchar(50) NOT NULL,
      start_time varchar(5) NOT NULL,
      end_time varchar(5) NOT NULL,
      grace_minutes integer NOT NULL DEFAULT 15,
      created_at timestamp DEFAULT now()
    )`,
  ],
  [
    // Staff fingerprint mappings - FPC1020A stores template, we store ID->staff mapping
    "staff_biometrics",
    `CREATE TABLE IF NOT EXISTS staff_biometrics (
      id serial PRIMARY KEY,
      staff_id integer NOT NULL,
      fingerprint_id integer NOT NULL,
      finger_name varchar(50) DEFAULT 'Right Index',
      enrolled_at timestamp DEFAULT now(),
      enrolled_by varchar(100)
    )`,
  ],
  [
    "attendance_scan_events",
    `CREATE TABLE IF NOT EXISTS attendance_scan_events (
      event_id varchar(32) PRIMARY KEY,
      fingerprint_id integer NOT NULL,
      captured_member_id integer,
      device_id varchar(50) NOT NULL,
      scanned_at timestamp NOT NULL,
      response jsonb NOT NULL,
      received_at timestamp NOT NULL DEFAULT now()
    )`,
  ],
  [
    // Attendance logs - one row per staff per day with IN/OUT like paper sheet
    "attendance_logs",
    `CREATE TABLE IF NOT EXISTS attendance_logs (
      id serial PRIMARY KEY,
      staff_id integer NOT NULL,
      fingerprint_id integer,
      date varchar(10) NOT NULL,
      clock_in timestamp,
      clock_out timestamp,
      clock_in_method varchar(20) DEFAULT 'fingerprint',
      clock_out_method varchar(20),
      total_minutes integer,
      late_minutes integer DEFAULT 0,
      status varchar(20) DEFAULT 'on_time',
      shift_id integer,
      device_id varchar(50) DEFAULT 'entrance',
      notes text,
      created_at timestamp DEFAULT now(),
      updated_at timestamp DEFAULT now()
    )`,
  ],
  [
    // Attendance roles (owner, Oct 2026): Cleaner, Chef, Waiter, Manager ...
    // The role carries the times, so "late" is measured against the entrance
    // time of the role the person belongs to.
    "attendance_roles",
    `CREATE TABLE IF NOT EXISTS attendance_roles (
      id serial PRIMARY KEY,
      name varchar(80) NOT NULL,
      created_at timestamp DEFAULT now()
    )`,
  ],
  [
    // The periods of one role: Morning 08:00 -> 14:00, Afternoon 14:00 -> 22:00,
    // and any extra period the owner adds in the same form.
    "attendance_role_shifts",
    `CREATE TABLE IF NOT EXISTS attendance_role_shifts (
      id serial PRIMARY KEY,
      role_id integer NOT NULL,
      label varchar(40) NOT NULL DEFAULT 'Morning',
      start_time varchar(5) NOT NULL,
      end_time varchar(5) NOT NULL,
      late_grace_minutes integer DEFAULT 15,
      early_leave_grace_minutes integer DEFAULT 0,
      sort_order integer DEFAULT 0
    )`,
  ],
  [
    // THE ATTENDANCE LISTING: its own people, not the station logins. A
    // cleaner clocks in with a finger and never logs in anywhere.
    "attendance_members",
    `CREATE TABLE IF NOT EXISTS attendance_members (
      id serial PRIMARY KEY,
      name varchar(100) NOT NULL,
      role_id integer,
      pin varchar(100),
      active boolean DEFAULT true,
      employment_started_at timestamp,
      terminated_at timestamp,
      created_at timestamp DEFAULT now(),
      updated_at timestamp DEFAULT now()
    )`,
  ],
  [
    // fingerprintId inside the FPC1020A -> which member of that listing.
    "attendance_biometrics",
    `CREATE TABLE IF NOT EXISTS attendance_biometrics (
      id serial PRIMARY KEY,
      member_id integer NOT NULL,
      fingerprint_id integer NOT NULL,
      finger_name varchar(50) DEFAULT 'Right Index',
      enrolled_at timestamp DEFAULT now(),
      enrolled_by varchar(100)
    )`,
  ],
  [
    // "Place your finger" jobs the ESP32 picks up by polling ?pending.
    "attendance_enroll_jobs",
    `CREATE TABLE IF NOT EXISTS attendance_enroll_jobs (
      id serial PRIMARY KEY,
      member_id integer NOT NULL,
      member_name varchar(100),
      fingerprint_id integer NOT NULL,
      status varchar(20) DEFAULT 'pending',
      detail text,
      started_at timestamp,
      created_at timestamp DEFAULT now(),
      completed_at timestamp
    )`,
  ],
  [
    "payroll_settings",
    `CREATE TABLE IF NOT EXISTS payroll_settings (
      id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      approved boolean NOT NULL DEFAULT false,
      approved_at timestamp,
      updated_at timestamp DEFAULT now()
    )`,
  ],
  [
    "payroll_compensation",
    `CREATE TABLE IF NOT EXISTS payroll_compensation (
      member_id integer PRIMARY KEY,
      basic_salary numeric(14,2) NOT NULL DEFAULT 0,
      transport_allowance numeric(14,2) NOT NULL DEFAULT 0,
      breakage_shortage numeric(14,2) NOT NULL DEFAULT 0,
      updated_at timestamp DEFAULT now()
    )`,
  ],
  [
    "payroll_monthly_inputs",
    `CREATE TABLE IF NOT EXISTS payroll_monthly_inputs (
      period_key varchar(10) NOT NULL,
      member_id integer NOT NULL,
      breakage_shortage numeric(14,2) NOT NULL DEFAULT 0,
      PRIMARY KEY(period_key, member_id)
    )`,
  ],
  [
    "payroll_breakages",
    `CREATE TABLE IF NOT EXISTS payroll_breakages (
      id serial PRIMARY KEY,
      period_key varchar(10) NOT NULL,
      member_id integer NOT NULL,
      item_type text NOT NULL,
      amount numeric(14,2) NOT NULL CHECK (amount > 0),
      recorded_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      voided_at timestamptz,
      voided_by text,
      legacy_key text UNIQUE,
      request_key text UNIQUE
    )`,
  ],
  [
    "payroll_exceptions",
    `CREATE TABLE IF NOT EXISTS payroll_exceptions (
      id serial PRIMARY KEY,
      period_key varchar(10) NOT NULL,
      member_id integer NOT NULL,
      attendance_date varchar(10) NOT NULL,
      exception_type varchar(20) NOT NULL,
      authorized_by varchar(100) NOT NULL,
      reason text NOT NULL,
      created_at timestamp DEFAULT now(),
      UNIQUE(period_key, member_id, attendance_date, exception_type)
    )`,
  ],
  [
    "payroll_overtime_entries",
    `CREATE TABLE IF NOT EXISTS payroll_overtime_entries (
      id serial PRIMARY KEY,
      member_id integer NOT NULL,
      period_key varchar(10) NOT NULL,
      overtime_type varchar(20) NOT NULL,
      hours numeric(10,2) NOT NULL DEFAULT 0,
      note text,
      created_at timestamp DEFAULT now()
    )`,
  ],
  [
    "payroll_periods",
    `CREATE TABLE IF NOT EXISTS payroll_periods (
      period_key varchar(10) PRIMARY KEY,
      calendar varchar(20) NOT NULL DEFAULT 'ethiopian',
      status varchar(20) NOT NULL DEFAULT 'draft',
      approved_at timestamp,
      paid_at timestamp,
      payment_method varchar(50),
      prepared_by varchar(100),
      checked_by varchar(100),
      approved_by varchar(100),
      updated_at timestamp DEFAULT now()
    )`,
  ],
  [
    "payroll_rows",
    `CREATE TABLE IF NOT EXISTS payroll_rows (
      id serial PRIMARY KEY,
      period_key varchar(10) NOT NULL,
      member_id integer NOT NULL,
      snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamp DEFAULT now(),
      UNIQUE(period_key, member_id)
    )`,
  ],
  [
    "payroll_audit",
    `CREATE TABLE IF NOT EXISTS payroll_audit (
      id serial PRIMARY KEY,
      period_key varchar(10),
      member_id integer,
      action varchar(60) NOT NULL,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      actor varchar(50) NOT NULL DEFAULT 'admin',
      created_at timestamp DEFAULT now()
    )`,
  ],
  [
    "payroll_holidays",
    `CREATE TABLE IF NOT EXISTS payroll_holidays (
      id serial PRIMARY KEY,
      holiday_date varchar(10) NOT NULL,
      name varchar(120) NOT NULL,
      created_at timestamp DEFAULT now()
    )`,
  ],
  [
    "payroll_payments",
    `CREATE TABLE IF NOT EXISTS payroll_payments (
      id serial PRIMARY KEY,
      period_key varchar(10) NOT NULL,
      member_id integer NOT NULL,
      paid_at timestamp DEFAULT now(),
      method varchar(40) DEFAULT 'Cash',
      note text,
      snapshot jsonb
    )`,
  ],
  [
    "attendance_free_schedules",
    `CREATE TABLE IF NOT EXISTS attendance_free_schedules (
      id serial PRIMARY KEY,
      member_id integer NOT NULL,
      schedule_type varchar(20) NOT NULL,
      weekday integer,
      free_date varchar(10),
      free_until varchar(10),
      start_time varchar(5) NOT NULL DEFAULT '00:00',
      end_time varchar(5) NOT NULL DEFAULT '23:59',
      note text,
      created_at timestamp DEFAULT now()
    )`,
  ],
  [
    "attendance_active_windows",
    `CREATE TABLE IF NOT EXISTS attendance_active_windows (
      id serial PRIMARY KEY,
      from_time varchar(5) NOT NULL,
      to_time varchar(5) NOT NULL,
      label varchar(40),
      enabled boolean DEFAULT true,
      sort_order integer DEFAULT 0,
      updated_at timestamp DEFAULT now()
    )`,
  ],
  [
    "attendance_overtime",
    `CREATE TABLE IF NOT EXISTS attendance_overtime (
      id serial PRIMARY KEY,
      member_id integer NOT NULL,
      date varchar(10) NOT NULL,
      type varchar(20) NOT NULL,
      minutes integer NOT NULL DEFAULT 0,
      shift_label varchar(40),
      log_id integer,
      source varchar(12) NOT NULL DEFAULT 'admin',
      entered_by varchar(100),
      note text,
      created_at timestamp DEFAULT now()
    )`,
  ],
  [
    // THE BARISTA HAND-OVER (owner's decision, Sept 2026): one row per
    // registered shift owner per station per Ethiopian day. A barista's FIRST
    // accept of the shift writes it (logging in alone registers nothing);
    // the unique index in the migration body makes the first-accept race
    // safe. See @/lib/shift-handover and the station-items route.
    "station_shift_claims",
    `CREATE TABLE IF NOT EXISTS station_shift_claims (
      id serial PRIMARY KEY,
      station varchar(20) NOT NULL,
      day_key varchar(10) NOT NULL,
      shift_name varchar(10) NOT NULL,
      staff_name varchar(100) NOT NULL,
      claimed_at timestamp DEFAULT now()
    )`,
  ],
];


/* ─── money columns that were created as whole numbers ─────────────────────
 * THE BUG THE OWNER HIT (2026-10-22): the payroll tabs on fanacafe.com.et were
 * made by an earlier build that kept salary, transport, breakage and overtime
 * hours as `integer`. `CREATE TABLE IF NOT EXISTS` never touches a table that
 * exists, so every later deploy kept the whole-number columns, and saving a
 * real salary answered:
 *
 *   invalid input syntax for type integer: "3080.13"
 *
 * These five columns must be `numeric(14,2)` (two decimals). The repair below
 * reads the live types first and converts only what is wrong, so it costs
 * nothing on a healthy database and never rewrites a table on every deploy.
 * Values already stored are kept: 3000 becomes 3000.00.
 */
const PAYROLL_MONEY_COLUMNS: Array<[string, string]> = [
  ["payroll_compensation", "basic_salary"],
  ["payroll_compensation", "transport_allowance"],
  ["payroll_compensation", "breakage_shortage"],
  ["payroll_monthly_inputs", "breakage_shortage"],
  ["payroll_overtime_entries", "hours"],
];

/** The five money columns that must accept cents, repaired in place.
 *  Returns the columns that could not be converted, so the payroll route can
 *  retry a save after it healed the database under itself. */
export async function repairPayrollMoneyColumns(): Promise<string[]> {
  const problems: string[] = [];
  let rows: Array<{ table_name: string; column_name: string; data_type: string; numeric_scale: number | null }> = [];
  try {
    const probe = await db.execute(
      sql`SELECT table_name, column_name, data_type, numeric_scale
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name IN ('payroll_compensation', 'payroll_monthly_inputs', 'payroll_overtime_entries')`
    );
    rows = ((probe as unknown as { rows?: typeof rows }).rows ?? []).map((r) => ({
      table_name: String(r.table_name),
      column_name: String(r.column_name),
      data_type: String(r.data_type),
      numeric_scale: r.numeric_scale === null ? null : Number(r.numeric_scale),
    }));
  } catch (e) {
    return [`payroll money columns: ${String(e)}`];
  }
  for (const [table, column] of PAYROLL_MONEY_COLUMNS) {
    const live = rows.find((r) => r.table_name === table && r.column_name === column);
    // The table or column does not exist yet: CREATE TABLE above makes it right.
    if (!live) continue;
    if (live.data_type === "numeric" && Number(live.numeric_scale) === 2) continue;
    const err = await run(
      `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE numeric(14,2)
        USING (COALESCE(NULLIF(btrim(${column}::text), ''), '0'))::numeric(14,2)`
    );
    if (err) problems.push(`${table}.${column}: ${err}`);
  }
  return problems;
}

/** True when a database error is this exact old-column problem. */
export function isIntegerColumnError(message: string): boolean {
  return /invalid input syntax for type integer/i.test(message) || /column .* is of type integer/i.test(message);
}

const RMS_COLUMNS: Record<string, Record<string, ColSpec>> = {
  staff_users: {
    name: { type: "text", def: "'Staff'" },
    role: { type: "text", def: "'waiter'" },
    pin: { type: "text", def: "'0000'" },
    // POCKET OFF-DUTY SWITCH: false = this person's devices stay silent
    // (they tapped "Off duty" at the end of their shift).
    notifications_enabled: { type: "boolean", def: "true" },
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
    order_type: { type: "text", def: "'dine_in'" },
    service_note: { type: "text" },
    status: { type: "text", def: "'new'" },
    payment_method: { type: "text" },
    payment_status: { type: "text", def: "'unpaid'" },
    receipt_image: { type: "text" },
    total_amount: { type: "integer", def: "0", castText: true },
    created_by: { type: "text" },
    confirmed_by: { type: "text" },
    closed_at: { type: "timestamp", dropNotNull: true },
    created_at: { type: "timestamp", def: "now()", dropNotNull: true },
    updated_at: { type: "timestamp", def: "now()", dropNotNull: true },
    // Group 1: guaranteed-unique order number + idempotent order submission
    order_number: { type: "text" },
    idempotency_key: { type: "text" },
    // Group 5: payment verification audit
    confirmed_at: { type: "timestamp", dropNotNull: true },
    verified_by: { type: "text" },
    verified_at: { type: "timestamp", dropNotNull: true },
    // Group 9 (print-queue mode): cashier printed the bill in the EFD/POS,
    // and the waiter later physically cleared the table (closes the bill).
    printed_at: { type: "timestamp", dropNotNull: true },
    printed_by: { type: "text" },
    closed_by: { type: "text" },
    // Group 8: guest/waiter "bring us the bill/receipt" request
    receipt_requested_at: { type: "timestamp", dropNotNull: true },
    receipt_requested_by: { type: "text" },
    // Bill-edit audit: WHEN a line on this bill was last corrected (qty, note
    // or removal). Compared with printed_at so a bill changed AFTER the EFD
    // receipt went out can be flagged for re-keying instead of silently
    // drifting from the EFD total.
    items_edited_at: { type: "timestamp", dropNotNull: true },
  },
  order_submissions: {
    ticket_id: { type: "integer", def: "0", castText: true },
    idempotency_key: { type: "text" },
    source: { type: "text" },
    waiter_name: { type: "text" },
    lines: { type: "integer", def: "0", castText: true },
    merged_lines: { type: "integer", def: "0", castText: true },
    created_at: { type: "timestamp", def: "now()", dropNotNull: true },
  },
  ticket_events: {
    ticket_id: { type: "integer", def: "0", castText: true },
    event_type: { type: "text" },
    actor_name: { type: "text" },
    actor_role: { type: "text" },
    source: { type: "text" },
    item_id: { type: "integer", castText: true },
    item_name: { type: "text" },
    from_value: { type: "text" },
    to_value: { type: "text" },
    details: { type: "text" },
    created_at: { type: "timestamp", def: "now()", dropNotNull: true },
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
    // Crew-action audit: WHO last touched this line (Accept/Done) and WHEN, so
    // a "done" nobody remembers pressing can always be traced to a person.
    station_status_by: { type: "text" },
    station_status_at: { type: "timestamp", dropNotNull: true },
    // Shift report: who ACCEPTED and who FINISHED each line (both kept).
    station_accepted_by: { type: "text" },
    station_accepted_at: { type: "timestamp", dropNotNull: true },
    station_done_by: { type: "text" },
    station_done_at: { type: "timestamp", dropNotNull: true },
    // Release gate: false = a guest top-up staff have not confirmed yet, so no
    // station screen shows it (see the release rule in station-items).
    released: { type: "boolean", def: "true" },
  },
  push_subscriptions: {
    endpoint: { type: "text" },
    p256dh: { type: "text" },
    auth: { type: "text" },
    role: { type: "text", def: "'waiter'" },
    name: { type: "text" },
    created_at: { type: "timestamp", def: "now()", dropNotNull: true },
  },
  attendance_shifts: {
    name: { type: "text", def: "'Morning'" },
    start_time: { type: "text", def: "'08:00'" },
    end_time: { type: "text", def: "'17:00'" },
    grace_minutes: { type: "integer", def: "15", castText: true },
    created_at: { type: "timestamp", def: "now()", dropNotNull: true },
  },
  staff_biometrics: {
    staff_id: { type: "integer", def: "0", castText: true },
    fingerprint_id: { type: "integer", def: "0", castText: true },
    finger_name: { type: "text", def: "'Right Index'" },
    enrolled_at: { type: "timestamp", def: "now()", dropNotNull: true },
    enrolled_by: { type: "text" },
  },
  attendance_logs: {
    staff_id: { type: "integer", def: "0", castText: true },
    member_id: { type: "integer", castText: true },
    role_id: { type: "integer", castText: true },
    fingerprint_id: { type: "integer", castText: true },
    date: { type: "text", def: "'2026-01-01'" },
    clock_in: { type: "timestamp", dropNotNull: true },
    clock_out: { type: "timestamp", dropNotNull: true },
    clock_in_method: { type: "text", def: "'fingerprint'" },
    clock_out_method: { type: "text" },
    total_minutes: { type: "integer", castText: true },
    late_minutes: { type: "integer", def: "0", castText: true },
    status: { type: "text", def: "'on_time'" },
    is_overtime: { type: "boolean", def: "false" },
    early_out: { type: "boolean", def: "false" },
    early_out_minutes: { type: "integer", def: "0", castText: true },
    shift_id: { type: "integer", castText: true },
    device_id: { type: "text", def: "'entrance'" },
    notes: { type: "text" },
    created_at: { type: "timestamp", def: "now()", dropNotNull: true },
    updated_at: { type: "timestamp", def: "now()", dropNotNull: true },
  },
  attendance_roles: {
    name: { type: "text", def: "'Role'" },
    created_at: { type: "timestamp", def: "now()", dropNotNull: true },
  },
  attendance_role_shifts: {
    role_id: { type: "integer", def: "0", castText: true },
    label: { type: "text", def: "'Morning'" },
    start_time: { type: "text", def: "'08:00'" },
    end_time: { type: "text", def: "'17:00'" },
    late_grace_minutes: { type: "integer", def: "15", castText: true },
    early_leave_grace_minutes: { type: "integer", def: "0", castText: true },
    sort_order: { type: "integer", def: "0", castText: true },
  },
  // YE AMET EREFT (owner, Oct 2026): a free schedule can now be a run of days
  // (from free_date to free_until), not only a weekday or a single date.
  attendance_free_schedules: {
    member_id: { type: "integer", def: "0", castText: true },
    schedule_type: { type: "text", def: "'weekly'" },
    weekday: { type: "integer" },
    free_date: { type: "text" },
    free_until: { type: "text" },
    start_time: { type: "text", def: "'00:00'" },
    end_time: { type: "text", def: "'23:59'" },
    note: { type: "text" },
  },
  attendance_members: {
    name: { type: "text", def: "'Member'" },
    role_id: { type: "integer", castText: true },
    pin: { type: "text" },
    active: { type: "boolean", def: "true" },
    employment_started_at: { type: "timestamp", dropNotNull: true },
    terminated_at: { type: "timestamp", dropNotNull: true },
    created_at: { type: "timestamp", def: "now()", dropNotNull: true },
    updated_at: { type: "timestamp", def: "now()", dropNotNull: true },
  },
  attendance_biometrics: {
    member_id: { type: "integer", def: "0", castText: true },
    fingerprint_id: { type: "integer", def: "0", castText: true },
    finger_name: { type: "text", def: "'Right Index'" },
    enrolled_at: { type: "timestamp", def: "now()", dropNotNull: true },
    enrolled_by: { type: "text" },
  },
  attendance_enroll_jobs: {
    member_id: { type: "integer", def: "0", castText: true },
    member_name: { type: "text" },
    fingerprint_id: { type: "integer", def: "0", castText: true },
    status: { type: "text", def: "'pending'" },
    // What the ESP32 is doing with the job, and when it picked it up.
    detail: { type: "text" },
    started_at: { type: "timestamp" },
    created_at: { type: "timestamp", def: "now()", dropNotNull: true },
    completed_at: { type: "timestamp" },
  },
};

const TABLE_COLUMNS: Record<string, Record<string, ColSpec>> = {
  orders: {
    order_number: { type: "text", def: "'FANA-ORD-000000'" },
    customer_name: { type: "text", def: "'Guest'" },
    phone: { type: "text", def: "''" },
    order_type: { type: "text", def: "'dine_in'" },
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
    is_buna: { type: "boolean", def: "false" },
    // Per-item station override ("barista" | "kitchen" | "buna") — wins over
    // the category routing, for mixed-crew categories like "Extra Things".
    station_override: { type: "text" },
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
    promotion_items: { type: "text" },
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
  // Shared promise so CONCURRENT first requests (e.g. the homepage's 5 parallel
  // fetches right after a cold start) collapse into ONE migration run instead of
  // each running the full CREATE/ALTER storm.
  __fanaMigratePromise?: Promise<{ success: boolean; errors: string[] }> | null;
};

/** The actual migration body (health probe + full CREATE/ALTER/sequence repair). */
async function runFullMigrate(force: boolean) {
  const errors: string[] = [];

  // TRAFFIC BOAT-FIX: test DB health + schema freshness with ONE light query.
  // If the DB already carries the CURRENT schema version (it does 99.99% of
  // the time), skip the entire 100+ CREATE/ALTER storm. An older DB (created
  // by a previous release) falls through and self-heals below.
  if (!force) {
    try {
      const probe = await db.execute(
        sql`SELECT value FROM site_settings WHERE key = 'schema_version' LIMIT 1`
      );
      const rows = (probe as unknown as { rows?: Array<{ value: string }> }).rows ?? [];
      if (rows.length > 0 && rows[0].value === SCHEMA_VERSION) {
        globalForMigrate.__fanaMigrateDone = true;
        // Leave the function, not just a labelled block: otherwise every cold
        // start still runs all the ALTERs and holds locks on live tables.
        return { success: true, errors: [] as string[] };
      }
      // Missing or older version: the full migration is still necessary.
    } catch {
      // site_settings missing / DB broken → fall through to full migration below
    }
  }

  // Step 1 — create missing tables (classic + RMS)
  for (const [name, ddl] of [...CREATES, ...RMS_CREATES]) {
    const err = await run(ddl);
    if (err) errors.push(`create ${name}: ${err}`);
  }

  // HOLIDAY DATES and PAID PEOPLE (payroll improvement, 2026-10-22): one row
  // per holiday day and one per person per payroll month, so a double tap can
  // never register Meskel twice or pay somebody twice.
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS payroll_holidays_date_key ON payroll_holidays (holiday_date)`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS payroll_payments_period_member_key ON payroll_payments (period_key, member_id)`);
  await run(`ALTER TABLE payroll_payments ADD COLUMN IF NOT EXISTS snapshot jsonb`);

  // MONEY COLUMNS: an earlier build created the payroll amounts as integers, and
  // saving 3080.13 failed with "invalid input syntax for type integer". Convert
  // them once (values kept), so every salary, transport and breakage value with
  // cents can be saved from this deploy on.
  for (const problem of await repairPayrollMoneyColumns()) errors.push(`money column ${problem}`);

  // DEDUCTION FORMULAS: an earlier build had shipped made-up minute rules
  // ("there isn't deduction related to this until I add formula"). A settings
  // row that still holds exactly those two shipped strings is cleared first,
  // so the owner's NEW per-minute rule below is the one that starts working;
  // a formula he wrote himself is left untouched. The old ABSENCE string is
  // deliberately NOT cleared any more: on 2026-10-27 he chose exactly that
  // rule (one 8 hour day = BasicSalary / 30 per unapproved absence), so
  // clearing it would erase his decision on every deploy.
  for (const [key, shipped] of [
    ["latenessFormula", "BasicSalary / 30 / 8 / 60 * LateMinutes"],
    ["earlyOutFormula", "BasicSalary / 30 / 8 / 60 * EarlyOutMinutes"],
  ] as Array<[string, string]>) {
    const err = await run(
      `UPDATE payroll_settings
          SET settings = jsonb_set(settings, '{${key}}', '""'::jsonb, true), updated_at = now()
        WHERE settings->>'${key}' = '${shipped}'`
    );
    if (err) errors.push(`deduction formula ${key}: ${err}`);
  }

  // THE OWNER'S PER-MINUTE RULE (2026-10-27): BasicSalary / 30 / 8 / 60 per
  // chargeable minute, for lateness AND early departure, after the grace of
  // the person's own role. BasicSalary is the one salary the owner types per
  // employee, and it is the same base the three overtime rates use.
  const minuteRuleMarker = "payroll_minute_rule_2026_10_27";
  const latenessRule = "BasicSalary / 30 / 8 / 60 * MAX(0, LateMinutes)";
  const earlyOutRule = "BasicSalary / 30 / 8 / 60 * MAX(0, EarlyOutMinutes)";

  // An interim build on the same day seeded the NetSalary version of exactly
  // these two shipped strings. Upgrade them to the final rules; a formula the
  // owner edited himself is left untouched.
  for (const [key, oldRule, newRule] of [
    ["latenessFormula", "NetSalary / 30 / 8 / 60 * MAX(0, LateMinutes)", latenessRule],
    ["earlyOutFormula", "NetSalary / 30 / 8 / 60 * MAX(0, EarlyOutMinutes)", earlyOutRule],
  ] as Array<[string, string, string]>) {
    const err = await run(
      `UPDATE payroll_settings
          SET settings = jsonb_set(settings, '{${key}}', to_jsonb('${newRule}'::text), true), updated_at = now()
        WHERE settings->>'${key}' = '${oldRule}'`
    );
    if (err) errors.push(`minute rule base upgrade ${key}: ${err}`);
  }

  // Older databases still carry empty boxes from the clearing above, so seed
  // the two shipped formulas ONCE. A formula the owner already wrote is
  // preserved, and a box he empties after this deploy stays empty because the
  // marker is never written twice.
  const seedErr = await run(
    `UPDATE payroll_settings
        SET settings = coalesce(settings, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
              'latenessFormula', CASE WHEN coalesce(settings->>'latenessFormula','') = '' THEN '${latenessRule}'::text ELSE NULL::text END,
              'earlyOutFormula', CASE WHEN coalesce(settings->>'earlyOutFormula','') = '' THEN '${earlyOutRule}'::text ELSE NULL::text END
            )),
            updated_at = now()
      WHERE NOT EXISTS (SELECT 1 FROM site_settings WHERE key = '${minuteRuleMarker}')`
  );
  if (seedErr) errors.push(`minute rule seed: ${seedErr}`);
  else
    await run(
      `INSERT INTO site_settings(key,value,updated_at) VALUES('${minuteRuleMarker}','1',now()) ON CONFLICT (key) DO NOTHING`
    );

  // ABSENCE (owner, 2026-10-27): "if someone is absent the system will deduct
  // the 8 hour from his salary ... 6000/30 days and that daily value is their
  // 8 hour value". One absent day therefore loses BasicSalary / 30. A build
  // from earlier the same day cleared this box, so seed the shipped rule once
  // with its own marker. A box the owner empties later stays empty.
  const absenceRule = "BasicSalary / 30 * UnapprovedAbsences";
  const absenceMarker = "payroll_absence_rule_2026_10_27";
  const absenceSeedErr = await run(
    `UPDATE payroll_settings
        SET settings = coalesce(settings, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
              'absenceFormula', CASE WHEN coalesce(settings->>'absenceFormula','') = '' THEN '${absenceRule}'::text ELSE NULL::text END
            )),
            updated_at = now()
      WHERE NOT EXISTS (SELECT 1 FROM site_settings WHERE key = '${absenceMarker}')`
  );
  if (absenceSeedErr) errors.push(`absence rule seed: ${absenceSeedErr}`);
  else
    await run(
      `INSERT INTO site_settings(key,value,updated_at) VALUES('${absenceMarker}','1',now()) ON CONFLICT (key) DO NOTHING`
    );

  // Payroll period sign-off columns added after the first payroll release.
  await run(`ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS prepared_by varchar(100)`);
  await run(`ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS checked_by varchar(100)`);
  await run(`ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS approved_by varchar(100)`);

  // Step 1b — translation cache: one row per (lang, source string) so repeat
  // translations are served from the DB and never hit Google again.
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS translations_lang_hash_key ON translations (lang, source_hash)`
  );

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
    "order_submissions",
    "ticket_events",
    "push_subscriptions",
    "attendance_shifts",
    "staff_biometrics",
    "attendance_logs",
    "attendance_roles",
    "attendance_role_shifts",
    "attendance_members",
    "attendance_biometrics",
    "attendance_enroll_jobs",
    "attendance_overtime",
    "attendance_active_windows",
    "payroll_holidays",
    "payroll_payments",
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

  //  • RELEASE GATE backfill (owner, Sept 2026). ticket_items.released is the
  //    per-line "have the stations been cleared to see this?" switch. New rows
  //    default to true (released) and only a guest top-up on an already-sent
  //    bill is written as false, so every historical line simply stays
  //    released. The UPDATE below only matters on databases where ADD COLUMN
  //    could not apply the default (very old Postgres): re-run safe.
  await run(`UPDATE ticket_items SET released = true WHERE released IS NULL`);

  //  • PRINT SERVES THE FOOD backfill (owner's decision, Sept 2026). The
  //    cashier's ✓ PRINTED tap means the order is done and served, so from now
  //    on the print itself stamps every released line of the bill done (see
  //    the PUT in tickets/route.ts) and the station live list hides it. Bills
  //    printed BEFORE that rule existed never got that stamp, so their items
  //    kept sitting on the kitchen / barista / juice / buna dashboards for
  //    days. This one-time sweep finishes exactly those lines — released (the
  //    crews had received them), not removed, not done yet, and created on or
  //    before the print (so a still-unprinted addition stays live work) —
  //    stamped as finished by the print itself. Re-run safe: done rows are
  //    skipped.
  await run(`
    UPDATE ticket_items ti
    SET station_status = 'done',
        station_status_by = 'cashier print',
        station_status_at = COALESCE(t.printed_at, now()),
        station_done_by = 'cashier print',
        station_done_at = COALESCE(t.printed_at, now())
    FROM tickets t
    WHERE t.id = ti.ticket_id
      AND t.printed_at IS NOT NULL
      AND COALESCE(ti.released, true) = true
      AND COALESCE(ti.removed, false) = false
      AND COALESCE(ti.station_status, 'pending') <> 'done'
      AND ti.created_at <= t.printed_at
  `);

  //  • CREW-LINE STATUS backfill (owner's bug report, 29 Sept 2026). A line's
  //    station_status only ever reads "pending", "accepted" or "done";
  //    everything else is work nobody has taken yet. Rows written before the
  //    column existed carry NULL, and SQL that compares station_status to
  //    'pending' never matched them: the barista hand-over treated them as
  //    "not pending", so they leaked onto a second barista's board. Make the
  //    data say what every screen already assumes. Re-run safe.
  await run(`UPDATE ticket_items SET station_status = 'pending' WHERE station_status IS NULL OR trim(station_status) = ''`);

  //  • GROUP 5 — one active bill per table, enforced at the DATABASE level.
  //    Before creating the partial unique index, repair any duplicate active
  //    tickets left by the old check-then-insert race: move the newer tickets'
  //    items onto the OLDEST active ticket, then delete the newer ticket rows
  //    (nothing lost — items are preserved). This makes concurrent first orders
  //    at the same table impossible to split into two bills.
  //    PRINT FREES THE TABLE: a dine-in bill the cashier already printed no
  //    longer occupies its table, so it is NOT a duplicate of the next guest's
  //    new bill — the repair below must leave the pair alone.
  const ACTIVE_BILL_PREDICATE = `status NOT IN ('paid','cancelled','closed') AND (order_type = 'outdoor' OR printed_at IS NULL)`;
  await run(`
    WITH dups AS (
      SELECT table_id, min(id) AS keep_id, array_agg(id ORDER BY id) AS ids
      FROM tickets
      WHERE ${ACTIVE_BILL_PREDICATE}
      GROUP BY table_id HAVING count(*) > 1
    )
    UPDATE ticket_items ti
    SET ticket_id = d.keep_id
    FROM dups d
    WHERE ti.ticket_id = ANY(d.ids) AND ti.ticket_id <> d.keep_id
  `);
  await run(`
    DELETE FROM tickets t
    USING (
      SELECT table_id, min(id) AS keep_id, array_agg(id ORDER BY id) AS ids
      FROM tickets
      WHERE ${ACTIVE_BILL_PREDICATE}
      GROUP BY table_id HAVING count(*) > 1
    ) d
    WHERE t.table_id = d.table_id AND t.id <> d.keep_id
      AND t.status NOT IN ('paid','cancelled','closed') AND (t.order_type = 'outdoor' OR t.printed_at IS NULL)
  `);
  // GROUP 9 (print-queue mode): `closed` (waiter cleared the table) is now also
  // an INACTIVE status — a closed bill must never block the next guest seated
  // at that table. `CREATE ... IF NOT EXISTS` cannot evolve an existing index
  // definition, so inspect what is on disk and recreate when it still uses the
  // old predicate (paid/cancelled only).
  //
  // PRINT FREES THE TABLE (owner's decision, Sept 2026): the cashier's
  // ✓ PRINTED tap now ALSO clears the table, because the waiters kept
  // forgetting to. A dine-in bill carrying printed_at is finished for the
  // floor: the next guest at that table starts a NEW bill, so it must stop
  // counting towards "one active bill per table". Outdoor/group bills are
  // exempt — a group takes more rounds on the same bill, so their print stays
  // a re-print, not a release.
  try {
    const idxProbe = await db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'tickets_one_active_per_table_idx' LIMIT 1`
    );
    const idxRows = (idxProbe as unknown as { rows?: Array<{ indexdef: string }> }).rows ?? [];
    if (idxRows.length > 0 && (!idxRows[0].indexdef.includes("'closed'") || !idxRows[0].indexdef.includes("printed_at"))) {
      await run(`DROP INDEX IF EXISTS tickets_one_active_per_table_idx`);
    }
  } catch {
    // pg_indexes unreadable → fall through, the create below still runs
  }
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS tickets_one_active_per_table_idx ON tickets (table_id) WHERE status NOT IN ('paid','cancelled','closed') AND (order_type = 'outdoor' OR printed_at IS NULL)`
  );

  //  • GROUP 3 indexes — each justified by a real query pattern:
  //    1. ticket_items(ticket_id): items attach on EVERY tickets/reports fetch
  //       (`WHERE ticket_id IN (...)`); also recomputeTotal per ticket.
  //    2. ticket_items(station_name, removed): kitchen/barista polling every 8s
  //       (`WHERE station_name = ? AND removed = false`).
  //    3. tickets(status, updated_at): active poll every 8s
  //       (`WHERE status NOT IN ('paid','cancelled') ORDER BY updated_at DESC`),
  //       paid-history (`WHERE status='paid' ORDER BY updated_at DESC LIMIT n`).
  //    4. tickets(table_id, status): "one active bill per table" merge lookup on
  //       every order submission (`WHERE table_id = ? AND status NOT IN (...)`).
  //    5. tickets(created_at) & 6. tickets(updated_at): reports 30-day scoping
  //       (`WHERE created_at > ? OR updated_at > ? OR closed_at > ?`); bare
  //       updated_at also serves the ?all=1 `ORDER BY updated_at DESC LIMIT 100`
  //       (a composite leading with status can't serve a bare updated_at sort).
  //    7. tickets(status, closed_at): receipt-cleanup job
  //       (`WHERE status='paid' AND receipt_image IS NOT NULL AND closed_at < ?`).
  await run(`CREATE INDEX IF NOT EXISTS ticket_items_ticket_id_idx ON ticket_items (ticket_id)`);
  await run(`CREATE INDEX IF NOT EXISTS ticket_items_station_name_removed_idx ON ticket_items (station_name, removed)`);
  await run(`CREATE INDEX IF NOT EXISTS tickets_status_updated_at_idx ON tickets (status, updated_at)`);
  await run(`CREATE INDEX IF NOT EXISTS tickets_table_id_status_idx ON tickets (table_id, status)`);
  await run(`CREATE INDEX IF NOT EXISTS tickets_created_at_idx ON tickets (created_at)`);
  await run(`CREATE INDEX IF NOT EXISTS tickets_updated_at_idx ON tickets (updated_at)`);
  await run(`CREATE INDEX IF NOT EXISTS tickets_status_closed_at_idx ON tickets (status, closed_at)`);
  //    8. order_submissions(idempotency_key) UNIQUE: the submission-level
  //       duplicate guard that survives line merging (Group 8)
  //    9. order_submissions(ticket_id): "what did this table send, and when"
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS order_submissions_idempotency_key_key ON order_submissions (idempotency_key) WHERE idempotency_key IS NOT NULL`);
  await run(`CREATE INDEX IF NOT EXISTS order_submissions_ticket_id_idx ON order_submissions (ticket_id)`);
  //   10. ticket_events(ticket_id, created_at): admin order history/audit trail
  //       and waiter ranking click-through read one bill's timeline in order.
  await run(`CREATE INDEX IF NOT EXISTS ticket_events_ticket_id_created_at_idx ON ticket_events (ticket_id, created_at)`);
  await run(`CREATE INDEX IF NOT EXISTS ticket_events_event_type_idx ON ticket_events (event_type)`);
  //   11. buna_notes(paid_at, held_at): the Coffee Note page reads the held
  //       rows (paid_at IS NULL) and today's paid rows in one query each.
  await run(`CREATE INDEX IF NOT EXISTS buna_notes_paid_at_held_at_idx ON buna_notes (paid_at, held_at)`);

  // Group 10 (pocket-mode alerts): one row per device — re-subscribing the same
  // device replaces its row instead of duplicating it.
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_key ON push_subscriptions (endpoint)`);

  //   12. station_shift_claims(station, day_key, shift_name): ONE registered
  //       owner per shift per station per day — the barista hand-over (owner,
  //       Sept 2026). The first accept of the shift inserts the row; a second
  //       barista racing the same shift loses on this index, never silently.
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS station_shift_claims_owner_key ON station_shift_claims (station, day_key, shift_name)`);
  await run(`CREATE INDEX IF NOT EXISTS station_shift_claims_station_day_idx ON station_shift_claims (station, day_key)`);


  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS attendance_overtime_member_day_type_key ON attendance_overtime (member_id, date, type, COALESCE(shift_label, ''))`
  );
  await run(`CREATE INDEX IF NOT EXISTS attendance_overtime_date_idx ON attendance_overtime (date)`);

  // Preserve earlier manually-entered payroll amounts as visible historical
  // records. The unique key makes this safe to repeat; new entries are only
  // created from the Store and the legacy input column is no longer written.
  await run(`INSERT INTO payroll_breakages(period_key,member_id,item_type,amount,recorded_by,legacy_key)
    SELECT period_key,member_id,'Previous manual payroll entry',breakage_shortage,'Previous payroll',period_key || '|' || member_id::text
    FROM payroll_monthly_inputs WHERE breakage_shortage > 0
    ON CONFLICT (legacy_key) DO NOTHING`);
  await run(`CREATE INDEX IF NOT EXISTS payroll_breakages_period_member_idx ON payroll_breakages(period_key,member_id)`);

  // "DON'T GIVE" (owner, 2026-10-28): an overtime that was given by mistake
  // must stay visible in the history but must NOT be added to the salary. One
  // row per (person, day, kind), so a double click cannot multiply it. The
  // payroll reads this table and skips those hours; the overtime row itself
  // is never deleted, which is exactly the audit trail the owner asked for.
  await run(`CREATE TABLE IF NOT EXISTS attendance_ot_exclusions (
      id serial PRIMARY KEY,
      member_id integer NOT NULL,
      date varchar(10) NOT NULL,
      type varchar(20) NOT NULL,
      authorized_by varchar(100),
      reason varchar(300),
      created_at timestamp DEFAULT now()
    )`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS attendance_ot_exclusions_member_day_type_key ON attendance_ot_exclusions (member_id, date, type)`);
  await run(`CREATE INDEX IF NOT EXISTS attendance_ot_exclusions_date_idx ON attendance_ot_exclusions (date)`);

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

  //  • QR HOLD FLOW backfill (Sept 2026). confirmed_at is now written when an
  //    order is SENT to the crews, not merely accepted: a cashier accepting a
  //    guest's QR order only holds the bill (no stamp) until she taps
  //    CONFIRM & SEND. Bills released under the OLD rule ("acceptance
  //    releases") must keep behaving as sent, so stamp them once — precisely:
  //    • every bill that already moved past "confirmed" (preparing, printed,
  //      closed…) passed through a release, whatever created it;
  //    • a "confirmed" bill created by STAFF was sent by the waiter at
  //      submission time (the old POST never stamped it).
  //    A held QR bill (status confirmed, created by "Customer (QR)", no stamp)
  //    never matches, so this stays safe to re-run on every migration.
  await run(`
    UPDATE tickets SET confirmed_at = COALESCE(confirmed_at, updated_at, created_at)
    WHERE confirmed_at IS NULL
      AND (
        status IN ('preparing','ready_for_payment','completed','printed','closed')
        OR (status = 'confirmed' AND COALESCE(created_by, '') <> 'Customer (QR)')
      )
  `);

  //  • POCKET OFF-DUTY SWITCH backfill (Sept 2026). staff_users.notifications
  //    _enabled is the per-person "my shift is over, stop ringing my phone at
  //    home" switch. The column lands as NULL on existing rows (ADD COLUMN
  //    does not apply the default retroactively), and NULL would read as
  //    "unknown" in code. Every existing staff member obviously wants alerts
  //    ON until they personally switch them off, so stamp true once. Re-run
  //    safe: nobody who DID switch off has NULL (they have false).
  await run(`UPDATE staff_users SET notifications_enabled = true WHERE notifications_enabled IS NULL`);

  //  • OUTDOOR ORDER FLOW (Sept 2026). Existing bills are ordinary dine-in rows
  //    unless explicitly marked otherwise; the new order_type column lands NULL
  //    on old rows, so stamp the safe default once.
  await run(`UPDATE tickets SET order_type = 'dine_in' WHERE order_type IS NULL OR trim(order_type) = ''`);

  //  • ORDER HISTORY / AUDIT TRAIL backfill (Sept 2026). New rows are written
  //    live by the routes below; old tickets get a minimal timeline so the
  //    admin history can still classify done vs cancelled and show the major
  //    moments even when exact field-by-field edit details did not exist yet.
  await run(`
    INSERT INTO ticket_events (ticket_id, event_type, actor_name, details, created_at)
    SELECT t.id, 'ticket_created', NULLIF(t.created_by, ''), 'Legacy bill existed before audit logging', COALESCE(t.created_at, now())
    FROM tickets t
    WHERE NOT EXISTS (
      SELECT 1 FROM ticket_events e WHERE e.ticket_id = t.id AND e.event_type = 'ticket_created'
    )
  `);
  await run(`
    INSERT INTO ticket_events (ticket_id, event_type, actor_name, actor_role, from_value, to_value, details, created_at)
    SELECT t.id, 'status_changed', NULLIF(t.confirmed_by, ''), NULL, 'pending_waiter', 'confirmed', 'Legacy confirmation backfill', COALESCE(t.confirmed_at, t.updated_at, t.created_at, now())
    FROM tickets t
    WHERE t.confirmed_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM ticket_events e
        WHERE e.ticket_id = t.id AND e.event_type = 'status_changed' AND e.to_value = 'confirmed'
      )
  `);
  await run(`
    INSERT INTO ticket_events (ticket_id, event_type, actor_name, actor_role, from_value, to_value, details, created_at)
    SELECT t.id, 'ticket_printed', NULLIF(t.printed_by, ''), 'cashier', NULL, 'printed', 'Legacy print backfill', COALESCE(t.printed_at, t.updated_at, t.created_at, now())
    FROM tickets t
    WHERE t.printed_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM ticket_events e WHERE e.ticket_id = t.id AND e.event_type = 'ticket_printed'
      )
  `);
  await run(`
    INSERT INTO ticket_events (ticket_id, event_type, actor_name, actor_role, from_value, to_value, details, created_at)
    SELECT t.id, 'item_edited', NULL, NULL, NULL, NULL, 'Legacy bill edit happened before detailed audit logging', COALESCE(t.items_edited_at, t.updated_at, t.created_at, now())
    FROM tickets t
    WHERE t.items_edited_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM ticket_events e WHERE e.ticket_id = t.id AND e.event_type = 'item_edited'
      )
  `);
  await run(`
    INSERT INTO ticket_events (ticket_id, event_type, actor_name, actor_role, from_value, to_value, details, created_at)
    SELECT t.id, 'status_changed', NULLIF(t.closed_by, ''), NULL, 'printed', 'closed', 'Legacy table-cleared backfill', COALESCE(t.closed_at, t.updated_at, t.created_at, now())
    FROM tickets t
    WHERE t.status = 'closed' AND t.closed_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM ticket_events e
        WHERE e.ticket_id = t.id AND e.event_type = 'status_changed' AND e.to_value = 'closed'
      )
  `);
  await run(`
    INSERT INTO ticket_events (ticket_id, event_type, actor_name, actor_role, from_value, to_value, details, created_at)
    SELECT t.id, 'status_changed', NULLIF(t.verified_by, ''), 'cashier', COALESCE(t.status, 'completed'), 'paid', 'Legacy payment backfill', COALESCE(t.verified_at, t.closed_at, t.updated_at, t.created_at, now())
    FROM tickets t
    WHERE t.status = 'paid'
      AND NOT EXISTS (
        SELECT 1 FROM ticket_events e
        WHERE e.ticket_id = t.id AND e.event_type = 'status_changed' AND e.to_value = 'paid'
      )
  `);
  await run(`
    INSERT INTO ticket_events (ticket_id, event_type, actor_name, actor_role, from_value, to_value, details, created_at)
    SELECT t.id, 'status_changed', NULL, NULL, NULL, 'cancelled', 'Legacy cancellation backfill', COALESCE(t.closed_at, t.updated_at, t.created_at, now())
    FROM tickets t
    WHERE t.status = 'cancelled'
      AND NOT EXISTS (
        SELECT 1 FROM ticket_events e
        WHERE e.ticket_id = t.id AND e.event_type = 'status_changed' AND e.to_value = 'cancelled'
      )
  `);

  //  • OWNER REQUEST — remove the default categories they marked unnecessary
  //    (Ethiopian Traditional … Pastry & Cakes). This is a ONE-TIME prune:
  //    gated by a settings flag so it runs once and never deletes a category
  //    the owner re-creates manually later. A category is only deleted when NO
  //    menu item references it (real items are never orphaned); if items still
  //    use one, that row is left in place for the owner to move/delete items first.
  const prunedRows = await db.execute(
    sql`SELECT value FROM site_settings WHERE key = 'default_cats_pruned' LIMIT 1`
  );
  const prunedList = (prunedRows as unknown as { rows?: Array<{ value: string }> }).rows ?? [];
  if (prunedList.length === 0) {
    await run(`
      DELETE FROM categories
      WHERE slug IN ('ethiopian-traditional-meals','sandwich','snack-and-wrap','juices','hot-drinks','soft-drinks','pastry-and-cakes')
        AND NOT EXISTS (SELECT 1 FROM menu_items WHERE menu_items.category = categories.slug)
    `);
    await run(
      `INSERT INTO site_settings (key, value, updated_at) VALUES ('default_cats_pruned', 'on', now()) ON CONFLICT (key) DO NOTHING`
    );
  }

  //  • OWNER REQUEST (Sept 2026): "wrong Amharic like 'semin', some text does
  //    not translate". The old translator cached whatever Google answered,
  //    including the English sent back unchanged, Latin romanisation and
  //    HTML-escaped text. ONE-TIME purge of every cached row that is not real
  //    Amharic. From now on translate-guard.ts checks every answer before it
  //    is cached AND every row when it is read, so this only clears the
  //    backlog (gated by a flag, and only stamped when the DELETE worked).
  const txPurgedRows = await db.execute(
    sql`SELECT value FROM site_settings WHERE key = 'translations_purged_v1' LIMIT 1`
  );
  const txPurgedList = (txPurgedRows as unknown as { rows?: Array<{ value: string }> }).rows ?? [];
  // Best effort, never fatal: the read path rejects (and deletes) bad rows
  // anyway, so a failure here must not block the schema-version stamp (that
  // would re-run the whole migration on every cold start). The Ethiopic
  // ranges need a UTF8 database (check the PostgreSQL database encoding); anything else skips.
  const encodingRows = await db.execute(sql`SELECT current_setting('server_encoding') AS enc`).catch(() => null);
  const serverEncoding = ((encodingRows as unknown as { rows?: Array<{ enc: string }> } | null)?.rows?.[0]?.enc || "").toUpperCase();
  if (txPurgedList.length === 0 && serverEncoding !== "UTF8") {
    console.warn(`translation cache purge skipped: database encoding is ${serverEncoding || "unknown"}, not UTF8`);
  } else if (txPurgedList.length === 0) {
    const purgeErr = await run(`
      DELETE FROM translations
      WHERE translated_text !~ '[\\u1200-\\u139F\\u2D80-\\u2DDF\\uAB00-\\uAB2F]'
         OR lower(btrim(translated_text)) = lower(btrim(source_text))
         OR translated_text ~ '<[A-Za-z/]'
         OR translated_text ~* '&(#x?[0-9a-f]+|[a-z]+);'
         OR strpos(translated_text, chr(65533)) > 0
         OR length(regexp_replace(translated_text, '[^A-Za-z]', '', 'g')) >
            1.5 * length(regexp_replace(translated_text, '[^\\u1200-\\u139F\\u2D80-\\u2DDF\\uAB00-\\uAB2F]', '', 'g'))
    `);
    if (purgeErr) console.warn(`translation cache purge skipped: ${purgeErr}`);
    else
      await run(
        `INSERT INTO site_settings (key, value, updated_at) VALUES ('translations_purged_v1', 'on', now()) ON CONFLICT (key) DO NOTHING`
      );
  }

  //  • OWNER REQUEST (2026-08-25) — the cafe is in TOWN SQUARE BUILDING, not
  //    "Golagul Building", and the business name is the full "Fana Cafe &
  //    Restaurant". One-time idempotent heal of every historical row that still
  //    carries the wrong building/name (re-running changes nothing afterwards).
  await run(`
    UPDATE site_settings SET value = regexp_replace(
      regexp_replace(
        regexp_replace(value, 'Golagul\\s+Bldg\\.?', 'Town Square Bldg', 'gi'),
        'Golagul\\s+Building', 'Town Square Building', 'gi'),
      'Golagul', 'Town Square', 'gi')
    WHERE value ~* 'golagul'
  `);
  await run(`
    UPDATE gallery_items SET title = regexp_replace(title, 'Golagul\\s+Building', 'Town Square Building', 'gi')
    WHERE title ~* 'golagul'
  `);
  await run(`
    UPDATE announcements SET
      title = regexp_replace(title, 'Golagul\\s+Building', 'Town Square Building', 'gi'),
      description = regexp_replace(description, 'Golagul\\s+Building', 'Town Square Building', 'gi')
    WHERE title ~* 'golagul' OR description ~* 'golagul'
  `);
  await run(`
    UPDATE site_settings SET value = 'Fana Cafe & Restaurant', updated_at = now()
    WHERE key = 'cafe_name'
      AND value ~* '^\\s*fana(queen)?\\s*cafe(\\s*&\\s*restaurant)?\\s*$'
      AND value <> 'Fana Cafe & Restaurant'
  `);

  if (errors.length > 0) {
    console.error("ensureTablesExist errors:", errors);
    // Do NOT stamp the schema version on failure — the next cold start retries
    // the full migration instead of believing the schema is current.
    return { success: false, errors };
  }

  // Stamp the schema version so future requests take the one-query fast path,
  // and future releases (with a bumped SCHEMA_VERSION) re-run the migration.
  await run(
    `INSERT INTO site_settings (key, value, updated_at) VALUES ('schema_version', '${SCHEMA_VERSION}', now()) ON CONFLICT (key) DO UPDATE SET value = '${SCHEMA_VERSION}', updated_at = now()`
  );

  globalForMigrate.__fanaMigrateDone = true;
  return { success: true, errors: [] as string[] };
}

export async function ensureTablesExist(force = false) {
  if (globalForMigrate.__fanaMigrateDone && !force) {
    return { success: true, errors: [] as string[] };
  }

  if (force) {
    // Explicit repair paths (/api/setup?force=1, image uploads) bypass the memo
    // and run a fresh migration, independent of any in-flight run.
    globalForMigrate.__fanaMigrateDone = false;
    globalForMigrate.__fanaMigratePromise = null;
    return runFullMigrate(true);
  }

  // Shared promise: the FIRST caller runs the migration (or the one-query health
  // probe on a healthy DB); concurrent first callers await the same result instead
  // of each executing the full CREATE/ALTER storm.
  if (!globalForMigrate.__fanaMigratePromise) {
    globalForMigrate.__fanaMigratePromise = runFullMigrate(false)
      .then((res) => {
        if (res.success) globalForMigrate.__fanaMigrateDone = true;
        return res;
      })
      .finally(() => {
        globalForMigrate.__fanaMigratePromise = null;
      });
  }
  return globalForMigrate.__fanaMigratePromise;
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
     VALUES ('FANA-TEST-000001','Setup Test','0911065022','dine_in','Test Address','[]',1,'pending','smoke test')`
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
