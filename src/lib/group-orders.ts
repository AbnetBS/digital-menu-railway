import { and, eq, gte, like, sql } from "drizzle-orm";
import { db } from "@/db";
import { tickets } from "@/db/schema";
import { etStartOfToday } from "@/lib/timezone";

/**
 * GROUP ORDERS (owner's decision, Sept 2026).
 *
 * On busy nights the guests do not sit where the table grid says they should:
 * chairs get dragged to the screen, different peoples end up sharing one
 * table, some sit on chairs with no table at all. So the billing unit is the
 * GROUP OF PEOPLE, not the place: each group gets its own auto-numbered bill
 * ("GROUP 3"), the waiter adds rounds to the same group, and each group pays
 * separately. The number is the identity — no names, no seat labels.
 */

/** Matches the tableName of a group bill, e.g. "GROUP 3". */
export const GROUP_LABEL_RE = /^GROUP (\d+)$/;
export const groupLabel = (n: number) => `GROUP ${n}`;

/**
 * Advisory-lock key: two waiters creating groups at the same millisecond must
 * still get consecutive numbers. The xact lock is held until the surrounding
 * transaction commits, so the read-max-then-write pair is atomic in practice.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GROUP_NUMBER_LOCK = 8_602_140_917; // arbitrary constant, stable forever

/**
 * Today's next group number: max N of today's GROUP bills + 1. Restarts at 1
 * every Ethiopian midnight, exactly like the Coffee Note's daily seq — the
 * cashier's EFD cross-check stays unambiguous within a day, and numbers never
 * repeat while a receipt from tonight can still be checked.
 *
 * Must run INSIDE the ticket transaction (tx) so the advisory lock covers the
 * insert that uses the number.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function nextGroupNumberInTx(tx: any): Promise<number> {
  await tx.execute(sql`select pg_advisory_xact_lock(${GROUP_NUMBER_LOCK})`);
  const rows = await tx
    .select({ tableName: tickets.tableName })
    .from(tickets)
    .where(
      and(
        eq(tickets.orderType, "outdoor"),
        gte(tickets.createdAt, etStartOfToday()),
        like(tickets.tableName, "GROUP %")
      )
    );
  let max = 0;
  for (const row of rows) {
    const match = GROUP_LABEL_RE.exec(String(row.tableName || ""));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/** Outside a transaction (GET /api/tickets?nextGroup=1): a display prediction. */
export async function nextGroupNumberToday(): Promise<number> {
  const rows = await db
    .select({ tableName: tickets.tableName })
    .from(tickets)
    .where(
      and(
        eq(tickets.orderType, "outdoor"),
        gte(tickets.createdAt, etStartOfToday()),
        like(tickets.tableName, "GROUP %")
      )
    );
  let max = 0;
  for (const row of rows) {
    const match = GROUP_LABEL_RE.exec(String(row.tableName || ""));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}
