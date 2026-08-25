"use client";

import { Coffee, Calendar, Utensils, Star, MapPin, Clock, ArrowRight, Sparkles } from "lucide-react";
import { SiteSettings } from "@/types";
import { useT, useAutoT } from "@/lib/i18n";

interface HeroProps {
  settings: SiteSettings;
  onOpenMenu: () => void;
  onOpenLocation: () => void;
}

export default function HeroSection({ settings, onOpenMenu, onOpenLocation }: HeroProps) {
  const t = useT();
  const tx = useAutoT();
  const title = settings.hero_title || "Where Great Coffee Meets Beautiful Moments";
  const subtitle =
    settings.hero_subtitle ||
    "A cozy café and restaurant located at Town Square Building, 22 Square (Djibouti Street, Bole, Addis Ababa). Designed for coffee lovers, food enthusiasts, families, and friends.";
  const heroBgImage =
    settings.hero_bg_image ||
    "https://images.pexels.com/photos/16563658/pexels-photo-16563658.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=800&w=1200";
  const openingHours = settings.opening_hours || "Open Daily Until 8:30 PM";

  return (
    <section id="hero" className="relative min-h-[90vh] flex items-center justify-center overflow-hidden py-16 lg:py-24 bg-[#2C1B17]">
      {/* Background Image with Gradient Overlays */}
      <div className="absolute inset-0 z-0">
        <img
          src={heroBgImage}
          alt="Fana Cafe Interior Ambience"
          className="w-full h-full object-cover object-center opacity-40 scale-105 transform hover:scale-100 transition-transform duration-1000 ease-out"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#2C1B17] via-[#2C1B17]/75 to-black/40" />
        <div className="absolute inset-0 bg-radial-gradient from-amber-500/10 via-transparent to-transparent" />
      </div>

      {/* Decorative Floating Lights / Steam Elements */}
      <div className="absolute top-1/4 left-10 w-72 h-72 bg-[#C9A227]/10 rounded-full blur-3xl pointer-events-none animate-ambient-pulse" />
      <div className="absolute bottom-1/3 right-10 w-96 h-96 bg-[#4E342E]/40 rounded-full blur-3xl pointer-events-none" />

      <div className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 text-center text-white">
        
        {/* Status Pills */}
        <div className="inline-flex items-center gap-3 bg-white/10 backdrop-blur-md border border-[#C9A227]/40 px-4 py-2 rounded-full mb-8 shadow-xl text-xs sm:text-sm">
          <span className="flex items-center gap-1.5 font-bold text-amber-300">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
            </span>
            {t("hero_open_daily")}
          </span>
          <span className="text-amber-200/50">•</span>
          <span className="flex items-center gap-1 text-stone-200">
            <Clock className="w-3.5 h-3.5 text-[#C9A227]" />
            {tx(openingHours)}
          </span>
          <span className="hidden sm:inline text-amber-200/50">•</span>
          <span className="hidden sm:flex items-center gap-1 text-stone-200">
            <MapPin className="w-3.5 h-3.5 text-[#C9A227]" />
            22 Square, Town Square Bldg
          </span>
        </div>

        {/* Main Title */}
        <h1 className="text-4xl sm:text-6xl lg:text-7xl font-serif font-black tracking-tight leading-tight text-transparent bg-clip-text bg-gradient-to-r from-amber-100 via-[#F4E8C1] to-amber-200 max-w-4xl mx-auto drop-shadow-md">
          {tx(title)}
        </h1>

        {/* Subtitle */}
        <p className="mt-6 text-base sm:text-xl text-stone-200 max-w-2xl mx-auto leading-relaxed font-light drop-shadow">
          {tx(subtitle)}
        </p>

        {/* Action Call to Action Buttons */}
        <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4 max-w-md mx-auto">
          <a
            href="#menu"
            onClick={(e) => {
              e.preventDefault();
              onOpenMenu();
            }}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-gradient-to-r from-[#C9A227] to-[#B8921F] hover:from-[#d6ad2a] hover:to-[#c29b21] text-[#2C1B17] font-extrabold text-sm uppercase tracking-wider px-8 py-4 rounded-full shadow-xl hover:shadow-amber-500/20 hover:scale-105 transition duration-200"
          >
            <Utensils className="w-4 h-4" />
            <span>{t("hero_cta_menu")}</span>
            <ArrowRight className="w-4 h-4" />
          </a>

          <button
            onClick={onOpenLocation}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/20 text-white font-bold text-sm uppercase tracking-wider px-8 py-4 rounded-full border border-amber-400/30 backdrop-blur-md transition hover:scale-105"
          >
            <MapPin className="w-4 h-4 text-[#C9A227]" />
            <span>{t("hero_cta_location")}</span>
          </button>
        </div>

        {/* Highlights Bar */}
        <div className="mt-16 grid grid-cols-2 md:grid-cols-4 gap-4 text-left max-w-4xl mx-auto">
          
          <div className="bg-[#3D2314]/80 backdrop-blur-md p-4 rounded-2xl border border-[#C9A227]/30 shadow-lg flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#C9A227]/20 flex items-center justify-center text-[#C9A227] shrink-0">
              <Coffee className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs text-stone-400 font-medium">{t("hero_hl_brews")}</p>
              <p className="text-sm font-bold text-stone-100">{t("hero_hl_macchiato")}</p>
            </div>
          </div>

          <div className="bg-[#3D2314]/80 backdrop-blur-md p-4 rounded-2xl border border-[#C9A227]/30 shadow-lg flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#C9A227]/20 flex items-center justify-center text-[#C9A227] shrink-0">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs text-stone-400 font-medium">{t("hero_hl_juices")}</p>
              <p className="text-sm font-bold text-stone-100">{t("hero_hl_spris")}</p>
            </div>
          </div>

          <div className="bg-[#3D2314]/80 backdrop-blur-md p-4 rounded-2xl border border-[#C9A227]/30 shadow-lg flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#C9A227]/20 flex items-center justify-center text-[#C9A227] shrink-0">
              <Utensils className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs text-stone-400 font-medium">{t("hero_hl_dining")}</p>
              <p className="text-sm font-bold text-stone-100">{t("hero_hl_sandwich")}</p>
            </div>
          </div>

          <div className="bg-[#3D2314]/80 backdrop-blur-md p-4 rounded-2xl border border-[#C9A227]/30 shadow-lg flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#C9A227]/20 flex items-center justify-center text-[#C9A227] shrink-0">
              <Star className="w-5 h-5 fill-[#C9A227] text-[#C9A227]" />
            </div>
            <div>
              <p className="text-xs text-stone-400 font-medium">{t("hero_hl_reviews")}</p>
              <p className="text-sm font-bold text-stone-100">3.7 ★ (28 Reviews)</p>
            </div>
          </div>

        </div>

      </div>
    </section>
  );
}
