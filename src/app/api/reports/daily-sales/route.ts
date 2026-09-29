import { NextResponse } from "next/server";
import { db } from "@/db";
import { siteSettings } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { sql } from "drizzle-orm";
import { readAdminSession, readStaffSession, requireStaffOrAdmin } from "@/lib/session";
import { etDayKey, etHour, etStartOfDaysAgo } from "@/lib/timezone";
import {
  DAY_CLOSE_NOTIFY_KEY,
  dayCloseCutoffHour,
  dayCloseNotifyHour,
  dayCloseSettingKey,
  dayKeyFromCloseSetting,
  isDayCloseDue,
  isDayCloseOpen,
  listedDayKeys,
  parseDayCloseValue,
  yesterdayKey,
  type DayCloseRecord,
} from "@/lib/daily-sales";
import {
  DAILY_SALES_WINDOW_DAYS,
  bucketByDay,
  maybeAutoCloseDay,
  readNotifyHour,
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
 *   TODAY and YESTERDAY plus every day that was closed since this feature
 *   started — the days before it were never fully recorded.
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
 *   { action: "set-notify-hour", hour: 21|22|23 }
 *     The OWNER's choice of when his phone rings (admin session only).
 *
 * Access: the dashboard (admin) reads the page and chooses the hour; the
 * cashier (or an admin acting for her) closes the day.
 */

/** The day-close state plus the listed days, shared by GET and the worker. */
async function buildState(now: Date) {
  const notifyHour = await readNotifyHour();
  const cutoffHour = dayCloseCutoffHour(notifyHour);
  const hour = etHour(now);
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
  }).map((dayKey) => ({
    dayKey,
    total: sales.get(dayKey)?.total ?? 0,
    bills: sales.get(dayKey)?.bills ?? 0,
    closed: closeMap.get(dayKey) || null,
  }));

  const today = sales.get(todayKey) ?? { total: 0, bills: 0 };
  return {
    notifyHour,
    cutoffHour,
    currentHour: hour,
    canClose: isDayCloseOpen(hour, cutoffHour),
    dueNow: isDayCloseDue(hour, notifyHour),
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

    /* ── THE OWNER CHOOSES WHEN HIS PHONE RINGS ─────────────────────────── */
    if (action === "set-notify-hour") {
      if (staff) {
        // Not the cashier's decision: it is the owner's phone and his hour.
        return NextResponse.json({ error: "Only the owner can change this" }, { status: 403 });
      }
      const hour = dayCloseNotifyHour(body?.hour);
      if (Number(body?.hour) !== hour) {
        return NextResponse.json({ error: "Choose 21:00, 22:00 or 23:00" }, { status: 400 });
      }
      const now = new Date();
      const value = String(hour);
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
    const notifyHour = await readNotifyHour();
    const cutoffHour = dayCloseCutoffHour(notifyHour);
    const hour = etHour(now);
    const isAuto = body?.auto === true;

    // The system's own send: allowed from the notify hour onwards, exactly
    // once per day (the record is written only if it is missing).
    if (isAuto) {
      const result = await maybeAutoCloseDay(now);
      const state = await buildState(now);
      return NextResponse.json({ ok: result === "sent", auto: true, result, ...state });
    }

    if (!isDayCloseOpen(hour, cutoffHour)) {
      return NextResponse.json(
        {
          error: `Today's shift end opens at ${String(cutoffHour).padStart(2, "0")}:00. Orders are still being served.`,
          cutoffHour,
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
