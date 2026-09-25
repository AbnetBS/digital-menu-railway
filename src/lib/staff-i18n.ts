"use client";

import { createElement, Fragment, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { STAFF_AM, type StaffPhrase } from "@/lib/staff-dictionary";

/**
 * STAFF LANGUAGE LAYER (owner's request, Sept 2026): English ⇄ አማርኛ for the
 * admin panel, the reports, the shift report and every crew screen (waiter,
 * buna, cashier, kitchen, barista, juice).
 *
 *   • The choice is PER DEVICE (localStorage `fana_staff_lang`): the kitchen
 *     tablet can read Amharic while the owner's laptop stays in English. It is
 *     separate from the guest menu's language, so a waiter testing the guest
 *     menu on her phone never flips her own work screen by accident.
 *   • Every fixed label comes from the hand-written dictionary in
 *     `staff-dictionary.ts`: no machine translation, works fully offline.
 *   • Anything NOT in the dictionary stays English. A missing word can never
 *     turn into garbage.
 *   • Data is never translated here: staff names, order numbers, table names,
 *     prices and "ETB" pass through untouched (they arrive as `{vars}`).
 */

export type StaffLang = "en" | "am";
export type { StaffPhrase };

export const STAFF_LANG_KEY = "fana_staff_lang";
const STAFF_LANG_EVENT = "fana-staff-lang-change";

/** Fallback when the browser blocks storage (private mode): lasts for this page. */
let memoryLang: StaffLang | null = null;

export function getStaffLang(): StaffLang {
  if (typeof window === "undefined") return "en";
  try {
    const stored = window.localStorage.getItem(STAFF_LANG_KEY);
    if (stored === "am" || stored === "en") return stored;
  } catch {
    /* storage blocked: fall through to the in-memory choice */
  }
  return memoryLang ?? "en";
}

export function setStaffLang(lang: StaffLang): void {
  memoryLang = lang;
  try {
    window.localStorage.setItem(STAFF_LANG_KEY, lang);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
  // Same-tab listeners (the storage event only reaches OTHER tabs).
  window.dispatchEvent(new CustomEvent(STAFF_LANG_EVENT, { detail: lang }));
}

function subscribeStaffLang(cb: () => void): () => void {
  window.addEventListener(STAFF_LANG_EVENT, cb);
  window.addEventListener("storage", cb); // other tabs on the same device
  return () => {
    window.removeEventListener(STAFF_LANG_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

/** Reactive staff language. The server render is always English. */
export function useStaffLang(): StaffLang {
  return useSyncExternalStore(subscribeStaffLang, getStaffLang, () => "en" as const);
}

/* ───────────────────────── translation core ───────────────────────── */

export type StaffVars = Record<string, string | number | null | undefined>;

function fill(template: string, vars?: StaffVars, lang: StaffLang = "en"): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const v = vars[key];
    if (v === undefined || v === null) return whole;
    return lang === "am" && typeof v === "string" ? staffDate("am", v) : String(v);
  });
}

/** Gregorian month names as Amharic readers write them. */
const AM_MONTHS: Record<string, string> = {
  Jan: "ጃንዋሪ",
  Feb: "ፌብሩዋሪ",
  Mar: "ማርች",
  Apr: "ኤፕሪል",
  May: "ሜይ",
  Jun: "ጁን",
  Jul: "ጁላይ",
  Aug: "ኦገስት",
  Sep: "ሴፕቴምበር",
  Oct: "ኦክቶበር",
  Nov: "ኖቬምበር",
  Dec: "ዲሴምበር",
};

/**
 * Dates such as "24 Sep 2026" (the app's formatDayMonthYear / fmtDayKey
 * shape) get Amharic month names in Amharic. Only the full "day month year"
 * pattern is touched, so a staff member called "Jan" or "May" keeps the name.
 */
export function staffDate(lang: StaffLang, text: string): string {
  if (lang !== "am" || !text) return text;
  return text.replace(/\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})\b/g, (_, d: string, m: string, y: string) => `${d} ${AM_MONTHS[m]} ${y}`);
}

const DICT: Record<string, string> = STAFF_AM;

/** Fixed label → current language. Unknown phrases stay English. */
export function staffT(lang: StaffLang, en: StaffPhrase, vars?: StaffVars): string {
  const template = lang === "am" ? DICT[en] || en : en;
  return fill(template, vars, lang);
}

interface CompiledTemplate {
  re: RegExp;
  keys: string[];
  am: string;
  weight: number;
}
let compiled: CompiledTemplate[] | null = null;

