# Performance Audit — Fana Cafe & Restaurant (digital-menu-railway)

**Date:** 2026-08-10
**Scope:** Full-stack review of the Next.js 16 + Postgres/Drizzle app (public website, customer QR menu, waiter/cashier/station RMS, admin panel).
**Method:** Static code review of every route handler, page, and component; request-path SQL accounting; bundle/rendering analysis. Verified against the running app where possible.

---

## 1. Executive summary

The app's architecture is sound (client-side session caching, on-demand receipt photos, immutable image caching, per-process migration memoization are all already good). The dominant problem is that **every public API request runs a ~30-statement database seed/migration pipeline**, and the public homepage **renders 100% client-side after a waterfall of 6–7 fetches**. Fixing the request path (Group 1, done in this pass) removes the vast majority of DB load and cuts perceived latency significantly; the rendering/payload work is grouped for the next pass.

Rough per-page-view SQL accounting **before** Group 1 (homepage, first visit):

| Source | SQL statements (approx.) |
|---|---|
| `fetch("/api/seed")` (fire-and-forget) | ~20–35 |
| `/api/settings` GET (calls `ensureDbSeeded`) | ~25–35 |
| `/api/categories` GET (calls `ensureDbSeeded`) | ~25–35 |
| `/api/menu` GET (calls `ensureDbSeeded`) | ~25–35 |
| `/api/reviews` GET (calls `ensureDbSeeded`) | ~25–35 |
| `/api/gallery` GET (calls `ensureDbSeeded`) | ~25–35 |
| `/api/admin/verify` | 1 |
| **Total** | **~150–210 SQL statements per page view** |

After Group 1: the seed pipeline runs **once per server process** (then 0 extra statements per request); the five data fetches run in parallel; public GETs are browser/CDN-cacheable. A repeat visitor typically hits **0–1 new statements** per fetch (served from cache or one memoized guard).

---

## 2. Findings by severity

### Critical

- **[C1] The seed pipeline runs on every public-data request.** `ensureDbSeeded()` is awaited by the GET handlers of `/api/settings`, `/api/categories`, `/api/menu`, `/api/reviews`, `/api/gallery`, `/api/staff`, `/api/tables` and others. Each invocation executes ~20–35 statements, including **two full-table `DELETE` dedup statements** against `menu_items` and `staff_users` on *every request*, plus up to ~26 category-migration `UPDATE`/`INSERT`/`DELETE` statements that only ever need to run once. A comment in the code claims "7 tiny SELECTs ≈ 50ms" — the real cost is far higher, and it is multiplied by the 6–7 API calls each page makes.
- **[C2] `fetch("/api/seed")` is fired on every page load** by the homepage, the customer QR menu, and the admin page. This guarantees the full seed pipeline (see C1) runs on every visitor's first request, even though the data routes already self-initialize.
- **[C3] The marketing homepage is 100% client-rendered.** `src/app/page.tsx` is a `"use client"` component that fetches settings → categories → menu → reviews → gallery in **sequence** (a waterfall) after hydration, plus an admin-verify call. No SSR/SSG: empty HTML shell, poor LCP/FCP, no SEO/content for crawlers. *(Planned for Group 2 — rendering refactor.)*

### High

- **[H1] No HTTP caching on public data.** `/api/categories`, `/api/menu`, `/api/gallery`, `/api/announcements` send `Cache-Control: no-store`; `/api/reviews` sends no header. This content changes rarely (menu, categories, gallery) and is served to every visitor — it should be cacheable for ~1 minute with stale-while-revalidate.
- **[H2] `/api/tickets` loads *every* `ticket_items` row ever written, then filters in JS.** The GET handler runs `SELECT * FROM ticket_items` (all items in the DB, growing forever) and then does an O(n·m) `items.filter(...)` per ticket to attach items. Should scope the items query to the listed tickets in SQL.
- **[H3] `/api/reports` loads *all* tickets and *all* ticket items into memory** on every call. Every revenue/order-history figure only needs the last 30 days. Unbounded query + unbounded JS aggregation as the business grows.
- **[H4] Unoptimized imagery.** 28 raw `<img>` tags (remote Pexels/self-hosted URLs) with mixed `loading`/`decoding` hints and no `next/image`, width/height, or sizing strategy → extra payload + layout shift. *(Group 2.)*

