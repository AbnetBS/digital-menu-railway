import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { siteSettings, ticketEvents, ticketItems, tickets } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { sendPushToRoles, type PushSendResult } from "@/lib/push";
import { saleLinesForTicket, type SalesItemEventLike, type SalesStamp } from "@/lib/printed-sales";
import { etDayKey, etHour, etMinute, etStartOfDaysAgo } from "@/lib/timezone";
import {
  AUTO_CLOSE_BY,
  DAY_CLOSE_NOTIFY_KEY,
  DAY_CLOSE_KEY_PREFIX,
  dayCloseAutoSentKey,
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
 * THE DAY CLOSE, server side (owner's decisions, 29 Sept 2026; the snapshot
 * rule below from 3 Oct 2026).
 *
 * ONE implementation of "add up today's printed bills, record the close and
 * ring the owner's phone", used by:
 *   • POST /api/reports/daily-sales (the cashier's "Today's shift end" tap),
 *   • the background worker (the automatic send when she forgot).
 *
 * SENDING THE TOTAL DOES NOT CLOSE THE DAY (owner, 3 Oct 2026): "when the
 * cashier click end shift doesnt mean after that time no sale will be place
 * but to send notification to the owners". Both sends are therefore
 * SNAPSHOTS of the printed bills up to that moment. The cashier's tap can be
 * repeated (a later, larger total replaces the earlier one), and the automatic
 * send is the day's FINAL number, which is why it now goes out even when the
 * cashier already closed the day earlier. No sale is ever refused because a
 * close record exists.
 *
 * THE AUTOMATIC SEND IS SAFE TO REPEAT: it claims the day with a marker row
 * inserted ON CONFLICT DO NOTHING and only notifies when its own INSERT was
 * the one that won. Two workers, a worker and a page load, or a worker and
 * the cashier tapping at the same second therefore produce exactly ONE
 * automatic notification. A send that reaches NO phone hands the day straight
 * back, so a phone armed five minutes later still gets the total.
 *
 * EVERY SEND REPORTS (3 Oct 2026): sendDayClosePush returns how many devices
 * the push service accepted, and the route hands that to the screen. "The
 * owner allowed notifications and received nothing" is now a number the owner
 * can read, not a silence.
 *
 * WHAT COUNTS: printed bills (tickets.printed_at) of that EAT day, cancelled
 * bills excluded — the EFD pile the owner counts against the drawer.
 */

/** How far back the owner's page reads (the list itself is filtered later). */
export const DAILY_SALES_WINDOW_DAYS = 90;

/** One eligible sale line total, placed on the EAT day it was printed/closed. */
export interface SoldRow {
  printedAt: SalesStamp;
  saleAt?: SalesStamp;
  totalAmount: number | null;
  status: string;
}

/** Days bucketed by the EAT calendar sale day (cancelled never counts). */
export function bucketByDay(rows: SoldRow[]): Map<string, { total: number; bills: number }> {
  const out = new Map<string, { total: number; bills: number }>();
  for (const row of rows) {
    if (row.status === "cancelled") continue;
    const day = etDayKey(row.saleAt || row.printedAt);
    if (!day) continue;
    const cur = out.get(day) ?? { total: 0, bills: 0 };
    cur.total += Number(row.totalAmount) || 0;
    cur.bills += 1;
    out.set(day, cur);
  }
  return out;
}

/**
 * Receipt-backed sales since the cutoff (newest first). Totals are recalculated
 * from each line's first qualifying receipt, never from a ticket total that can
 * also contain post-print additions. Reprints cannot move earlier lines into
 * today's total. Full-payment mode uses its paid/completed rule.
 */
export async function readPrintedBills(cutoff: Date): Promise<SoldRow[]> {
  let printQueueMode = true;
  try {
    const mode = await db.select({ value: siteSettings.value }).from(siteSettings).where(eq(siteSettings.key, "cashier_mode"));
    printQueueMode = String(mode[0]?.value || "print-queue") !== "full";
  } catch {
    /* unreadable setting → the default print-queue workflow */
  }

  const candidates = await db
    .select()
    .from(tickets)
    .where(
      or(
        gte(tickets.printedAt, cutoff),
        gte(tickets.closedAt, cutoff),
        gte(tickets.updatedAt, cutoff),
        gte(tickets.createdAt, cutoff)
      )
    );
  if (!candidates.length) return [];

  const ids = candidates.map((ticket) => ticket.id);
  const [items, printEvents] = await Promise.all([
    db.select().from(ticketItems).where(inArray(ticketItems.ticketId, ids)),
    db.select({
      ticketId: ticketEvents.ticketId,
      itemId: ticketEvents.itemId,
      eventType: ticketEvents.eventType,
      fromValue: ticketEvents.fromValue,
      toValue: ticketEvents.toValue,
      createdAt: ticketEvents.createdAt,
    })
      .from(ticketEvents)
      .where(and(inArray(ticketEvents.ticketId, ids), inArray(ticketEvents.eventType, ["ticket_printed", "item_quantity_changed"]))),
  ]);
  const itemsByTicket = new Map<number, typeof items>();
  for (const item of items) {
    const rows = itemsByTicket.get(item.ticketId) || [];
    rows.push(item);
    itemsByTicket.set(item.ticketId, rows);
  }
  const printEventsByTicket = new Map<number, SalesStamp[]>();
  const quantityEventsByTicket = new Map<number, SalesItemEventLike[]>();
  for (const event of printEvents) {
    if (event.eventType === "ticket_printed") {
      const rows = printEventsByTicket.get(event.ticketId) || [];
      rows.push(event.createdAt);
      printEventsByTicket.set(event.ticketId, rows);
    } else if (event.eventType === "item_quantity_changed") {
      const rows = quantityEventsByTicket.get(event.ticketId) || [];
      rows.push(event);
      quantityEventsByTicket.set(event.ticketId, rows);
    }
  }

  return candidates.flatMap((ticket) => {
    const lines = saleLinesForTicket(
      ticket,
      itemsByTicket.get(ticket.id) || [],
      printQueueMode,
      printEventsByTicket.get(ticket.id) || [],
      quantityEventsByTicket.get(ticket.id) || [],
    );
    // A ticket may have several incremental EFD receipts. Keep each receipt as
    // its own dated row so earlier lines stay on their original sale day.
    const receipts = new Map<number, { saleAt: SalesStamp; totalAmount: number }>();
    for (const line of lines) {
      if (!line.soldAt) continue;
      const time = new Date(String(line.soldAt)).getTime();
      if (!Number.isFinite(time) || time < cutoff.getTime()) continue;
      const receipt = receipts.get(time) || { saleAt: line.soldAt, totalAmount: 0 };
      receipt.totalAmount += (Number(line.item.price) || 0) * (Number(line.item.quantity) || 0);
      receipts.set(time, receipt);
    }
    return [...receipts.values()].map((receipt) => ({
      printedAt: ticket.printedAt,
      saleAt: receipt.saleAt,
      totalAmount: receipt.totalAmount,
      status: ticket.status,
    }));
  });
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
 * button. Always writes, so a late correction can be sent again, and the
 * caller always notifies.
 *
 * `mode: "auto"` — the system's own send. It also always writes: the owner's
 * snapshot rule means the automatic send carries the day's FINAL number, so
 * its record must replace whatever total an earlier tap produced. The
 * once-a-day latch is `claimAutoSendDay` below, not this write.
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

  await db
    .insert(siteSettings)
    .values({ key, value, updatedAt: at })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: at } });
  return { written: true, record };
}

