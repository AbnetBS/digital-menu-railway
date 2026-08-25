import { NextResponse } from "next/server";
import { ensureTablesExist } from "@/db/migrate";
import { checkRateLimit } from "@/lib/rate-limit";
import { SUPPORTED_TX_LANGS, translateBatch } from "@/lib/translate-server";

/**
 * POST /api/translate — public auto-translation for owner-managed content.
 * Body:  { lang: "am", texts: string[] }
 * Reply: { translations: { "English text": "የተተረጎመ ጽሑፍ", ... } }
 *
 * Failures ALWAYS return an empty map (HTTP 200) — the client then simply
 * keeps the English text, so a Google/DB hiccup can never break the menu.
 */
export const dynamic = "force-dynamic";

const MAX_TEXTS = 150;

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  // The client batches strings (one call per view), so 40/min/IP is generous.
  const rl = checkRateLimit(`translate:${ip}`, 40, 60_000);
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
    const translations = await translateBatch(lang, texts);
    return NextResponse.json({ translations }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("translate error:", error);
    return NextResponse.json(
      { translations: {} },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }
}
