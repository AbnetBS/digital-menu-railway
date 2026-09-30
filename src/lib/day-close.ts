import { and, desc, gt, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { siteSettings, tickets } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { sendPushToRoles } from "@/lib/push";
import { etDayKey, etHour, etMinute, etStartOfDaysAgo } from "@/lib/timezone";
import {
  AUTO_CLOSE_BY,
  DAY_CLOSE_NOTIFY_KEY,
  DAY_CLOSE_KEY_PREFIX,
  dayCloseCutoffHour,
  dayCloseNotifyTime,
  dayClosePush,
  dayCloseSettingKey,
  dayKeyFromCloseSetting,
  dayKeyLabel,
  isDayCloseDue,
  parseDayCloseValue,
  type DayCloseRecord,
  type NotifyTime,
} from "@/lib/daily-sales";

/**
 * THE DAY CLOSE, server side (owner's decisions, 29 Sept 2026).
 *
 * ONE implementation of "add up today's printed bills, record the close and
 * ring the owner's phone", used by:
 *   • POST /api/reports/daily-sales (the cashier's "Today's shift end" tap),
 *   • the background worker (the automatic send when she forgot).
 *
 * THE AUTOMATIC SEND IS SAFE TO REPEAT: it inserts the day's record with
 * ON CONFLICT DO NOTHING and only sends the notification when its own INSERT
 * was the one that won. Two workers, a worker and a page load, or a worker and
 * the cashier tapping at the same second therefore produce exactly ONE record
 * and exactly ONE notification.
 *
 * WHAT COUNTS: printed bills (tickets.printed_at) of that EAT day, cancelled
 * bills excluded — the EFD pile the owner counts against the drawer.
 */

/** How far back the owner's page reads (the list itself is filtered later). */
export const DAILY_SALES_WINDOW_DAYS = 90;

/** One printed bill, only the columns the totals need. */
export interface SoldRow {
  printedAt: Date | null;
  totalAmount: number | null;
  status: string;
}

/** Days bucketed by the EAT calendar day of the PRINT (cancelled never counts). */
export function bucketByDay(rows: SoldRow[]): Map<string, { total: number; bills: number }> {
  const out = new Map<string, { total: number; bills: number }>();
  for (const row of rows) {
    if (row.status === "cancelled") continue;
    const day = etDayKey(row.printedAt);
    if (!day) continue;
    const cur = out.get(day) ?? { total: 0, bills: 0 };
    cur.total += Number(row.totalAmount) || 0;
    cur.bills += 1;
    out.set(day, cur);
  }
  return out;
}

/** Every printed bill since the cutoff (newest first). */
export async function readPrintedBills(cutoff: Date): Promise<SoldRow[]> {
  return db
    .select({ printedAt: tickets.printedAt, totalAmount: tickets.totalAmount, status: tickets.status })
    .from(tickets)
    .where(and(isNotNull(tickets.printedAt), gt(tickets.printedAt, cutoff)))
    .orderBy(desc(tickets.printedAt));
}

export interface DayCloseState {
  /** The owner's chosen notify hour (21:00 default). */
  notifyHour: number;
  /** The minute of that time (0 until he types one, e.g. 3 for 21:03). */
  notifyMinute: number;
  /** The hour the cashier's button opens (one hour before the notify time). */
  cutoffHour: number;
  /** The minute the button opens (one hour before the owner's exact time). */
  cutoffMinute: number;
  /** Today's close record, if the day was closed (manually or automatically). */
  today: DayCloseRecord | null;
}

/** The owner's notify hour from settings (never fails: falls back to 21:00). */
export async function readNotifyHour(): Promise<number> {
  return (await readNotifyTime()).hour;
}

/**
 * The owner's exact notify TIME from settings (never fails: falls back to
 * 21:00). Since 30 Sept 2026 he picks the minute too — "any time like 3:03" —
 * so the automatic send compares the wall clock to the minute, not the hour.
 */
export async function readNotifyTime(): Promise<NotifyTime> {
  try {
    const rows = await db
      .select()
      .from(siteSettings)
      .where(sql`${siteSettings.key} = ${DAY_CLOSE_NOTIFY_KEY}`);
    return dayCloseNotifyTime(rows[0]?.value);
  } catch {
    return dayCloseNotifyTime(null);
  }
}

/** Today's EAT close record (null when the day is still open). */
export async function readTodayClose(dayKey: string): Promise<DayCloseRecord | null> {
  try {
    const rows = await db
      .select()
      .from(siteSettings)
      .where(sql`${siteSettings.key} = ${dayCloseSettingKey(dayKey)}`);
    return parseDayCloseValue(rows[0]?.value);
  } catch {
    return null;
  }
}

/** Today's total, live, straight from the printed bills. */
export async function todayTotals(dayKey: string): Promise<{ total: number; bills: number }> {
  const sales = bucketByDay(await readPrintedBills(etStartOfDaysAgo(1)));
  return sales.get(dayKey) ?? { total: 0, bills: 0 };
}

/**
 * RECORD THE CLOSE.
 *
 * `mode: "manual"` — the cashier (or the owner acting for her) tapped the
 * button. Always writes, so a late correction can be sent again, and always
 * notifies.
 *
 * `mode: "auto"` — the system's own send when the notify hour arrived. Writes
 * ONLY if the day has no record yet, and notifies only when its write won: that
 * is what makes the automatic send exactly-once.
 */
export async function recordDayClose(input: {
  dayKey: string;
  by: string;
  total: number;
  bills: number;
  mode: "manual" | "auto";
}): Promise<{ written: boolean; record: DayCloseRecord }> {
  const at = new Date();
  const record: DayCloseRecord = {
    at: at.toISOString(),
    by: input.mode === "auto" ? AUTO_CLOSE_BY : input.by,
    total: input.total,
    bills: input.bills,
  };
  const key = dayCloseSettingKey(input.dayKey);
  const value = JSON.stringify(record);

  if (input.mode === "auto") {
    const inserted = await db
      .insert(siteSettings)
      .values({ key, value, updatedAt: at })
      .onConflictDoNothing({ target: siteSettings.key })
      .returning({ key: siteSettings.key });
    return { written: inserted.length > 0, record };
  }

  await db
    .insert(siteSettings)
    .values({ key, value, updatedAt: at })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: at } });
  return { written: true, record };
}

