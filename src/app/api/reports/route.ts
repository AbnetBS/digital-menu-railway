import { NextResponse } from "next/server";
import { db } from "@/db";
import { tickets, ticketItems, categories } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { inArray, or, gt } from "drizzle-orm";
import { requireAdmin } from "@/lib/session";

function isToday(d: Date | string | null | undefined): boolean {
  if (!d) return false;
  const date = new Date(d);
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

function isYesterday(d: Date | string | null | undefined): boolean {
  if (!d) return false;
  const date = new Date(d);
  const y = new Date();
  y.setDate(y.getDate() - 1);
  return date.getFullYear() === y.getFullYear() && date.getMonth() === y.getMonth() && date.getDate() === y.getDate();
}

function isWithinDays(d: Date | string | null | undefined, days: number): boolean {
  if (!d) return false;
  const date = new Date(d);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  return diff >= 0 && diff < days * 24 * 60 * 60 * 1000;
}

export async function GET() {
  const __auth = await requireAdmin();
  if (!__auth.ok) return __auth.response;
  await ensureTablesExist();
  try {
    // PERFORMANCE: every figure in this report only spans the last 30 days —
    // scope the tickets query in SQL (instead of loading the entire table forever)
    // and fetch items ONLY for those tickets.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);

    const allTickets = await db
      .select()
      .from(tickets)
      .where(
        or(
          gt(tickets.createdAt, cutoff),
          gt(tickets.updatedAt, cutoff),
          gt(tickets.closedAt, cutoff)
        )
      );

    const cats = await db.select().from(categories);

    // Revenue counts tickets that reached payment confirmation (completed/paid)
    const revenueTickets = allTickets.filter((t) => t.status === "completed" || t.status === "paid");
    const ticketDate = (t: (typeof allTickets)[number]) => t.closedAt || t.updatedAt || t.createdAt;

    const todayTickets = revenueTickets.filter((t) => isToday(ticketDate(t)));
    const yesterdayTickets = revenueTickets.filter((t) => isYesterday(ticketDate(t)));
    const weekTickets = revenueTickets.filter((t) => isWithinDays(ticketDate(t), 7));
    const monthTickets = revenueTickets.filter((t) => isWithinDays(ticketDate(t), 30));

    const todayRevenue = todayTickets.reduce((s, t) => s + (t.totalAmount || 0), 0);
    const yesterdayRevenue = yesterdayTickets.reduce((s, t) => s + (t.totalAmount || 0), 0);
    const weeklyRevenue = weekTickets.reduce((s, t) => s + (t.totalAmount || 0), 0);
    const monthlyRevenue = monthTickets.reduce((s, t) => s + (t.totalAmount || 0), 0);
    const todayOrders = todayTickets.length;
    const averageOrderValue = todayOrders > 0 ? Math.round(todayRevenue / todayOrders) : 0;

    // GROUP 4 / ITEM 2 — scope item reads to what the report ACTUALLY uses:
    //  • popular-items & category-sales need items of TODAY'S revenue tickets only
    //  • order history needs items of the newest 200 closed tickets only
    // (Previously ALL 30-day tickets' items were loaded into memory just to filter
    //  down to these two subsets — e.g. ~27k rows for a 9k-ticket month when ~2k
    //  were used.)
    const todayTicketIds = new Set(todayTickets.map((t) => t.id));

    const orderHistoryTickets = allTickets
      .filter((t) => t.status === "paid" || t.status === "completed" || t.status === "cancelled")
      .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
      .slice(0, 200);
    const historyTicketIds = orderHistoryTickets.map((t) => t.id);

    const [todayItems, historyItems] = await Promise.all([
      todayTicketIds.size > 0
        ? db.select().from(ticketItems).where(inArray(ticketItems.ticketId, [...todayTicketIds]))
        : Promise.resolve([]),
      historyTicketIds.length > 0
        ? db.select().from(ticketItems).where(inArray(ticketItems.ticketId, historyTicketIds))
        : Promise.resolve([]),
    ]);

    // Peak selling hours — orders grouped by hour of the day (today)
    const hourAgg: Array<{ hour: number; orders: number; revenue: number }> = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      orders: 0,
      revenue: 0,
    }));
    for (const t of todayTickets) {
      const d = new Date(ticketDate(t) as Date);
      const h = d.getHours();
      hourAgg[h].orders += 1;
      hourAgg[h].revenue += t.totalAmount || 0;
    }
    const hourlySales = hourAgg.filter((h) => h.orders > 0);
    const peakHour =
      hourlySales.length > 0 ? hourlySales.reduce((a, b) => (b.revenue > a.revenue ? b : a), hourlySales[0]) : null;

    // Popular items (from today's revenue tickets, non-removed)
    const itemAgg = new Map<string, { quantity: number; revenue: number }>();
    for (const it of todayItems) {
      if (!todayTicketIds.has(it.ticketId) || it.removed) continue;
      const cur = itemAgg.get(it.name) || { quantity: 0, revenue: 0 };
      cur.quantity += it.quantity;
      cur.revenue += it.price * it.quantity;
      itemAgg.set(it.name, cur);
    }
    const categoryNames = cats.filter((c) => c.slug !== "all").map((c) => ({ slug: c.slug, name: c.name }));
    const itemToCatName = (slug: string | null | undefined) =>
      categoryNames.find((c) => c.slug === slug)?.name || slug || "General";

    const popularItems = Array.from(itemAgg.entries())
      .map(([name, v]) => ({ name, quantity: v.quantity, revenue: v.revenue }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 8);

    // Sales by category
    const catAgg = new Map<string, number>();
    for (const it of todayItems) {
      if (!todayTicketIds.has(it.ticketId) || it.removed) continue;
      const cName = itemToCatName(it.category);
      catAgg.set(cName, (catAgg.get(cName) || 0) + it.price * it.quantity);
    }
    const categorySales = Array.from(catAgg.entries())
      .map(([category, revenue]) => ({ category, revenue }))
      .sort((a, b) => b.revenue - a.revenue);

    // Payment method statistics
    const payAgg = new Map<string, { count: number; revenue: number }>();
    for (const t of todayTickets) {
      const m = t.paymentMethod || "cash";
      const cur = payAgg.get(m) || { count: 0, revenue: 0 };
      cur.count += 1;
      cur.revenue += t.totalAmount || 0;
      payAgg.set(m, cur);
    }
    const paymentStats = Array.from(payAgg.entries()).map(([method, v]) => ({
      method,
      count: v.count,
      revenue: v.revenue,
    }));

    // Receipt METADATA list only — photos load on demand via /api/tickets/receipt?id=
    const receipts = revenueTickets
      .filter((t) => t.receiptImage)
      .map((t) => ({
        id: t.id,
        tableName: t.tableName,
        method: t.paymentMethod || "online",
        totalAmount: t.totalAmount || 0,
        closedAt: t.closedAt ? String(t.closedAt) : null,
      }))
      .slice(0, 30);

    // Full order history (completed/paid/cancelled), newest first, with items + payment + receipt
    // Items come from the scoped historyItems query (bounded to these 200 tickets).
    const orderHistory = orderHistoryTickets.map((t) => ({
      ...t,
      items: historyItems.filter((i) => i.ticketId === t.id),
    }));

    return NextResponse.json({
      todayRevenue,
      yesterdayRevenue,
      weeklyRevenue,
      monthlyRevenue,
      todayOrders,
      yesterdayOrders: yesterdayTickets.length,
      weekOrders: weekTickets.length,
      monthOrders: monthTickets.length,
      averageOrderValue,
      popularItems,
      categorySales,
      paymentStats,
      receipts,
      orderHistory,
      hourlySales,
      peakHour,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
