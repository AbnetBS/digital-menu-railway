import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Fana Cafe & Restaurant — Addis Ababa",
    template: "%s — Fana Cafe & Restaurant",
  },
  description:
    "Fana Cafe & Restaurant in Addis Ababa — specialty coffee, authentic Ethiopian meals, and fresh juices at Town Square Building, 22 Square. Scan your table QR to order, or browse the menu, gallery, and reviews online.",
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
      </head>
      <body className="bg-slate-100 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
