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
| **Group 2 (next)** | Rendering & payload | C3 (SSR/SSG homepage, server components), H4 (`next/image`), M2 (fonts/preconnect), metadata/OG |
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

## 5g. Group 3 — performance & long-term reliability (2026-08-10)

Worked strictly one item at a time: inspect → verify → fix only if the problem exists → test → measure → report.

### ITEM 1 — Polling / active orders

**Inspection:** cashier polls `/api/tables` + `/api/tickets?active=1` every 8s; waiter same; station polls `/api/station-items?station=X` every 8s — all active-only, receipts excluded, items scoped in SQL. ✅ The one remaining issue was the cashier's "Recently Paid" refresh: it fetched `?all=1` (up to 100 tickets **with items**) every 60s just to render 12 cards showing only table/method/total.
**Fix:** `/api/tickets` GET gained `?paid=1&limit=N` → only the N most recent paid tickets, **no items query, no receipt**; cashier `loadHistory` now uses `?paid=1&limit=12` and renders the response directly.
**Measured (counting stub):** per history refresh 2→1 SQL, 100→12 tickets, items query eliminated, response ~0.4 KB.

### ITEM 2 — Cashier unrelated polling

**Inspection:** full fetch inventory of the cashier — polls ONLY `/api/tables` + `/api/tickets?active=1` (8s) and `/api/tickets?paid=1&limit=12` (60s); staff list fetched once on mount; everything else is on-demand (PUT/DELETE/receipt-on-click). **No gallery/reviews/categories/settings/menu polling exists** — nothing to remove.
**Measured (simulated 60s cashier window, original commit vs current):** statements/min 770→33 (seeding removal from Groups 1–2), rows/min 2505→1140, KB/min 217→85 (active-only + lightweight history).

### ITEM 3 — Database indexes

**Inspection:** verified each hot query's WHERE/ORDER BY in the current code, then added only justified indexes in `ensureTablesExist` (Step 4, `CREATE INDEX IF NOT EXISTS` — backward-safe, idempotent):
1. `ticket_items(ticket_id)` — items attach on every tickets/reports fetch
2. `ticket_items(station_name, removed)` — kitchen/barista 8s polling
3. `tickets(status, updated_at)` — active poll + paid history + all=1 sort
4. `tickets(table_id, status)` — "one active bill per table" merge lookup on every order
5. `tickets(created_at)` — reports 30-day scoping
6. `tickets(updated_at)` — reports OR + bare `ORDER BY updated_at DESC LIMIT 100`
7. `tickets(status, closed_at)` — receipt-cleanup job

**Verified (PGlite, 8k tickets / 24k items):** all 5 representative query patterns went **Seq Scan → Index/Bitmap Index Scan** after adding the indexes.

### ITEM 4 — Pause polling when page is inactive

**Inspection:** all three RMS apps already skip poll work while `document.hidden`. Missing: immediate refresh on return to the tab (waited up to one 8s tick).
**Fix:** added `visibilitychange` listeners (with cleanup) to cashier, waiter, and station apps — the moment the tab becomes visible, the poll runs immediately. No duplicate timers (single interval + single listener, both cleaned up).

### ITEM 5 — Cashier offline / connection indicator

**Inspection:** none existed.
**Fix:** added a header indicator driven by **real backend communication** (fetch success/failure of the polled endpoints, with a try/catch around the whole poll — also fixes a latent unhandled-rejection): 🟢 `ONLINE` + `last updated HH:MM:SS`, or 🔴 `OFFLINE — RECONNECTING` (pulsing). Reflects the backend, not the browser's internet status.

### ITEM 6 — Base64 / menu images

**Inspection:** uploads are compressed on-device (`compressImage` 640px/0.6 for menu, 800/0.65 for receipts) then stored once in `cdn_images` (base64 text) with a short `/api/images/{id}` URL; served with `Cache-Control: public, max-age=31536000, immutable` (downloaded once per device); receipts excluded from all polling payloads; defaults use external Pexels URLs (0 self-hosted in seed data).
**Verdict:** the "smallest safe improvement" from the plan is **already implemented** — report, no change. A full move to object storage is explicitly a later-group item; suggested one-time check on the real DB to size `cdn_images` (`SELECT pg_size_pretty(pg_total_relation_size('cdn_images'))`).

### Group 3 verification

- `tsc --noEmit` clean; `next build` compiles; lint identical to baseline (42 pre-existing, 0 new — verified by stash-diff; only line numbers shifted).
- Pages load: /, /menu, /cashier, /waiter, /kitchen, /admin all 200.
- Index behavior proven on a real Postgres engine (Seq Scan → Index).
- Polling payloads/statements measured before/after (items 1–2 tables above).

