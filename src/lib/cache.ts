/**
 * Cache header for PUBLIC read-only data (menu, categories, gallery, reviews,
 * announcements, settings). These change rarely (admin edits) and are served to
 * every visitor, so a short browser/CDN cache with stale-while-revalidate keeps
 * repeat visits instant while edits still propagate within ~1 minute.
 *
 * Admin reads MUST bypass this cache — they append `?v=${Date.now()}` (see
 * src/app/admin/page.tsx) which keys a fresh URL, guaranteeing the owner always
 * sees saved changes immediately.
 */
export const PUBLIC_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";
