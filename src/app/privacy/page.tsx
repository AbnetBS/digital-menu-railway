import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — Fana Cafe & Restaurant",
  description:
    "How Fana Cafe & Restaurant collects, uses, and protects your information when you browse the menu, submit a review, or place a table/QR order.",
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[#FAF6F0] text-[#2C1B17]">
      <div className="max-w-3xl mx-auto px-5 sm:px-6 py-12 sm:py-16">
        {/* Brand header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-11 h-11 rounded-full bg-[#2C1B17] border-2 border-[#C9A227] flex items-center justify-center shrink-0">
            <span className="text-xl font-black text-[#C9A227] font-serif">F</span>
          </div>
          <div>
            <h1 className="font-serif text-2xl sm:text-3xl font-black text-[#2C1B17]">Privacy Policy</h1>
            <p className="text-xs font-bold uppercase tracking-[0.25em] text-[#C9A227]">
              Fana Cafe &amp; Restaurant
            </p>
          </div>
        </div>

        <p className="text-sm text-[#6D4C41] leading-relaxed mb-8">
          This page explains, in plain language, what information Fana Cafe &amp; Restaurant
          may collect through this website, why we collect it, how we protect it, and how you
          can contact us about privacy questions. This is a general information page and is not
          legal advice.
        </p>

        <Section title="1. Who we are">
          Fana Cafe &amp; Restaurant is a café and restaurant located in Addis Ababa, Ethiopia.
          This website lets customers view our menu, read and submit reviews, and place orders
          by scanning the QR code at their table.
        </Section>

        <Section title="2. Information we may collect">
          <ul className="list-disc pl-5 space-y-2">
            <li>
              <strong className="text-[#4E342E]">Reviews.</strong> When you submit a review,
              we collect the name you enter, your star rating, and the text of your review.
              This information is displayed publicly on the website.
            </li>
            <li>
              <strong className="text-[#4E342E]">Table and order information.</strong> When you
              order from a table (by scanning the QR code), we record the table you are at, the
              items you order (including quantities and any notes such as “no sugar”), the order
              total, and how you chose to pay (for example, cash, Telebirr, CBE, or card).
            </li>
            <li>
              <strong className="text-[#4E342E]">Receipt photos (optional).</strong> For card or
              online payments, a staff member may capture a photo of the payment receipt to
              verify the payment. This is optional and only stored when provided.
            </li>
            <li>
              <strong className="text-[#4E342E]">Staff and admin accounts.</strong> We store the
              names and roles of our own staff, together with login credentials (PINs and
              passwords) that are stored in a protected (hashed) form — never as plain text.
            </li>
            <li>
              <strong className="text-[#4E342E]">Basic technical information.</strong> Like most
              websites, our server processes standard technical details needed to deliver pages
              to your device (such as your IP address and browser type).
            </li>
          </ul>
        </Section>

        <Section title="3. What we do NOT collect">
          We do not run advertising, analytics, or tracking. We do not collect or store your
          payment card number — we only record the method used to pay. Unless you provide it in
          a review, we do not collect your email address or phone number.
        </Section>

        <Section title="4. Why and how we use this information">
          <ul className="list-disc pl-5 space-y-2">
            <li>To take, prepare, and deliver your order to the correct table.</li>
            <li>To display customer reviews on the website.</li>
            <li>To verify payments and keep accurate business records.</li>
            <li>To let our staff and the owner sign in and manage the menu, prices, and orders.</li>
          </ul>
        </Section>

        <Section title="5. How we protect your information">
          Your information is stored in a secure database that is accessed only by the website
          behind the scenes — not directly by visitors. Staff login credentials are stored
          using password hashing, and login attempts are rate-limited to help prevent
          unauthorized access. Only authorized staff can access the management dashboard.
        </Section>

        <Section title="6. Third-party services actually used">
          This website uses an embedded Google Maps view to show our location. The English and
          Amharic language setting is provided directly by this website and is saved only in your
          browser. When the map loads, Google may apply its own privacy practices. We do not share
          your order or review information with Google.
        </Section>

        <Section title="7. How long we keep information">
          We keep order and review information for as long as it is needed to operate the
          business. Receipt photos attached to paid bills are automatically cleared after about
          30 days, while the order record itself is retained.
        </Section>

        <Section title="8. Do we share your information?">
          We do not sell your information, and we do not share it with other businesses except
          the Google services described above that help display part of the website.
        </Section>

        <Section title="9. Contact us about privacy">
          If you have any questions or concerns about your privacy, you can reach us at:
          <ul className="list-none space-y-1 mt-2 text-[#4E342E]">
            <li>📞 0911 065 022</li>
            <li>📍 Town Square Building, 22 Square, Djibouti Street, Bole, Addis Ababa, Ethiopia</li>
          </ul>
        </Section>

        <div className="mt-10 pt-6 border-t border-[#C9A227]/30 flex items-center justify-between text-xs">
          <Link href="/" className="text-[#4E342E] font-bold hover:text-[#C9A227] transition">
            ← Back to Homepage
          </Link>
          <Link href="/terms" className="text-[#4E342E] font-bold hover:text-[#C9A227] transition">
            Terms of Service →
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
