import { createHash } from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { translations } from "@/db/schema";
import { acceptTranslation } from "@/lib/translate-guard";

/**
 * GOOGLE-POWERED AUTO-TRANSLATION (server-side)
 * ─────────────────────────────────────────────
 * Translates owner-managed content (menu items the owner adds, categories,
 * announcements, settings texts) from English to Amharic, SERVER-SIDE:
 *
 *   ✅ no Google script in the browser  → nothing pops up over the menu
 *   ✅ no DOM rewriting by Google       → React/order flow can never break
 *   ✅ works on any host (VPS/Coolify)  → it's a plain server-side fetch
 *
 * Every unique string is translated once, then cached in two layers: process
 * memory + the `translations` DB table.
 *
 * FIXES (owner, Sept 2026: "wrong Amharic like 'semin', some text never
 * translates"):
 *   • Every answer passes translate-guard.ts BEFORE it is cached or returned:
 *     English echoed back, Latin romanisation, HTML error pages, entities or
 *     changed numbers are rejected, and the guest sees the English original.
 *   • Bad rows already in the caches are dropped when read (and the database
 *     row deleted), and a fresh good answer REPLACES an old row
 *     (onConflictDoUpdate) instead of being ignored.
 *   • A single-text request used to never translate: Google answers one `q`
 *     with a bare string, which the parser threw away.
 *   • When Google refuses (HTTP 429 "unusual traffic" HTML page, 403, 5xx) a
 *     circuit breaker pauses live calls for a while instead of hammering it;
 *     the texts come back as `pending` so the browser retries later instead of
 *     giving up for the whole session.
 *   • Set GOOGLE_TRANSLATE_API_KEY to use the official Cloud Translation API
 *     (v2) instead of the free public endpoint, which Google rate-limits.
 */

const API_BASE = process.env.TRANSLATE_API_BASE || "https://translate.googleapis.com";
const ENDPOINT = `${API_BASE}/translate_a/t`;
const OFFICIAL_BASE = process.env.TRANSLATE_OFFICIAL_API_BASE || "https://translation.googleapis.com";
const OFFICIAL_ENDPOINT = `${OFFICIAL_BASE}/language/translate/v2`;

/** Target languages the public API may request (extend if more are added). */
export const SUPPORTED_TX_LANGS = new Set(["am"]);

const MAX_TEXT_LEN = 1500; // longer strings are returned untranslated
const MAX_URL_CHARS = 4000; // conservative GET URL budget per chunk
const MAX_TEXTS_PER_CHUNK = 30;
const MAX_CHUNKS_PER_CALL = 6; // ≤ 180 strings per request
const FETCH_TIMEOUT_MS = 9000;
/** A text Google keeps answering badly is not asked again for this long. */
const REJECT_TTL_MS = 6 * 60 * 60 * 1000;
/** Circuit breaker: first pause, doubling on every new refusal, capped. */
const BREAKER_BASE_MS = 60 * 1000;
const BREAKER_MAX_MS = 30 * 60 * 1000;

/* ─────────── in-process state (hot path, skips the DB entirely) ─────────── */

interface Breaker {
  openUntil: number;
  strikes: number;
}
const globalForTx = globalThis as typeof globalThis & {
  __fanaTxMem?: Map<string, string>;
  __fanaTxReject?: Map<string, number>;
  __fanaTxBreaker?: Breaker;
};
const memCache: Map<string, string> = globalForTx.__fanaTxMem ?? new Map();
globalForTx.__fanaTxMem = memCache;
const rejected: Map<string, number> = globalForTx.__fanaTxReject ?? new Map();
globalForTx.__fanaTxReject = rejected;
const breaker: Breaker = globalForTx.__fanaTxBreaker ?? { openUntil: 0, strikes: 0 };
globalForTx.__fanaTxBreaker = breaker;

const hashText = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 48);

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

/**
 * Parse Google's response defensively; it varies between shapes:
 *   "ሰላም"                          one q  (bare string: was dropped before)
 *   ["ሰላም", "ሻይ"]                  several q, source language given
 *   [["ሰላም","en"], ["ሻይ","en"]]    several q, source language detected
 *   [[["ሰላም","en"]]]              one q, wrapped once more
 *   { "Hello": "ሰላም" }              rare map variant
 * Anything else, or a count that does not match, → [] (keep English).
 */
