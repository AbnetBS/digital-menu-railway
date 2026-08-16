import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";

/**
 * robots.txt
 *
 * Allow:   the public site (homepage, customer menu) — fully crawlable.
 * Disallow: internal/private staff + owner apps, and all API routes.
 *
 * Note: /table/[id] is intentionally NOT disallowed — it is the QR entry point
 * that redirects to the canonical /menu, and carries `noindex` at the page level
 * (see src/app/table/layout.tsx), so search engines won't index it but can still
 * reach the canonical menu.
 */
export default function robots(): MetadataRoute.Robots {
  const base = getSiteUrl();

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/waiter", "/cashier", "/kitchen", "/barista", "/api"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