### Medium

- **[M1] Google Translate third-party script loads eagerly** on the homepage and customer menu (heavy `translate.google.com` script + DOM mutations + full `location.reload()` on toggle). Should lazy-load on first toggle. *(Group 2.)*
- **[M2] No `next/font`, no `preconnect`/`dns-prefetch`** for image origins. *(Group 2.)*
- **[M3] No DB indexes on hot query columns** — `ticket_items(ticket_id)`, `tickets(status)`, `tickets(table_id)`, `ticket_items(station_name)`, etc. Fine at small scale; matters as ticket volume grows. *(Group 3.)*
- **[M4] Photos stored as base64 in Postgres and decoded per request.** Mitigations already exist (client-side compression, on-demand receipts, immutable `Cache-Control` on `/api/images/[id]`), so this is acceptable short-term. *(Group 3: move to object storage / server-side resize.)*

### Already handled (verified — keep as-is)

- ✅ `ensureTablesExist()` is memoized per server process (the "traffic boat-fix") and health-checks with one light query first.
- ✅ RMS polling (`waiter`, `cashier`, `station`) skips work while `document.hidden`.
- ✅ Ticket list payloads exclude `receiptImage`; receipts load on demand via `/api/tickets/receipt?id=`.
- ✅ `/api/images/[id]` serves with `Cache-Control: public, max-age=31536000, immutable`.
- ✅ Customer menu has a sessionStorage stale-while-revalidate cache (`fana_menu_cache`).
- ✅ DB `Pool` is a process-wide singleton; connection errors are handled.

---

## 3. Grouped fix plan

| Group | Theme | Items |
|---|---|---|
| **Group 1 (this pass)** | Request-path efficiency | C1, C2, C3-fetch-pattern (parallelize), H1, H2, H3 |
| **Group 2 (next)** | Rendering & payload | C3 (SSR/SSG homepage, server components), H4 (`next/image`), M1 (lazy Google Translate), M2 (fonts/preconnect), metadata/OG |
| **Group 3 (later)** | Scale & ops | M3 (DB indexes), M4 (image pipeline), SSE/WebSocket for RMS instead of polling, route-level data cache with revalidation tags, connection pooling tuning for serverless |

---

## 4. Group 1 — changes implemented

1. **Seed-once memoization** (`src/lib/seed-db.ts`): `ensureDbSeeded()` now runs the full seed exactly once per server process (shared promise — concurrent first requests collapse into one run); subsequent calls return instantly with zero SQL. A failure clears the memo so the next call retries. `invalidateDbSeeded()` is exported and called from destructive endpoints so the documented "empty table self-heal" contract still works *after* admin writes — but never on plain reads.
2. **Removed `fetch("/api/seed")`** from the homepage, customer menu, and admin page (C2). Data routes self-initialize on first data read.
3. **Parallelized the homepage + admin data loads** with `Promise.all` (removes the 5-step sequential waterfall).
4. **HTTP caching on public GETs** (H1): `Cache-Control: public, max-age=60, stale-while-revalidate=300` on `/api/categories`, `/api/menu`, `/api/gallery`, `/api/announcements`, `/api/reviews` (settings already had it). Admin fetches append a cache-busting `?v=` so the owner never sees stale data.
5. **`/api/tickets` scoped items query** (H2): item rows are now fetched `WHERE ticket_id IN (listed ticket ids)` instead of loading the entire table.
6. **`/api/reports` 30-day SQL scoping** (H3): tickets are filtered in SQL to `created_at/updated_at/closed_at >= now() - 30 days` and items are fetched only for those tickets, bounding both the query and the JS aggregation.

### Verification

- `npm run typecheck` — clean
- `npm run lint` — clean
- `npm run build` — passes
- Request-path smoke tests (see `docs/` or run against a local Postgres with `DATABASE_URL` set): first request performs the full seed; subsequent requests execute only the data read.

---

## 5b. Group 1 follow-up — advisor plan reality-check (2026-08-10)

