import { NextResponse } from "next/server";
import { ensureTablesExist } from "@/db/migrate";
import { checkSharedIpRateLimit, VENUE_POLICIES } from "@/lib/rate-limit";
import { SUPPORTED_TX_LANGS, translateBatchDetailed } from "@/lib/translate-server";

/**
 * POST /api/translate — public auto-translation for owner-managed content.
 * Body:  { lang: "am", texts: string[] }
 * Reply: { translations: { "English text": "የተተረጎመ ጽሑፍ", ... },
 *          pending?: ["texts to ask again later"], retryAfterSeconds?: n }
 *
 * Failures ALWAYS return an empty map (HTTP 200) — the client then simply
 * keeps the English text, so a Google/DB hiccup can never break the menu.
 */
export const dynamic = "force-dynamic";

const MAX_TEXTS = 150;

/** The per-device id the browser sends (random, kept in localStorage). */
function clientIdOf(request: Request): string {
  const id = request.headers.get("x-fana-client")?.trim() || "";
  return /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : "anon";
}

export async function POST(request: Request) {
  // Per DEVICE and per venue: every guest shares the café's one WiFi IP, so a
  // plain per-IP limit (the old 40/min) ran out on a busy evening and those
  // phones stayed English. See VENUE_POLICIES.translate.
  const rl = checkSharedIpRateLimit("translate", request, clientIdOf(request), VENUE_POLICIES.translate);
  if (!rl.allowed) {
    return NextResponse.json(
      { translations: {}, retryAfterSeconds: rl.retryAfterSeconds },
      { status: 429, headers: { "Cache-Control": "no-store" } }
    );
  }

  let body: { lang?: unknown; texts?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const lang = String(body.lang || "");
  if (!SUPPORTED_TX_LANGS.has(lang)) {
    return NextResponse.json({ error: "Unsupported language" }, { status: 400 });
  }

  const raw = Array.isArray(body.texts) ? body.texts : [];
  const texts = raw
    .slice(0, MAX_TEXTS)
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().slice(0, 1500))
    .filter(Boolean);
  if (!texts.length) {
    return NextResponse.json({ translations: {} }, { headers: { "Cache-Control": "no-store" } });
  }

  await ensureTablesExist();
  try {
    const { translations, pending, retryAfterSeconds } = await translateBatchDetailed(lang, texts);
    // `pending`: the translator refused or timed out for these texts; the
    // browser asks again after `retryAfterSeconds` instead of giving up.
    return NextResponse.json(
      pending.length ? { translations, pending, retryAfterSeconds } : { translations },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("translate error:", error);
    return NextResponse.json(
      { translations: {} },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }
}
