import { db } from "@/db";
import { tickets } from "@/db/schema";
import { and, inArray, isNotNull, lt, or, isNull } from "drizzle-orm";
import { deleteOrphanedCdnImages } from "@/lib/image-store";

/**
 * FINISHED statuses whose bills may be swept by "Clean Old Receipts".
 * Bills in this house are finished as "completed" (instant release) or
 * "closed" (EFD-verified), and "paid"/"cancelled" cover the legacy mobile-
 * money path and voided orders — every one of them is a receipt.
 */
const CLEANABLE_STATUSES = ["completed", "closed", "paid", "cancelled"] as const;

/**
 * Permanently deletes old RECEIPTS from the database — the bill's PHOTO —
 * and removes any cdn_images rows orphaned by the sweep.
 *
 * A bill is "old" when it finished (closed, or last touched when closedAt
 * was never stamped) more than `days` days ago. Open tickets (pending,
 * preparing, ready, served) are NEVER touched, whatever their age. The
 * order record itself (items, amounts, method) is always kept — only the
 * receipt photo is deleted, and the column is set back to NULL like a bill
 * that never had a photo.
 *
 * Returns the number of receipts cleared; failures are propagated to the caller.
 */
export async function cleanupOldReceipts(days = 30): Promise<number> {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    // finishedAs: closedAt wins when stamped, updatedAt otherwise — old
    // "completed" bills never got a closedAt stamp, but their last touch
    // still tells when the receipt went stale.
    const old = or(lt(tickets.closedAt, cutoff), and(isNull(tickets.closedAt), lt(tickets.updatedAt, cutoff)));
    const where = and(inArray(tickets.status, [...CLEANABLE_STATUSES]), isNotNull(tickets.receiptImage), old);

    const targets = await db
      .select({ receiptImage: tickets.receiptImage })
      .from(tickets)
      .where(where);

    if (targets.length === 0) return 0;

    const cleared = await db
      .update(tickets)
      .set({ receiptImage: null })
      .where(where)
      .returning({ id: tickets.id });

    const urls = targets.map((t) => t.receiptImage).filter((u): u is string => !!u);
    if (urls.length > 0) await deleteOrphanedCdnImages(urls);
    return cleared.length;
  } catch (error) {
    console.error("[receipt-cleanup] failed:", error);
    throw error;
  }
}