export function parseGoogleResponse(data: unknown, expected: number): string[] {
  if (typeof data === "string") return expected === 1 ? [data] : [];
  const out: string[] = [];
  if (Array.isArray(data)) {
    // One q wrapped as [[text, lang]] or [[[text, lang]]]
    if (expected === 1 && data.length === 1 && Array.isArray(data[0]) && Array.isArray(data[0][0])) {
      const inner = data[0][0];
      return typeof inner[0] === "string" ? [inner[0]] : [];
    }
    // One q answered as [text, lang] (two strings, second a language code)
    if (expected === 1 && data.length === 2 && typeof data[0] === "string" && typeof data[1] === "string" && /^[a-z]{2,3}(-[A-Za-z]+)?$/.test(data[1])) {
      return [data[0]];
    }
    for (const entry of data) {
      if (typeof entry === "string") out.push(entry);
      else if (Array.isArray(entry) && typeof entry[0] === "string") out.push(entry[0]);
      else return [];
    }
  } else if (data && typeof data === "object") {
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (typeof value === "string") out.push(value);
    }
  }
  return out.length === expected ? out : [];
}

type ChunkResult = { texts: string[]; refused: boolean; retryAfterMs?: number };

/** HTTP answers that mean "Google is refusing us for now", not "bad text". */
const isRefusal = (status: number) => status === 403 || status === 429 || status >= 500;

function retryAfterMs(res: Response): number | undefined {
  const h = Number(res.headers.get("retry-after"));
  return Number.isFinite(h) && h > 0 ? Math.min(h * 1000, BREAKER_MAX_MS) : undefined;
}

async function readJson(res: Response): Promise<unknown | typeof NOT_JSON> {
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    return NOT_JSON; // e.g. Google's "Sorry... unusual traffic" HTML page
  }
}
const NOT_JSON = Symbol("not-json");

async function publicTranslateChunk(lang: string, texts: string[]): Promise<ChunkResult> {
  const params = new URLSearchParams({ client: "gtx", sl: "en", tl: lang });
  for (const text of texts) params.append("q", text);
  try {
    const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FanaMenu/1.0)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return { texts: [], refused: isRefusal(res.status), retryAfterMs: retryAfterMs(res) };
    const data = await readJson(res);
    if (data === NOT_JSON) return { texts: [], refused: true };
    return { texts: parseGoogleResponse(data, texts.length), refused: false };
  } catch {
    return { texts: [], refused: true }; // network blocked / timeout
  }
}

