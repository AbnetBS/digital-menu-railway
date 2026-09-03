import { NextResponse } from "next/server";
import { getVapidKeys } from "@/lib/push";
import { requireStaffOrAdmin } from "@/lib/session";

/**
 * GET /api/push/public-key — the VAPID public key a staff device needs to
 * subscribe to Web Push ("pocket mode"). Staff-only (subscribing is something
 * a logged-in device does), and it self-generates the keypair on first call.
 */
export async function GET() {
  const __auth = await requireStaffOrAdmin();
  if (!__auth.ok) return __auth.response;
  try {
    const keys = await getVapidKeys();
    if (!keys) return NextResponse.json({ error: "Push unavailable" }, { status: 503 });
    return NextResponse.json({ publicKey: keys.publicKey }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
