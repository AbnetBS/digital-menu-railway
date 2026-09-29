/**
 * DAILY SALES + THE DAY CLOSE (owner's decision, 29 Sept 2026).
 *
 * WHAT THE OWNER ASKED FOR: when the restaurant is about to close he wants to
 * read today's TOTAL and match it against the money in the drawer and the
 * system printer (EFD) receipts. So:
 *
 *   • the cashier gets a "Today's shift end" button that opens after the
 *     closing hour (1:00 Ethiopian local = 19:00, five hours after the shift
 *     change the owner already configured);
 *   • tapping it records the day's total and sends ONE notification to the
 *     owner's phone: "Today's total sale • 12,450 ETB";
 *   • that notification opens the Daily Sales page in the dashboard, which
 *     lists, per date (newest first): "29 Sep 2026 • 12,450 ETB".
 *
 * WHAT COUNTS AS A SALE: exactly what the reports count. The money moment is
 * the cashier's ✓ PRINTED tap (tickets.printed_at) — the EFD receipt in her
 * hand. Cancelled bills never count.
 *
 * This module is deliberately PURE: no database, no Next.js, no React. The API
 * route feeds data in, the regression test (scripts/verify-daily-sales.ts)
 * feeds fixtures in.
 */
import { etDayKey, etDayKeyDaysAgo, etHour, etStartOfDay } from "@/lib/timezone";

/** The owner's shift-change hour when nothing is configured (14:00 EAT). */
export const DEFAULT_SPLIT_HOUR = 14;

/**
 * HOW LONG AFTER THE SHIFT CHANGE THE CLOSING HOUR SITS. The owner's closing
 * hour is 1:00 on the Ethiopian local clock = 19:00 EAT, exactly five hours
 * after the 8:00 local (14:00) shift change. Deriving it from the configured
 * split hour means an owner who moves the shift change moves the closing hour
 * with it, instead of editing two settings.
 */
export const CLOSE_HOURS_AFTER_SPLIT = 5;

/** The closing hour when nothing is configured: 14:00 + 5h = 19:00 EAT. */
export const DEFAULT_CUTOFF_HOUR = DEFAULT_SPLIT_HOUR + CLOSE_HOURS_AFTER_SPLIT;

/**
 * The hour (EAT) the "Today's shift end" button opens. Any split hour the
 * owner saved is honoured, clamped so the closing hour can never be an
 * impossible "24:00" or run past midnight into the next day's business.
 */
export function dayCloseCutoffHour(splitHour: number | null | undefined): number {
  // "Not configured" must never read as hour 0 (Number(null) is 0, and that
  // would open the day close in the middle of the night).
  const missing = splitHour === null || splitHour === undefined || String(splitHour).trim() === "";
  const parsed = missing ? NaN : Number(splitHour);
  const split = Number.isInteger(parsed) ? Math.min(23, Math.max(0, parsed)) : DEFAULT_SPLIT_HOUR;
  return Math.min(23, split + CLOSE_HOURS_AFTER_SPLIT);
}

/**
 * Is the shift-end button open? A CLOSED day counts as open too: if the
 * cashier closed, the day was already sent and re-sending must stay possible
 * (a late correction she must report).
 */
export function isDayCloseOpen(hour: number, cutoffHour: number): boolean {
  return hour >= cutoffHour;
}

/** The site_settings key holding one day's close record. */
export const DAY_CLOSE_KEY_PREFIX = "day_close_";

export function dayCloseSettingKey(dayKey: string): string {
  return `${DAY_CLOSE_KEY_PREFIX}${String(dayKey || "").trim()}`;
}

/** What was stored when the day was closed (JSON in site_settings.value). */
export interface DayCloseRecord {
  /** ISO instant of the tap. */
  at: string;
  /** WHO tapped it (the cashier's name, or "admin"). */
  by: string;
  /** The total that was sent to the owner at that moment. */
  total: number;
  /** How many printed bills made that total. */
  bills: number;
}

/** Read a stored close record; anything malformed reads as "not closed". */
export function parseDayCloseValue(value: string | null | undefined): DayCloseRecord | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(String(value)) as Partial<DayCloseRecord>;
    if (!raw || typeof raw !== "object" || !raw.at) return null;
    const total = Number(raw.total);
    const bills = Number(raw.bills);
    return {
      at: String(raw.at),
      by: String(raw.by || ""),
      total: Number.isFinite(total) ? total : 0,
      bills: Number.isFinite(bills) ? bills : 0,
    };
  } catch {
    return null;
  }
}

/** True when this value is a day-close record key for one EAT day. */
export function dayKeyFromCloseSetting(key: string): string | null {
  const k = String(key || "");
  if (!k.startsWith(DAY_CLOSE_KEY_PREFIX)) return null;
  const day = k.slice(DAY_CLOSE_KEY_PREFIX.length).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/* ─── THE OWNER'S PAGE: one line per date ────────────────────────────────── */

/** "12,450 ETB" — the shape the owner reads against the EFD paper. */
export function formatEtb(n: number | null | undefined): string {
  const v = Number(n || 0);
  return `${(Number.isFinite(v) ? v : 0).toLocaleString("en-US")} ETB`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-29" → "29 Sep 2026" (an EAT calendar date, never shifted). */
export function dayKeyLabel(dayKey: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || "").trim());
  if (!m) return "";
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return "";
  return `${Number(m[3])} ${MONTHS[monthIndex]} ${m[1]}`;
}

/**
 * The EAT day keys a page shows, NEWEST FIRST: today, yesterday, and so on.
 * `count` days in total. Built from the canonical EAT helpers, so the list is
 * a true calendar list even around midnight.
 */
export function recentDayKeys(count: number, now: Date = new Date()): string[] {
  const n = Math.max(1, Math.min(400, Math.round(Number(count) || 1)));
  const today = etDayKey(now) || etDayKey(etStartOfDay(now));
  const keys: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const key = i === 0 ? today : etDayKeyDaysAgo(i);
    if (key) keys.push(key);
  }
  return keys;
}

/** The current EAT hour (0-23), for the closing-hour gate. */
export function currentEtHour(now: Date = new Date()): number {
  return etHour(now);
}

/** The payload the owner's phone notification carries. */
export interface DayClosePush {
  title: string;
  body: string;
  tag: string;
  url: string;
}

export function dayClosePush(dayKey: string, total: number, bills: number): DayClosePush {
  return {
    title: "💰 Today's total sale",
    body: `${dayKeyLabel(dayKey)} • ${formatEtb(total)} • ${bills} bill(s) • tap to open the sales page`,
    tag: `fana-day-close-${dayKey}`,
    url: "/admin?tab=sales",
  };
}
