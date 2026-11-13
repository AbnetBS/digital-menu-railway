/**
 * THE GROUP GRID'S NUMBERS (owner, 2026-11-08): "create 20 groups by default...
 * if they want more they will add more".
 *
 * Deliberately PURE: no database, no drizzle, no Next.js. The waiter's phone
 * imports this, and importing @/lib/group-orders there would drag the pg driver
 * into the browser bundle (which Next.js refuses to build). The numbering rule
 * lives here; the transaction that stamps the number stays in group-orders.ts.
 */

/** Matches the tableName of a group bill, e.g. "GROUP 3". */
export const GROUP_LABEL_RE = /^GROUP (\d+)$/;
export const groupLabel = (n: number) => `GROUP ${n}`;

/**
 * TWENTY GROUPS, READY BEFORE THE FIRST GUEST (owner, 2026-11-08).
 *
 * "create 20 groups by default... if they want more they will add more". The
 * group screen used to show only the bills that already existed, so at 7 pm the
 * waiter had to invent a group before he could seat anybody. Now the grid shows
 * GROUP 1 to GROUP 20 from the start: touching one opens (or joins) its bill.
 *
 * The list is the DEFAULT ONLY. It never invents a bill in the database and it
 * never caps the day at 20: a group with a bill on it today keeps its number
 * even if that number is above 20, and the "New group" button still goes to
 * 21, 22, 23 for as long as the night needs them.
 */
export const DEFAULT_GROUP_COUNT = 20;

/** GROUP 1 ... GROUP n, the default slots of a fresh day. */
export function defaultGroupLabels(count: number = DEFAULT_GROUP_COUNT): string[] {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return Array.from({ length: n }, (_, i) => groupLabel(i + 1));
}

/**
 * Every group card the waiter must see: the 20 default numbers, plus any open
 * bill whose number is above them (GROUP 23 on a wild night), each at most
 * once, in number order. A number appears here whether or not it has a bill
 * yet, so the grid never changes shape mid-service.
 */
export function groupNumbersForGrid(
  openGroups: Array<{ tableName?: string | null }>,
  count: number = DEFAULT_GROUP_COUNT
): number[] {
  const numbers = new Set<number>();
  for (let i = 1; i <= Math.max(0, Math.floor(count || 0)); i++) numbers.add(i);
  for (const g of openGroups) {
    const match = GROUP_LABEL_RE.exec(String(g.tableName || ""));
    if (match) numbers.add(Number(match[1]));
  }
  return [...numbers].sort((a, b) => a - b);
}
