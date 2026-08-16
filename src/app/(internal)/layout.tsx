import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * Route-group layout for INTERNAL / PRIVATE application pages
 * (/admin, /waiter, /cashier, /kitchen, /barista).
 *
 * These pages are staff/owner tools, not customer-facing content, so they must
 * never be indexed by search engines. The route group `(internal)` does not
 * change any URL — it only lets us apply `noindex` in one place.
 */
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export default function InternalLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