function compileTemplates(): CompiledTemplate[] {
  const out: CompiledTemplate[] = [];
  for (const [en, am] of Object.entries(DICT)) {
    if (!en.includes("{")) continue;
    const keys: string[] = [];
    let literal = 0;
    const source = en
      .split(/(\{\w+\})/)
      .map((part) => {
        const m = /^\{(\w+)\}$/.exec(part);
        if (m) {
          keys.push(m[1]);
          return "(.+?)";
        }
        literal += part.length;
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("");
    // A template that is ONLY placeholders would match everything: skip it.
    if (literal < 2) continue;
    out.push({ re: new RegExp(`^${source}$`, "s"), keys, am, weight: literal });
  }
  // Most specific (longest fixed text) first.
  return out.sort((a, b) => b.weight - a.weight);
}

/**
 * DYNAMIC text built elsewhere in English (report flags like "2 line(s) never
 * marked done", server messages, audit lines "Tea: quantity 2 → 3"). Exact
 * dictionary hits first, then the dictionary's `{placeholder}` templates are
 * matched in reverse and refilled in Amharic. No match → the English original.
 */
export function staffTd(lang: StaffLang, text: string | null | undefined): string {
  const s = String(text ?? "");
  if (lang !== "am" || !s.trim()) return s;
  const exact = DICT[s] || DICT[s.trim()];
  if (exact) return exact;
  compiled ??= compileTemplates();
  for (const t of compiled) {
    const m = t.re.exec(s);
    if (!m) continue;
    const vars: StaffVars = {};
    t.keys.forEach((k, i) => {
      vars[k] = m[i + 1];
    });
    return fill(t.am, vars, lang);
  }
  return staffDate(lang, s);
}

export type RichRenderers = Record<string, (chunk: string) => ReactNode>;

/**
 * Sentences with styled words inside: the dictionary marks them with
 * `<b>…</b>`-style tags so the Amharic word order can differ from English.
 *   rich("Tap a <g>green table</g> to order", { g: (s) => <span>{s}</span> })
 */
export function staffRich(lang: StaffLang, en: StaffPhrase, renderers: RichRenderers, vars?: StaffVars): ReactNode[] {
  const template = lang === "am" ? DICT[en] || en : en;
  const out: ReactNode[] = [];
  const re = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    if (m.index > last) out.push(fill(template.slice(last, m.index), vars, lang));
    const render = renderers[m[1]];
    const chunk = fill(m[2], vars, lang);
    out.push(createElement(Fragment, { key: `rich-${i++}` }, render ? render(chunk) : chunk));
    last = re.lastIndex;
  }
  if (last < template.length) out.push(fill(template.slice(last), vars, lang));
  return out;
}

/** Numbers stay in Latin digits with thousands separators in BOTH languages. */
export function staffNum(n: number | string | null | undefined): string {
  const v = Number(n || 0);
  return (Number.isFinite(v) ? v : 0).toLocaleString("en-US");
}

/** Money always reads "1,250 ETB" (the owner's rule: ETB is never translated). */
export function staffEtb(n: number | string | null | undefined): string {
  return `${staffNum(n)} ETB`;
}

export interface StaffI18n {
  lang: StaffLang;
  am: boolean;
  /** Fixed label from the dictionary (typed: an unknown phrase fails typecheck). */
  t: (en: StaffPhrase, vars?: StaffVars) => string;
  /** Dynamic English text (flags, server messages): dictionary or unchanged. */
  td: (text: string | null | undefined) => string;
  /** A sentence with styled parts, see staffRich. */
  rich: (en: StaffPhrase, renderers: RichRenderers, vars?: StaffVars) => ReactNode[];
  /** A formatted date ("24 Sep 2026") with the month name in the current language. */
  date: (text: string) => string;
}

export function makeStaffI18n(lang: StaffLang): StaffI18n {
  return {
    lang,
    am: lang === "am",
    t: (en, vars) => staffT(lang, en, vars),
    td: (text) => staffTd(lang, text),
    rich: (en, renderers, vars) => staffRich(lang, en, renderers, vars),
    date: (text) => staffDate(lang, text),
  };
}

/** The hook every staff screen uses. Re-renders when the language changes. */
export function useStaffT(): StaffI18n {
  const lang = useStaffLang();
  return useMemo(() => makeStaffI18n(lang), [lang]);
}

/**
 * For code outside a component body: alerts, confirms and toasts built in
 * callbacks, and small helper functions (a status badge, a money line) that
 * only run on the logged-in screens, i.e. after hydration.
 */
export function staffNow(): StaffI18n {
  return makeStaffI18n(getStaffLang());
}

/**
 * Translate at the moment the code runs. For toasts, alerts, confirms and
 * notifications built inside event handlers, effects and timers: it always
 * uses the language chosen right now (no stale closure, no hook dependency).
 */
export function tNow(en: StaffPhrase, vars?: StaffVars): string {
  return staffT(getStaffLang(), en, vars);
}

/**
 * Marks an English label in a constant table as a dictionary phrase. It is
 * an identity function: the typecheck fails if the phrase has no Amharic
 * entry, and screens translate the value where they render it (`t(x.label)`).
 */
export function phrase<const T extends StaffPhrase>(en: T): T {
  return en;
}
