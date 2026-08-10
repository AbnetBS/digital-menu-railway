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

## 5. How to measure after deploying

1. Open the deployed homepage in Chrome DevTools → Network: confirm `settings/categories/menu/reviews/gallery` load **in parallel** and return `Cache-Control: public, max-age=60, stale-while-revalidate=300` (no `no-store`).
2. `SELECT count(*) FROM pg_stat_statements` (or enable `pg_stat_statements` on Neon) before/after: total statement count on a repeat page view should drop from ~150+ to single digits.
3. Watch Vercel "Function Duration" for `/api/menu`, `/api/categories`, `/api/settings` — should drop from hundreds of ms to a single query (~5–20 ms warm).
4. Repeat-visit homepage load: most fetches should be served from browser cache (status 200 from memory/disk cache, or 304).
