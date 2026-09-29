import { NextResponse } from "next/server";
import { db } from "@/db";
import { siteSettings, tickets } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { and, desc, gt, isNotNull, sql } from "drizzle-orm";
import { readAdminSession, readStaffSession, requireStaffOrAdmin } from "@/lib/session";
import { sendPushToRoles } from "@/lib/push";
import { etDayKey, etHour, etStartOfDaysAgo } from "@/lib/timezone";
import {
  dayCloseCutoffHour,
  dayClosePush,
  dayCloseSettingKey,
  dayKeyFromCloseSetting,
  isDayCloseOpen,
  parseDayCloseValue,
  type DayCloseRecord,
} from "@/lib/daily-sales";

/**
 * DAILY SALES + THE DAY CLOSE (owner's decision, 29 Sept 2026).
 *
 * GET  /api/reports/daily-sales
 *   The owner's Daily Sales page: one line per date, newest first —
 *   "29 Sep 2026 • 12,450 ETB". A sale is a bill the cashier PRINTED (the EFD
 *   receipt moment); cancelled bills never count. The answer also carries the
 *   closing-hour state (the "Today's shift end" button opens at the closing
 *   hour, five hours after the configured shift change) and, for each day, who
 *   closed it and when.
 *
 * POST /api/reports/daily-sales { action: "day-close" }
 *   The cashier's "Today's shift end" tap. Records today's total and sends ONE
 *   notification to the OWNER's phone ("💰 Today's total sale • 12,450 ETB"),
 *   which opens this page. Before the closing hour the tap is refused, so the
 *   total can never be sent while orders are still being served.
 *
 * Access: the dashboard (admin) reads the page; the cashier (or an admin
 * acting for her) closes the day.
 *
 * THE SAME MONEY RULE AS THE REPORTS. A bill is a sale the moment the cashier
 * keyed it into the EFD and printed it (tickets.printed_at) — the paper the
 * owner counts against the drawer. This route therefore reads exactly the pile
 * /api/reports calls "printed today": printed_at is set and the bill is not
 * cancelled. Days are bucketed with etDayKey() on the Ethiopian wall clock, the
 * same helper the reports use, so the two pages can never disagree by a day.
 */

/**
 * HOW FAR BACK THE PAGE LISTS. 90 days covers a season of browsing and keeps
 * the read no heavier than the reports' own window, while the whole list stays
 * on one printed page for the usual month.
 */
const WINDOW_DAYS = 90;

/** The site_settings key holding the owner's shift-change hour. */
const SPLIT_KEY = "shift_split_hour";
const DEFAULT_SPLIT_HOUR = 14;

/** One printed bill, only the three columns the totals need. */
interface SoldRow {
  printedAt: Date | null;
  totalAmount: number | null;
  status: string;
}

/** Days bucketed by the EAT calendar day of the PRINT. */
function bucketByDay(rows: SoldRow[]): Map<string, { total: number; bills: number }> {
  const out = new Map<string, { total: number; bills: number }>();
  for (const row of rows) {
    if (row.status === "cancelled") continue; // a voided bill is never a sale
    const day = etDayKey(row.printedAt);
    if (!day) continue;
    const cur = out.get(day) ?? { total: 0, bills: 0 };
    cur.total += Number(row.totalAmount) || 0;
    cur.bills += 1;
    out.set(day, cur);
  }
  return out;
}

async function readSettings(): Promise<{ splitHour: number; closeMap: Map<string, DayCloseRecord> }> {
  const closeMap = new Map<string, DayCloseRecord>();
  try {
    const rows = await db
      .select()
      .from(siteSettings)
      .where(sql`${siteSettings.key} = ${SPLIT_KEY} OR ${siteSettings.key} LIKE 'day_close_%'`);
    let split = DEFAULT_SPLIT_HOUR;
    for (const row of rows) {
      if (row.key === SPLIT_KEY) {
        const n = Number(row.value);
        if (Number.isInteger(n) && n >= 1 && n <= 23) split = n;
        continue;
      }
      const day = dayKeyFromCloseSetting(row.key);
      if (!day) continue;
      const record = parseDayCloseValue(row.value);
      if (record) closeMap.set(day, record);
    }
    return { splitHour: split, closeMap };
  } catch {
    // A settings hiccup must never blank the owner's page.
    return { splitHour: DEFAULT_SPLIT_HOUR, closeMap };
  }
}

