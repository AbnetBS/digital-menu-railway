import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fana Cafe & Restaurant — POS & Operations System",
  description:
    "Modern restaurant POS and operations management system for Fana Cafe & Restaurant, Addis Ababa — QR table menus, waiter-cashier coordination, payments, and reports.",
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
      <body className="bg-slate-100 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