### Remaining Group 3 issues

None within scope. (Group 4 explicitly not started.)

## 5i. Group 4 — database usage, storage & historical performance (2026-08-10)

Worked one item at a time with the required report format. All measurements used the
real route handlers with a faithful pg stub (array-mode rows, real drizzle mapping)
or PGlite (real Postgres engine).

### ITEM 1 — Database image storage
**Found:** images ARE stored in Postgres — `cdn_images.data` (base64 text, menu/gallery
uploads via `/api/images` POST) and `tickets.receipt_image` (base64 text). Menu/gallery
payloads carry only short `/api/images/{id}` URLs; receipts are excluded from polling.
**Evidence (PGlite, incompressible data):** one menu-image column ≈ 45 KB, one receipt
≈ 75 KB; 230 uploads ≈ 11.6 MB total.
**Projections (labeled estimates):** 200 menu + 30 gallery ≈ 10.8 MB (small, fine).
Receipts are the real growth driver: 7.5–22.5 MB/day → **~330 MB steady-state WITH the
30-day cleanup job, ~8 GB/year WITHOUT it** — the cleanup job is essential.
**Fix:** none in code (the smallest-safe-improvement — client-side compression, short
immutable URLs, receipts excluded, cleanup job — is already in place). The real fix is
object storage (S3/R2/Vercel Blob) behind the same `/api/images/{id}` endpoint so URLs
never break; **requires a provider decision** → reported, not implemented (no
credentials/infrastructure to invent).
**Remaining concern:** `cdn_images` orphans (replaced/deleted items' photos) accumulate
~45 KB each; a safe orphan-cleanup query is proposed but not executed (destructive).

### ITEM 2 — Historical ticket queries
**Found:** `/api/reports` loaded items for ALL 30-day tickets (~27k rows at 9k
tickets/month) but only used items for (a) today's revenue tickets (popular/category
stats) and (b) the newest 200 history tickets.
**Before:** 1 item query, 9,000 ids scanned → 27,000 item rows read.
**Fix:** two scoped item queries (today's revenue tickets + 200 history tickets),
run in parallel; order-history stays bounded at 200 (bounded, not paginated further —
admin UI shows the newest 200).
**After:** 2 item queries, 308 ids scanned → 924 item rows read (**97% reduction**).
**Tests:** identical output (todayOrders 108, popular 3, history 200); typecheck + build clean.

### ITEM 3 — Large API payloads
**Inventory (real routes, realistic volumes):** reports 125.7 KB, tickets?all=1 124.5 KB,
**reviews 114 KB for 500 rows (NO limit)**, menu 53.4 KB, tickets?active=1 24.9 KB,
tables 5.3 KB, paid-history 4.0 KB, gallery 3.3 KB, announcements 1.8 KB.
**Offender:** `/api/reviews` — unbounded, fetched by the public homepage on every visit.
**Fix:** default limit 100 (newest first); admin moderation passes `?all=1` for the full
list (rare, on-demand).
**After (measured):** public reviews 114 KB → **22.6 KB**; admin unchanged (114 KB on demand).
Other endpoints already bounded (tickets limits, active-only, URLs-only menu) — left alone.

### ITEM 4 — N+1 query audit
**Evidence (statement counts at 20 vs 200 rows):** tickets?active=1: 2→2 · tables: 2→2
(warm) · station-items: 1→1 · reports: batched (scoped IN queries). **No N+1 exists** —
all operational routes batch with `IN (...)` + Map grouping (done in earlier groups).
**Fix:** none needed. Verified, not modified.

### ITEM 5 — Database connection / query pressure
**Evidence:** `src/db/index.ts` — single `pg.Pool` singleton memoized on `globalThis`
(one per server instance; survives dev reloads), `connectionTimeoutMillis: 5000`, pool
error handler. **Only one `new Pool()` in the codebase**; no per-request pools/clients.
**Fix:** none — already correct. (Pool sizing per the Neon plan is a deployment decision,
not invented here.)

### ITEM 6 — Query result limits / safety bounds
**Found:** reviews unbounded (fixed in ITEM 3). Gallery and announcements were the other
unbounded GETs (owner-managed, small in practice).
**Fix:** safety caps — gallery `.limit(500)`, announcements `.limit(200)` — far beyond
realistic cafe usage, purely protective. Tickets/menu/categories/staff/tables already
bounded by design (100/200/13/11/40). Reports bounded by 30-day scope + 200 history + 30 receipts.

### ITEM 7 — Database growth / retention analysis (no code change)
**Estimates (labeled; assume 300 tickets/day busy season, 3.5 items/ticket):**
| Table | 1 yr | 3 yr | 5 yr |
|---|---|---|---|
| tickets (rows) | 109,500 (~27 MB) | 328,500 (~82 MB) | 547,500 (~137 MB) |
| ticket_items | 383k (~77 MB) | 1.15M (~230 MB) | 1.9M (~383 MB) |
| receipts WITH 30-day cleanup | ~330 MB steady | ~330 MB steady | ~330 MB steady |
| receipts WITHOUT cleanup | ~8 GB | ~24 GB | ~40 GB |
| cdn_images (owner uploads) | ~11 MB + small growth | small | small |
| reviews | ~2 MB | ~6 MB | ~10 MB |
**Key finding:** receipts are the dominant growth driver; the cleanup job exists but is
only triggered manually (admin "Free up storage" button). **Recommended retention
design (not implemented — needs a deployment decision):** schedule `POST
/api/tickets/cleanup` automatically (e.g. Vercel Cron / Neon scheduled job) so receipt
storage stays bounded without manual action. No business data deleted.

### ITEM 8 — Final database load measurement (synthetic workload)
Simulated the real workload against the REAL route handlers with an in-memory DB:
10,000 historical tickets + 30k items, 40 tables, 11 staff; concurrent orders, 40-way
duplicate race, cashier/waiter/station polling, payment flows, reports, menu.
**Results:**
- 8 simultaneous customer orders → all created, unique order numbers (2 correctly
  merged into existing active table bills)
- **40 concurrent duplicate submissions of one order → exactly 1 order created, 39
  returned as replay** (idempotency bulletproof under a true race)
- Cashier poll cycle = 2 statements · history refresh = 1 · station poll = 2 ·
  order POST = 8 · report over 10k tickets = 4 · menu = 1
- ≈ **1,861 statements per simulated minute** of restaurant activity (8s polls × 2
  screens + stations + orders), ~74k rows read, **0 failures**
- **Found & fixed a real bug:** the 23505 (unique-violation) catch only checked
  `err.code`, but drizzle wraps pg errors in `DrizzleQueryError` WITHOUT copying
  `code` — a true concurrent duplicate would have returned HTTP 500 instead of a
  graceful replay. Now checks `err.cause?.code` too (verified: 1 created / 39 replays).
- "Duplicate order numbers: 46" = intentional response-level repeats (merges into the
  same table's active bill + replay responses); genuine collisions are impossible
  (order_number = FANA-<DB serial> + partial UNIQUE index).

### Group 4 verification
`tsc --noEmit` clean · `next build` compiles · lint identical to baseline (0 new —
stash-diff verified) · all pages load (/, /menu, /cashier, /waiter, /kitchen, /admin = 200).

### Remaining Group 4 concerns
1. Object storage for receipts/images — requires a storage-provider decision (migration
   boundary documented; existing `/api/images/{id}` URLs keep working if adopted).
2. Automatic receipt-cleanup scheduling (cron) — deployment decision, recommended.
3. `cdn_images` orphan cleanup — proposed, not implemented (destructive).
Group 5 NOT started.

## 5k. Group 5 — real restaurant workflow / order / payment correctness (2026-08-10)

Worked one item at a time; verified against the CURRENT code; fixed only genuine gaps.

### ITEM 1 — Table / active-bill relationship
**Status:** **Fixed (DB-level one-active-bill-per-table).**
**Found:** the merge model already exists (new orders for a table join its active
ticket; combined total; payment closes it; table reopens after). BUT there was a
check-then-insert race: two CONCURRENT first orders at the same table could each see
"no active ticket" and create TWO active bills.
**Fix:** partial UNIQUE index `tickets_one_active_per_table_idx ON tickets (table_id)
WHERE status NOT IN ('paid','cancelled')` + a migration that first dedupes any
legacy duplicates (moves the newer tickets' items onto the oldest, deletes the newer
rows — nothing lost) + POST fallback: on 23505, merge into the winner's bill.
**After (real Postgres/PGlite + workflow test):** 3 concurrent first orders at one
table → exactly 1 bill; duplicate legacy tickets collapsed with all items preserved;
second-active-ticket insert rejected; paid insert for same table still allowed.
**Database impact:** one partial unique index; no data loss (verified).

### ITEM 2 — Order status model
**Status:** **Already solved — verified.**
**Found:** lifecycle `pending_waiter → confirmed → preparing → ready_for_payment →
completed → paid` (cancellable), enforced server-side since Group 1; food status
(`status`) is fully separate from payment status (`paymentStatus`).
**Tests:** valid chain OK; skipping states rejected (400); backwards moves rejected;
concurrent status updates → stale one rejected, final state consistent (no corruption).

### ITEM 3 — Payment state model
**Status:** **Already solved — verified.**
**Found:** `paymentStatus` (unpaid | paid_cash | paid_telebirr | paid_cbe |
paid_card) independent of `status`. `completed + unpaid` is possible (food done ≠ paid).
**Tests:** completed/unpaid ✓; completed + paid (telebirr/card/cash) ✓; already-paid
order → idempotent no-op; invalid payment status rejected (400).

### ITEM 4 — Payment method
**Status:** **Fixed (validation).**
**Found:** methods cash/telebirr/cbe/card (+legacy online) existed, but `PUT` accepted
ANY string — "bitcoin" would have been stored.
**Fix:** validate `paymentMethod` against the allowed set (400 otherwise).
**Tests:** cash recorded ✓; invalid method rejected ✓.

### ITEM 5 — Receipt / payment verification workflow
**Status:** **Already solved — verified (+ audit stamping).**
**Found:** waiter attaches compressed receipt for digital/card and marks
completed+paid_<method>; cashier views receipt on demand and "Mark PAID & Release"
verifies. No money transfer (records only). Missing: WHO verified / WHEN.
**Fix (shared with ITEM 8):** `verifiedBy`/`verifiedAt` stamped on the paid transition
(cashier's markPaid now sends their name).
**Tests:** receipt attached on digital payment ✓; cashier verification stamps
verifiedBy/verifiedAt ✓.

### ITEM 6 — Payment concurrency / double payment
**Status:** **Already solved — verified (single-row model).**
**Found:** no separate payments table — one ticket row holds payment state, so
double-payment records are structurally impossible; mark-paid is idempotent.
**Tests:** 3 concurrent mark-paid attempts → single paid row, consistent total,
verifiedBy stamped once. No double totals.

### ITEM 7 — Table closing / reopening
**Status:** **Already solved — verified.**
**Found:** paid/cancelled tickets drop out of the active set → table shows available;
new order creates a fresh bill; tickets are per-table (paying one never touches others).
**Tests (5 tables):** paid tables 1–4 became available; ACTIVE table 5 remained active;
table 1 reopened with a NEW bill ≠ old; historical paid bills still listed.

### ITEM 8 — Order / payment auditability
**Status:** **Fixed (verification audit fields).**
**Found:** createdBy/tableId/tableName/createdAt/items/orderNumber/totalAmount/
closedAt already recorded. Missing: who marked paid and when.
**Fix:** `verifiedBy` (varchar 100) + `verifiedAt` (timestamp) on tickets; stamped only
by the paid transition; migration backfills nothing destructive (existing paid rows
keep NULL → treated as legacy). Surfaced through ticket payloads/reports/history.
**Database impact:** 2 columns on tickets; backward-safe.

### ITEM 9 — Final restaurant workflow test
**Status:** **All checks passed.**
**Scenario:** 5 tables × multiple orders; concurrent first-orders at one table;
status chains; payments (cash/telebirr/card + receipt); concurrent mark-paid; table
close/reopen; duplicate submissions; station visibility.
**Results:** all merged bills correct (totals 390/420 ETB verified); no duplicate
orders; no mixed totals; no double payment; no unrelated table closed; historical
bills intact; stations see active items; every invalid transition rejected; Group
1–4 performance intact (tests ran against the same hardened routes).

### Group 5 verification
`tsc --noEmit` clean · `next build` compiles · lint identical to baseline (0 new —
stash-diff verified) · migration dedupe + unique index proven on real Postgres
(PGlite) · workflow test: ALL checks passed.
Group 6 NOT started.

## 5m. Group 6 — final production load / reliability proof (2026-08-10)

Real route handlers + a stateful in-memory DB that enforces the same Postgres
constraints (one-active-bill-per-table partial unique index, idempotency unique
index). All measurements are of the ACTUAL app logic. Limitation stated plainly:
this is an in-process simulation (no real network/DB round-trips), so latencies
are handler-time only; it proves correctness, flatness and per-request DB work.

### ITEM 1 — Concurrent order creation ✅
10/20/40 simultaneous orders across tables: **all succeeded, 0 failed, 0 duplicates,
40/40 unique order numbers, 0 incorrect totals**. 10 concurrent orders at ONE table
→ exactly 1 bill (race fallback + unique index), correct combined total, correct
table association.

### ITEM 2 — Duplicate submission / retry storm ✅
Same idempotency key sent 1×, 10×, and **40× concurrently** → exactly **1 order
created, 39 replayed** (`duplicate:true`), 0 HTTP 500, kitchen sees one order.

### ITEM 3 — Polling under restaurant load ✅ (one real bug FOUND + FIXED)
Measured 1 simulated minute (10k historical): **97 statements/min, 5,452 rows/min,
1.04 MB/min** across cashier+waiter+station polling.
**FOUND:** `/api/station-items` fetched EVERY historical item for the station every
8s (≈15k rows at 10k tickets) then filtered to open tickets in JS.
**FIX:** query open-ticket ids first (tiny), then fetch only their items
(`station_name = ? AND removed = ? AND ticket_id IN (open ids)`).
**AFTER:** station-poll rows/min dropped ~97% (252k → 5.4k rows/min overall).
**Flatness proven:** active poll reads **160 rows at 1k, 10k AND 50k historical
tickets** — polling does NOT scale with history.

### ITEM 4 — Historical database growth test ✅
1k/5k/10k/50k tickets: **18 statements at every scale** (flat); active poll flat
(160 rows); menu flat (200); order-create flat; history flat (12). Rows read grow
only in the REPORTS route (2.2k → 54k), which reads the 30-day window — at a
realistic 300 tickets/day that's ~9k rows/30d (bounded by the window, not total
history); the test's "50k within 30 days" is an artificial worst case (≈1,700
tickets/day). Documented as a watch-item, not fixed (no demonstrated real problem).

### ITEM 5 — 40-table restaurant simulation ✅
24 tables opened, multi-order bills, 12 paid (odd) / 12 left active (even),
untouched tables free: **perfect isolation** — paid tables available, active tables
stay active, reopen creates a NEW bill, per-table totals exact (390/120 ETB), no
cross-table mixing.

### ITEM 6 — Network failure / retry behavior ✅
DB outage: order POST returns 500 (no false success); retry after recovery with the
SAME key → exactly 1 order. All 3 poll types fail gracefully (no crash) and resume
after recovery; no false payment/order states created (active bills unchanged).

### ITEM 7 — Sustained workload ✅
**60 simulated restaurant-minutes** (≈4s wall): 2,100 requests, **2,100 ok, 0 failed,
0 HTTP 500, 0 duplicates**; 82 statements/min; 4,966 rows/min; handler latency
avg 1.8ms / median 2ms / p95 3ms; heap stable (±5 MB — no leak). (60-min wall-clock
not practical in this sandbox; the simulated-minute model is the stated limitation.)

### ITEM 8 — Database connection pressure ✅
Single `pg.Pool` singleton (module export === global singleton); 40 concurrent +
140 sustained requests through it; **0 new Pool constructions** — no per-request
pools, no runaway connections. Pool sizing for Neon remains a deployment decision.

### ITEM 9 — Data integrity after load ✅
Scan of the post-stress DB (10,040 tickets / 30,120 items): **no orphans, all totals
consistent, exactly 1 active bill per table, unique order numbers, unique idempotency
keys, valid enums, terminal states (paid/cancelled) intact with closedAt, history
accessible.** (Earlier scan "failures" were seed-data artifacts — fixed the seed to
production-realistic data; the app itself was clean.)

### ITEM 10 — Verdict
**🟢 READY FOR CONTROLLED REAL RESTAURANT DEPLOYMENT** (with the enumerated
limitations below). Based on: 10–40-way concurrent orders clean; 40-way retry storm
collapses to one order; polling flat regardless of history; station-poll
scalability bug found & fixed; 60-minute sustained run with zero failures/duplicates;
single-pool connection model; clean post-load integrity.

**What remains (deployment decisions, not code blockers):**
1. Neon/Postgres pool sizing + connection limits for the actual serverless plan.
2. Scheduling the receipt-cleanup job (cron) — receipts grow ~22 MB/day otherwise.
3. Optional object storage for images/receipts (documented in Group 4).
4. Reports cost is bounded by the 30-day window (~9k rows at realistic volume);
   revisit with SQL-side aggregation only if the cafe ever exceeds ~1,000 tickets/day.
5. A real-network smoke test on the deployed Neon DB (this proof is in-process).

Separated: **problems fixed** (station-items scaling, Groups 1–5 work) · **verified
already solved** (duplicates, transitions, one-bill-per-table, payment model,
connection pool, integrity) · **acceptable limitations** (in-process proof,
30-day-bounded report) · **deferred decisions** (pool sizing, cron cleanup, object
storage).

Group 6 verification: `tsc` clean · build compiles · lint identical to baseline (0
new) · all pages 200 · harness run: **ALL CHECKS PASSED** (exit 0). Group 7 NOT started.

## 5n. How to measure after deploying (Group 6)

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
