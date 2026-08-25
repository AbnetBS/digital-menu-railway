/**
 * Brand guard — the business is "Fana Cafe & Restaurant".
 * Repairs every historical caching layer (bad seed defaults, wrong admin edits,
 * earlier naive regex that produced "Fana Cafe Cafe") to one correct name.
 */
export const BRAND_NAME = "Fana Cafe & Restaurant";

export function fixBrandText(v: unknown): string {
  if (typeof v !== "string" || !v) return v as string;
  let out = v
    .replace(/FanaQueen(\s+Cafe)?/gi, "Fana Cafe") // FanaQueen / FanaQueen Cafe → Fana Cafe
    .replace(/\bCafe\s+Cafe(\s+Cafe)?\b/gi, "Cafe") // Cafe Cafe (Cafe) → Cafe
    .replace(/\s{2,}/g, " ")
    .trim();
  // When the WHOLE value is just the cafe name (e.g. DB cafe_name = "Fana Cafe"
  // or "FANA CAFE"), upgrade it to the full legal name "Fana Cafe & Restaurant".
  if (/^fana\s+cafe$/i.test(out)) out = BRAND_NAME;
  // Already-complete name, possibly with different casing/spacing → normalize once.
  if (/^fana\s+cafe\s*&\s+restaurant$/i.test(out)) out = BRAND_NAME;
  return out;
}

/**
 * Address guard — the cafe is located in TOWN SQUARE BUILDING (22 Square,
 * Bole), not "Golagul Building". Old seeds, old admin edits and cached DB rows
 * may still carry the wrong building name; every display path runs through
 * this so the address is always correct.
 */
export function fixAddressText(v: unknown): string {
  if (typeof v !== "string" || !v) return v as string;
  return v
    .replace(/golagul\s+building/gi, "Town Square Building")
    .replace(/golagul\s+bldg\.?/gi, "Town Square Bldg")
    .replace(/golagul/gi, "Town Square") // any remaining bare mention
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Combined normalizer for serving text content to clients. */
export function fixSiteText(v: unknown): string {
  return fixAddressText(fixBrandText(v));
}