/** Official Cloud Translation API v2 (used when GOOGLE_TRANSLATE_API_KEY is set). */
async function officialTranslateChunk(lang: string, texts: string[], key: string): Promise<ChunkResult> {
  try {
    const res = await fetch(`${OFFICIAL_ENDPOINT}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // format "text": otherwise the API HTML-escapes the answer ("&#39;").
      body: JSON.stringify({ q: texts, source: "en", target: lang, format: "text" }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return { texts: [], refused: isRefusal(res.status), retryAfterMs: retryAfterMs(res) };
    const data = (await readJson(res)) as { data?: { translations?: Array<{ translatedText?: unknown }> } } | typeof NOT_JSON;
    if (data === NOT_JSON) return { texts: [], refused: true };
    const list = data?.data?.translations;
    if (!Array.isArray(list) || list.length !== texts.length) return { texts: [], refused: false };
    return { texts: list.map((t) => (typeof t?.translatedText === "string" ? t.translatedText : "")), refused: false };
  } catch {
    return { texts: [], refused: true };
  }
}

function translateChunk(lang: string, texts: string[]): Promise<ChunkResult> {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY?.trim();
  return key ? officialTranslateChunk(lang, texts, key) : publicTranslateChunk(lang, texts);
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
      // A good answer REPLACES an old (possibly bad) row.
      .onConflictDoUpdate({
        target: [translations.lang, translations.sourceHash],
        set: { translatedText: sql`excluded.translated_text`, sourceText: sql`excluded.source_text` },
      });
  } catch {
    // cache write failed (rare): translations still return fine this request
  }
}

async function dropBadRows(lang: string, hashes: string[]): Promise<void> {
  if (!hashes.length) return;
  try {
    await db.delete(translations).where(and(eq(translations.lang, lang), inArray(translations.sourceHash, hashes)));
  } catch {
    /* next read tries again */
  }
}

export interface TranslateOutcome {
  /** source → Amharic, only answers that passed the guard. */
  translations: Record<string, string>;
  /** Texts that could not be translated RIGHT NOW (Google refused / timed out): ask again later. */
  pending: string[];
  /** When the pending texts may be asked for again. */
  retryAfterSeconds?: number;
}

/** Test hook: forget every in-process cache and close the breaker. */
export function resetTranslateStateForTests(): void {
  memCache.clear();
  rejected.clear();
  breaker.openUntil = 0;
  breaker.strikes = 0;
}

/**
 * Translate a batch of unique English strings to `lang`.
 * Missing from `translations` = keep the English original (the site never
 * breaks); listed in `pending` = worth asking again later.
 */
export async function translateBatchDetailed(lang: string, input: string[]): Promise<TranslateOutcome> {
  const result: Record<string, string> = {};
  const outcome: TranslateOutcome = { translations: result, pending: [] };
  if (!SUPPORTED_TX_LANGS.has(lang)) return outcome;

  const unique = [...new Set(input.map((s) => String(s).trim()).filter(Boolean))];
  const translatable = unique.filter(isTranslatable);
  const now = Date.now();

  const need: string[] = [];
  for (const text of translatable) {
    const key = `${lang}::${hashText(text)}`;
    const hit = memCache.get(key);
    const good = hit ? acceptTranslation(text, hit, lang) : "";
    if (good) {
      result[text] = good;
      continue;
    }
    if (hit) memCache.delete(key); // a bad answer cached by an older release
    const until = rejected.get(key);
    if (until && until > now) continue; // Google answered badly recently: English
    if (until) rejected.delete(key);
    need.push(text);
  }
  if (!need.length) return outcome;

  // 1) DB cache layer (bad rows are deleted, then translated again)
  try {
    const hashes = need.map((t) => hashText(t));
    const rows = await db
      .select({ sourceHash: translations.sourceHash, sourceText: translations.sourceText, translatedText: translations.translatedText })
      .from(translations)
      .where(and(eq(translations.lang, lang), inArray(translations.sourceHash, hashes)));
    const found = new Set<string>();
    const bad: string[] = [];
    for (const row of rows) {
      const good = acceptTranslation(row.sourceText, row.translatedText, lang);
      if (!good) {
        bad.push(row.sourceHash);
        continue;
      }
      result[row.sourceText] = good;
      memCache.set(`${lang}::${row.sourceHash}`, good);
      found.add(row.sourceText);
    }
    await dropBadRows(lang, bad);
    for (let i = need.length - 1; i >= 0; i--) if (found.has(need[i])) need.splice(i, 1);
  } catch {
    // DB unavailable → continue with live translation only
  }
  if (!need.length) return outcome;

  // 2) live translation, unless Google refused us a moment ago
  if (breaker.openUntil > now) {
    outcome.pending = need;
    outcome.retryAfterSeconds = Math.ceil((breaker.openUntil - now) / 1000);
    return outcome;
  }

  const fresh: Array<[string, string]> = [];
  const chunks = buildChunks(need);
  const asked = new Set(chunks.flat());
  const settled = await Promise.all(chunks.map((chunk) => translateChunk(lang, chunk)));
  let refused = false;
  let waitMs = 0;
  chunks.forEach((chunk, ci) => {
    const { texts, refused: no, retryAfterMs: wait } = settled[ci];
    if (no) {
      refused = true;
      waitMs = Math.max(waitMs, wait || 0);
      outcome.pending.push(...chunk);
      return;
    }
    chunk.forEach((source, i) => {
      const key = `${lang}::${hashText(source)}`;
      const good = acceptTranslation(source, texts[i], lang);
      if (!good) {
        // Answered, but not real Amharic (or no answer for this text):
        // show English and do not ask again for a while.
        rejected.set(key, now + REJECT_TTL_MS);
        return;
      }
      result[source] = good;
      fresh.push([source, good]);
      memCache.set(key, good);
    });
  });
  // Texts beyond the per-call chunk budget: ask again in the next request.
  for (const text of need) if (!asked.has(text)) outcome.pending.push(text);

  if (refused) {
    breaker.strikes = Math.min(breaker.strikes + 1, 10);
    const pause = Math.max(waitMs, Math.min(BREAKER_BASE_MS * 2 ** (breaker.strikes - 1), BREAKER_MAX_MS));
    breaker.openUntil = now + pause;
    outcome.retryAfterSeconds = Math.ceil(pause / 1000);
  } else if (chunks.length) {
    breaker.strikes = 0;
  }
  if (!outcome.retryAfterSeconds && outcome.pending.length) outcome.retryAfterSeconds = 5;

  await persistToDb(lang, fresh);
  return outcome;
}

/** Map-only form (kept for callers that do not care about `pending`). */
export async function translateBatch(lang: string, input: string[]): Promise<Record<string, string>> {
  return (await translateBatchDetailed(lang, input)).translations;
}
