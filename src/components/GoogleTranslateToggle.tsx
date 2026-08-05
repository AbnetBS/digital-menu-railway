"use client";

import { useEffect, useState } from "react";
import { Globe, ArrowLeftRight } from "lucide-react";

type Lang = "en" | "am";

declare global {
  interface Window {
    googleTranslateElementInit?: () => void;
    google?: any;
  }
}

function setGoogTransCookie(lang: Lang) {
  const value = lang === "am" ? "/en/am" : "/en/en";
  document.cookie = `googtrans=${value}; path=/`;
  document.cookie = `googtrans=${value}; path=/; domain=.${location.hostname}`;
}

function readGoogLang(): Lang {
  return document.cookie.includes("googtrans=/en/am") ? "am" : "en";
}

/**
 * Floating 🌐 English ⇄ አማህርኛ toggle that activates Google Translate
 * for the FULL page (menu, descriptions, prices labels, reviews...).
 * Persists across page loads via the googtrans cookie.
 */
export default function GoogleTranslateToggle({ className = "", pill = true }: { className?: string; pill?: boolean }) {
  const [lang, setLang] = useState<Lang>("en");
  const [loaded, setLoaded] = useState(false);

  // Load Google's script once; strip its default toolbar visuals.
  useEffect(() => {
    setLang(readGoogLang());
    if (document.getElementById("google-translate-script")) {
      setLoaded(true);
      return;
    }

    window.googleTranslateElementInit = () => {
      if (window.google?.translate?.TranslateElement) {
        new window.google.translate.TranslateElement(
          {
            pageLanguage: "en",
            includedLanguages: "am,en",
            layout: window.google.translate.TranslateElement.InlineLayout.SIMPLE,
            autoDisplay: false,
          },
          "google_translate_element"
        );
        setLoaded(true);
      }
    };

    const script = document.createElement("script");
    script.id = "google-translate-script";
    script.src = "//translate.google.com/translate_a/element.js?cb=googleTranslateElementInit";
    script.async = true;
    document.head.appendChild(script);

    // Hide Google's banner, logos and combo box — we drive with our own pill instead
    const style = document.createElement("style");
    style.textContent = `
      body { top: 0 !important; }
      .goog-te-banner-frame, .goog-logo-link, .goog-te-gadget-icon, .goog-te-combo,
      .goog-te-balloon-frame, #goog-gt-tt, .skiptranslate.goog-te-gadget { display: none !important; }
      .goog-te-combo { display: none !important; }
      body > .skiptranslate { display: none !important; }
    `;
    document.head.appendChild(style);

    const s = document.createElement("script");
    document.body.appendChild(s);
  }, []);

  const switchLanguage = (target: Lang) => {
    setGoogTransCookie(target);
    setLang(target);
    // Google Translate mutates the DOM; a reload keeps React stable and applies the translation
    window.location.reload();
  };

  if (!pill) {
    return (
      <button
        onClick={() => switchLanguage(lang === "am" ? "en" : "am")}
        className={`inline-flex items-center gap-1.5 text-[11px] font-bold text-stone-400 hover:text-[#C9A227] transition ${className}`}
        title={lang === "am" ? "Switch to English" : "በአማርኛ ያንብቡ"}
      >
        <Globe className="w-3.5 h-3.5" />
        <span>{lang === "am" ? "EN" : "እኛ"}</span>
      </button>
    );
  }

  return (
    <>
      {/* Google Translate mounts here (invisible) */}
      <div id="google_translate_element" className="hidden" />

      <button
        onClick={() => switchLanguage(lang === "am" ? "en" : "am")}
        className={`fixed bottom-5 right-5 z-40 flex items-center gap-2 bg-[#2C1B17] text-white border-2 border-[#C9A227] px-4 py-2.5 rounded-full shadow-2xl hover:scale-105 transition-transform ${className}`}
        aria-label={lang === "am" ? "Switch to English" : "በአማርኛ ያንብቡ"}
      >
        <Globe className="w-4 h-4 text-[#C9A227]" />
        <span className="text-xs font-black tracking-wider">
          {lang === "am" ? "English" : "አማርኛ"}
        </span>
        <ArrowLeftRight className="w-3.5 h-3.5 text-[#C9A227]" />
      </button>
    </>
  );
}
