import { createHash } from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { translations } from "@/db/schema";

/**
 * GOOGLE-POWERED AUTO-TRANSLATION (server-side)
 * ─────────────────────────────────────────────
 * Translates owner-managed content (menu items the owner adds, categories,
 * announcements, settings texts) from English to Amharic using Google
 * Translate's public batch endpoint — the same engine as the Google Translate
 * widget, but running SERVER-SIDE:
 *
 *   ✅ no Google script in the browser  → nothing pops up over the menu
 *   ✅ no DOM rewriting by Google       → React/order flow can never break
 *   ✅ works on any host (VPS/Coolify)  → it's a plain server-side fetch
 *
 * Every unique string is translated once, then cached forever in two layers:
 * process memory + the `translations` DB table. Repeat loads are instant,
 * free, and never touch Google again.
 */

const API_BASE = process.env.TRANSLATE_API_BASE || "https://translate.googleapis.com";
const ENDPOINT = `${API_BASE}/translate_a/t`;

/** Target languages the public API may request (extend if more are added). */
export const SUPPORTED_TX_LANGS = new Set(["am"]);

const MAX_TEXT_LEN = 1500; // longer strings are returned untranslated
const MAX_URL_CHARS = 4000; // conservative GET URL budget per chunk
const MAX_TEXTS_PER_CHUNK = 30;
const MAX_CHUNKS_PER_CALL = 6; // ≤ 180 strings per request
const FETCH_TIMEOUT_MS = 9000;

/* ─────────── in-process cache (hot path — skips the DB entirely) ─────────── */

const globalForTx = globalThis as typeof globalThis & {
  __fanaTxMem?: Map<string, string>;
};
const memCache: Map<string, string> = globalForTx.__fanaTxMem ?? new Map();
globalForTx.__fanaTxMem = memCache;

const hashText = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 48);

/** Already Amharic / no Latin letters → nothing to translate. */
export function isTranslatable(text: string): boolean {
  if (!text || text.length > MAX_TEXT_LEN) return false;
  if (/[\u1200-\u137F]/.test(text)) return false; // Ge'ez script already
  return /[a-z]/i.test(text); // must contain at least one Latin letter
}

/** Group texts into URL-safe chunks for Google's batch endpoint. */
export function buildChunks(texts: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const text of texts) {
    const encLen = encodeURIComponent(text).length + 3; // "&q="
    if (current.length >= MAX_TEXTS_PER_CHUNK || (current.length > 0 && currentLen + encLen > MAX_URL_CHARS)) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(text);
    currentLen += encLen;
  }
  if (current.length) chunks.push(current);
  return chunks.slice(0, MAX_CHUNKS_PER_CALL);
}

/** Parse Google's response defensively — it varies between shapes. */
export function parseGoogleResponse(data: unknown, expected: number): string[] {
  const out: string[] = [];
  if (Array.isArray(data)) {
    for (const entry of data) {
      if (typeof entry === "string") out.push(entry);
      else if (Array.isArray(entry) && typeof entry[0] === "string") out.push(entry[0]);
    }
  } else if (data && typeof data === "object") {
    // rare variant: { "source text": "translated text", ... }
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (typeof value === "string") out.push(value);
    }
  }
  return out.length === expected ? out : [];
}

async function googleTranslateChunk(lang: string, texts: string[]): Promise<string[]> {
  const params = new URLSearchParams({ client: "gtx", sl: "en", tl: lang });
  for (const text of texts) params.append("q", text);
  try {
    const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FanaMenu/1.0)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    return parseGoogleResponse(data, texts.length);
  } catch {
    return []; // network blocked / timeout / bad shape → caller falls back to English
  }
}

async function persistToDb(lang: string, pairs: Array<[string, string]>): Promise<void> {
  if (!pairs.length) return;
  try {
    await db
      .insert(translations)
      .values(
        pairs.map(([source, translated]) => ({
          lang,
          sourceHash: hashText(source),
          sourceText: source,
          translatedText: translated,
        }))
      )
      .onConflictDoNothing();
  } catch {
    // cache write failed (rare) — translations still return fine this request
  }
}

/**
 * Translate a batch of unique English strings to `lang`.
 * Returns a map source → translated (missing = could not translate; the
 * caller simply keeps the English original — the site never breaks).
 */
export async function translateBatch(lang: string, input: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  if (!SUPPORTED_TX_LANGS.has(lang)) return result;

  // de-dupe + filter
  const unique = [...new Set(input.map((s) => String(s).trim()).filter(Boolean))];
  const translatable = unique.filter(isTranslatable);
  // pass through anything untranslatable untouched (caller shows original)

  const need: string[] = [];
  for (const text of translatable) {
    const key = `${lang}::${hashText(text)}`;
    const hit = memCache.get(key);
    if (hit) result[text] = hit;
    else need.push(text);
  }
  if (!need.length) return result;

  // 1) DB cache layer
  try {
    const hashes = need.map((t) => hashText(t));
    const rows = await db
      .select({ sourceHash: translations.sourceHash, sourceText: translations.sourceText, translatedText: translations.translatedText })
      .from(translations)
      .where(and(eq(translations.lang, lang), inArray(translations.sourceHash, hashes)));
    const foundTexts = new Set<string>();
    for (const row of rows) {
      result[row.sourceText] = row.translatedText;
      memCache.set(`${lang}::${row.sourceHash}`, row.translatedText);
      foundTexts.add(row.sourceText);
    }
    for (let i = need.length - 1; i >= 0; i--) if (foundTexts.has(need[i])) need.splice(i, 1);
  } catch {
    // DB unavailable → continue with live translation only
  }
  if (!need.length) return result;

  // 2) live Google translation (chunked), then cache
  const fresh: Array<[string, string]> = [];
  const chunks = buildChunks(need);
  const settled = await Promise.all(chunks.map((chunk) => googleTranslateChunk(lang, chunk)));
  chunks.forEach((chunk, ci) => {
    const translated = settled[ci];
    if (!translated.length) return; // chunk failed → keep English for those
    chunk.forEach((source, i) => {
      const value = (translated[i] || "").trim();
      if (!value || value === source) return;
      result[source] = value;
      fresh.push([source, value]);
      memCache.set(`${lang}::${hashText(source)}`, value);
    });
  });
  await persistToDb(lang, fresh);
  return result;
}
