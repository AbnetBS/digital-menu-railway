import type { Metadata } from "next";
import type { ReactNode } from "react";
import { FACEBOOK_URL, GOOGLE_MAPS_DIRECTIONS_URL, INSTAGRAM_URL, TIKTOK_URL } from "@/lib/business-links";
import { getSiteUrl } from "@/lib/site-url";
import "./globals.css";

const siteUrl = getSiteUrl();
const localBusinessSchema = {
  "@context": "https://schema.org",
  "@type": "Restaurant",
  "@id": `${siteUrl}/#restaurant`,
  name: "Fana Cafe & Restaurant",
  description: "Specialty coffee, Ethiopian meals, fresh juices, and desserts at Town Square Building, 22 Square in Addis Ababa.",
  url: siteUrl,
  logo: `${siteUrl}/logo.png`,
  image: `${siteUrl}/logo.png`,
  telephone: "+251911065022",
  currenciesAccepted: "ETB",
  servesCuisine: ["Ethiopian", "Coffee", "Cafe"],
  hasMenu: `${siteUrl}/menu`,
  hasMap: GOOGLE_MAPS_DIRECTIONS_URL,
  address: {
    "@type": "PostalAddress",
    streetAddress: "Town Square Building, 22 Square, Djibouti Street, Bole",
    addressLocality: "Addis Ababa",
    addressCountry: "ET",
  },
  geo: {
    "@type": "GeoCoordinates",
    latitude: 9.0148457,
    longitude: 38.7875868,
  },
  sameAs: [FACEBOOK_URL, INSTAGRAM_URL, TIKTOK_URL],
};

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Fana Cafe & Restaurant — Addis Ababa",
    template: "%s — Fana Cafe & Restaurant",
  },
  description:
    "Fana Cafe & Restaurant in Addis Ababa — specialty coffee, authentic Ethiopian meals, and fresh juices at Town Square Building, 22 Square. Scan your table QR to order, or browse the menu, gallery, and reviews online.",
  alternates: {
    canonical: "/",
  },
  icons: {
    icon: "/logo.png",
    apple: "/logo.png",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Speed up external menu/gallery images (Pexels URLs used by seed/admin) */}
        <link rel="preconnect" href="https://images.pexels.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://images.pexels.com" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(localBusinessSchema).replace(/</g, "\\u003c") }}
        />
      </head>
      <body className="bg-slate-100 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
