/**
 * Canonical public site URL used for SEO artifacts (sitemap.xml, robots.txt).
 *
 * Resolution order:
 *   1. NEXT_PUBLIC_SITE_URL  — set this in Railway (or Vercel) to your real
 *      public domain, e.g. https://fanacafe.com (no trailing slash).
 *   2. RAILWAY_PUBLIC_DOMAIN — auto-provided by Railway when deployed there.
 *   3. VERCEL_URL            — auto-provided by Vercel when deployed there.
 *   4. http://localhost:3000 — local development fallback only.
 */
export function getSiteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return stripTrailingSlash(configured);

  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) return `https://${stripTrailingSlash(railway)}`;

  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${stripTrailingSlash(vercel)}`;

  return "http://localhost:3000";
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
