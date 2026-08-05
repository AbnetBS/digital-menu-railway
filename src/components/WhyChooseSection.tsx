"use client";

import { Coffee, Utensils, GlassWater, Sparkles, HeartHandshake, Briefcase, Heart, BookOpen, Users, Sun } from "lucide-react";

export default function WhyChooseSection() {
  const features = [
    {
      icon: Coffee,
      title: "Premium Coffee",
      desc: "Freshly prepared Ethiopian coffee including our popular Fana Macchiato, brewed with rich local Arabica beans.",
      badge: "Local Roasts",
    },
    {
      icon: Utensils,
      title: "Delicious Food",
      desc: "From traditional Ethiopian favorites to triple-decker club sandwiches, snacks, and satisfying meals.",
      badge: "Quality Ingredients",
    },
    {
      icon: GlassWater,
      title: "Fresh Juices",
      desc: "Taste naturally refreshing mixed fruit juices (Spris), avocado blends, and seasonal fruit punches.",
      badge: "100% Pure Fruit",
    },
    {
      icon: Sparkles,
      title: "Relaxing Atmosphere",
      desc: "A calm, peaceful setting designed with warm lighting, comfortable seating, and cozy nooks.",
      badge: "Serene Vibe",
    },
    {
      icon: HeartHandshake,
      title: "Friendly Service",
      desc: "Our goal is to provide every guest with authentic Ethiopian hospitality and a memorable dining experience.",
      badge: "Warm Hospitality",
    },
  ];

  const occasions = [
    { icon: Briefcase, label: "Business Meetings" },
    { icon: Heart, label: "Coffee Dates" },
    { icon: BookOpen, label: "Studying & Work" },
    { icon: Users, label: "Family Lunches" },
    { icon: Sun, label: "Catching Up With Friends" },
  ];

  return (
    <section id="why-us" className="py-20 bg-[#2C1B17] text-white relative overflow-hidden">
      {/* Decorative Blur BG */}
      <div className="absolute top-0 right-0 w-96 h-96 bg-[#C9A227]/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-96 h-96 bg-[#4E342E]/50 rounded-full blur-3xl pointer-events-none" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#C9A227]/20 border border-[#C9A227]/40 text-[#C9A227] text-xs font-bold uppercase tracking-widest mb-3">
            <Sparkles className="w-3.5 h-3.5" />
            <span>Why Choose Fana Cafe</span>
          </div>

          <h2 className="text-3xl sm:text-5xl font-serif font-bold text-amber-100">
            Crafted For Quality, Flavor & Comfort
          </h2>

          <p className="text-stone-300 text-base sm:text-lg mt-4 font-light">
            Whether you are stopping by for your morning macchiato or unwinding with fresh juice and desserts, Fana Cafe offers a welcoming setting for every guest.
          </p>
        </div>

        {/* Feature Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feat, idx) => {
            const IconComponent = feat.icon;
            return (
              <div
                key={idx}
                className="bg-[#3D2314]/70 backdrop-blur-md p-6 rounded-3xl border border-[#C9A227]/20 hover:border-[#C9A227]/60 transition-all duration-300 hover:-translate-y-1 group shadow-xl"
              >
                <div className="flex items-center justify-between mb-4">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#C9A227] to-[#B8921F] flex items-center justify-center text-[#2C1B17] shadow-lg group-hover:scale-110 transition-transform">
                    <IconComponent className="w-6 h-6" />
                  </div>
                  <span className="text-[10px] uppercase font-extrabold tracking-widest text-[#C9A227] bg-[#C9A227]/10 px-2.5 py-1 rounded-full border border-[#C9A227]/20">
                    {feat.badge}
                  </span>
                </div>

                <h3 className="text-xl font-serif font-bold text-stone-100 group-hover:text-[#C9A227] transition-colors">
                  {feat.title}
                </h3>

                <p className="text-stone-300 text-sm mt-2 leading-relaxed font-light">
                  {feat.desc}
                </p>
              </div>
            );
          })}

          {/* Occasions Card */}
          <div className="bg-gradient-to-br from-[#4E342E] to-[#2C1B17] p-6 rounded-3xl border-2 border-[#C9A227]/40 shadow-xl flex flex-col justify-between">
            <div>
              <div className="inline-block bg-[#C9A227] text-[#2C1B17] font-extrabold text-[10px] uppercase tracking-wider px-3 py-1 rounded-full mb-3">
                Versatile Environment
              </div>
              <h3 className="text-2xl font-serif font-bold text-amber-100 mb-2">
                Designed For Every Occasion
              </h3>
              <p className="text-stone-300 text-xs leading-relaxed mb-4">
                A place where productivity and relaxation flow naturally together.
              </p>
            </div>

            <div className="space-y-2">
              {occasions.map((occ, oIdx) => {
                const OccIcon = occ.icon;
                return (
                  <div key={oIdx} className="flex items-center gap-2.5 text-xs text-amber-200/90 font-medium bg-black/20 px-3 py-1.5 rounded-lg">
                    <OccIcon className="w-3.5 h-3.5 text-[#C9A227]" />
                    <span>{occ.label}</span>
                  </div>
                );
              })}
            </div>
          </div>

        </div>

      </div>
    </section>
  );
}
