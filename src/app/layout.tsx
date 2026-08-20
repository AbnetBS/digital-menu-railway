import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Fana Cafe & Restaurant — Addis Ababa",
    template: "%s — Fana Cafe & Restaurant",
  },
  description:
    "Fana Cafe & Restaurant in Addis Ababa — specialty coffee, authentic Ethiopian meals, and fresh juices at Golagul Building, 22 Square. Scan your table QR to order, or browse the menu, gallery, and reviews online.",
  icons: {
    icon: "/logo.png",
    apple: "/logo.png",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="google" content="notranslate" />
        {/* Speed up external menu/gallery images (Pexels URLs used by seed/admin) */}
        <link rel="preconnect" href="https://images.pexels.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://images.pexels.com" />
      </head>
      {/* `notranslate` stops Chrome/Google auto-translate from rewriting our DOM —
          the app ships its own English ⇄ አማርኛ switch (LanguageToggle), and browser
          auto-translate was fighting it (pages stuck in Amharic, broken React). */}
      <body className="bg-slate-100 text-slate-900 antialiased notranslate">{children}</body>
    </html>
  );
}