/** The ONE phone notification left in the cafe: the owner's daily total. */
export function sendDayClosePush(dayKey: string, total: number, bills: number): void {
  const push = dayClosePush(dayKey, total, bills);
  void sendPushToRoles(["admin"], {
    title: push.title,
    body: push.body,
    tag: push.tag,
    url: push.url,
    // A NORMAL notification (owner's wording): it rings once like any other
    // phone notification, shows the date and the total, and can be swiped
    // away — it is not one of the old "stays on the lock screen" staff alerts.
    urgent: false,
    repeat: 0,
  }).catch(() => {});
}

/**
 * THE AUTOMATIC SEND (owner: "if she forgets to click that button the system
 * will automatically send that notification after 1 hour").
 *
 * Called every minute by the background worker and, as a safety net, whenever
 * the Daily Sales page is loaded. Returns what it did, so the caller can log it.
 */
export async function maybeAutoCloseDay(now: Date = new Date()): Promise<
  "early" | "closed" | "sent" | "raced" | "error"
> {
  try {
    await ensureTablesExist();
    const notifyTime = await readNotifyTime();
    const hour = etHour(now);
    // To the MINUTE: the owner picks 3:03 and the total leaves at 3:03, not at
    // the top of the hour (the worker itself wakes every minute).
    if (!isDayCloseDue(hour, notifyTime.hour, etMinute(now), notifyTime.minute)) return "early";

    const dayKey = etDayKey(now) || "";
    if (!dayKey) return "error";
    if (await readTodayClose(dayKey)) return "closed";

    const totals = await todayTotals(dayKey);
    const { written, record } = await recordDayClose({
      dayKey,
      by: AUTO_CLOSE_BY,
      total: totals.total,
      bills: totals.bills,
      mode: "auto",
    });
    if (!written) return "raced"; // the cashier (or another process) closed it

    sendDayClosePush(dayKey, record.total, record.bills);
    return "sent";
  } catch (error) {
    console.error("[day-close] automatic send failed", String(error));
    return "error";
  }
}

/* ─── THE BACKGROUND WORKER ───────────────────────────────────────────────── */

const POLL_MS = 60_000;

type DayCloseWorkerGlobal = typeof globalThis & {
  __fanaDayCloseWorkerStarted?: boolean;
  __fanaDayCloseWorkerBusy?: boolean;
};

const workerGlobal = globalThis as DayCloseWorkerGlobal;

/**
 * The minute-by-minute check behind the automatic send. Started once from
 * @/instrumentation (the same pattern the waiter send-hold worker uses), and
 * safe if the process is replaced: the day's record lives in the database, so
 * a late start still sees whether the day was already closed.
 */
export function startDayCloseWorker(): void {
  if (workerGlobal.__fanaDayCloseWorkerStarted) return;
  workerGlobal.__fanaDayCloseWorkerStarted = true;

  const tick = async () => {
    if (workerGlobal.__fanaDayCloseWorkerBusy) return;
    workerGlobal.__fanaDayCloseWorkerBusy = true;
    try {
      const result = await maybeAutoCloseDay();
      if (result === "sent") {
        console.log(`[day-close] automatic send at ${dayKeyLabel(etDayKey(new Date()) || "")}`);
      }
    } finally {
      workerGlobal.__fanaDayCloseWorkerBusy = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), POLL_MS);
  // Do not keep one-shot scripts alive just because this module was imported.
  if (typeof timer.unref === "function") timer.unref();
}

/** Re-exported for the route + verifier (one import site for the day keys). */
export { DAY_CLOSE_KEY_PREFIX, dayCloseCutoffHour, dayCloseSettingKey, dayKeyFromCloseSetting };
