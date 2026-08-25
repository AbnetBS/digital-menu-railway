"use client";

import { UtensilsCrossed, QrCode, Users, Briefcase, ArrowUpRight, ShieldCheck } from "lucide-react";
import { useT, useAutoT } from "@/lib/i18n";

export default function ServicesSection() {
  const t = useT();
  const tx = useAutoT();
  const services = [
    {
      icon: UtensilsCrossed,
      title: "Dine-In",
      desc: "Enjoy freshly prepared meals, aromatic macchiato, and fresh juices in our cozy, ambient dining space in Addis Ababa.",
      badge: "In-House Hospitality",
    },
    {
      icon: QrCode,
      title: "QR Digital Menu",
      desc: "Every table has a QR code. Scan it to browse our full menu with photos, prices and descriptions right from your phone.",
      badge: "Contactless Browsing",
    },
    {
      icon: Users,
      title: "Personal Waiter Service",
      desc: "Our waiters take your order tableside, add your personal notes (No Sugar, Extra Mayo...), and your bill stays open until you pay.",
      badge: "Tableside Care",
    },
    {
      icon: Briefcase,
      title: "Business & Meetings",
      desc: "A quiet, professional space with comfortable seating and great coffee for productive team catch-ups and meetings.",
      badge: "Productive Vibe",
    },
  ];

  return (
    <section id="services" className="py-20 bg-[#2C1B17] text-white relative">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#C9A227]/20 border border-[#C9A227]/40 text-[#C9A227] text-xs font-bold uppercase tracking-widest mb-3">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>{tx("Tailored Hospitality")}</span>
          </div>
          <h2 className="text-3xl sm:text-5xl font-serif font-bold text-amber-100">{t("sec_how")}</h2>
          <p className="text-stone-300 text-sm sm:text-base mt-3 font-light">
            {tx("A modern table-service experience: scan, browse, order through your waiter, pay when you're done.")}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {services.map((srv, idx) => {
            const Icon = srv.icon;
            return (
              <div
                key={idx}
                className="bg-[#3D2314]/80 backdrop-blur-md p-6 rounded-3xl border border-[#C9A227]/20 hover:border-[#C9A227]/60 transition-all duration-300 flex flex-col justify-between group hover:-translate-y-1 shadow-xl"
              >
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#C9A227] to-[#B8921F] flex items-center justify-center text-[#2C1B17] shadow-lg group-hover:scale-110 transition-transform">
                      <Icon className="w-6 h-6" />
                    </div>
                    <span className="text-[10px] uppercase font-bold text-[#C9A227] bg-[#C9A227]/10 px-2 py-0.5 rounded border border-[#C9A227]/20">
                      {tx(srv.badge)}
                    </span>
                  </div>
                  <h3 className="text-xl font-serif font-bold text-stone-100 group-hover:text-[#C9A227] transition-colors">
                    {tx(srv.title)}
                  </h3>
                  <p className="text-stone-300 text-xs mt-2 leading-relaxed font-light">{tx(srv.desc)}</p>
                </div>
                <div className="mt-6 pt-3 border-t border-stone-800 text-xs font-extrabold text-[#C9A227] flex items-center justify-between">
                  <span>{tx("Always available")}</span>
                  <ArrowUpRight className="w-4 h-4 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
