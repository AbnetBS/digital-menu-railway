import type { Metadata } from "next";
import type { ReactNode } from "react";
import Script from "next/script";
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
        {/* Google Translate remains available as a fallback for dynamic/database text
            that is not part of the hand-written application dictionary. */}
        <Script id="google-translate-init" strategy="beforeInteractive">
          {`window.googleTranslateElementInit = function () {
            new window.google.translate.TranslateElement({
              pageLanguage: 'en',
              includedLanguages: 'en,am',
              autoDisplay: false
            }, 'google_translate_element');
          };`}
        </Script>
        <Script
          src="https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit"
          strategy="afterInteractive"
        />
        {/* Speed up external menu/gallery images (Pexels URLs used by seed/admin) */}
        <link rel="preconnect" href="https://images.pexels.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://images.pexels.com" />
      </head>
      <body className="bg-slate-100 text-slate-900 antialiased">
        <div id="google_translate_element" className="hidden" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
