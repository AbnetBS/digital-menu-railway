import { db } from "@/db";
import { tickets } from "@/db/schema";
import { and, eq, lt, isNotNull } from "drizzle-orm";
import { deleteOrphanedCdnImages } from "@/lib/image-store";

/**
 * Clears receipt PHOTOS from paid bills older than `days` days, and removes
 * any cdn_images rows orphaned by that cleanup. The order record itself
 * (items, amounts, method) is always kept — only the image is deleted.
 *
 * Returns the number of receipts cleared, or 0 on failure (never throws).
 */
export async function cleanupOldReceipts(days = 30): Promise<number> {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const targets = await db
      .select({ receiptImage: tickets.receiptImage })
      .from(tickets)
      .where(and(eq(tickets.status, "paid"), isNotNull(tickets.receiptImage), lt(tickets.closedAt, cutoff)));

    if (targets.length === 0) return 0;

    const cleared = await db
      .update(tickets)
      .set({ receiptImage: "" })
      .where(and(eq(tickets.status, "paid"), isNotNull(tickets.receiptImage), lt(tickets.closedAt, cutoff)))
      .returning({ id: tickets.id });

    await deleteOrphanedCdnImages(targets.map((t) => t.receiptImage));
    return cleared.length;
  } catch (error) {
    console.warn("[receipt-cleanup] skipped:", error);
    return 0;
  }
}
