"use client";

import { useState } from "react";
import { MapPin, Phone, Clock, Navigation, Copy, Check, ExternalLink, Calendar } from "lucide-react";
import { SiteSettings } from "@/types";
import { useT, useAutoT } from "@/lib/i18n";

interface LocationProps {
  settings: SiteSettings;
}

export default function LocationSection({ settings }: LocationProps) {
  const t = useT();
  const tx = useAutoT();
  const [copiedCode, setCopiedCode] = useState(false);

  const phone = settings.phone || "0911 065 022";
  const address = settings.address || "Town Square Building, 22 Square, Djibouti Street, Bole, Addis Ababa, Ethiopia";
  const plusCode = settings.plus_code || "2Q7Q+W2 Addis Ababa";
  const openingHours = settings.opening_hours || "Open Daily Until 8:30 PM (Hours may vary during holidays)";

  const handleCopyPlusCode = () => {
    navigator.clipboard.writeText(plusCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const mapDirectionsUrl = "https://www.google.com/maps/place/Fana+cafe/@9.0148457,38.7875868,17z";

  return (
    <section id="contact" className="py-20 bg-[#FAF6F0] relative">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#4E342E]/10 border border-[#4E342E]/20 text-[#4E342E] text-xs font-bold uppercase tracking-widest mb-3">
            <MapPin className="w-3.5 h-3.5 text-[#C9A227]" />
            <span>{tx("Exact Google Maps Location")}</span>
          </div>

          <h2 className="text-3xl sm:text-5xl font-serif font-bold text-[#2C1B17]">
            {t("sec_location")}
          </h2>

          <p className="text-stone-600 text-sm sm:text-base mt-3">
            {tx("Located at Town Square Building, 22 Square on Djibouti Street in Bole, Addis Ababa. Drop in for coffee or reserve a table.")}
          </p>
        </div>

        {/* Location Info Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-stretch">
          
          {/* Card 1: Address & Plus Code */}
          <div className="bg-white rounded-3xl p-6 sm:p-8 border border-[#C9A227]/30 shadow-lg flex flex-col justify-between space-y-6">
            <div className="space-y-4">
              <div className="w-12 h-12 rounded-2xl bg-[#4E342E] text-[#C9A227] flex items-center justify-center shadow-md">
                <MapPin className="w-6 h-6" />
              </div>

              <div>
                <h3 className="text-xl font-serif font-bold text-[#2C1B17]">{tx("Town Square Building Location")}</h3>
                <p className="text-stone-600 text-sm mt-1 leading-relaxed">{tx(address)}</p>
              </div>

              <div className="bg-[#FAF6F0] p-4 rounded-2xl border border-[#C9A227]/20 space-y-2">
                <span className="text-[10px] uppercase font-extrabold text-[#4E342E] tracking-widest block">
                  {tx("Google Maps Plus Code")}
                </span>
                <div className="flex items-center justify-between">
                  <span className="font-mono font-bold text-[#2C1B17] text-sm sm:text-base">{plusCode}</span>
                  <button
                    onClick={handleCopyPlusCode}
                    className="inline-flex items-center gap-1 text-xs font-bold text-[#C9A227] bg-white border border-[#C9A227]/40 px-2.5 py-1 rounded-lg hover:bg-amber-50"
                  >
                    {copiedCode ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedCode ? tx("Copied") : tx("Copy")}</span>
                  </button>
                </div>
              </div>
            </div>

            <a
              href={mapDirectionsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full inline-flex items-center justify-center gap-2 bg-[#4E342E] hover:bg-[#3D2314] text-amber-200 font-bold text-xs uppercase py-3.5 rounded-2xl shadow transition"
            >
              <Navigation className="w-4 h-4 text-[#C9A227]" />
              <span>{tx("Open in Google Maps App")}</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>

          {/* Card 2: Hours & Direct Phone */}
          <div className="bg-white rounded-3xl p-6 sm:p-8 border border-[#C9A227]/30 shadow-lg flex flex-col justify-between space-y-6">
            <div className="space-y-4">
              <div className="w-12 h-12 rounded-2xl bg-[#4E342E] text-[#C9A227] flex items-center justify-center shadow-md">
                <Clock className="w-6 h-6" />
              </div>

              <div>
                <h3 className="text-xl font-serif font-bold text-[#2C1B17]">{tx("Opening Hours & Phone")}</h3>
                <p className="text-stone-600 text-xs mt-1">{tx("Open daily for breakfast, lunch, juices, and dinner.")}</p>
              </div>

              <div className="space-y-3 pt-2">
                <div className="flex items-start gap-3 p-3 bg-amber-50/50 rounded-xl border border-amber-200/60">
                  <Clock className="w-4 h-4 text-[#C9A227] shrink-0 mt-0.5" />
                  <div>
                    <span className="text-xs font-bold text-[#2C1B17] block">{tx("Daily Schedule")}</span>
                    <span className="text-xs text-stone-600">{tx(openingHours)}</span>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-3 bg-amber-50/50 rounded-xl border border-amber-200/60">
                  <Phone className="w-4 h-4 text-[#C9A227] shrink-0 mt-0.5" />
                  <div>
                    <span className="text-xs font-bold text-[#2C1B17] block">{tx("Direct Phone")}</span>
                    <a href={`tel:${phone.replace(/\s+/g, "")}`} className="text-xs font-bold text-[#4E342E] hover:underline">
                      {phone}
                    </a>
                  </div>
                </div>
              </div>
            </div>

            <a
              href="#menu"
              className="w-full inline-flex items-center justify-center gap-2 bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-extrabold text-xs uppercase py-3.5 rounded-2xl shadow transition"
            >
              <Calendar className="w-4 h-4" />
              <span>{tx("Browse Our Menu")}</span>
            </a>
          </div>

          {/* Card 3: Precise Coordinates Google Maps Embed */}
          <div className="bg-white rounded-3xl border border-[#C9A227]/30 shadow-lg overflow-hidden flex flex-col min-h-[320px]">
            <div className="bg-[#4E342E] text-amber-100 px-5 py-3 text-xs font-bold flex items-center justify-between border-b border-[#C9A227]/30">
              <span className="flex items-center gap-1.5">
                <MapPin className="w-4 h-4 text-[#C9A227]" /> 22 Square Embed Map
              </span>
              <span className="text-[10px] text-amber-300">9.0148457, 38.7875868</span>
            </div>
            <div className="flex-1 w-full bg-stone-200 relative">
              <iframe
                title="Fana Cafe 22 Square Google Maps Location"
                src="https://maps.google.com/maps?q=9.0148457,38.7875868&hl=es&z=17&output=embed"
                className="w-full h-full min-h-[280px] border-0"
                loading="lazy"
                allowFullScreen
              />
            </div>
          </div>

        </div>

      </div>
    </section>
  );
}
