"use client";

import { Coffee, Heart, Sparkles, CheckCircle2, ShieldCheck } from "lucide-react";
import { SiteSettings } from "@/types";

interface AboutProps {
  settings: SiteSettings;
}

export default function AboutSection({ settings }: AboutProps) {
  const aboutTitle = settings.about_title || "Experience Modern Ethiopian Hospitality";
  const aboutDesc =
    settings.about_description ||
    "Ethiopia is recognized as the birthplace of Arabica coffee, and coffee is more than a beverage—it's part of our culture and hospitality. At Fana Cafe, every detail is centered around comfort, flavor, and warm service. Enjoy carefully prepared coffee, freshly made meals, refreshing beverages, and a calm environment that lets you slow down and enjoy the moment.";

  return (
    <section id="about" className="py-20 bg-[#FAF6F0] relative overflow-hidden">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          
          {/* Text Content */}
          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#4E342E]/10 border border-[#4E342E]/20 text-[#4E342E] text-xs font-bold uppercase tracking-widest">
              <Coffee className="w-3.5 h-3.5 text-[#C9A227]" />
              <span>Discover Our Story</span>
            </div>

            <h2 className="text-3xl sm:text-4xl font-serif font-bold text-[#2C1B17] leading-tight">
              {aboutTitle}
            </h2>

            <p className="text-stone-700 text-base sm:text-lg leading-relaxed font-normal">
              {aboutDesc}
            </p>

            {/* Highlights List */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
              
              <div className="flex items-start gap-3 p-3.5 rounded-xl bg-white border border-[#C9A227]/20 shadow-sm">
                <CheckCircle2 className="w-5 h-5 text-[#C9A227] shrink-0 mt-0.5" />
                <div>
                  <h4 className="font-bold text-[#2C1B17] text-sm">Authentic Coffee Culture</h4>
                  <p className="text-xs text-stone-600 mt-0.5">Brewed from fresh, high-altitude Ethiopian beans.</p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3.5 rounded-xl bg-white border border-[#C9A227]/20 shadow-sm">
                <CheckCircle2 className="w-5 h-5 text-[#C9A227] shrink-0 mt-0.5" />
                <div>
                  <h4 className="font-bold text-[#2C1B17] text-sm">Fresh Made Daily</h4>
                  <p className="text-xs text-stone-600 mt-0.5">Sandwiches, local dishes, and 100% natural juices.</p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3.5 rounded-xl bg-white border border-[#C9A227]/20 shadow-sm">
                <CheckCircle2 className="w-5 h-5 text-[#C9A227] shrink-0 mt-0.5" />
                <div>
                  <h4 className="font-bold text-[#2C1B17] text-sm">Calm & Welcoming Ambience</h4>
                  <p className="text-xs text-stone-600 mt-0.5">Designed for remote work, meetings, or relaxing.</p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3.5 rounded-xl bg-white border border-[#C9A227]/20 shadow-sm">
                <CheckCircle2 className="w-5 h-5 text-[#C9A227] shrink-0 mt-0.5" />
                <div>
                  <h4 className="font-bold text-[#2C1B17] text-sm">Dine-In, Takeaway & Delivery</h4>
                  <p className="text-xs text-stone-600 mt-0.5">Enjoy your favorites in-house or brought to your door.</p>
                </div>
              </div>

            </div>

            {/* Quote Badge */}
            <div className="p-4 rounded-2xl bg-gradient-to-r from-[#4E342E] to-[#2C1B17] text-white flex items-center gap-4 shadow-xl border-l-4 border-[#C9A227]">
              <div className="w-12 h-12 rounded-full bg-[#C9A227]/20 flex items-center justify-center shrink-0 text-[#C9A227]">
                <Heart className="w-6 h-6 fill-[#C9A227]" />
              </div>
              <div>
                <p className="text-sm italic font-light text-amber-100">
                  "At Fana Cafe, every cup is poured with warmth, and every guest is treated like long-time family."
                </p>
                <p className="text-xs text-[#C9A227] font-bold mt-1 uppercase tracking-wider">
                  — The Fana Hospitality Team
                </p>
              </div>
            </div>

          </div>

          {/* Visual Grid */}
          <div className="grid grid-cols-2 gap-4 relative">
            <div className="space-y-4">
              <div className="rounded-3xl overflow-hidden shadow-2xl border-2 border-[#C9A227]/20 group">
                <img
                  src="https://images.pexels.com/photos/36794595/pexels-photo-36794595.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=800&w=600"
                  alt="Traditional Ethiopian Coffee Jebena"
                  className="w-full h-64 object-cover group-hover:scale-105 transition-transform duration-500"
                />
              </div>
              <div className="bg-[#4E342E] text-amber-100 p-5 rounded-3xl shadow-xl border border-[#C9A227]/30 text-center">
                <span className="text-3xl font-serif font-extrabold text-[#C9A227] block">100%</span>
                <span className="text-xs uppercase font-bold tracking-wider block mt-1 text-amber-200">
                  Single-Origin Ethiopian Beans
                </span>
              </div>
            </div>

            <div className="space-y-4 pt-8">
              <div className="bg-[#C9A227] text-[#2C1B17] p-5 rounded-3xl shadow-xl text-center">
                <span className="text-3xl font-serif font-black block">Addis</span>
                <span className="text-xs uppercase font-extrabold tracking-wider block mt-1">
                  Heart of the City
                </span>
              </div>
              <div className="rounded-3xl overflow-hidden shadow-2xl border-2 border-[#C9A227]/20 group">
                <img
                  src="https://images.pexels.com/photos/6763235/pexels-photo-6763235.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=800&w=600"
                  alt="Fana Macchiato"
                  className="w-full h-64 object-cover group-hover:scale-105 transition-transform duration-500"
                />
              </div>
            </div>
          </div>

        </div>

      </div>
    </section>
  );
}
