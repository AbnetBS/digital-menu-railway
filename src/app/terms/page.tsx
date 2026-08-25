import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service — Fana Cafe & Restaurant",
  description:
    "The terms for using the Fana Cafe & Restaurant website, including ordering from your table, menu availability, and user-submitted reviews.",
};

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-[#FAF6F0] text-[#2C1B17]">
      <div className="max-w-3xl mx-auto px-5 sm:px-6 py-12 sm:py-16">
        {/* Brand header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-11 h-11 rounded-full bg-[#2C1B17] border-2 border-[#C9A227] flex items-center justify-center shrink-0">
            <span className="text-xl font-black text-[#C9A227] font-serif">F</span>
          </div>
          <div>
            <h1 className="font-serif text-2xl sm:text-3xl font-black text-[#2C1B17]">Terms of Service</h1>
            <p className="text-xs font-bold uppercase tracking-[0.25em] text-[#C9A227]">
              Fana Cafe &amp; Restaurant
            </p>
          </div>
        </div>

        <p className="text-sm text-[#6D4C41] leading-relaxed mb-8">
          These terms describe how you may use the Fana Cafe &amp; Restaurant website, including
          our menu and table ordering. By using this website you agree to these terms. This is a
          general information page and is not legal advice.
        </p>

        <Section title="1. Acceptable use">
          You may use this website to view our menu, read and submit reviews, and place an order
          from your table. Please use the website only for its intended purpose and do not attempt
          to disrupt it, access staff areas without permission, or misuse it in any way.
        </Section>

        <Section title="2. Ordering from your table">
          You can order by scanning the QR code at your table. Orders are sent to our staff for
          confirmation and preparation. Ordering through the website does not in itself create a
          completed sale — your order is finalized and paid at the restaurant.
        </Section>

        <Section title="3. Menu, prices, and availability">
          Our menu, prices, and item availability are shown for information and may change without
          notice. Some items may be unavailable at certain times. The final price and availability
          of any item are confirmed by our staff when you order.
        </Section>

        <Section title="4. Reviews and content you submit">
          You may submit reviews of your experience. By submitting a review, you agree that it may
          be displayed publicly on the website. Please keep reviews honest, respectful, and free of
          content that is unlawful, offensive, or misleading. We may choose not to display a review
          that does not meet these standards.
        </Section>

        <Section title="5. Website availability">
          We aim to keep this website available, but it may occasionally be interrupted for
          maintenance or technical reasons beyond our control. We are not responsible for temporary
          interruptions, errors, or delays in the operation of the website.
        </Section>

        <Section title="6. Limitation of responsibility">
          To the extent permitted by law, Fana Cafe &amp; Restaurant is not liable for any loss or
          damage arising from your use of this website, including any temporary technical problems.
          Nothing here affects rights you may have under applicable law.
        </Section>

        <Section title="7. Content and intellectual property">
          The design, text, and images on this website belong to Fana Cafe &amp; Restaurant (or are
          used with permission). You may view and use them for personal, non-commercial purposes
          only, and may not copy or reuse them without permission.
        </Section>

        <Section title="8. Changes to these terms">
          We may update these terms from time to time. Continued use of the website after a change
          means you accept the updated terms.
        </Section>

        <Section title="9. Contact us">
          If you have questions about these terms, you can reach us at:
          <ul className="list-none space-y-1 mt-2 text-[#4E342E]">
            <li>📞 0911 065 022</li>
            <li>📍 Town Square Building, 22 Square, Djibouti Street, Bole, Addis Ababa, Ethiopia</li>
          </ul>
        </Section>

        <div className="mt-10 pt-6 border-t border-[#C9A227]/30 flex items-center justify-between text-xs">
          <Link href="/privacy" className="text-[#4E342E] font-bold hover:text-[#C9A227] transition">
            ← Privacy Policy
          </Link>
          <Link href="/" className="text-[#4E342E] font-bold hover:text-[#C9A227] transition">
            Back to Homepage →
          </Link>
        </div>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="font-serif text-lg font-bold text-[#4E342E] mb-3">{title}</h2>
      <div className="text-sm text-[#6D4C41] leading-relaxed">{children}</div>
    </section>
  );
}
