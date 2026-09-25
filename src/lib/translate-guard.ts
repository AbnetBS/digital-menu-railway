/**
 * TRANSLATION GUARD (owner, Sept 2026: "some Amharic is wrong, like 'semin',
 * and some text does not translate at all").
 *
 * The automatic translator (Google, see translate-server.ts) sometimes answers
 * with something that is NOT Amharic: the English sentence sent back
 * unchanged, a Latin romanisation ("semin"), an HTML error page, "&#39;"
 * entities, a truncated string, or numbers that changed. Before this guard
 * such answers were cached forever (browser + database) and shown to guests.
 *
 * One rule set, used in THREE places so they can never disagree:
 *   • the server, before caching a fresh answer and when reading its caches;
 *   • the browser, when it receives an answer and when it loads its cache;
 *   • scripts/verify-translation-guard.ts (fixtures of every bad shape).
 *
 * If an answer fails, the guest simply sees the owner's English text.
 * Pure module: no "use client", no server imports.
 */

/** Ge'ez (Ethiopic) letters: main block, supplement, extended, extended-A. */
const ETHIOPIC_RE = /[\u1200-\u139F\u2D80-\u2DDF\uAB00-\uAB2F]/g;
const LATIN_RE = /[A-Za-z]/g;
/** At least this share of the letters must be Ge'ez ("Coca-Cola ጠርሙስ" is fine). */
export const MIN_ETHIOPIC_SHARE = 0.4;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** "&#39;" → "'", "&amp;" → "&" ... (Google's gtx endpoint HTML-escapes). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    const c = code.toLowerCase();
    if (c.startsWith("#x")) {
      const n = parseInt(c.slice(2), 16);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    if (c.startsWith("#")) {
      const n = parseInt(c.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return NAMED_ENTITIES[c] ?? whole;
  });
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Share of letters that are Ge'ez (0 when there are no letters at all). */
export function ethiopicShare(s: string): number {
  const eth = (s.match(ETHIOPIC_RE) || []).length;
  const lat = (s.match(LATIN_RE) || []).length;
  return eth + lat === 0 ? 0 : eth / (eth + lat);
}

/**
 * The cleaned Amharic when `translated` is a real translation of `source`,
 * otherwise "" (= show the English original instead).
 */
export function acceptTranslation(source: string, translated: unknown, lang = "am"): string {
  if (lang !== "am" || typeof translated !== "string") return "";
  const src = squash(String(source || ""));
  const out = squash(decodeEntities(translated));
  if (!src || !out) return "";
  if (out.includes("\uFFFD")) return ""; // broken encoding
  if (/<\/?[a-z][^>]*>/i.test(out) || /&(#x?[0-9a-f]+|[a-z]+);/i.test(out)) return ""; // HTML page / double-escaped
  if (out.length > src.length * 4 + 20) return ""; // an error page, not a translation
  if (out.toLowerCase() === src.toLowerCase()) return ""; // sent back unchanged
  if (ethiopicShare(out) < MIN_ETHIOPIC_SHARE) return ""; // Latin garbage ("semin")
  // Prices, sizes, table numbers must survive exactly.
  for (const n of src.match(/\d+(?:[.,]\d+)*/g) || []) {
    if (!out.includes(n)) return "";
  }
  // "ETB" is never translated (owner's rule).
  if (/\bETB\b/.test(src) && !/\bETB\b/.test(out)) return "";
  return out;
}

/** True when a stored translation may be shown. */
export function isAcceptableTranslation(source: string, translated: unknown, lang = "am"): boolean {
  return acceptTranslation(source, translated, lang) !== "";
}
