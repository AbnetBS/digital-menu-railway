"use client";

import { useState } from "react";
import { ChevronDown, HelpCircle } from "lucide-react";

export default function FaqSection() {
  const [openIdx, setOpenIdx] = useState<number | null>(0);

  const faqs = [
    {
      q: "What are Fana Cafe's opening hours?",
      a: "Fana Cafe is open daily until 8:30 PM in Addis Ababa. Operating hours may vary slightly during Ethiopian public holidays. Call 0911 065 022 for holiday hours.",
    },
    {
      q: "Can I order foods and drinks for delivery or takeaway?",
      a: "Yes! You can order online directly through this website or by phone. We offer takeaway pick-up as well as direct delivery to your home or office across Addis Ababa.",
    },
    {
      q: "How do I reserve a table in advance?",
      a: "You can reserve a table by clicking the 'Reserve Table' button on this page. Choose your preferred date, time, party size, and table setting (Indoor, Garden, Quiet Corner, or Window View). Your table will be held for you.",
    },
    {
      q: "What are Fana Cafe's most popular menu items?",
      a: "Our signature Fana Macchiato and Jebena Ethiopian Coffee are loved by local coffee connoisseurs. For food and juices, our Chicken Club Sandwich, Chechebsa, and thick multi-layered Mixed Fruit Juice (Spris) are customer favorites.",
    },
    {
      q: "Is Fana Cafe suitable for remote work or business meetings?",
      a: "Absolutely! Fana Cafe provides a calm, comfortable environment with relaxed seating, ideal lighting, and great coffee—making it a favorite spot for business meetings, study sessions, and remote work.",
    },
    {
      q: "Are vegetarian, vegan, and fasting options available?",
      a: "Yes, we serve traditional Ethiopian fasting dishes (like Shiro and Chechebsa), fresh fruit juices, teas, and vegan pastries clearly tagged on our menu.",
    },
  ];

  return (
    <section id="faq" className="py-20 bg-[#2C1B17] text-white relative">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        
        {/* Header */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#C9A227]/20 border border-[#C9A227]/40 text-[#C9A227] text-xs font-bold uppercase tracking-widest mb-3">
            <HelpCircle className="w-3.5 h-3.5" />
            <span>Got Questions?</span>
          </div>

          <h2 className="text-3xl sm:text-4xl font-serif font-bold text-amber-100">
            Frequently Asked Questions
          </h2>
        </div>

        {/* Accordion List */}
        <div className="space-y-4">
          {faqs.map((faq, idx) => {
            const isOpen = openIdx === idx;
            return (
              <div
                key={idx}
                className="bg-[#3D2314]/80 rounded-2xl border border-[#C9A227]/20 overflow-hidden transition"
              >
                <button
                  onClick={() => setOpenIdx(isOpen ? null : idx)}
                  className="w-full p-5 text-left flex items-center justify-between gap-4 focus:outline-none"
                >
                  <span className="font-serif font-bold text-sm sm:text-base text-amber-100">
                    {faq.q}
                  </span>
                  <ChevronDown
                    className={`w-5 h-5 text-[#C9A227] transition-transform duration-300 shrink-0 ${
                      isOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {isOpen && (
                  <div className="px-5 pb-5 text-xs sm:text-sm text-stone-300 leading-relaxed font-light border-t border-stone-800 pt-3">
                    {faq.a}
                  </div>
                )}
              </div>
            );
          })}
        </div>

      </div>
    </section>
  );
}
