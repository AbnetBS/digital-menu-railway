import { NextResponse } from "next/server";
import { db } from "@/db";
import { siteSettings } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { sql } from "drizzle-orm";
import { readAdminSession, readStaffSession, requireStaffOrAdmin } from "@/lib/session";
import { etDayKey, etHour, etMinute, etStartOfDaysAgo } from "@/lib/timezone";
import {
  DAY_CLOSE_NOTIFY_KEY,
  dayCloseCutoffTime,
  dayCloseMoment,
  dayCloseNotifyTime,
  dayCloseSettingKey,
  dayKeyFromCloseSetting,
  isDayCloseDue,
  isDayCloseOpen,
  isNotifyTime,
  listedDayKeys,
  notifyTimeValue,
  parseDayCloseValue,
  yesterdayKey,
  type DayCloseRecord,
} from "@/lib/daily-sales";
import {
  DAILY_SALES_WINDOW_DAYS,
  bucketByDay,
  maybeAutoCloseDay,
  readNotifyTime,
  readPrintedBills,
  recordDayClose,
  sendDayClosePush,
  todayTotals,
} from "@/lib/day-close";

/**
 * DAILY SALES + THE DAY CLOSE (owner's decisions, 29 Sept 2026).
 *
 * GET  /api/reports/daily-sales
 *   The owner's Daily Sales page, LIVE: today's figure is recomputed from the
 *   printed bills on every read ("whenever the owner opens that page it shows
 *   him the total price that got printed up to that time"). The list shows
 *   every day with a recent receipt-backed sale plus every saved close record,
 *   so dates before yesterday (including last week) stay available. Older close
 *   records supply their saved totals after they age out of live recalculation.
 *
 *   The answer also carries the two moments: the cutoff hour (the cashier's
 *   button appears, 20:00 default) and the owner's notify hour (the automatic
 *   send if she forgot, 21:00 default, chosen by the owner in this tab).
 *   Loading the page also runs the automatic-send check, so a page visit can
 *   never miss it.
 *
 * POST /api/reports/daily-sales
 *   { action: "day-close", auto?: boolean }
 *     The cashier's "Today's shift end" tap — refused before the cutoff hour,
 *     because orders are still being served. With auto:true it is the system's
 *     own send (recorded as "auto (system)", exactly once per day).
 *   { action: "set-notify-time", hour: 21, minute: 3 }
 *     The OWNER's choice of when his phone rings, to the MINUTE (admin session
 *     only). "make it look like i can add any time like 3:03 or any other" —
 *     any clock time in the evening window is accepted and stored as "21:03".
 *   { action: "set-notify-hour", hour: 21|22|23 }
 *     The same setting through the three quick picks (minute = 0).
 *
 * Access: the dashboard (admin) reads the page and chooses the hour; the
 * cashier (or an admin acting for her) closes the day.
 */

/** The day-close state plus the listed days, shared by GET and the worker. */
async function buildState(now: Date) {
  // The owner's EXACT time (hour + minute) — he may pick 21:03, not just 21:00.
  const notifyTime = await readNotifyTime();
  const cutoff = dayCloseCutoffTime(notifyTime);
  const notifyHour = notifyTime.hour;
  const notifyMinute = notifyTime.minute;
  const cutoffHour = cutoff.hour;
  const cutoffMinute = cutoff.minute;
  const hour = etHour(now);
  const minute = etMinute(now);
  const todayKey = etDayKey(now) || "";
  const yKey = yesterdayKey(now);

  // Today's figure, LIVE from the printed pile.
  const sales = bucketByDay(await readPrintedBills(etStartOfDaysAgo(DAILY_SALES_WINDOW_DAYS)));

  // The close records (which days were ever closed) + the notify-hour setting.
  const closeMap = new Map<string, DayCloseRecord>();
  try {
    const rows = await db
      .select()
      .from(siteSettings)
      .where(sql`${siteSettings.key} LIKE 'day_close_%'`);
    for (const row of rows) {
      const day = dayKeyFromCloseSetting(row.key);
      if (!day) continue;
      const record = parseDayCloseValue(row.value);
      if (record) closeMap.set(day, record);
    }
  } catch {
    /* a settings hiccup must never blank the owner's page */
  }

  const days = listedDayKeys({
    todayKey,
    yesterdayKey: yKey,
    closedKeys: closeMap.keys(),
    salesKeys: sales.keys(),
  }).map((dayKey) => {
    const closed = closeMap.get(dayKey) || null;
    const live = sales.get(dayKey);
    return {
      dayKey,
      // Older sales are preserved by the day-close record even after they age
      // out of the live recalculation window. Recent days always use live lines.
      total: live?.total ?? closed?.total ?? 0,
      bills: live?.bills ?? closed?.bills ?? 0,
      closed,
    };
  });

  const today = sales.get(todayKey) ?? { total: 0, bills: 0 };
  return {
    notifyHour,
    notifyMinute,
    /** "21:03" — the exact moment the owner's phone rings, ready to print. */
    notifyAt: dayCloseMoment(notifyHour, notifyMinute),
    cutoffHour,
    cutoffMinute,
    /** "20:03" — the exact moment the cashier's button opens. */
    cutoffAt: dayCloseMoment(cutoffHour, cutoffMinute),
    currentHour: hour,
    currentMinute: minute,
    canClose: isDayCloseOpen(hour, cutoffHour, minute, cutoffMinute),
    dueNow: isDayCloseDue(hour, notifyHour, minute, notifyMinute),
    todayKey,
    today: { total: today.total, bills: today.bills, closed: closeMap.get(todayKey) || null },
    days,
  };
}

