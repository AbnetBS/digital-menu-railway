/**
 * THE ORDER HISTORY "DATE" FILTER (owner, Oct 2026).
 *
 * "the current shows like this Order History (200) but i want to add other
 * filter that makes him choose specific date like today order history,
 * yesterday, before yesterday, last 7 days, last 1 month, name the filter
 * 'date'".
 *
 * The list itself is unchanged: it is still the newest finished bills of the
 * report's rolling 30-day window. This module only decides WHICH of those bills
 * a chosen day-range keeps, so the owner can read one day at a time.
 *
 * The days are ETHIOPIAN calendar days (src/lib/timezone.ts), exactly like the
 * reports: "Today" starts at EAT midnight, not "24 hours ago", and "Last 7
 * Days" is today plus the six days before it. A bill belongs to the day it was
 * FINISHED on - the same stamp the history card shows as its time - and a bill
 * with no closing stamp falls back to the day it arrived.
 *
 * This module is deliberately PURE: no database, no React. The regression guard
 * runs it directly.
 */
import {
  etStartOfDay,
  isDayBeforeYesterdayET,
  isTodayET,
  isWithinEtDays,
  isYesterdayET,
} from "@/lib/timezone";

// TYPE-only import: it is erased at build time, so this module stays pure and
// runnable outside Next, while the compiler still insists that every label of
// the dropdown has its hand-written አማርኛ wording.
import type { StaffPhrase } from "@/lib/staff-i18n";

const MS_PER_DAY = 24 * 60 * 60 * 1000;


export type OrderDateFilter = "all" | "today" | "yesterday" | "day_before" | "last7" | "last30";

/**
 * The choices of the dropdown, in the order the owner listed them. `label` is
 * the English phrase the staff dictionary translates (so the Amharic screen
 * reads ዛሬ / ትናንት / ...), and every one of them is already a StaffPhrase.
 */
export const ORDER_DATE_FILTERS: Array<{ value: OrderDateFilter; label: StaffPhrase }> = [
  { value: "all", label: "All Dates" },
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "day_before", label: "Day Before Yesterday" },
  { value: "last7", label: "Last 7 Days" },
  { value: "last30", label: "Last 30 Days" },
];

/** "last 1 month" in the owner's words is the report's own 30-day window. */
export const ORDER_DATE_FILTER_MONTH_DAYS = 30;

type Dated = {
  closedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  createdAt?: Date | string | null;
};

const asDate = (value: Date | string | null | undefined): Date | null => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * The day a finished bill belongs to: when it closed, or - for a bill that
 * never got a closing stamp - the last time it moved, and failing that the day
 * it arrived. It is the same stamp the history card prints as its time, so the
 * filter and the card can never disagree.
 */
export function orderHistoryDateOf(order: Dated | null | undefined): Date | null {
  if (!order) return null;
  return asDate(order.closedAt) ?? asDate(order.updatedAt) ?? asDate(order.createdAt);
}

/** True when `order` falls inside the chosen day-range. */
export function matchesOrderDateFilter(
  order: Dated | null | undefined,
  filter: OrderDateFilter | string | null | undefined
): boolean {
  const date = orderHistoryDateOf(order);
  if (!date) return false; // a bill with no readable stamp matches no day
  switch (filter) {
    case "today":
      return isTodayET(date);
    case "yesterday":
      return isYesterdayET(date);
    case "day_before":
      return isDayBeforeYesterdayET(date);
    case "last7":
      return isWithinEtDays(date, 7);
    case "last30":
      return isWithinEtDays(date, ORDER_DATE_FILTER_MONTH_DAYS);
    default:
      return true; // "all" (and anything unknown) keeps the whole list
  }
}

/** Is a filter other than "All Dates" on? Used to say so next to the count. */
export function isOrderDateFilterActive(filter: OrderDateFilter | string | null | undefined): boolean {
  return Boolean(filter) && filter !== "all";
}

/**
 * How many Ethiopian calendar days back the range starts, counting today as 0
 * ("Last 7 Days" covers today plus the 6 days before it, exactly like the
 * report's own rolling windows), or null when the filter is off.
 */
export function orderFilterStartDaysAgo(filter: OrderDateFilter): number | null {
  switch (filter) {
    case "today":
      return 0;
    case "yesterday":
      return 1;
    case "day_before":
      return 2;
    case "last7":
      return 6;
    case "last30":
      return ORDER_DATE_FILTER_MONTH_DAYS - 1;
    default:
      return null;
  }
}

/**
 * The instant the chosen range starts at — Ethiopian midnight of the first day
 * it covers — or null when the filter is off. Ethiopia never changes its
 * clocks, so stepping back in whole days from Ethiopian midnight is exact.
 * Used to warn the admin when the server's list of the newest bills cannot
 * reach back that far, so a range is never silently short.
 */
export function orderFilterRangeStart(filter: OrderDateFilter, now: Date = new Date()): Date | null {
  const back = orderFilterStartDaysAgo(filter);
  if (back === null) return null;
  return new Date(etStartOfDay(now).getTime() - back * MS_PER_DAY);
}

/** How many Ethiopian calendar days the chosen range covers (0 = no filter). */
export function orderFilterDayCount(filter: OrderDateFilter): number {
  switch (filter) {
    case "today":
    case "yesterday":
    case "day_before":
      return 1;
    case "last7":
      return 7;
    case "last30":
      return ORDER_DATE_FILTER_MONTH_DAYS;
    default:
      return 0;
  }
}
