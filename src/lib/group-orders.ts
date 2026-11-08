import { and, eq, gte, like, sql } from "drizzle-orm";
import { db } from "@/db";
import { tickets } from "@/db/schema";
import { etStartOfToday } from "@/lib/timezone";
import { GROUP_LABEL_RE, groupLabel } from "@/lib/group-grid";

// Re-exported so every server caller keeps its one import.
export { DEFAULT_GROUP_COUNT, GROUP_LABEL_RE, defaultGroupLabels, groupLabel, groupNumbersForGrid } from "@/lib/group-grid";

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


/**
 * Advisory-lock key: two waiters creating groups at the same millisecond must
 * still get consecutive numbers. The xact lock is held until the surrounding
 * transaction commits, so the read-max-then-write pair is atomic in practice.
 */
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

/** Every group number that already has a bill today. */
async function takenGroupNumbersInTx(tx: any): Promise<Set<number>> {
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
  const taken = new Set<number>();
  for (const row of rows) {
    const match = GROUP_LABEL_RE.exec(String(row.tableName || ""));
    if (match) taken.add(Number(match[1]));
  }
  return taken;
}

/**
 * The number a NEW group bill gets. The waiter may tap a default slot before
 * that group has any bill ("use GROUP 7"), so `requested` is honoured when it is
 * still free today; otherwise the next unused number is stamped.
 *
 * The client can only ever ask for a number, never force one: every used number
 * of the day is read under the same advisory lock, so two waiters who both tap
 * GROUP 7 still end up with 7 and the next free number, never one bill twice.
 */
export async function groupNumberForNewBillInTx(tx: any, requested?: number | null): Promise<number> {
  await tx.execute(sql`select pg_advisory_xact_lock(${GROUP_NUMBER_LOCK})`);
  const taken = await takenGroupNumbersInTx(tx);
  const want = Math.floor(Number(requested) || 0);
  if (want > 0 && !taken.has(want)) return want;
  let next = 1;
  while (taken.has(next)) next++;
  return next;
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
