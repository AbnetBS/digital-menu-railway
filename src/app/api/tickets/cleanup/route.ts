import { NextResponse } from "next/server";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { cleanupOldReceipts } from "@/lib/receipt-cleanup";

/**
 * POST: manually clears receipt PHOTOS for paid bills older than N days
 * (the "Clean Old Receipts" button in the admin Order History tab).
 * Default 30 days (?days=60 to change). The order record is always kept.
 *
 * This same cleanup also runs automatically every 24h via src/instrumentation.ts,
 * so this endpoint is a manual override only.
 */
export async function POST(request: Request) {
  const __auth = await requireAdmin();
  if (!__auth.ok) return __auth.response;
  await ensureTablesExist();
  try {
    const { searchParams } = new URL(request.url);
    const days = Math.max(1, Number(searchParams.get("days") || 30));

    const clearedReceipts = await cleanupOldReceipts(days);

    return NextResponse.json({
      success: true,
      clearedReceipts,
      message: `Cleared receipt photos from ${clearedReceipts} paid bill(s) older than ${days} days. Order records are kept.`,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
