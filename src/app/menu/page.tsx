import { Suspense } from "react";
import CustomerMenuApp from "@/components/rms/CustomerMenuApp";
import { firstScreenPhotoUrls } from "@/lib/menu-preview";

/**
 * The QR-scan entry point: `/menu?table=N` (and `/table/N` redirects here).
 *
 * Rendered on the SERVER on purpose. The guest's phone spends its first seconds
 * downloading this page's JS; asking Postgres for the eight photos that will be
 * on the first screen and emitting them as high-priority `<link rel="preload">`
 * puts those bytes in flight during exactly that window, so the photos are
 * already in the browser cache when `ImageBatchProvider` reveals the grid.
 *
 * `force-dynamic` is required: a prerendered page would bake in whatever the
 * database held at BUILD time (usually nothing at all) and every QR scan would
 * preload stale or empty URLs forever.
 */
export const dynamic = "force-dynamic";

export default async function CustomerMenuPage() {
  // Fails soft to [] — the menu then behaves exactly as it did before.
  const firstScreen = await firstScreenPhotoUrls();

  return (
    <>
      {firstScreen.map((href) => (
        <link key={href} rel="preload" as="image" href={href} fetchPriority="high" />
      ))}
      <Suspense
        fallback={
          <div className="min-h-screen bg-[#FAF6F0] flex items-center justify-center text-[#4E342E] text-sm font-bold">
            Loading menu...
          </div>
        }
      >
        <CustomerMenuApp />
      </Suspense>
    </>
  );
}