export async function GET() {
  const admin = await readAdminSession();
  if (!admin) {
    // The cashier needs the hours for her button; the page itself is the
    // owner's.
    const staff = await readStaffSession();
    if (!staff) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await ensureTablesExist();
  try {
    // SAFETY NET for the automatic send: the background worker runs every
    // minute, and this makes a page visit (the owner opening his tab, the
    // cashier's screen polling) do the same check — one record, one
    // notification, whatever runs first.
    void maybeAutoCloseDay().catch(() => {});

    const now = new Date();
    const state = await buildState(now);
    return NextResponse.json(
      { serverTime: now.toISOString(), ...state },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[daily-sales GET error]", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  // A staff session (the cashier) or the owner's own admin session.
  const guard = await requireStaffOrAdmin();
  if (!guard.ok) return guard.response;
  const staff = guard.session.kind === "staff" ? await readStaffSession() : null;
  await ensureTablesExist();
  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || "");

    /* ── THE OWNER CHOOSES WHEN HIS PHONE RINGS (to the minute) ───────────── */
    if (action === "set-notify-hour" || action === "set-notify-time") {
      if (staff) {
        // Not the cashier's decision: it is the owner's phone and his time.
        return NextResponse.json({ error: "Only the owner can change this" }, { status: 403 });
      }
      const hour = Math.floor(Number(body?.hour));
      // "set-notify-hour" is the three quick picks and carries no minute; the
      // typed value ("any time like 3:03") arrives as "set-notify-time".
      const minute = action === "set-notify-time" ? Math.floor(Number(body?.minute ?? 0)) : 0;
      if (!isNotifyTime(hour, minute)) {
        return NextResponse.json(
          { error: "Choose a time between 12:00 PM and 11:59 PM EAT, for example 21:03" },
          { status: 400 },
        );
      }
      const now = new Date();
      const value = notifyTimeValue({ hour, minute });
      await db
        .insert(siteSettings)
        .values({ key: DAY_CLOSE_NOTIFY_KEY, value, updatedAt: now })
        .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: now } });
      const state = await buildState(now);
      return NextResponse.json({ ok: true, ...state });
    }

    if (action !== "day-close") {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
    // The cashier closes the day; the owner may act for her (admin session).
    if (staff && staff.role !== "cashier") {
      return NextResponse.json({ error: "Cashier role required" }, { status: 403 });
    }

    const now = new Date();
    const cutoff = dayCloseCutoffTime(await readNotifyTime());
    const cutoffHour = cutoff.hour;
    const hour = etHour(now);
    const minute = etMinute(now);
    const isAuto = body?.auto === true;

    // The system's own send: allowed from the notify minute onwards, exactly
    // once per day (the record is written only if it is missing).
    if (isAuto) {
      const result = await maybeAutoCloseDay(now);
      const state = await buildState(now);
      return NextResponse.json({ ok: result === "sent", auto: true, result, ...state });
    }

    if (!isDayCloseOpen(hour, cutoffHour, minute, cutoff.minute)) {
      return NextResponse.json(
        {
          error: `Today's shift end opens at ${dayCloseMoment(cutoffHour, cutoff.minute)}. Orders are still being served.`,
          cutoffHour,
          cutoffAt: dayCloseMoment(cutoffHour, cutoff.minute),
          currentHour: hour,
        },
        { status: 409 }
      );
    }

    const todayKey = etDayKey(now) || "";
    if (!todayKey) return NextResponse.json({ error: "Could not read today's date" }, { status: 500 });
    const totals = await todayTotals(todayKey);
    const { record } = await recordDayClose({
      dayKey: todayKey,
      by: staff?.name || "admin",
      total: totals.total,
      bills: totals.bills,
      mode: "manual",
    });

    // THE OWNER'S PHONE: the one notification left in the whole system.
    sendDayClosePush(todayKey, record.total, record.bills);

    return NextResponse.json({
      ok: true,
      dayKey: todayKey,
      total: record.total,
      bills: record.bills,
      closed: record,
      ...(await buildState(now)),
    });
  } catch (error) {
    console.error("[daily-sales POST error]", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

/** Re-exported so the verifier can assert the settings key in one place. */
export { dayCloseSettingKey };
