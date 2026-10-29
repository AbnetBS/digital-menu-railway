import { NextResponse } from 'next/server';
import { pool } from '@/db';
import { ensureTablesExist } from '@/db/migrate';
import {
  readStaffSession,
  requireStaff,
  refreshStoreSession,
} from '@/lib/session';
import { ensureStoreSchema } from '@/lib/store/schema';
import { isDimension, toBase, type Dimension } from '@/lib/store/units';

const roles = ['kitchen', 'barista', 'juice'];
async function session() {
  const s = await readStaffSession();
  if (!s || !roles.includes(s.role)) return null;
  const user = await pool.query(
    'SELECT name,role FROM staff_users WHERE id=$1',
    [s.staffId],
  );
  return user.rows[0]?.role === s.role
    ? { station: s.role, name: String(user.rows[0].name) }
    : null;
}
class Invalid extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
function qty(value: unknown, unit: unknown, dim: Dimension) {
  try {
    return toBase(value, unit, dim);
  } catch (e) {
    throw new Invalid(e instanceof Error ? e.message : 'Invalid amount');
  }
}
function fail(e: unknown) {
  if (e instanceof Invalid)
    return NextResponse.json({ error: e.message }, { status: e.status });
  console.error('[station stock]', e);
  return NextResponse.json(
    { error: 'Could not save station stock. Please try again.' },
    { status: 500 },
  );
}
async function ready() {
  const result = await ensureTablesExist();
  if (!result.success) throw new Error('Database migration failed');
  await ensureStoreSchema();
}
export async function GET() {
  const guard = await requireStaff();
  if (!guard.ok) return guard.response;
  if (!roles.includes(guard.session.role))
    return NextResponse.json(
      { error: 'Station login required' },
      { status: 403 },
    );
  try {
    await ready();
    const who = await session();
    if (!who) throw new Invalid('Station session expired', 401);
    const [items, history] = await Promise.all([
      pool.query(
        'SELECT i.id,i.name,i.dimension,i.image,COALESCE(b.balance,0) AS station_balance FROM store_items i LEFT JOIN store_station_balances b ON b.item_id=i.id AND b.station=$1 ORDER BY i.name',
        [who.station],
      ),
      pool.query(
        "SELECT m.id,m.kind,m.amount,m.reason,m.actor,m.created_at,i.name,i.dimension FROM store_movements m JOIN store_items i ON i.id=m.item_id WHERE m.station=$1 AND (m.kind='waste' OR (m.kind='purchase' AND m.reason='Direct station import')) ORDER BY m.created_at DESC LIMIT 100",
        [who.station],
      ),
    ]);
    return refreshStoreSession(
      NextResponse.json(
        { who, items: items.rows, history: history.rows },
        { headers: { 'Cache-Control': 'no-store' } },
      ),
      guard.session,
    );
  } catch (e) {
    return fail(e);
  }
}
export async function POST(request: Request) {
  const guard = await requireStaff();
  if (!guard.ok) return guard.response;
  if (!roles.includes(guard.session.role))
    return NextResponse.json(
      { error: 'Station login required' },
      { status: 403 },
    );
  try {
    await ready();
    const who = await session();
    if (!who) throw new Invalid('Station session expired', 401);
    const b = await request.json();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (!['new_import', 'import', 'waste'].includes(b.action))
        throw new Invalid('Unknown action');
      const key = String(b.key || '');
      if (!/^[0-9a-f-]{36}$/i.test(key))
        throw new Invalid('Invalid operation key');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      const previous = await client.query(
        'SELECT p.station,p.actor,p.kind,p.reason,p.amount,p.item_id,i.name,i.dimension FROM store_station_imports p JOIN store_items i ON i.id=p.item_id WHERE p.idempotency_key=$1',
        [key],
      );
      if (previous.rowCount) {
        const p = previous.rows[0],
          expectedKind = b.action === 'waste' ? 'waste' : 'import';
        const sameItem =
          b.action === 'new_import'
            ? String(b.name || '').trim() === p.name &&
              b.dimension === p.dimension
            : Number(b.itemId) === p.item_id;
        const sameReason =
          expectedKind !== 'waste' ||
          String(b.reason || '')
            .trim()
            .slice(0, 300) === p.reason;
        if (
          p.station !== who.station ||
          p.actor !== who.name ||
          p.kind !== expectedKind ||
          !sameItem ||
          !sameReason ||
          qty(b.amount, b.unit, p.dimension) !== Number(p.amount)
        )
          throw new Invalid(
            'This operation was already saved with different details. Start a new entry.',
            409,
          );
        await client.query('COMMIT');
        return NextResponse.json({ success: true });
      }
      let i: { id: number; name: string; dimension: Dimension };
      if (b.action === 'new_import') {
        const name = String(b.name || '')
          .trim()
          .slice(0, 120);
        if (!name || !isDimension(b.dimension))
          throw new Invalid('Enter an item name and measurement type');
        const image = String(b.image || '');
        if (
          image.length > 2000000 ||
          (image &&
            !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image))
        )
          throw new Invalid('Choose a JPEG, PNG or WebP photo under 1.5 MB');
        const created = await client.query(
          'INSERT INTO store_items(name,dimension,image) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id,name,dimension',
          [name, b.dimension, image],
        );
        if (!created.rowCount)
          throw new Invalid(
            'This name already exists. Select it under Add stock instead.',
            409,
          );
        i = created.rows[0];
      } else {
        const id = Number(b.itemId);
        if (!Number.isSafeInteger(id) || id <= 0)
          throw new Invalid('Choose an item');
        const r = await client.query(
          'SELECT id,name,dimension FROM store_items WHERE id=$1',
          [id],
        );
        if (!r.rowCount) throw new Invalid('Item not found', 404);
        i = r.rows[0];
      }
      const amount = qty(b.amount, b.unit, i.dimension);
      if (b.action === 'new_import' || b.action === 'import') {
        const inserted = await client.query(
          'INSERT INTO store_station_imports(idempotency_key,station,item_id,amount,actor) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING idempotency_key',
          [key, who.station, i.id, amount, who.name],
        );
        if (inserted.rowCount) {
          await client.query(
            'INSERT INTO store_station_balances(station,item_id,balance) VALUES($1,$2,$3) ON CONFLICT(station,item_id) DO UPDATE SET balance=store_station_balances.balance+EXCLUDED.balance',
            [who.station, i.id, amount],
          );
          await client.query(
            "INSERT INTO store_movements(item_id,station,kind,amount,actor,reason) VALUES($1,$2,'purchase',$3,$4,'Direct station import')",
            [i.id, who.station, amount, who.name],
          );
        }
      } else if (b.action === 'waste') {
        const reason = String(b.reason || '')
          .trim()
          .slice(0, 300);
        if (!reason) throw new Invalid('Enter a reason');
        const r = await client.query(
          'SELECT balance FROM store_station_balances WHERE station=$1 AND item_id=$2 FOR UPDATE',
          [who.station, i.id],
        );
        if (!r.rowCount || Number(r.rows[0].balance) < amount)
          throw new Invalid('Waste is more than the station balance', 409);
        await client.query(
          "INSERT INTO store_station_imports(idempotency_key,station,item_id,amount,actor,kind,reason) VALUES($1,$2,$3,$4,$5,'waste',$6)",
          [key, who.station, i.id, amount, who.name, reason],
        );
        await client.query(
          'UPDATE store_station_balances SET balance=balance-$1 WHERE station=$2 AND item_id=$3',
          [amount, who.station, i.id],
        );
        await client.query(
          "INSERT INTO store_movements(item_id,station,kind,amount,actor,reason) VALUES($1,$2,'waste',$3,$4,$5)",
          [i.id, who.station, amount, who.name, reason],
        );
      } else throw new Invalid('Unknown action');
      await client.query('COMMIT');
      return NextResponse.json({ success: true });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    return fail(e);
  }
}
