import { NextResponse } from "next/server";
import { db } from "@/db";
import { tickets, ticketItems, orderSubmissions, ticketEvents, staffUsers, siteSettings } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { inArray, or, gt, eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/session";
import { etDayKeyDaysAgo, etStartOfDaysAgo } from "@/lib/timezone";
import {
  buildShiftReport,
  DEFAULT_SHIFT_SPLIT_HOUR,
  SHIFT_DATES,
  SHIFT_DATE_LENGTH,
  SHIFT_DATE_START_DAYS_AGO,
  SHIFT_ROLES,
  type ShiftDate,
  type ShiftRole,
} from "@/lib/shift-report";

/**
 * SHIFT REPORT — GET /api/reports/shifts?role=waiter&date=today
 *
 * Who did what, per shift, for one role and one date window. The shift change
 * hour is an owner setting (site_settings.shift_split_hour, default 14 =
 * 8:00 on the Ethiopian clock) and can be changed with POST { splitHour }.
 */
const SPLIT_KEY = "shift_split_hour";

async function readSplitHour(): Promise<number> {
  try {
    const rows = await db.select().from(siteSettings).where(eq(siteSettings.key, SPLIT_KEY));
    const n = Number(rows[0]?.value);
    return Number.isInteger(n) && n >= 1 && n <= 23 ? n : DEFAULT_SHIFT_SPLIT_HOUR;
  } catch {
    return DEFAULT_SHIFT_SPLIT_HOUR;
  }
}

export async function GET(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  const params = new URL(request.url).searchParams;
  const rawRole = params.get("role") as ShiftRole | null;
  const role: ShiftRole = rawRole && SHIFT_ROLES.includes(rawRole) ? rawRole : "waiter";
  const rawDate = params.get("date") as ShiftDate | null;
  const date: ShiftDate = rawDate && SHIFT_DATES.includes(rawDate) ? rawDate : "today";

  try {
    const splitHour = await readSplitHour();
    const startDaysAgo = SHIFT_DATE_START_DAYS_AGO[date];
    const dayKeys: string[] = [];
    for (let i = 0; i < SHIFT_DATE_LENGTH[date]; i++) {
      const k = etDayKeyDaysAgo(startDaysAgo - i);
      if (k) dayKeys.push(k);
    }
    // Any bill touched since the window started (a bill opened the evening
    // before and printed this morning still belongs to this morning).
    const cutoff = etStartOfDaysAgo(startDaysAgo);
    const ticketRows = await db
      .select()
      .from(tickets)
      .where(
        or(
          gt(tickets.createdAt, cutoff),
          gt(tickets.updatedAt, cutoff),
          gt(tickets.printedAt, cutoff),
          gt(tickets.closedAt, cutoff)
        )
      );
    const ids = ticketRows.map((t) => t.id);
    const [items, events, submissions, staff] = await Promise.all([
      ids.length ? db.select().from(ticketItems).where(inArray(ticketItems.ticketId, ids)) : Promise.resolve([]),
      ids.length ? db.select().from(ticketEvents).where(inArray(ticketEvents.ticketId, ids)) : Promise.resolve([]),
      ids.length ? db.select().from(orderSubmissions).where(inArray(orderSubmissions.ticketId, ids)) : Promise.resolve([]),
      db.select({ name: staffUsers.name, role: staffUsers.role }).from(staffUsers),
    ]);
    const staffRoles: Record<string, string> = {};
    for (const s of staff) if (s.name) staffRoles[String(s.name).trim()] = s.role;

    const report = buildShiftReport({
      role,
      date,
      splitHour,
      dayKeys,
      tickets: ticketRows,
      items,
      events,
      submissions,
      staffRoles,
    });
    return NextResponse.json(
      { ...report, dayKeys, staff: staff.filter((s) => s.role === role).map((s) => s.name) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  try {
    const body = await request.json();
    const n = Number(body?.splitHour);
    if (!Number.isInteger(n) || n < 1 || n > 23) {
      return NextResponse.json({ error: "splitHour must be a whole hour 1-23" }, { status: 400 });
    }
    await db
      .insert(siteSettings)
      .values({ key: SPLIT_KEY, value: String(n) })
      .onConflictDoUpdate({ target: siteSettings.key, set: { value: String(n), updatedAt: new Date() } });
    return NextResponse.json({ ok: true, splitHour: n });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
