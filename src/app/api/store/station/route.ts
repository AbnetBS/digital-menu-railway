import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { pool } from '@/db';
import { ensureTablesExist } from '@/db/migrate';
import {
  readStationStockSession,
  requireStationStock,
  refreshStoreSession,
  type StationStockSession,
} from '@/lib/session';
import { ensureStoreSchema } from '@/lib/store/schema';
import { isDimension, toBase, type Dimension } from '@/lib/store/units';
import { publish, CHANNELS } from '@/lib/realtime';

const STATIONS = ['kitchen', 'barista', 'buna', 'juice', 'cleaning'];

async function verifyAccepter(s: StationStockSession | null) {
  if (!s || !STATIONS.includes(s.station)) return null;
  const r = await pool.query<{
    station: string;
    name: string;
    role: string;
    valid_after: string | number;
  }>(
    `SELECT a.station, s.name, s.role, extract(epoch from a.session_valid_after)*1000 AS valid_after
     FROM store_accounts a
     JOIN staff_users s ON s.id = a.staff_id
     WHERE s.id = $1 AND s.role = 'stock_accepter'`,
    [s.staffId],
  );
  const row = r.rows[0];
  if (
    !row ||
    row.station !== s.station ||
    Number(s.iat) < Number(row.valid_after)
  ) {
    return null;
  }
  return {
    id: s.staffId,
    station: String(row.station),
    name: String(row.name),
  };
}