A second review plan was received (external advisor, 4 priority groups). Each Group 1
item was checked against the **actual** code — several claims referred to a different
system version (it mentions `/api/orders` and random `FANA-ORD-xxxxxx` numbers, which
do not exist in this codebase — ordering here is `tickets`/`ticket_items`, and status
updates go through `PUT /api/tickets`). The underlying operational concerns are real
and were fixed:

| Advisor item | Reality in this codebase | Fix applied |
|---|---|---|
| 1. "PUT /api/orders broken" | No `/api/orders` route exists; `PUT /api/tickets` works but accepted ANY status | **Added server-side status-transition validation** (pending_waiter → confirmed → preparing → ready_for_payment → completed → paid; cancellable at any active step; paid/cancelled terminal). Invalid moves now get 400 instead of silently corrupting state. |
| 2. Duplicate orders on retry | Real: a retry after WiFi loss re-added the same cart items to the bill | **Idempotency keys**: customer + waiter apps generate one UUID per submission (kept across retries, discarded on cart edit). Server stores per-item derived keys `<key>#<i>` and a UNIQUE index on `(ticket_id, idempotency_key)` rejects re-inserts even under concurrency; replays return the existing bill with `duplicate: true`. |
| 3. Order number collisions | No random generator in the real flow (legacy `orders` table only) | **`order_number` column = `FANA-<ticket id>`** (DB serial → unique by construction), partial UNIQUE index as a second layer, backfill for existing rows, displayed on customer confirmation, cashier cards and station screens. |
| 4. Runtime seeding on every request | Already fixed in the first Group 1 pass (seed runs once per server process; 0 statements afterwards) | No further change needed. |
| 5. Polling the entire order history | Real: cashier polled `/api/tickets?all=1` every 8s → re-downloaded last 100 bills incl. paid | **Cashier now polls `/api/tickets?active=1` only** (small live payload); the "Recently Paid" panel loads on login + every 60s instead. |
| 6. "Cashier polls 8 endpoints" | Exaggerated (cashier polled 2, station 1); pause-on-hidden-tab already implemented everywhere | Covered by item 5. |

### Group 1 fix verification

- `tsc --noEmit` clean, `next build` passes, zero new lint issues (baseline unchanged: 42 pre-existing errors in untouched files).
- Drizzle-generated SQL verified for every new query.
- **Real database-level test (PGlite/Postgres WASM)** of the migration DDL + constraints:
  ✅ order_number = FANA-<id> on insert · ✅ retry probe returns the existing ticket ·
  ✅ concurrent duplicate submission blocked by unique index · ✅ second submission on
  the same table bill allowed · ✅ order_number collision blocked · ✅ backfill of old rows.
- Client single-flight guards (`disabled` while submitting) + key reuse across retries,
  so a double-tap cannot double-cook.

Still open from the advisor plan (later groups, as agreed — one group at a time):
Group 2 table sessions & payment-status separation, Group 3 offline indicator / indexes /
image pipeline, Group 4 explicitly deferred (WebSockets not needed at this scale).

## 5c. Group 1 prompt cross-check (2026-08-10) — payment status added

The advisor's official GROUP 1 prompt was checked item-by-item against the real code:

| Prompt item | Status | Evidence / action |
|---|---|---|
| 1. PUT /api/orders | **Not applicable — no such route in this repo** | Verified: `src/app/api/orders/` does not exist and nothing references `api/orders` or `OrderCartModal.tsx` (advisor described a different version). The real equivalent — `PUT /api/tickets` — already existed and was hardened with status-transition validation (pending_waiter→confirmed→preparing→ready_for_payment→completed→paid, cancellable, terminal states protected) + 400/404 handling. |
| 2. Unique order numbers | **Done (previous pass)** | `tickets.order_number = FANA-<DB serial id>` (never random → collisions impossible by construction), partial UNIQUE index as second layer, backfill for existing rows, conflict-safe. |
| 3. Table number on dine-in orders | **Already satisfied by architecture** | `tickets.table_id` (NOT NULL) + `table_name`; QR flow reads `?table=` and sends `tableId`; server validates (`400` if missing); cashier/waiter display table name. Takeaway doesn't exist in this system (all orders are table-based). |
| 4. Payment status | **NEW — implemented this pass** | See below. |
| 5. Duplicate orders from retries | **Done (previous pass)** | Client UUID idempotency keys (reused on retry, regenerated on cart edit), per-item derived keys `K#<i>`, UNIQUE index on `(ticket_id, idempotency_key)`, DB-level rejection under concurrency, single-flight buttons. |
| 6. No unrelated changes | Followed | Only payment-status related files touched this pass. |
| 7. Migrations | Followed | Uses the project's own `ensureTablesExist()` DDL pattern (no drizzle-kit migration files exist in this repo); backward-safe: `ADD COLUMN IF NOT EXISTS`, default, backfill, nothing dropped. |
| 8. Verify everything | Done | See test evidence below. |

