/**
 * Canonical public site URL used for SEO artifacts (sitemap.xml, robots.txt).
 *
 * Resolution order:
 *   1. NEXT_PUBLIC_SITE_URL — set in Coolify to your real HTTPS domain,
 *      e.g. https://fanacafe.com.et (at build time for public variables).
 *   2. VERCEL_URL — optional compatibility fallback on Vercel.
 *   3. http://localhost:3000 — local development fallback only.
 */
export function getSiteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return stripTrailingSlash(configured);

  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${stripTrailingSlash(vercel)}`;

  return "http://localhost:3000";
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
