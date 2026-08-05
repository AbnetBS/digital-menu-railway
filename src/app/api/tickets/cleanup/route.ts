import { NextResponse } from "next/server";
import { db } from "@/db";
import { tickets } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { and, eq, lt, isNotNull } from "drizzle-orm";

/**
 * POST: frees database storage by clearing receipt PHOTOS
 * for already-PAID bills older than N days.
 * The order record (items, amounts, method) stays — only the image goes.
 * Default: 30 days (add ?days=60 to change).
 */
export async function POST(request: Request) {
  await ensureTablesExist();
  try {
    const { searchParams } = new URL(request.url);
    const days = Math.max(1, Number(searchParams.get("days") || 30));

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const cleared = await db
      .update(tickets)
      .set({ receiptImage: "" })
      .where(and(eq(tickets.status, "paid"), isNotNull(tickets.receiptImage), lt(tickets.closedAt, cutoff)))
      .returning({ id: tickets.id });

    return NextResponse.json({
      success: true,
      clearedReceipts: cleared.length,
      message: `Cleared receipt photos from ${cleared.length} paid bill(s) older than ${days} days. Order records are kept.`,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