### Payment status (prompt item 4) — what was added

- **Schema:** `tickets.payment_status` text, NOT NULL default `'unpaid'` — values `unpaid | paid_cash | paid_telebirr | paid_cbe | paid_card`. Fully separate from `status` (order/food status). No split billing.
- **Migration:** column auto-added by `ensureTablesExist`; backfill derives concrete status for existing paid/completed bills from their stored method (`cash→paid_cash`, `card→paid_card`, `online/telebirr→paid_telebirr`, `cbe→paid_cbe`), then any remaining NULL → `unpaid`. Old data preserved.
- **Waiter payment screen:** options split from `cash | card | online` into **Cash · Telebirr · CBE Birr · Card** (Ethiopian mobile-money reality). Confirming payment records `paymentMethod` AND `paymentStatus: paid_<method>` (order status stays `completed` until the cashier verifies & releases).
- **Cashier:** each bill in the payment stage shows a colored **PAID/UNPAID** chip plus a dropdown to correct/record the payment status (PUTs `/api/tickets`). "Mark PAID & Release Table" derives the status if still unpaid.
- **PUT /api/tickets** now validates `paymentStatus` against the allowed set (400 on anything else).
- **Reports/history:** payment-stat cards now cover cash/telebirr/cbe/card (plus legacy "online"); filters and icons updated; "online" legacy rows still display.

### Test evidence (this pass)

- `tsc --noEmit` clean; `next build` compiles; lint identical to baseline (42 pre-existing errors, 0 new — verified by stash diff; only line numbers shifted).
- **PGlite (real Postgres engine) tests:**
  - Migration: column added to legacy table without touching data ✓; backfill maps paid/completed by method ✓; active bills and unknown methods → `unpaid` ✓; new tickets default `unpaid` ✓ (initial attempt exposed a NULL-backfill bug → fixed with `IS NULL` guard + final normalize; all assertions now pass).
  - Regression: unique order numbers ✓, replay probe ✓, concurrent-duplicate rejection ✓, second submission on same bill allowed ✓, collision blocked ✓.
- UI: dev server compiles all touched screens (cashier, waiter, kitchen, menu, reports).

## 5e. Group 2 — seeding & redundant requests (2026-08-10)

**Task:** verify the old audit's claim that `ensureDbSeeded()` runs on normal GET
requests, remove redundant seeding, measure before/after, and stop.

### What the current code actually does (inspected first)

- `ensureDbSeeded()` is still *called* by 9 data routes (settings, categories, menu,
  reviews, gallery, staff, tables) + 2 login routes + the intentional init routes
  (`/api/seed`, `/api/setup`).
- But since the first Group 1 pass it is **memoized per server process**:
  `__fanaSeedDone` + a shared promise collapse concurrent first calls; warm calls
  return instantly with **zero SQL** (verified by code reading and by counting).
- `ensureTablesExist()` was already memoized (`__fanaMigrateDone`) — but only a
  *flag*, so concurrent cold-start requests each ran the full migration until the
  flag was set at the end.
- Zero `fetch("/api/seed")` calls remain in client code; `/api/admin/verify` does no
  DB work (cookie check only).

### What was measured (real route handlers, stubbed `pg` Pool that counts every statement)

