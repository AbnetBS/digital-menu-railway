import { NextResponse } from "next/server";
import { db } from "@/db";
import { ticketItems } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { and, eq, gte, lt, or } from "drizzle-orm";
import { readStaffSession } from "@/lib/session";
import { etStartOfDaysAgo } from "@/lib/timezone";

/** An action belongs to the day it was tapped, not the day the ticket was opened. */
export async function GET(request: Request) {
  const staff = await readStaffSession();
  if (!staff || !["barista", "kitchen", "juice"].includes(staff.role))
    return NextResponse.json({ error: "Station login required" }, { status: 403 });
  await ensureTablesExist();
  const params = new URL(request.url).searchParams;
  const period = params.get("period") || "today";
  const days = period === "yesterday" ? 1 : period === "dayBefore" ? 2 : 0;
  const start = etStartOfDaysAgo(period === "week" ? 6 : days);
  const end = period === "week" ? etStartOfDaysAgo(-1) : etStartOfDaysAgo(days - 1);
  const rows = await db.select().from(ticketItems).where(and(
    eq(ticketItems.stationName, staff.role), eq(ticketItems.removed, false),
    or(and(gte(ticketItems.stationAcceptedAt, start), lt(ticketItems.stationAcceptedAt, end)),
       and(gte(ticketItems.stationDoneAt, start), lt(ticketItems.stationDoneAt, end)))
  ));
  const groups = ["accepted", "done", "combined"] as const;
  const result = Object.fromEntries(groups.map((group) => {
    const pile = new Map<string, { quantity: number; amount: number; bills: Set<number> }>();
    for (const row of rows) {
      const accepted = row.stationAcceptedBy === staff.name && !!row.stationAcceptedAt && new Date(row.stationAcceptedAt) >= start && new Date(row.stationAcceptedAt) < end;
      const done = row.stationDoneBy === staff.name && !!row.stationDoneAt && new Date(row.stationDoneAt) >= start && new Date(row.stationDoneAt) < end;
      // Combined means accepted by this person, finished by a DIFFERENT person.
      if (!(group === "accepted" ? accepted : group === "done" ? done : accepted && !!row.stationDoneBy && row.stationDoneBy !== staff.name)) continue;
      const value = pile.get(row.name) || { quantity: 0, amount: 0, bills: new Set<number>() };
      value.quantity += row.quantity;
      value.amount += row.price * row.quantity;
      value.bills.add(row.ticketId);
      pile.set(row.name, value);
    }
    return [group, [...pile].map(([name, value]) => ({ name, quantity: value.quantity, amount: value.amount, bills: value.bills.size })).sort((a, b) => b.quantity - a.quantity)];
  }));
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
