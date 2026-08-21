import type { NextConfig } from "next";

/**
 * Production security headers (Group 3).
 *
 * Kept intentionally conservative so no existing functionality breaks:
 *   - NO Content-Security-Policy: the app relies on Next.js inline scripts for
 *     hydration, Google Maps embeds
 *     (maps.google.com), QR code images (api.qrserver.com) and menu/gallery
 *     images (images.pexels.com). A strict CSP without careful nonce/hash and
 *     domain allow-listing would break these.
 *   - NO frame blocking beyond SAMEORIGIN: X-Frame-Options governs whether
 *     OTHER sites may embed OUR pages; it does not affect the Google Maps
 *     iframes we embed ourselves.
 *   - `camera` is NOT disabled in Permissions-Policy: the receipt-photo flow
 *     uses `<input type="file" capture="environment">` (mobile camera capture),
 *     which is not the getUserMedia API, but we leave it unrestricted to be
 *     certain the phone capture workflow is unaffected.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  {
    key: "Permissions-Policy",
    value: "microphone=(), geolocation=(), payment=()",
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Apply to every route (pages, API, static assets).
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
