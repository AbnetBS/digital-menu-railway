import Link from "next/link";

/**
 * Custom 404 page — Fana Cafe branding (coffee brown + gold), mobile-friendly.
 * No internal/system details are exposed; just a friendly "page not found"
 * with clear routes back to the homepage and the customer menu.
 */
export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-[#FAF6F0] px-6 py-16">
      <div className="w-full max-w-md text-center">
        {/* Brand mark */}
        <div className="mx-auto w-16 h-16 rounded-full bg-[#2C1B17] border-2 border-[#C9A227] flex items-center justify-center shadow-lg mb-6">
          <span className="text-2xl font-black text-[#C9A227] font-serif">F</span>
        </div>

        <p className="text-xs font-bold uppercase tracking-[0.3em] text-[#C9A227] mb-2">
          Fana Cafe &amp; Restaurant
        </p>

        <h1 className="font-serif text-5xl sm:text-6xl font-black text-[#2C1B17]">404</h1>
        <h2 className="mt-3 text-xl font-bold text-[#4E342E]">Page not found</h2>
        <p className="mt-3 text-sm text-[#6D4C41] leading-relaxed">
          Sorry — the page you&apos;re looking for doesn&apos;t exist or may have been moved.
          Let&apos;s get you back to something delicious.
        </p>

        <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#4E342E] hover:bg-[#2C1B17] text-amber-200 font-bold text-sm px-6 py-3 transition-colors"
          >
            Back to Homepage
          </Link>
          <Link
            href="/menu"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#C9A227] hover:bg-[#B8921F] text-[#2C1B17] font-bold text-sm px-6 py-3 transition-colors"
          >
            View Our Menu
          </Link>
        </div>
      </div>
    </main>
  );
}
