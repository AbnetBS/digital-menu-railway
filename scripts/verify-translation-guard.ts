#!/usr/bin/env tsx
/**
 * Regression guard: AUTOMATIC AMHARIC never shows garbage and never gives up
 * (owner, Sept 2026: "some Amharic is wrong, like 'semin', and some text does
 * not translate at all").
 *
 *   1. translate-guard.ts rejects every bad answer shape (English echoed back,
 *      Latin romanisation like "semin", HTML error pages, entities, broken
 *      characters, changed prices, "ETB" translated away) and accepts real
 *      Amharic, including brand names kept in Latin.
 *   2. The Google parser understands every reply shape, including the bare
 *      string Google sends for a SINGLE text (those were silently dropped).
 *   3. translate-server.ts: bad answers are never returned or cached, a bad
 *      answer already in memory is replaced, Google's 429 "unusual traffic"
 *      HTML page opens a circuit breaker and returns the texts as `pending`
 *      (ask again later), and the official API is used when a key is set.
 *   4. The browser layer (i18n.ts): the old cache with bad answers is dropped,
 *      stored answers are re-checked on load, the cache is read BEFORE the
 *      first lookup, a failed request is retried instead of being marked done,
 *      bad answers are never cached, and each phone sends its own id.
 *
 * No network, no database (DATABASE_URL points at a closed port).
 * Run with: npx tsx scripts/verify-translation-guard.ts   (wired into `npm test`)
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

process.env.DATABASE_URL = "postgresql://nobody:nothing@127.0.0.1:9/none";
delete process.env.GOOGLE_TRANSLATE_API_KEY;

let failures = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
  if (!cond) failures++;
};

type FetchCall = { url: string; init?: RequestInit };
const calls: FetchCall[] = [];
let answer: (url: string, init?: RequestInit) => Response | Promise<Response> = () => new Response("[]");
const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  calls.push({ url: u, init });
  return answer(u, init);
};
(globalThis as unknown as { fetch: typeof fakeFetch }).fetch = fakeFetch;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
const qsOf = (url: string) => new URL(url).searchParams.getAll("q");

async function main() {
  const { acceptTranslation, decodeEntities, ethiopicShare } = await import("../src/lib/translate-guard");

  /* ── 1. the guard ─────────────────────────────────────────────────────── */
  pass("real Amharic is accepted", acceptTranslation("Hot tea", "ትኩስ ሻይ") === "ትኩስ ሻይ");
  pass("brand names may stay Latin inside Amharic", acceptTranslation("Coca-Cola bottle", "Coca-Cola ጠርሙስ ኮካ") !== "");
  pass("entities are decoded, not shown", acceptTranslation("Tea & coffee", "ሻይ &amp; ቡና") === "ሻይ & ቡና" && decodeEntities("&#39;&quot;") === "'\"");
  pass("English sent back unchanged is rejected", acceptTranslation("Macchiato", "Macchiato") === "" && acceptTranslation("Fresh juice", " fresh  JUICE ") === "");
  pass("Latin romanisation ('semin') is rejected", acceptTranslation("North", "semin") === "" && acceptTranslation("Seminar room", "Semin ክፍል room area") === "");
  pass("an HTML error page is rejected", acceptTranslation("Tea", "<html><body>Sorry... unusual traffic</body></html>") === "");
  pass("double-escaped entities are rejected", acceptTranslation("Tea", "ሻይ &amp;amp; ቡና") === "");
  pass("broken characters are rejected", acceptTranslation("Tea", "ሻ\uFFFDይ") === "");
  pass("a changed price is rejected", acceptTranslation("Pizza 250 ETB", "ፒዛ 205 ETB") === "" && acceptTranslation("Pizza 250 ETB", "ፒዛ 250 ETB") !== "");
  pass("'ETB' may not be translated away", acceptTranslation("Only 50 ETB", "50 ብር ብቻ") === "");
  pass("an answer far longer than the text is rejected", acceptTranslation("Tea", "ሻይ ".repeat(40)) === "");
  pass("non-strings and empty answers are rejected", acceptTranslation("Tea", null) === "" && acceptTranslation("Tea", 42) === "" && acceptTranslation("Tea", "   ") === "");
  pass("only Amharic is supported", acceptTranslation("Tea", "ሻይ", "fr") === "");
  pass("Ge'ez share counts letters only", ethiopicShare("ሻይ 25") === 1 && ethiopicShare("abc") === 0);

  /* ── 2. the parser ────────────────────────────────────────────────────── */
  const { parseGoogleResponse, translateBatchDetailed, resetTranslateStateForTests } = await import("../src/lib/translate-server");
  pass("a single text answered as a bare string is kept", JSON.stringify(parseGoogleResponse("ሻይ", 1)) === '["ሻይ"]');
  pass("several texts answered as strings", JSON.stringify(parseGoogleResponse(["ሻይ", "ቡና"], 2)) === '["ሻይ","ቡና"]');
  pass("several texts answered as [text, lang]", JSON.stringify(parseGoogleResponse([["ሻይ", "en"], ["ቡና", "en"]], 2)) === '["ሻይ","ቡና"]');
  pass("one text wrapped twice", JSON.stringify(parseGoogleResponse([[["ሻይ", "en"]]], 1)) === '["ሻይ"]');
  pass("one text answered as [text, lang]", JSON.stringify(parseGoogleResponse(["ሻይ", "en"], 1)) === '["ሻይ"]');
  pass("a count mismatch keeps English", parseGoogleResponse(["ሻይ"], 2).length === 0 && parseGoogleResponse("ሻይ", 2).length === 0);
  pass("an unknown shape keeps English", parseGoogleResponse([{ x: 1 }], 1).length === 0 && parseGoogleResponse(null, 1).length === 0);

  /* ── 3. the server translator ─────────────────────────────────────────── */
  resetTranslateStateForTests();
  calls.length = 0;
  answer = (url) => {
    const qs = qsOf(url);
    const map: Record<string, string> = { "Spicy lentil stew": "ቅመም ያለው የምስር ወጥ", North: "semin", "House special": "House special" };
    return qs.length === 1 ? json(map[qs[0]] ?? "") : json(qs.map((q) => map[q] ?? ""));
  };
  let out = await translateBatchDetailed("am", ["Spicy lentil stew", "North", "House special"]);
  pass("good Amharic comes back", out.translations["Spicy lentil stew"] === "ቅመም ያለው የምስር ወጥ");
  pass("'semin' and the English echo are NOT returned", !("North" in out.translations) && !("House special" in out.translations));
  pass("…and they are not 'pending' (they simply stay English)", out.pending.length === 0);
  const before = calls.length;
  out = await translateBatchDetailed("am", ["North", "House special", "Spicy lentil stew"]);
  pass("a bad answer is not asked again right away, a good one comes from memory", calls.length === before && out.translations["Spicy lentil stew"] === "ቅመም ያለው የምስር ወጥ");

  resetTranslateStateForTests();
  calls.length = 0;
  answer = () => json("ትኩስ ሻይ");
  out = await translateBatchDetailed("am", ["Hot tea"]);
  pass("a SINGLE text now translates (bare-string reply)", out.translations["Hot tea"] === "ትኩስ ሻይ" && calls.length === 1);

  // A bad answer cached in memory by an older release is replaced.
  resetTranslateStateForTests();
  const mem = (globalThis as unknown as { __fanaTxMem: Map<string, string> }).__fanaTxMem;
  mem.set(`am::${createHash("sha256").update("Cold milk").digest("hex").slice(0, 48)}`, "Cold milk");
  calls.length = 0;
  answer = () => json("ቀዝቃዛ ወተት");
  out = await translateBatchDetailed("am", ["Cold milk"]);
  pass("a bad cached answer is dropped and translated again", out.translations["Cold milk"] === "ቀዝቃዛ ወተት" && calls.length === 1);

  // Google's block page: HTTP 429 + HTML → breaker, texts pending.
  resetTranslateStateForTests();
  calls.length = 0;
  answer = () => new Response("<html><title>Sorry...</title>unusual traffic</html>", { status: 429, headers: { "Content-Type": "text/html" } });
  out = await translateBatchDetailed("am", ["Avocado juice", "Mango juice"]);
  pass("Google's 429 page returns the texts as pending", out.pending.length === 2 && Object.keys(out.translations).length === 0);
  pass("…with a pause before asking again", (out.retryAfterSeconds || 0) >= 60);
  calls.length = 0;
  out = await translateBatchDetailed("am", ["Avocado juice"]);
  pass("while the breaker is open Google is not hammered", calls.length === 0 && out.pending.includes("Avocado juice"));

  resetTranslateStateForTests();
  answer = () => new Response("<html>Sorry</html>", { status: 200, headers: { "Content-Type": "text/html" } });
  out = await translateBatchDetailed("am", ["Papaya juice"]);
  pass("an HTML page with HTTP 200 counts as a refusal too", out.pending.includes("Papaya juice"));

  // Official Cloud Translation API when a key is configured.
  resetTranslateStateForTests();
  process.env.GOOGLE_TRANSLATE_API_KEY = "test-key-123";
  calls.length = 0;
  answer = (_url, init) => {
    const body = JSON.parse(String(init?.body || "{}")) as { q: string[] };
    return json({ data: { translations: body.q.map((q) => ({ translatedText: q === "Green salad" ? "አረንጓዴ ሰላጣ" : q })) } });
  };
  out = await translateBatchDetailed("am", ["Green salad", "Burger"]);
  const sent = calls[0];
  const sentBody = JSON.parse(String(sent?.init?.body || "{}"));
  pass(
    "with GOOGLE_TRANSLATE_API_KEY the official v2 API is used (POST, format text)",
    !!sent && sent.url.startsWith("https://translation.googleapis.com/language/translate/v2?key=test-key-123") && sent.init?.method === "POST" && sentBody.format === "text" && sentBody.target === "am"
  );
  pass("…and its answers pass the same guard", out.translations["Green salad"] === "አረንጓዴ ሰላጣ" && !("Burger" in out.translations));
  delete process.env.GOOGLE_TRANSLATE_API_KEY;

  /* ── 4. the browser layer ─────────────────────────────────────────────── */
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fana.test/menu" });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.localStorage = dom.window.localStorage;
  const ls = dom.window.localStorage;
  ls.setItem("fana_tx_am", JSON.stringify({ North: "semin" }));
  ls.setItem("fana_tx_am_v2", JSON.stringify({ "Fana special tea": "የፋና ልዩ ሻይ", Brownie: "Brownie", Waffle: "wafel" }));
  const i18n = await import("../src/lib/i18n");
  i18n.resetAutoTranslateForTests();
  calls.length = 0;
  answer = () => json({ translations: {} });
  pass("the first lookup already shows the stored Amharic", i18n.autoTranslateForTests("Fana special tea") === "የፋና ልዩ ሻይ");
  pass("the old cache (with bad answers) is removed", ls.getItem("fana_tx_am") === null);
  const stored = JSON.parse(ls.getItem("fana_tx_am_v2") || "{}");
  pass("stored bad answers are dropped on load", !("Brownie" in stored) && !("Waffle" in stored) && stored["Fana special tea"] === "የፋና ልዩ ሻይ");
  pass("a dropped answer shows English", i18n.autoTranslateForTests("Brownie") === "Brownie");

  // A busy server (429) must NOT mark the text done: it is asked again later.
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  i18n.resetAutoTranslateForTests();
  calls.length = 0;
  answer = () => json({ translations: {}, retryAfterSeconds: 20 }, 429);
  i18n.autoTranslateForTests("Tibs with injera");
  await i18n.flushAutoTranslateForTests();
  pass("the text was sent once", calls.length === 1 && JSON.parse(String(calls[0].init?.body)).texts.includes("Tibs with injera"));
  const id1 = (calls[0].init?.headers as Record<string, string>)["X-Fana-Client"];
  pass("each phone sends its own id", /^[A-Za-z0-9-]{8,64}$/.test(id1 || ""));
  await i18n.flushAutoTranslateForTests();
  pass("it waits the pause the server asked for", calls.length === 1);
  clock += 21_000;
  answer = () => json({ translations: { "Tibs with injera": "ጥብስ በእንጀራ" } });
  await i18n.flushAutoTranslateForTests();
  pass("after the pause it is asked again (not given up)", calls.length === 2);
  pass("…and the Amharic shows", i18n.autoTranslateForTests("Tibs with injera") === "ጥብስ በእንጀራ");
  pass("…with the same phone id", (calls[1].init?.headers as Record<string, string>)["X-Fana-Client"] === id1);

  // Offline: retried too.
  answer = () => {
    throw new TypeError("Failed to fetch");
  };
  i18n.autoTranslateForTests("Shiro wot");
  await i18n.flushAutoTranslateForTests();
  clock += 6_000;
  answer = () => json({ translations: { "Shiro wot": "ሽሮ ወጥ" } });
  await i18n.flushAutoTranslateForTests();
  pass("an offline moment is retried", i18n.autoTranslateForTests("Shiro wot") === "ሽሮ ወጥ");

  // Bad answers from the server are never shown or stored.
  answer = () => json({ translations: { Kitfo: "kitfo", "Special kitfo": "Special kitfo" } });
  i18n.autoTranslateForTests("Kitfo");
  i18n.autoTranslateForTests("Special kitfo");
  await i18n.flushAutoTranslateForTests();
  const after = JSON.parse(ls.getItem("fana_tx_am_v2") || "{}");
  pass("a Latin answer is not shown", i18n.autoTranslateForTests("Kitfo") === "Kitfo" && i18n.autoTranslateForTests("Special kitfo") === "Special kitfo");
  pass("…and not stored", !("Kitfo" in after) && !("Special kitfo" in after));
  const sentCount = calls.length;
  i18n.autoTranslateForTests("Kitfo");
  await i18n.flushAutoTranslateForTests();
  pass("…and not asked again in the same visit", calls.length === sentCount);

  // `pending` from the server: asked again later.
  answer = () => json({ translations: {}, pending: ["Beyaynetu"], retryAfterSeconds: 30 });
  i18n.autoTranslateForTests("Beyaynetu");
  await i18n.flushAutoTranslateForTests();
  clock += 31_000;
  answer = () => json({ translations: { Beyaynetu: "በያይነቱ" } });
  await i18n.flushAutoTranslateForTests();
  pass("texts the server could not do yet are retried", i18n.autoTranslateForTests("Beyaynetu") === "በያይነቱ");
  Date.now = realNow;

  /* ── 5. One-time purge of the old bad cache (src/db/migrate.ts) ───────────
   * Checked live on PostgreSQL 17 (UTF8): real Amharic, brand names in Latin
   * and "ETB" are kept; Latin romanisation, echoed English, HTML pages,
   * entities, broken characters and mostly-Latin answers are deleted, once. */
  const migrate = readFileSync(path.join(__dirname, "..", "src", "db", "migrate.ts"), "utf8");
  const purge = migrate.slice(migrate.indexOf("translations_purged_v1"), migrate.indexOf("translations_purged_v1', 'on'"));
  pass("migration: the purge is one-time (translations_purged_v1 flag)", purge.length > 0 && /INSERT INTO site_settings[^`]*'translations_purged_v1', 'on'/.test(migrate));
  pass("migration: rows with no Ethiopic letters are deleted", /translated_text !~ '\[\\\\u1200-\\\\u139F/.test(purge));
  pass("migration: English echoed back is deleted", /lower\(btrim\(translated_text\)\) = lower\(btrim\(source_text\)\)/.test(purge));
  pass("migration: HTML pages and entities are deleted", /translated_text ~ '<\[A-Za-z\/\]'/.test(purge) && /&\(#x\?\[0-9a-f\]\+\|\[a-z\]\+\);/.test(purge));
  pass("migration: broken characters (U+FFFD) are deleted", /chr\(65533\)/.test(purge));
  pass("migration: mostly-Latin answers are deleted", /1\.5 \* length\(regexp_replace\(translated_text/.test(purge));
  pass("migration: the purge only runs on a UTF8 database", /current_setting\('server_encoding'\)/.test(migrate) && /serverEncoding !== "UTF8"/.test(purge));
  pass(
    "migration: a failed purge never blocks the schema stamp (no errors.push)",
    !/errors\.push\(`purge/.test(migrate) && /translation cache purge skipped/.test(purge),
  );

  console.log(failures === 0 ? "\n✅ Translation guard PASSED" : `\n❌ ${failures} translation guard assertions FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
