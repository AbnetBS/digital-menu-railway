import { NextResponse } from 'next/server';
import { pool } from '@/db';
import { readAdminSession, readStaffSession } from '@/lib/session';
import { ensureStoreSchema } from '@/lib/store/schema';

/** Reports are independently grouped in SQL so busy months are never truncated. */
export async function GET(request: Request) {
  try {
    const staff = await readStaffSession();
    const admin = await readAdminSession();
    if (
      staff?.role === 'stock_accepter' ||
      (!admin && staff?.role !== 'store_manager')
    )
      return NextResponse.json(
        { error: 'Manager access required' },
        { status: 403 },
      );
    await ensureStoreSchema();
    if (staff?.role === 'store_manager') {
      const account = await pool.query(
        "SELECT 1 FROM store_accounts a JOIN staff_users s ON s.id=a.staff_id WHERE s.id=$1 AND s.role='store_manager' AND extract(epoch from a.session_valid_after)*1000 <= $2",
        [staff.staffId, staff.iat],
      );
      if (!account.rowCount)
        return NextResponse.json(
          { error: 'Manager access required' },
          { status: 403 },
        );
    }
    const url = new URL(request.url),
      from = url.searchParams.get('from') || '',
      to = url.searchParams.get('to') || '';
    const valid = (d: string) =>
      /^\d{4}-\d{2}-\d{2}$/.test(d) &&
      !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) &&
      new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
    if (
      !valid(from) ||
      !valid(to) ||
      from > to ||
      Date.parse(to) - Date.parse(from) > 31 * 86400000
    )
      return NextResponse.json(
        { error: 'Choose a valid period of up to 32 days' },
        { status: 400 },
      );
    const bounds = [`${from}T00:00:00+03:00`, `${to}T00:00:00+03:00`];
    const [done, movements, waste] = await Promise.all([
      pool.query(
        `SELECT station, COALESCE(category,'Other') AS category,item_name, SUM(quantity)::int AS quantity, bool_or(missing_recipe) AS missing_recipe
        FROM store_done_events WHERE done_at >= $1::timestamptz AND done_at < $2::timestamptz + interval '1 day'
        GROUP BY station,category,item_name ORDER BY station,category,item_name`,
        bounds,
      ),
      pool.query(
        `SELECT m.station,m.kind,m.item_id,i.name,i.dimension,SUM(m.amount) AS amount
        FROM store_movements m JOIN store_items i ON i.id=m.item_id
        WHERE m.created_at >= $1::timestamptz AND m.created_at < $2::timestamptz + interval '1 day' AND (m.kind IN ('usage','waste') OR (m.kind='purchase' AND m.station IS NOT NULL AND m.reason='Direct station import'))
        GROUP BY m.station,m.kind,m.item_id,i.name,i.dimension ORDER BY m.station,m.kind,i.name`,
        bounds,
      ),
      pool.query(
        `SELECT m.id,m.station,m.amount,m.reason,m.actor,m.created_at,i.name,i.dimension
        FROM store_movements m JOIN store_items i ON i.id=m.item_id
        WHERE m.created_at >= $1::timestamptz AND m.created_at < $2::timestamptz + interval '1 day' AND m.kind='waste'
        ORDER BY m.created_at DESC`,
        bounds,
      ),
    ]);
    return NextResponse.json(
      { done: done.rows, movements: movements.rows, waste: waste.rows },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    console.error('[store report]', e);
    return NextResponse.json(
      { error: 'Could not load the store report' },
      { status: 500 },
    );
  }
}
