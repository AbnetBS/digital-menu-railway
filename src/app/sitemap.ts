import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";

/**
 * Sitemap for the PUBLIC, customer-facing site only.
 *
 * Included:
 *   - /      homepage (hero, about, menu section, gallery, reviews, location)
 *   - /menu  canonical customer menu (QR menu, ordering)
 *
 * Deliberately EXCLUDED (internal/private, never indexed):
 *   - /admin, /waiter, /cashier, /kitchen, /barista (staff/owner apps)
 *   - /table/[id] (QR redirect shim → /menu)
 *   - /api/* (API routes)
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = getSiteUrl();
  const now = new Date();

  return [
    {
      url: `${base}/`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: `${base}/menu`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.9,
    },
  ];
}
