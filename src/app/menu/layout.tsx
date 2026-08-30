import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Digital Menu & Table Ordering",
  description:
    "Browse the Fana Cafe & Restaurant digital menu, check current availability, and send an order directly from your table in Addis Ababa.",
  alternates: {
    canonical: "/menu",
  },
};

export default function MenuLayout({ children }: Readonly<{ children: ReactNode }>) {
  return children;
}