| Scenario (warm = 2nd request in same process) | BEFORE (original commit) | AFTER (start of this pass) | AFTER (end of this pass) |
|---|---|---|---|
| `GET /api/menu` warm | 94 (81 seed writes) | 1 | 1 |
| `GET /api/staff?public=1` warm | 94 (81 seed writes) | 1 | 1 |
| `GET /api/categories` warm | 94 (81 seed writes) | 1 | 1 |
| Homepage 5 routes, parallel, warm | 470 (405 seed writes) | 5 | 5 |
| Homepage 5 routes, parallel, COLD | 2300 (migrate ran 5×) | 2033 (migrate 5×) | **485 (migrate 1×)** |

(Stub returns empty rows, so the one-time init does its maximum work — real cold
cost on a healthy DB is the 1-query health probe + a few seed writes.)

### Changes made

**`src/db/migrate.ts` — `ensureTablesExist()` now uses a shared promise** (same
pattern as the seed memo): the first caller runs the migration/health probe; any
concurrent first callers await the same result instead of each executing the full
CREATE/ALTER storm. `force` paths (`/api/setup?force=1`, image uploads) still run a
fresh migration. Failure does NOT set the memo → next call retries (verified).

**Deliberately NOT done:** `ensureDbSeeded()` was **not stripped from GET routes**.
With the memo, warm cost is provably zero (measured: 1 query = the data SELECT), and
the one-time first-request auto-init is the project's documented self-heal mechanism
(fresh Neon DB works without the owner remembering to visit `/api/setup`). Removing
the call would break first-time setup — the prompt explicitly says not to remove
genuinely-required initialization.

### Verification

- `tsc --noEmit` clean; `next build` compiles; lint identical to baseline (42
  pre-existing errors, 0 new — verified by stash-diff).
- Memo behavior tests (stubbed pool): healthy DB → 1 probe query then 0;
  3 concurrent broken-DB calls → ONE migration (387 statements, not 3×); failed
  migration → memo does not stick, retry succeeds; `force=true` bypasses memo.
- Pages still load (dev server: /, /menu, /cashier, /waiter, /kitchen, /admin all 200).

### Remaining Group 2 issues

None. (Items excluded by the prompt — polling intervals, historical filtering,
Base64 images, WebSockets, etc. — untouched.)

## 5f. How to measure after deploying (Group 2)

1. After deploy, the FIRST request to any data route (or `/api/setup`) performs the
   one-time seed + migration; every subsequent request in the same server process
   executes only its data SELECT (1 query for `/api/menu`, `/api/categories`, …).
2. Open the site with 5+ parallel tabs right after a cold start — the migration runs
   once, not once per request (observable via Neon's query log / `pg_stat_statements`).
3. Repeated menu/category/settings requests produce no `INSERT`/`UPDATE`/`DELETE`
   against `menu_items`, `categories`, `site_settings` etc. (previously ~81 seed
   statements per warm request).

### Group 1 measurement (retained from earlier pass)

1. Cashier: open DevTools → Network, watch the 8s poll — it now hits only
   `/api/tickets?active=1` + `/api/tables` (small JSON, no paid history).
2. Customer: submit an order, then press Submit again with WiFi off and on — the second
   press shows the same bill (never a second ticket).
3. Kitchen: a ticket now shows `Order #FANA-<n>`; the number never repeats.
4. Try `PUT /api/tickets` with an illegal transition (e.g. `paid` → `preparing`) — it
   returns 400.

## 5. How to measure after deploying

1. Open the deployed homepage in Chrome DevTools → Network: confirm `settings/categories/menu/reviews/gallery` load **in parallel** and return `Cache-Control: public, max-age=60, stale-while-revalidate=300` (no `no-store`).
2. `SELECT count(*) FROM pg_stat_statements` (or enable `pg_stat_statements` on Neon) before/after: total statement count on a repeat page view should drop from ~150+ to single digits.
3. Watch Vercel "Function Duration" for `/api/menu`, `/api/categories`, `/api/settings` — should drop from hundreds of ms to a single query (~5–20 ms warm).
4. Repeat-visit homepage load: most fetches should be served from browser cache (status 200 from memory/disk cache, or 304).
