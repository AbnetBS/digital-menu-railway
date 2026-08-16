import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * /table/[id] is the QR-code entry point: it immediately redirects to the
 * canonical customer menu (/menu?table=N). It has no content of its own, so it
 * must NOT be indexed — but it stays crawlable/followable so search engines
 * reach the canonical menu. The public /menu page itself remains indexable.
 */
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: true,
  },
};

export default function TableLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