async function readPrintedBills(cutoff: Date): Promise<SoldRow[]> {
  return db
    .select({ printedAt: tickets.printedAt, totalAmount: tickets.totalAmount, status: tickets.status })
    .from(tickets)
    .where(and(isNotNull(tickets.printedAt), gt(tickets.printedAt, cutoff)))
    .orderBy(desc(tickets.printedAt));
}

export async function GET() {
  const admin = await readAdminSession();
  if (!admin) {
    // The cashier needs the closing-hour state for her button; the page itself
    // is the owner's.
    const staff = await readStaffSession();
    if (!staff) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await ensureTablesExist();
  try {
    const { splitHour, closeMap } = await readSettings();
    const cutoffHour = dayCloseCutoffHour(splitHour);
    const now = new Date();
    const todayKey = etDayKey(now) || "";
    const sales = bucketByDay(await readPrintedBills(etStartOfDaysAgo(WINDOW_DAYS)));
    const today = sales.get(todayKey) ?? { total: 0, bills: 0 };

    // One line per date, NEWEST FIRST. A day with a close record but no sale
    // rows (an empty day somebody closed) still appears, so the paper trail is
    // never silently missing.
    const dayKeys = [...new Set<string>([...sales.keys(), ...closeMap.keys(), todayKey].filter(Boolean))];
    dayKeys.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    const days = dayKeys.map((dayKey) => ({
      dayKey,
      total: sales.get(dayKey)?.total ?? 0,
      bills: sales.get(dayKey)?.bills ?? 0,
      closed: closeMap.get(dayKey) || null,
    }));

    return NextResponse.json(
      {
        serverTime: now.toISOString(),
        splitHour,
        cutoffHour,
        currentHour: etHour(now),
        canClose: isDayCloseOpen(etHour(now), cutoffHour),
        todayKey,
        today: { total: today.total, bills: today.bills, closed: closeMap.get(todayKey) || null },
        days,
      },
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
  // The cashier closes the day; the owner may act for her (admin session).
  if (staff && staff.role !== "cashier") {
    return NextResponse.json({ error: "Cashier role required" }, { status: 403 });
  }
  await ensureTablesExist();
  try {
    const body = await request.json().catch(() => ({}));
    if (String(body?.action || "") !== "day-close") {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
    const { splitHour } = await readSettings();
    const cutoffHour = dayCloseCutoffHour(splitHour);
    const now = new Date();
    const hour = etHour(now);
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
    const sales = bucketByDay(await readPrintedBills(etStartOfDaysAgo(1)));
    const today = sales.get(todayKey) ?? { total: 0, bills: 0 };

    const by = staff?.name || "admin";
    const record: DayCloseRecord = { at: now.toISOString(), by, total: today.total, bills: today.bills };
    const value = JSON.stringify(record);
    await db
      .insert(siteSettings)
      .values({ key: dayCloseSettingKey(todayKey), value, updatedAt: now })
      .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: now } });

    // THE OWNER'S PHONE: the one notification left in the whole system.
    const push = dayClosePush(todayKey, today.total, today.bills);
    void sendPushToRoles(["admin"], {
      title: push.title,
      body: push.body,
      tag: push.tag,
      url: push.url,
      urgent: true,
      repeat: 0,
    }).catch(() => {});

    return NextResponse.json({
      ok: true,
      dayKey: todayKey,
      total: today.total,
      bills: today.bills,
      closed: record,
    });
  } catch (error) {
    console.error("[daily-sales POST error]", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
