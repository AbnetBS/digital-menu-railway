import { NextResponse } from "next/server";
import { db } from "@/db";
import { attendanceLogs, attendanceMembers, attendanceRoles } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { etDayKey, etDayKeyDaysAgo } from "@/lib/timezone";
import { and, gte, lte } from "drizzle-orm";
import {
  SHEET_RANGE_MAX_DAYS,
  buildLeaderboard,
  hoursLabel,
  sheetDates,
  wholeHoursOf,
} from "@/lib/attendance";

/**
 * ADMIN -> ATTENDANCE -> LEADERBOARD (owner, Oct 2026).
 *
 * "add 1 category that says leaderboard that shows highest time that is spent
 * in work for example
 *      role (can be waiter)
 *      1, alem  -  40 hours
 *      2, abel  -  36 hours
 *  like this category by role then the name with rank"
 *
 * So: one card per ROLE, and inside it the people of that role ranked by the
 * hours they spent at work in the chosen range. The hours are the ones the
 * sheet is made of (IN -> OUT of every day), plus the day that is still open
 * right now, which is marked "still in" instead of being hidden until the
 * person scans out.
 *
 * The range follows the paper sheet's: at most SHEET_RANGE_MAX_DAYS (30) days,
 * and it defaults to the last 30 days so the tab says something the first time
 * it is opened.
 */

export async function GET(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  await ensureTablesExist();

  try {
    const { searchParams } = new URL(request.url);
    const today = etDayKey(new Date()) || new Date().toISOString().slice(0, 10);
    const from = searchParams.get("from") || etDayKeyDaysAgo(SHEET_RANGE_MAX_DAYS - 1) || today;
    const to = searchParams.get("to") || today;
    const roleIdFilter = searchParams.get("roleId");
    const now = new Date();

    // The same window helper the paper sheet uses: reversed ranges are turned
    // the right way up and a longer ask is cut back to 30 days.
    const dates = sheetDates(from, to);
    if (dates.length === 0) {
      return NextResponse.json({ error: "A from and a to date are required" }, { status: 400 });
    }

    const [members, roles, logs] = await Promise.all([
      db.select().from(attendanceMembers),
      db.select().from(attendanceRoles),
      db
        .select()
        .from(attendanceLogs)
        .where(and(gte(attendanceLogs.date, dates[0]), lte(attendanceLogs.date, dates[dates.length - 1]))),
    ]);

    const roleName = new Map(roles.map((r) => [r.id, r.name]));
    const people = members
      .filter((m) => m.active !== false)
      .filter((m) => !roleIdFilter || String(m.roleId ?? "") === String(roleIdFilter))
      .map((m) => ({
        id: m.id,
        name: m.name,
        roleId: m.roleId,
        // A log keeps the role it was written under, but the board groups the
        // people by the role they have NOW: that is the card the owner reads.
        roleName: m.roleId ? roleName.get(m.roleId) || "No role" : "No role",
      }));

    const seen = new Set(people.map((p) => p.id));
    const groups = buildLeaderboard(
      // A line of somebody who left the list (or of another role when a filter
      // is on) is not counted: the cards show the people on the list now.
      logs.filter((l) => l.memberId !== null && seen.has(l.memberId)),
      people,
      now
    );

    const totalMinutes = groups.reduce((sum, g) => sum + g.totalMinutes, 0);

    return NextResponse.json({
      from: dates[0],
      to: dates[dates.length - 1],
      days: dates.length,
      maxRangeDays: SHEET_RANGE_MAX_DAYS,
      generatedAt: now.toISOString(),
      roles: roles.map((r) => ({ id: r.id, name: r.name })),
      groups: groups.map((g) => ({
        ...g,
        totalHours: hoursLabel(g.totalMinutes),
        rows: g.rows.map((row) => ({ ...row, wholeHours: wholeHoursOf(row.totalMinutes) })),
      })),
      totals: {
        people: groups.reduce((sum, g) => sum + g.rows.length, 0),
        minutes: totalMinutes,
        hours: hoursLabel(totalMinutes),
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
