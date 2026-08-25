"use client";

import { Coffee, MapPin, Phone, Clock, Lock, Heart, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { SiteSettings } from "@/types";
import { fixBrandText } from "@/lib/brand";
import { useT, useAutoT } from "@/lib/i18n";

interface FooterProps {
  settings: SiteSettings;
  onOpenAdmin: () => void;
  isAdminLoggedIn: boolean;
}

export default function Footer({ settings, onOpenAdmin, isAdminLoggedIn }: FooterProps) {
  const t = useT();
  const tx = useAutoT();
  const cafeName = fixBrandText(settings.cafe_name || "Fana Cafe & Restaurant");
  const tagline = settings.tagline || "Where Great Coffee Meets Beautiful Moments";
  const phone = settings.phone || "0911 065 022";
  const address = settings.address || "Addis Ababa, Ethiopia";
  const plusCode = settings.plus_code || "2Q7Q+W2";
  const openingHours = settings.opening_hours || "Open Daily Until 8:30 PM";

  return (
    <footer className="bg-[#1C120F] text-stone-300 pt-16 pb-8 border-t border-[#C9A227]/30 text-xs sm:text-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-10 pb-12 border-b border-stone-800">
          
          {/* Col 1: Brand */}
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#C9A227] to-[#8C6D18] flex items-center justify-center text-[#2C1B17] font-bold">
                <Coffee className="w-5 h-5 text-[#2C1B17]" />
              </div>
              <span className="text-2xl font-serif font-black text-amber-100 tracking-wider">
                {tx(cafeName)}
              </span>
            </div>

            <p className="text-stone-400 leading-relaxed font-light text-xs">
              {tx(tagline)}
            </p>

            <div className="flex items-center gap-2 pt-1 text-xs text-[#C9A227] font-semibold">
              <MapPin className="w-4 h-4" />
              <span>Addis Ababa • Plus Code: {plusCode}</span>
            </div>
          </div>

          {/* Col 2: Navigation Shortcuts */}
          <div className="space-y-3">
            <h4 className="text-amber-100 font-serif font-bold uppercase tracking-wider text-xs border-b border-[#C9A227]/30 pb-2">
              {t("footer_quick_links")}
            </h4>
            <ul className="space-y-2 text-stone-400">
              <li><a href="#hero" className="hover:text-[#C9A227] transition">{t("fl_home")}</a></li>
              <li><a href="#about" className="hover:text-[#C9A227] transition">{t("fl_about")}</a></li>
              <li><a href="#why-us" className="hover:text-[#C9A227] transition">{t("fl_why")}</a></li>
              <li><a href="#menu" className="hover:text-[#C9A227] transition">{t("fl_menu")}</a></li>
              <li><a href="#services" className="hover:text-[#C9A227] transition">{t("fl_services")}</a></li>
              <li><a href="#gallery" className="hover:text-[#C9A227] transition">{t("fl_gallery")}</a></li>
            </ul>
          </div>

          {/* Col 3: Hours & Info */}
          <div className="space-y-3">
            <h4 className="text-amber-100 font-serif font-bold uppercase tracking-wider text-xs border-b border-[#C9A227]/30 pb-2">
              {t("footer_hours")}
            </h4>
            <div className="space-y-2 text-stone-400 text-xs">
              <p className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-[#C9A227] shrink-0" />
                <span>{tx(openingHours)}</span>
              </p>
              <p className="flex items-center gap-2">
                <Phone className="w-4 h-4 text-[#C9A227] shrink-0" />
                <a href={`tel:${phone.replace(/\s+/g, "")}`} className="hover:text-amber-200 font-bold">
                  {phone}
                </a>
              </p>
              <p className="flex items-center gap-2">
                <MapPin className="w-4 h-4 text-[#C9A227] shrink-0" />
                <span>{tx(address)}</span>
              </p>
            </div>
          </div>

          {/* Col 4: Admin Live Control */}
          <div className="space-y-3">
            <h4 className="text-amber-100 font-serif font-bold uppercase tracking-wider text-xs border-b border-[#C9A227]/30 pb-2">
              Website Admin
            </h4>
            <p className="text-stone-400 text-xs leading-relaxed">
              Protected live control panel to edit menu items, prices, reservations, orders, and content.
            </p>

            <button
              onClick={onOpenAdmin}
              className={`w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-xs font-bold transition shadow-md ${
                isAdminLoggedIn
                  ? "bg-emerald-600 text-white hover:bg-emerald-500"
                  : "bg-white/10 hover:bg-white/20 text-amber-200 border border-amber-500/30"
              }`}
            >
              {isAdminLoggedIn ? (
                <>
                  <ShieldCheck className="w-4 h-4 text-amber-300" />
                  <span>Open Live Admin Panel</span>
                </>
              ) : (
                <>
                  <Lock className="w-4 h-4 text-[#C9A227]" />
                  <span>Admin Password Access</span>
                </>
              )}
            </button>
          </div>

        </div>

        {/* Bottom copyright + developer signature */}
        <div className="pt-8 flex flex-col sm:flex-row items-center justify-between text-stone-500 text-xs gap-3">
          <div className="flex flex-col sm:flex-row items-center gap-2 sm:gap-4">
            <p>© {new Date().getFullYear()} {cafeName} Addis Ababa. {t("footer_rights")}</p>
            <div className="flex items-center gap-3">
              <Link href="/privacy" className="hover:text-[#C9A227] transition">
                {t("footer_privacy")}
              </Link>
              <span className="text-stone-700">•</span>
              <Link href="/terms" className="hover:text-[#C9A227] transition">
                {t("footer_terms")}
              </Link>
            </div>
          </div>
          <a
            href="tel:+251919081802"
            className="flex items-center gap-2 bg-[#C9A227]/10 hover:bg-[#C9A227]/20 border border-[#C9A227]/30 px-3.5 py-2 rounded-xl transition"
          >
            <Heart className="w-4 h-4 text-[#C9A227] fill-[#C9A227]" />
            <span className="font-extrabold text-[#C9A227] tracking-wide">AB Web</span>
            <span className="text-stone-400">📞 +251 91 908 1802</span>
          </a>
        </div>

      </div>
    </footer>
  );
}
