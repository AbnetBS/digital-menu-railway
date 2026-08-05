/**
 * Brand guard — the business is "Fana Cafe & Restaurant".
 * Repairs every historical caching layer (bad seed defaults, wrong admin edits,
 * earlier naive regex that produced "Fana Cafe Cafe") to one correct name.
 */
export function fixBrandText(v: unknown): string {
  if (typeof v !== "string" || !v) return v as string;
  return v
    .replace(/FanaQueen(\s+Cafe)?/gi, "Fana Cafe") // FanaQueen / FanaQueen Cafe → Fana Cafe
    .replace(/\bCafe\s+Cafe(\s+Cafe)?\b/gi, "Cafe") // Cafe Cafe (Cafe) → Cafe
    .replace(/\s{2,}/g, " ")
    .trim();
}
