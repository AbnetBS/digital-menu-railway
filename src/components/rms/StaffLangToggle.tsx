"use client";

import { useEffect } from "react";
import { Languages } from "lucide-react";
import { setStaffLang, useStaffLang } from "@/lib/staff-i18n";

/**
 * English ⇄ አማርኛ switch for the staff screens (admin, reports, shift report,
 * waiter, buna, cashier, kitchen, barista, juice).
 *
 *   • per device: saved in localStorage, so each tablet/phone keeps its own;
 *   • instant: no reload, no network, the dictionary ships with the page;
 *   • the button always names the OTHER language, so it can be found even by
 *     someone who cannot read the current one.
 */
export default function StaffLangToggle({ className = "", compact = false }: { className?: string; compact?: boolean }) {
  const lang = useStaffLang();
  const isAm = lang === "am";

  // Screen readers and the browser's own hyphenation follow <html lang>.
  useEffect(() => {
    const el = document.documentElement;
    const before = el.lang;
    el.lang = lang;
    return () => {
      el.lang = before || "en";
    };
  }, [lang]);

  const label = isAm ? "Switch to English" : "ወደ አማርኛ ቀይር";
  return (
    <button
      type="button"
      onClick={() => setStaffLang(isAm ? "en" : "am")}
      className={`no-print shrink-0 inline-flex items-center gap-1.5 rounded-xl border border-[#C9A227]/60 bg-black/30 text-amber-100 hover:bg-[#C9A227]/20 transition active:scale-95 font-black ${
        compact ? "px-2 py-1.5 text-[11px]" : "px-3 py-2 text-xs"
      } ${className}`}
      title={label}
      aria-label={label}
      data-staff-lang-toggle={lang}
    >
      <Languages className={compact ? "w-3.5 h-3.5 text-[#C9A227]" : "w-4 h-4 text-[#C9A227]"} aria-hidden="true" />
      <span>{isAm ? "English" : "አማርኛ"}</span>
    </button>
  );
}