/**
 * THE ONCE-A-DAY LATCH FOR THE AUTOMATIC SEND (3 Oct 2026).
 *
 * The marker row is inserted ON CONFLICT DO NOTHING, so of everything that
 * notices the notify time arriving in the same second (the minute worker, a
 * page load, the cashier's own screen) exactly ONE insert wins and only that
 * one notifies. It is deliberately NOT the close record: the cashier's taps
 * rewrite that row, and the automatic send has to survive them.
 */
export async function claimAutoSendDay(dayKey: string, now: Date = new Date()): Promise<boolean> {
  const inserted = await db
    .insert(siteSettings)
    .values({ key: dayCloseAutoSentKey(dayKey), value: now.toISOString(), updatedAt: now })
    .onConflictDoNothing({ target: siteSettings.key })
    .returning({ key: siteSettings.key });
  return inserted.length > 0;
}

/**
 * GIVE THE DAY BACK WHEN NOBODY ANSWERED (3 Oct 2026).
 *
 * A latch that is consumed by a send which reached no phone would leave the
 * owner waiting all evening for a total that had nowhere to go - and the fix
 * for "my phone is not armed yet" is something he does minutes later. So when
 * the send reaches nobody the marker is removed and the next minute tries
 * again: the system keeps asking until a phone answers, and latches only once
 * one does. That is also why this is safe: a phone that is armed for a moment
 * gets exactly one notification, because that one attempt succeeds and latches.
 */
export async function releaseAutoSendDay(dayKey: string): Promise<void> {
  try {
    await db.delete(siteSettings).where(sql`${siteSettings.key} = ${dayCloseAutoSentKey(dayKey)}`);
  } catch (error) {
    // Worst case the day stays latched and the owner's own button still works.
    console.warn(`[day-close] could not release the automatic send for ${dayKey}: ${String(error)}`);
  }
}