async function loadAccepters(stationFilter: string) {
  const filter = STATIONS.includes(stationFilter) ? stationFilter : '';
  const r = await pool.query<{ id: number; name: string; station: string }>(
    `SELECT s.id, s.name, a.station
     FROM store_accounts a
     JOIN staff_users s ON s.id = a.staff_id
     WHERE s.role = 'stock_accepter' AND ($1::text = '' OR a.station = $1)
     ORDER BY a.station, s.name`,
    [filter],
  );
  return r.rows;
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

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const requestedStation = String(
      url.searchParams.get('station') || '',
    ).trim();
    await ready();
    const cookieSession = await readStationStockSession();
    const who = await verifyAccepter(cookieSession);

    if (
      !who ||
      (STATIONS.includes(requestedStation) && who.station !== requestedStation)
    ) {
      const accepters = await loadAccepters(requestedStation);
      return NextResponse.json(
        {
          error: 'Sign in with your Stock Accepter account',
          needsLogin: true,
          accepters,
        },
        { status: 401, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const [items, history] = await Promise.all([
      pool.query(
        `SELECT i.id,i.name,i.dimension,
          CASE WHEN left(i.image, 11) = 'data:image/' THEN '/api/store/images/' || i.id ELSE i.image END AS image,
          COALESCE(b.balance,0) AS station_balance
         FROM store_items i LEFT JOIN store_station_balances b ON b.item_id=i.id AND b.station=$1 ORDER BY i.name`,
        [who.station],
      ),
      pool.query(
        `SELECT m.id,m.kind,m.amount,m.reason,m.actor,m.created_at,i.name,i.dimension
         FROM store_movements m
         JOIN store_items i ON i.id=m.item_id
         WHERE m.station=$1
           AND (
             m.kind IN ('waste','transfer_out','transfer_in')
             OR (m.kind='purchase' AND m.reason='Direct station import')
           )
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT 100`,
        [who.station],
      ),
    ]);
    return refreshStoreSession(
      NextResponse.json(
        {
          who,
          stations: STATIONS.filter((s) => s !== who.station),
          items: items.rows,
          history: history.rows,
        },
        { headers: { 'Cache-Control': 'no-store' } },
      ),
      cookieSession,
    );
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request: Request) {
  const guard = await requireStationStock();
  if (!guard.ok) return guard.response;
  try {
    const [, b] = await Promise.all([ready(), request.json()]);
    const who = await verifyAccepter(guard.session);
    if (!who) throw new Invalid('Stock Accepter session expired. Please sign in again.', 401);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (!['new_import', 'import', 'waste', 'transfer'].includes(b.action))
        throw new Invalid('Unknown action');
      const key = String(b.key || '');
      if (!/^[0-9a-f-]{36}$/i.test(key))
        throw new Invalid('Invalid operation key');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

      if (b.action === 'transfer') {
        const toStation = String(b.toStation || '').trim();
        if (!STATIONS.includes(toStation) || toStation === who.station)
          throw new Invalid('Choose a destination station');
        if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 100)
          throw new Invalid('Add at least one stock item to transfer');

        const rawIds = b.lines.map((line: { itemId?: unknown }) => {
          const parsed = Number(line?.itemId);
          if (!Number.isSafeInteger(parsed) || parsed <= 0)
            throw new Invalid('Choose an item on every transfer line');
          return parsed;
        });
        const uniqueIds = Array.from(new Set(rawIds));
        if (uniqueIds.length !== rawIds.length)
          throw new Invalid('Each item may appear only once in a transfer');

        const catalogRes = await client.query<{
          id: number;
          name: string;
          dimension: Dimension;
        }>(
          'SELECT id,name,dimension FROM store_items WHERE id=ANY($1::int[])',
          [uniqueIds],
        );
        const catalog = new Map(
          catalogRes.rows.map((row) => [Number(row.id), row]),
        );

        const normalized: Array<{
          id: number;
          name: string;
          dimension: Dimension;
          amount: number;
        }> = [];
        for (let idx = 0; idx < b.lines.length; idx++) {
          const line = b.lines[idx];
          const itemRow = catalog.get(rawIds[idx]);
          if (!itemRow) throw new Invalid('Item not found', 404);
          normalized.push({
            id: itemRow.id,
            name: itemRow.name,
            dimension: itemRow.dimension,
            amount: qty(line.amount, line.unit, itemRow.dimension),
          });
        }
        normalized.sort((a, c) => a.id - c.id);

        const payloadHash = createHash('sha256')
          .update(
            JSON.stringify({
              from: who.station,
              to: toStation,
              actor: who.name,
              lines: normalized.map((l) => ({ id: l.id, amount: l.amount })),
            }),
          )
          .digest('hex');

        const prevTransfer = await client.query<{ payload_hash: string }>(
          'SELECT payload_hash FROM store_station_transfers WHERE idempotency_key=$1',
          [key],
        );
        if (prevTransfer.rowCount) {
          if (prevTransfer.rows[0].payload_hash !== payloadHash) {
            throw new Invalid(
              'This operation was already saved with different details. Start a new entry.',
              409,
            );
          }
          await client.query('COMMIT');
          return NextResponse.json({ success: true });
        }

        const itemIds = normalized.map((l) => l.id);
        const amounts = normalized.map((l) => l.amount);

        // Seed zero balance rows for both stations, then lock in deterministic
        // (item_id, station) order so simultaneous opposite transfers never deadlock.
        await client.query(
          'INSERT INTO store_station_balances(station,item_id,balance) SELECT s.st, i.item_id, 0 FROM unnest($1::text[]) AS s(st) CROSS JOIN unnest($2::int[]) AS i(item_id) ON CONFLICT DO NOTHING',
          [[who.station, toStation], itemIds],
        );
        const lockedBalances = await client.query<{
          station: string;
          item_id: number;
          balance: string;
        }>(
          'SELECT station,item_id,balance FROM store_station_balances WHERE station=ANY($1::text[]) AND item_id=ANY($2::int[]) ORDER BY item_id,station FOR UPDATE',
          [[who.station, toStation], itemIds],
        );
        const senderBalanceById = new Map<number, number>();
        for (const row of lockedBalances.rows) {
          if (row.station === who.station) {
            senderBalanceById.set(Number(row.item_id), Number(row.balance));
          }
        }
        for (const l of normalized) {
          const current = senderBalanceById.get(l.id) ?? 0;
          if (current < l.amount) {
            throw new Invalid(
              `Not enough ${l.name} in ${who.station} stock to transfer`,
              409,
            );
          }
        }

        await client.query(
          'INSERT INTO store_station_transfers(idempotency_key,from_station,to_station,payload_hash,actor) VALUES($1,$2,$3,$4,$5)',
          [key, who.station, toStation, payloadHash, who.name],
        );
        await client.query(
          'UPDATE store_station_balances AS b SET balance=b.balance-v.amount FROM unnest($2::int[],$3::numeric[]) AS v(item_id,amount) WHERE b.station=$1 AND b.item_id=v.item_id',
          [who.station, itemIds, amounts],
        );
        await client.query(
          'UPDATE store_station_balances AS b SET balance=b.balance+v.amount FROM unnest($2::int[],$3::numeric[]) AS v(item_id,amount) WHERE b.station=$1 AND b.item_id=v.item_id',
          [toStation, itemIds, amounts],
        );
        await client.query(
          "INSERT INTO store_movements(item_id,station,kind,amount,actor,reason) SELECT v.item_id,$1,'transfer_out',v.amount,$2,$3 FROM unnest($4::int[],$5::numeric[]) AS v(item_id,amount)",
          [who.station, who.name, toStation, itemIds, amounts],
        );
        await client.query(
          "INSERT INTO store_movements(item_id,station,kind,amount,actor,reason) SELECT v.item_id,$1,'transfer_in',v.amount,$2,$3 FROM unnest($4::int[],$5::numeric[]) AS v(item_id,amount)",
          [toStation, who.name, who.station, itemIds, amounts],
        );
        await client.query('COMMIT');
        publish(CHANNELS.store);
        return NextResponse.json({ success: true });
      }

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
      publish(CHANNELS.store);
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
