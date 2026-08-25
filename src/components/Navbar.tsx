"use client";

import { useState } from "react";
import { Lock, Menu, X, Phone, ShieldCheck } from "lucide-react";
import { SiteSettings } from "@/types";
import { fixBrandText } from "@/lib/brand";
import { useT, useAutoT } from "@/lib/i18n";

interface NavbarProps {
  settings: SiteSettings;
  onOpenAdmin: () => void;
  isAdminLoggedIn: boolean;
}

export default function Navbar({ settings, onOpenAdmin, isAdminLoggedIn }: NavbarProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showAnnouncement, setShowAnnouncement] = useState(true);
  const t = useT();
  const tx = useAutoT();

  const phone = settings.phone || "0911 065 022";
  const cafeName = fixBrandText(settings.cafe_name || "Fana Cafe & Restaurant");
  const announcement = settings.announcement || "☕ Welcome to Fana Cafe & Restaurant!";

  const navLinks = [
    { label: t("nav_home"), href: "#hero" },
    { label: t("nav_about"), href: "#about" },
    { label: t("nav_menu"), href: "#menu" },
    { label: t("nav_services"), href: "#services" },
    { label: t("nav_gallery"), href: "#gallery" },
    { label: t("nav_reviews"), href: "#reviews" },
    { label: t("nav_find_us"), href: "#contact" },
  ];

  const handleNavClick = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    e.preventDefault();
    setMobileMenuOpen(false);
    const element = document.querySelector(href);
    if (element) {
      const offset = 80;
      const elementPosition = element.getBoundingClientRect().top - document.body.getBoundingClientRect().top;
      window.scrollTo({ top: elementPosition - offset, behavior: "smooth" });
    }
  };

  return (
    <header className="sticky top-0 z-50 w-full transition-all duration-300">
      {showAnnouncement && announcement && (
        <div className="bg-[#2C1B17] text-[#FAF6F0] px-4 py-2 text-xs md:text-sm font-medium flex items-center justify-between border-b border-[#C9A227]/30">
          <div className="flex items-center gap-2 max-w-6xl mx-auto overflow-hidden">
            <span className="inline-block bg-[#C9A227] text-[#2C1B17] px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider shrink-0">
              22 Square Bole
            </span>
            <span className="truncate">{tx(announcement)}</span>
          </div>
          <button onClick={() => setShowAnnouncement(false)} className="text-amber-200/70 hover:text-white ml-2 shrink-0" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <nav className="glass-dark border-b border-[#C9A227]/20 shadow-xl px-4 lg:px-8 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          {/* Logo */}
          <a href="#hero" onClick={(e) => handleNavClick(e, "#hero")} className="flex items-center gap-3 group">
            <img
              src={String(settings.logo_url || "/logo.png")}
              alt={cafeName}
              className="w-11 h-11 rounded-full object-contain bg-white border-2 border-[#C9A227] shadow-md group-hover:scale-105 transition-transform p-0.5"
            />
            <div className="flex flex-col">
              <span className="text-xl font-black tracking-wider text-white font-serif group-hover:text-[#C9A227] transition-colors">
                {tx(cafeName)}
              </span>
              <span className="text-[10px] text-[#C9A227] tracking-widest uppercase font-semibold">
                Town Square Bldg, Addis Ababa
              </span>
            </div>
          </a>

          {/* Desktop links */}
          <div className="hidden lg:flex items-center space-x-5 text-xs xl:text-sm font-medium text-stone-200">
            {navLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                onClick={(e) => handleNavClick(e, link.href)}
                className="hover:text-[#C9A227] transition-colors py-1 relative after:content-[''] after:absolute after:bottom-0 after:left-0 after:w-0 after:h-[2px] after:bg-[#C9A227] hover:after:w-full after:transition-all"
              >
                {link.label}
              </a>
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center space-x-2">
            <a
              href={`tel:${phone.replace(/\s+/g, "")}`}
              className="hidden xl:flex items-center gap-1.5 text-xs text-[#FAF6F0] bg-white/10 hover:bg-white/20 px-3 py-2 rounded-full border border-white/10"
            >
              <Phone className="w-3.5 h-3.5 text-[#C9A227]" />
              <span className="font-semibold">{phone}</span>
            </a>

            <button
              onClick={onOpenAdmin}
              className={`p-2 rounded-full transition flex items-center gap-1 text-xs font-semibold ${
                isAdminLoggedIn
                  ? "bg-emerald-600 text-white shadow-md hover:bg-emerald-500 px-3"
                  : "text-amber-200/80 hover:text-amber-300 hover:bg-white/10"
              }`}
              title={isAdminLoggedIn ? "Open Admin Dashboard" : "Admin Login"}
            >
              {isAdminLoggedIn ? (
                <>
                  <ShieldCheck className="w-4 h-4 text-amber-300" />
                  <span className="hidden md:inline">Admin</span>
                </>
              ) : (
                <Lock className="w-5 h-5 text-[#C9A227]" />
              )}
            </button>

            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="lg:hidden p-2 text-stone-200 hover:text-amber-400"
              aria-label="Menu"
            >
              {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>
        </div>

        {/* Mobile drawer */}
        {mobileMenuOpen && (
          <div className="lg:hidden mt-3 pt-3 border-t border-amber-900/40 space-y-3 pb-3">

          </div>
        )}
      </nav>
    </header>
  );
}