/** Has the system's own send already gone out for this EAT day? */
export async function autoSentForDay(dayKey: string): Promise<string | null> {
  try {
    const rows = await db
      .select()
      .from(siteSettings)
      .where(sql`${siteSettings.key} = ${dayCloseAutoSentKey(dayKey)}`);
    return rows[0]?.value ? String(rows[0].value) : null;
  } catch {
    return null;
  }
}

/**
 * The ONE phone notification left in the cafe: the owner's daily total.
 *
 * It now RETURNS what the push service did. The caller (the cashier's tap, the
 * worker, the owner's own "send it to my phone now" button) waits for it and
 * can tell the reader the truth: "sent to 1 phone" or "no phone is armed yet",
 * instead of a cheerful success message for a push that went nowhere.
 */
export async function sendDayClosePush(
  dayKey: string,
  total: number,
  bills: number,
): Promise<PushSendResult> {
  const push = dayClosePush(dayKey, total, bills);
  const result = await sendPushToRoles(["admin"], {
    title: push.title,
    body: push.body,
    tag: push.tag,
    url: push.url,
    // A NORMAL notification (owner's wording): it rings once like any other
    // phone notification, shows the date and the total, and can be swiped
    // away — it is not one of the old "stays on the lock screen" staff alerts.
    urgent: false,
    repeat: 0,
  }).catch(() => ({ attempted: 0, sent: 0, failed: 0, removed: 0, noSubscribers: true }));

  if (result.sent > 0) {
    console.log(
      `[day-close] ${dayKey}: ${total} ETB on ${bills} bill(s) sent to ${result.sent} owner phone(s)`,
    );
  } else {
    // THE MOST IMPORTANT LOG LINE IN THE APP: allowed notifications, nothing
    // arrived. It is written on every miss so the cause is in the server log
    // instead of nowhere.
    console.warn(
      `[day-close] ${dayKey}: ${total} ETB on ${bills} bill(s) was NOT delivered to any owner phone ` +
        `(tried ${result.attempted}, failed ${result.failed}, pruned ${result.removed}). ` +
        `The owner must open the Daily Sales page and press "Turn on notifications" on that phone.`,
    );
  }
  return result;
}

/**
 * THE AUTOMATIC SEND (owner: "if she forgets to click that button the system
 * will automatically send that notification after 1 hour").
 *
 * Called every minute by the background worker and, as a safety net, whenever
 * the Daily Sales page is loaded. Returns what it did, so the caller can log it.
 *
 * "closed" is a DONE answer, not a failure: it means the system's own send
 * already went out today (someone else won the latch). "unarmed" is the one
 * that needs a human: the total was added up and recorded, but no phone was
 * registered to hear it.
 */
export async function maybeAutoCloseDay(now: Date = new Date()): Promise<
  "early" | "closed" | "sent" | "unarmed" | "error"
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

    // THE DAY'S FINAL NUMBER (owner, 3 Oct 2026). Note what is NOT checked
    // here any more: a close record from an earlier tap no longer blocks the
    // send. The cashier tapping at 20:03 does not end the day, so the total
    // at 21:03 can be bigger, and that bigger number is the one the owner
    // reconciles against the drawer. The latch below keeps it to one a day.
    //
    // ORDER MATTERS: the bills are added up BEFORE the day is claimed, so a
    // database hiccup here leaves the latch free and the next minute retries.
    const totals = await todayTotals(dayKey);
    if (!(await claimAutoSendDay(dayKey, now))) return "closed"; // another process sent it

    const { record } = await recordDayClose({
      dayKey,
      by: AUTO_CLOSE_BY,
      total: totals.total,
      bills: totals.bills,
      mode: "auto",
    });
    const push = await sendDayClosePush(dayKey, record.total, record.bills);
    if (push.sent > 0) return "sent";
    // No phone answered: hand the day back so the system keeps asking until
    // the owner has armed one (see releaseAutoSendDay).
    await releaseAutoSendDay(dayKey);
    return "unarmed";
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
 * safe if the process is replaced: the once-a-day latch lives in the database,
 * so a late start still sees whether the system already sent today's final
 * number.
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
      } else if (result === "unarmed") {
        // sendDayClosePush already logged the detail; this is the "nobody is
        // listening" marker, once a day, on the owner's own daily total.
        console.warn(
          `[day-close] automatic send had no armed phone at ${dayKeyLabel(etDayKey(new Date()) || "")}`,
        );
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
export {
  DAY_CLOSE_KEY_PREFIX,
  dayCloseAutoSentKey,
  dayCloseCutoffHour,
  dayCloseSettingKey,
  dayKeyFromCloseSetting,
};
