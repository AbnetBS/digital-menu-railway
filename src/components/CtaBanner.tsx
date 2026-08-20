"use client";

import { Utensils, Phone, MapPin } from "lucide-react";
import { SiteSettings } from "@/types";
import { useT } from "@/lib/i18n";

interface CtaBannerProps {
  settings: SiteSettings;
  onOpenMenu: () => void;
}

export default function CtaBanner({ settings, onOpenMenu }: CtaBannerProps) {
  const t = useT();
  const phone = settings.phone || "0911 065 022";

  return (
    <section className="py-16 bg-gradient-to-r from-[#4E342E] via-[#2C1B17] to-[#3D2314] text-white relative overflow-hidden border-y-2 border-[#C9A227]/40">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 text-center relative z-10 space-y-6">
        <span className="text-[#C9A227] text-xs font-bold uppercase tracking-widest bg-[#C9A227]/10 px-3 py-1 rounded-full border border-[#C9A227]/30">
          {t("cta_badge")}
        </span>

        <h2 className="text-3xl sm:text-5xl font-serif font-black text-amber-100 max-w-3xl mx-auto leading-tight">
          {t("cta_title")}
        </h2>

        <p className="text-stone-300 text-sm sm:text-base max-w-xl mx-auto font-light">
          {t("cta_sub")}
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-2">
          <button
            onClick={onOpenMenu}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-black text-xs uppercase tracking-wider px-8 py-4 rounded-full shadow-2xl hover:scale-105 transition"
          >
            <Utensils className="w-4 h-4" />
            <span>{t("cta_menu")}</span>
          </button>

          <a
            href={`tel:${phone.replace(/\s+/g, "")}`}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/20 text-white font-bold text-xs uppercase tracking-wider px-8 py-4 rounded-full border border-amber-400/30 transition"
          >
            <Phone className="w-4 h-4 text-[#C9A227]" />
            <span>{t("cta_call")} {phone}</span>
          </a>

          <a
            href="#contact"
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-stone-900 text-amber-200 font-bold text-xs uppercase tracking-wider px-6 py-4 rounded-full border border-stone-700 hover:bg-stone-800 transition"
          >
            <MapPin className="w-4 h-4 text-[#C9A227]" />
            <span>{t("cta_find")}</span>
          </a>
        </div>
      </div>
    </section>
  );
}
