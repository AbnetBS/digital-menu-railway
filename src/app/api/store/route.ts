import { createHash } from 'node:crypto';
import { publish, CHANNELS } from '@/lib/realtime';
import { sendStoreRequestPush } from '@/lib/store/alerts';
import { NextResponse } from 'next/server';
import { pool } from '@/db';
import { ensureTablesExist } from '@/db/migrate';
import {
  readAdminSession,
  readStaffSession,
  refreshStoreSession,
  requireStaffOrAdmin,
} from '@/lib/session';
import { hashSecret } from '@/lib/auth';
import { currentEthiopianPeriod } from '@/lib/payroll';
import { ensureStoreSchema } from '@/lib/store/schema';
import { isDimension, toBase, type Dimension } from '@/lib/store/units';
import type { PoolClient } from 'pg';

const STATIONS = ['kitchen', 'barista', 'buna', 'juice', 'cleaning'];
class UserError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
const requiredId = (v: unknown) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new UserError('Invalid ID');
  return n;
};
const text = (v: unknown, max = 120) =>
  String(v ?? '')
    .trim()
    .slice(0, max);
function checkedAmount(
  value: unknown,
  unit: unknown,
  dimension: Dimension,
  allowZero = false,
) {
  try {
    return toBase(value, unit, dimension, allowZero);
  } catch (e) {
    throw new UserError(e instanceof Error ? e.message : 'Invalid amount');
  }
}
async function identity() {
  const staff = await readStaffSession();
  if (
    staff &&
    (staff.role === 'stock_accepter' || staff.role === 'store_manager')
  ) {
    const r = await pool.query(
      'SELECT a.station, s.name, s.role, extract(epoch from a.session_valid_after)*1000 AS valid_after FROM store_accounts a JOIN staff_users s ON s.id=a.staff_id WHERE s.id=$1',
      [staff.staffId],
    );
    if (
      r.rows[0] &&
      r.rows[0].role === staff.role &&
      Number(staff.iat) >= Number(r.rows[0].valid_after)
    )
      return {
        id: staff.staffId,
        name: r.rows[0].name as string,
        role: staff.role,
        station: r.rows[0].station as string,
        manager: staff.role === 'store_manager',
        admin: false,
      };
    throw new UserError('Store session expired. Please sign in again.', 401);
  }
  if (await readAdminSession())
    return {
      id: 0,
      name: 'Admin',
      role: 'admin',
      station: '',
      manager: true,
      admin: true,
    };
  throw new UserError('Please sign in to the store', 401);
}
function failure(e: unknown) {
  if (e instanceof UserError)
    return NextResponse.json({ error: e.message }, { status: e.status });
  console.error('[store]', e);
  return NextResponse.json(
    {
      error:
        'Store operation failed. Please try again or contact the administrator.',
    },
    { status: 500 },
  );
}
function managerOnly(who: Awaited<ReturnType<typeof identity>>) {
  if (!who.manager) throw new UserError('Store manager access required', 403);
}
async function item(client: PoolClient, id: unknown, lock = false) {
  const r = await client.query(
    `SELECT * FROM store_items WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`,
    [requiredId(id)],
  );
  if (!r.rows[0]) throw new UserError('Stock item not found', 404);
  return r.rows[0] as {
    id: number;
    name: string;
    dimension: Dimension;
    balance: string;
    low_at: string;
  };
}
async function lines(client: PoolClient, raw: unknown) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 100)
    throw new UserError('Add at least one item (maximum 100)');
  const out: Array<{ id: number; amount: number }> = [];
  for (const line of raw) {
    const i = await item(client, line.itemId);
    if (out.some((x) => x.id === i.id))
      throw new UserError('Each item may appear only once');
    const amount = checkedAmount(line.amount, line.unit, i.dimension);
    if (amount > Number(i.balance))
      throw new UserError(
        `${i.name}: not enough in store. Available: ${i.balance} ${i.dimension === 'mass' ? 'g' : i.dimension === 'volume' ? 'ml' : 'pcs'}`,
        409,
      );
    out.push({ id: i.id, amount });
  }
  return out;
}
async function prepare() {
  const result = await ensureTablesExist();
  if (!result.success) throw new Error('Database migration failed');
  await ensureStoreSchema();
}
export async function GET() {
  try {
    // Authenticate before initialising privileged schema.
    const sessionGuard = await requireStaffOrAdmin();
    if (!sessionGuard.ok) return sessionGuard.response;
    const staffSession = await readStaffSession();
    if (
      staffSession?.role !== 'store_manager' &&
      staffSession?.role !== 'stock_accepter' &&
      !(await readAdminSession())
    )
      throw new UserError('Store access required', 403);
    await prepare();
    const who = await identity();
    const items = (await pool.query('SELECT * FROM store_items ORDER BY name'))
      .rows;
    const requests = (
      await pool.query(
        `SELECT r.*, COALESCE(json_agg(json_build_object('item_id',l.item_id,'name',i.name,'dimension',i.dimension,'amount',l.amount) ORDER BY i.name) FILTER (WHERE l.item_id IS NOT NULL),'[]') AS lines
      FROM store_requests r LEFT JOIN store_request_lines l ON l.request_id=r.id LEFT JOIN store_items i ON i.id=l.item_id
      WHERE ($1::boolean OR r.requester_id=$2) GROUP BY r.id ORDER BY r.created_at DESC`,
        [who.manager, who.id],
      )
    ).rows;
    if (!who.manager)
      return refreshStoreSession(
        NextResponse.json(
          { who, items, requests },
          { headers: { 'Cache-Control': 'no-store' } },
        ),
        staffSession,
      );
    const [balances, menu, recipes, accounts, members, breakages] =
      await Promise.all([
        pool.query(
          'SELECT b.station,b.item_id,b.balance,i.name,i.dimension FROM store_station_balances b JOIN store_items i ON i.id=b.item_id ORDER BY b.station,i.name',
        ),
        pool.query(
          'SELECT id,name,category,image_url FROM menu_items ORDER BY category,name',
        ),
        pool.query('SELECT * FROM store_recipes'),
        pool.query(
          'SELECT s.id,s.name,s.role,a.station FROM store_accounts a JOIN staff_users s ON s.id=a.staff_id ORDER BY s.name',
        ),
        pool.query(
          'SELECT id,name,active FROM attendance_members ORDER BY name,id',
        ),
        pool.query(
          'SELECT b.*,m.name AS member_name FROM payroll_breakages b LEFT JOIN attendance_members m ON m.id=b.member_id ORDER BY b.created_at DESC,b.id DESC',
        ),
      ]);
    return refreshStoreSession(
      NextResponse.json(
        {
          who,
          items,
          requests,
          balances: balances.rows,
          menu: menu.rows,
          recipes: recipes.rows,
          accounts: accounts.rows,
          members: members.rows,
          breakages: breakages.rows,
        },
        { headers: { 'Cache-Control': 'no-store' } },
      ),
      who.admin ? await readAdminSession() : staffSession,
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    const sessionGuard = await requireStaffOrAdmin();
    if (!sessionGuard.ok) return sessionGuard.response;
    const staffSession = await readStaffSession();
    if (
      staffSession?.role !== 'store_manager' &&
      staffSession?.role !== 'stock_accepter' &&
      !(await readAdminSession())
    )
      throw new UserError('Store access required', 403);
    await prepare();
    const who = await identity();
    const body = await request.json();
    const action = text(body.action, 40);
    const client = await pool.connect();
    let newRequestCreated = false;
    try {
      await client.query('BEGIN');
      if (action === 'account') {
        managerOnly(who);
        const role =
          body.role === 'store_manager' ? 'store_manager' : 'stock_accepter';
        if (role === 'store_manager' && !who.admin)
          throw new UserError('Only the owner can create store managers', 403);
        const name = text(body.name, 100),
          pin = String(body.pin || ''),
          station = text(body.station, 30);
        if (!name || !/^\d{4,12}$/.test(pin))
          throw new UserError('Enter a name and a PIN of 4 to 12 digits');
        if (role === 'stock_accepter' && !STATIONS.includes(station))
          throw new UserError('Choose a station');
        const duplicate = await client.query(
          'SELECT 1 FROM staff_users WHERE name=$1 AND role=$2',
          [name, role],
        );
        if (duplicate.rowCount)
          throw new UserError('That name already exists for this role');
        const s = await client.query(
          'INSERT INTO staff_users(name,role,pin) VALUES($1,$2,$3) RETURNING id',
          [name, role, await hashSecret(pin)],
        );
        await client.query(
          'INSERT INTO store_accounts(staff_id,station) VALUES($1,$2)',
          [s.rows[0].id, role === 'store_manager' ? 'store' : station],
        );
      } else if (action === 'remove_account') {
        managerOnly(who);
        const id = requiredId(body.staffId);
        const found = await client.query(
          'SELECT s.role FROM staff_users s JOIN store_accounts a ON a.staff_id=s.id WHERE s.id=$1 FOR UPDATE OF s',
          [id],
        );
        if (!found.rowCount) throw new UserError('Account not found', 404);
        if (found.rows[0].role === 'store_manager' && !who.admin)
          throw new UserError('Only the owner can remove a store manager', 403);
        if (id === who.id)
          throw new UserError('Ask the owner to remove your own account');
        await client.query('DELETE FROM store_accounts WHERE staff_id=$1', [
          id,
        ]);
        await client.query('DELETE FROM staff_users WHERE id=$1', [id]);
      } else if (action === 'reset_pin') {
        managerOnly(who);
        const id = requiredId(body.staffId),
          pin = String(body.pin || '');
        if (!/^\d{4,12}$/.test(pin))
          throw new UserError('PIN must be 4 to 12 digits');
        const found = await client.query(
          'SELECT s.role FROM staff_users s JOIN store_accounts a ON a.staff_id=s.id WHERE s.id=$1 FOR UPDATE OF s',
          [id],
        );
        if (!found.rowCount) throw new UserError('Account not found', 404);
        if (found.rows[0].role === 'store_manager' && !who.admin)
          throw new UserError(
            'Only the owner can reset a store manager PIN',
            403,
          );
        await client.query('UPDATE staff_users SET pin=$1 WHERE id=$2', [
          await hashSecret(pin),
          id,
        ]);
        await client.query(
          'UPDATE store_accounts SET session_valid_after=now() WHERE staff_id=$1',
          [id],
        );
      } else if (action === 'breakage' || action === 'void_breakage') {
        managerOnly(who);
        let period = currentEthiopianPeriod();
        let record:
          | {
              id: number;
              period_key: string;
              voided_at: Date | null;
              member_id: number;
            }
          | undefined;
        if (action === 'void_breakage') {
          const found = await client.query(
            'SELECT id,period_key,voided_at,member_id FROM payroll_breakages WHERE id=$1 FOR UPDATE',
            [requiredId(body.id)],
          );
          record = found.rows[0];
          if (!record) throw new UserError('Record not found', 404);
          period = record.period_key;
          if (record.voided_at)
            throw new UserError('This record was already voided', 409);
        }
        const memberId =
          action === 'breakage' ? requiredId(body.memberId) : record!.member_id;
        const key = String(body.key || '');
        if (action === 'breakage') {
          if (!/^[0-9a-f-]{36}$/i.test(key))
            throw new UserError('Invalid record key');
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
            key,
          ]);
          const prior = await client.query(
            'SELECT recorded_by,member_id,item_type,amount FROM payroll_breakages WHERE request_key=$1',
            [key],
          );
          if (prior.rowCount) {
            if (
              prior.rows[0].recorded_by !== who.name ||
              Number(prior.rows[0].member_id) !== memberId ||
              prior.rows[0].item_type !== text(body.itemType, 200) ||
              Number(prior.rows[0].amount) !== Number(body.amount)
            )
              throw new UserError(
                'This record was already saved with different details. Start a new entry.',
                409,
              );
            await client.query('COMMIT');
            return NextResponse.json({ success: true });
          }
        }
        await client.query(
          "INSERT INTO payroll_periods(period_key,status,updated_at) VALUES($1,'draft',now()) ON CONFLICT(period_key) DO NOTHING",
          [period],
        );
        const periodRow = await client.query(
          'SELECT status FROM payroll_periods WHERE period_key=$1 FOR UPDATE',
          [period],
        );
        if (['approved', 'paid'].includes(periodRow.rows[0]?.status))
          throw new UserError(
            'This payroll month is approved or paid and cannot be changed',
            409,
          );
        if (
          (
            await client.query(
              'SELECT 1 FROM payroll_payments WHERE period_key=$1 AND member_id=$2',
              [period, memberId],
            )
          ).rowCount
        )
          throw new UserError(
            'This employee is already paid for this month',
            409,
          );
        if (action === 'breakage') {
          if (
            !(
              await client.query(
                'SELECT 1 FROM attendance_members WHERE id=$1',
                [memberId],
              )
            ).rowCount
          )
            throw new UserError('Employee not found', 404);
          const itemType = text(body.itemType, 200),
            amount = Number(body.amount);
          if (
            !itemType ||
            !Number.isFinite(amount) ||
            amount <= 0 ||
            amount > 100000000 ||
            Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001
          )
            throw new UserError(
              'Enter an item and a positive price with at most two decimals',
            );
          await client.query(
            'INSERT INTO payroll_breakages(period_key,member_id,item_type,amount,recorded_by,request_key) VALUES($1,$2,$3,$4,$5,$6)',
            [period, memberId, itemType, amount, who.name, key],
          );
        } else {
          await client.query(
            'UPDATE payroll_breakages SET voided_at=now(),voided_by=$2 WHERE id=$1',
            [record!.id, who.name],
          );
        }
      } else if (action === 'new_item') {
        managerOnly(who);
        const name = text(body.name),
          dimension = body.dimension;
        if (!name || !isDimension(dimension))
          throw new UserError('Enter a name and choose a measurement type');
        const amount = checkedAmount(body.amount, body.unit, dimension, true);
        const low = checkedAmount(body.low, body.lowUnit, dimension, true);
        const image = String(body.image || '');
        if (
          image.length > 2_000_000 ||
          (image &&
            !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image))
        )
          throw new UserError('Choose a JPEG, PNG or WebP image under 1.5 MB');
        if (
          (
            await client.query(
              'SELECT 1 FROM store_items WHERE lower(trim(name))=lower($1)',
              [name],
            )
          ).rowCount
        )
          throw new UserError('This stock item already exists; use Add stock');
        const r = await client.query(
          'INSERT INTO store_items(name,dimension,balance,low_at,image) VALUES($1,$2,$3,$4,$5) RETURNING id',
          [name, dimension, amount, low, image],
        );
        if (amount > 0)
          await client.query(
            "INSERT INTO store_movements(item_id,kind,amount,actor,reason) VALUES($1,'purchase',$2,$3,'Opening stock')",
            [r.rows[0].id, amount, who.name],
          );
      } else if (action === 'add_stock') {
        managerOnly(who);
        const i = await item(client, body.itemId, true),
          amount = checkedAmount(body.amount, body.unit, i.dimension);
        await client.query(
          'UPDATE store_items SET balance=balance+$1 WHERE id=$2',
          [amount, i.id],
        );
        await client.query(
          "INSERT INTO store_movements(item_id,kind,amount,actor,reason) VALUES($1,'purchase',$2,$3,$4)",
          [i.id, amount, who.name, text(body.reason, 300)],
        );
      } else if (action === 'threshold') {
        managerOnly(who);
        const i = await item(client, body.itemId, true),
          low = checkedAmount(body.amount, body.unit, i.dimension, true);
        await client.query('UPDATE store_items SET low_at=$1 WHERE id=$2', [
          low,
          i.id,
        ]);
      } else if (action === 'request_batch') {
        if (who.role !== 'stock_accepter')
          throw new UserError(
            'Sign in as a stock accepter to request items',
            403,
          );
        const key = String(body.key || '');
        if (!/^[0-9a-f-]{36}$/i.test(key))
          throw new UserError('Invalid request key');
        if (
          !Array.isArray(body.lines) ||
          body.lines.length < 1 ||
          body.lines.length > 100
        )
          throw new UserError('Choose 1 to 100 items');
        const payloadHash = createHash('sha256')
          .update(JSON.stringify(body.lines))
          .digest('hex');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
        const prior = await client.query(
          'SELECT requester_id,payload_hash FROM store_request_batches WHERE idempotency_key=$1',
          [key],
        );
        if (prior.rowCount) {
          if (
            Number(prior.rows[0].requester_id) !== who.id ||
            prior.rows[0].payload_hash !== payloadHash
          )
            throw new UserError(
              'This request was already sent with different details. Check your requests before starting a new one.',
              409,
            );
        } else {
          const grouped = new Map<
            string,
            Array<{ itemId: unknown; amount: unknown; unit: unknown }>
          >();
          for (const line of body.lines) {
            if (!line || typeof line !== 'object' || Array.isArray(line))
              throw new UserError('Invalid request line');
            const station = String(line.station || '');
            if (!['kitchen', 'barista', 'juice', 'buna'].includes(station))
              throw new UserError('Choose a valid station');
            const group = grouped.get(station) || [];
            group.push(line);
            grouped.set(station, group);
          }
          const totals = new Map<number, number>();
          const groups: Array<{
            station: string;
            list: Array<{ id: number; amount: number }>;
          }> = [];
          for (const [station, group] of grouped) {
            const list = await lines(client, group);
            for (const l of list)
              totals.set(l.id, (totals.get(l.id) || 0) + l.amount);
            groups.push({ station, list });
          }
          for (const [id, amount] of totals) {
            const i = await item(client, id);
            if (amount > Number(i.balance) + 0.0000001)
              throw new UserError(
                `${i.name}: total requested across stations exceeds store stock`,
                409,
              );
          }
          newRequestCreated = true;
          await client.query(
            'INSERT INTO store_request_batches(idempotency_key,requester_id,payload_hash) VALUES($1,$2,$3)',
            [key, who.id, payloadHash],
          );
          for (const group of groups) {
            const r = await client.query(
              'INSERT INTO store_requests(requester_id,requester_name,station) VALUES($1,$2,$3) RETURNING id',
              [who.id, who.name, group.station],
            );
            for (const l of group.list)
              await client.query(
                'INSERT INTO store_request_lines(request_id,item_id,amount) VALUES($1,$2,$3)',
                [r.rows[0].id, l.id, l.amount],
              );
          }
        }
      } else if (action === 'request' || action === 'edit_request') {
        if (
          who.role !== 'stock_accepter' &&
          !(action === 'edit_request' && who.manager)
        )
          throw new UserError(
            'Sign in as a stock accepter to request items',
            403,
          );
        const destination = String(body.station || 'kitchen');
        if (!['kitchen', 'barista', 'juice', 'buna'].includes(destination))
          throw new UserError('Choose a valid station');
        let id: number;
        if (action === 'edit_request') {
          id = requiredId(body.requestId);
          const r = await client.query(
            'SELECT * FROM store_requests WHERE id=$1 FOR UPDATE',
            [id],
          );
          if (!r.rows[0] || (!who.manager && r.rows[0].requester_id !== who.id))
            throw new UserError('Request not found', 404);
          if (r.rows[0].status !== 'pending')
            throw new UserError(
              'An accepted request can no longer be edited',
              409,
            );
          const previous = await client.query(
            'SELECT item_id,amount FROM store_request_lines WHERE request_id=$1 ORDER BY item_id',
            [id],
          );
          await client.query(
            'INSERT INTO store_request_edits(request_id,actor,before_lines,after_lines) VALUES($1,$2,$3::jsonb,$4::jsonb)',
            [
              id,
              who.name,
              JSON.stringify({
                station: r.rows[0].station,
                lines: previous.rows,
              }),
              JSON.stringify({ station: destination, lines: body.lines }),
            ],
          );
          await client.query(
            'UPDATE store_requests SET station=$1 WHERE id=$2',
            [destination, id],
          );
          await client.query(
            'DELETE FROM store_request_lines WHERE request_id=$1',
            [id],
          );
        } else {
          newRequestCreated = true;
          const r = await client.query(
            'INSERT INTO store_requests(requester_id,requester_name,station) VALUES($1,$2,$3) RETURNING id',
            [who.id, who.name, destination],
          );
          id = r.rows[0].id;
        }
        const list = await lines(client, body.lines);
        for (const l of list)
          await client.query(
            'INSERT INTO store_request_lines(request_id,item_id,amount) VALUES($1,$2,$3)',
            [id, l.id, l.amount],
          );
      } else if (action === 'accept') {
        managerOnly(who);
        const id = requiredId(body.requestId);
        const req = (
          await client.query(
            'SELECT * FROM store_requests WHERE id=$1 FOR UPDATE',
            [id],
          )
        ).rows[0];
        if (!req) throw new UserError('Request not found', 404);
        if (req.status !== 'pending')
          throw new UserError('This request was already accepted', 409);
        const list = (
          await client.query(
            'SELECT * FROM store_request_lines WHERE request_id=$1 ORDER BY item_id',
            [id],
          )
        ).rows;
        if (!list.length) throw new UserError('Request has no items');
        for (const l of list) {
          const i = await item(client, l.item_id, true);
          if (Number(i.balance) < Number(l.amount))
            throw new UserError(
              `${i.name}: no longer enough in the store. Ask the requester to edit.`,
              409,
            );
        }
        // Explicit acknowledgement is required if a station already has stock.
        for (const l of list)
          await client.query(
            'INSERT INTO store_station_balances(station,item_id,balance) VALUES($1,$2,0) ON CONFLICT DO NOTHING',
            [req.station, l.item_id],
          );
        const available = await client.query(
          'SELECT b.item_id,i.name,i.dimension,b.balance FROM store_station_balances b JOIN store_items i ON i.id=b.item_id WHERE b.station=$1 AND b.item_id=ANY($2::int[]) ORDER BY b.item_id FOR UPDATE OF b',
          [req.station, list.map((l) => l.item_id)],
        );
        const existing = available.rows.filter((x) => Number(x.balance) > 0);
        const checked = Array.isArray(body.checkedBalances)
          ? body.checkedBalances
          : [];
        const matchesChecked =
          checked.length === existing.length &&
          existing.every((x) =>
            checked.some(
              (c: { itemId: number; balance: string }) =>
                Number(c.itemId) === Number(x.item_id) &&
                Number(c.balance) === Number(x.balance),
            ),
          );
        if (
          existing.length &&
          (body.confirmExisting !== true || !matchesChecked)
        )
          throw new UserError(
            `Check existing ${req.station} stock first: ${existing.map((x) => `${x.name}: ${x.balance} ${x.dimension === 'mass' ? 'g' : x.dimension === 'volume' ? 'ml' : 'pcs'}`).join(', ')}`,
            409,
          );
        for (const l of list) {
          await client.query(
            'UPDATE store_items SET balance=balance-$1 WHERE id=$2',
            [l.amount, l.item_id],
          );
          await client.query(
            'INSERT INTO store_station_balances(station,item_id,balance) VALUES($1,$2,$3) ON CONFLICT(station,item_id) DO UPDATE SET balance=store_station_balances.balance+EXCLUDED.balance',
            [req.station, l.item_id, l.amount],
          );
          await client.query(
            "INSERT INTO store_movements(item_id,station,kind,amount,actor,request_id) VALUES($1,$2,'issue',$3,$4,$5)",
            [l.item_id, req.station, l.amount, who.name, id],
          );
        }
        await client.query(
          "UPDATE store_requests SET status='accepted',accepted_at=now(),accepted_by=$2 WHERE id=$1",
          [id, who.name],
        );
      } else if (action === 'recipe') {
        managerOnly(who);
        const menuId = requiredId(body.menuId);
        if (
          !(
            await client.query('SELECT 1 FROM menu_items WHERE id=$1', [menuId])
          ).rowCount
        )
          throw new UserError('Menu item not found', 404);
        if (!Array.isArray(body.lines) || body.lines.length > 100)
          throw new UserError('Invalid recipe');
        const seen = new Set<number>();
        const recipe: Array<{ id: number; amount: number }> = [];
        for (const line of body.lines) {
          const i = await item(client, line.itemId);
          if (seen.has(i.id))
            throw new UserError('Each ingredient may appear only once');
          seen.add(i.id);
          recipe.push({
            id: i.id,
            amount: checkedAmount(line.amount, line.unit, i.dimension),
          });
        }
        await client.query('DELETE FROM store_recipes WHERE menu_item_id=$1', [
          menuId,
        ]);
        for (const l of recipe)
          await client.query(
            'INSERT INTO store_recipes(menu_item_id,item_id,amount) VALUES($1,$2,$3)',
            [menuId, l.id, l.amount],
          );
      } else if (action === 'waste') {
        managerOnly(who);
        const station = text(body.station, 30),
          reason = text(body.reason, 300);
        if ((!STATIONS.includes(station) && station !== 'store') || !reason)
          throw new UserError('Choose a location and enter the reason');
        const i = await item(client, body.itemId, station === 'store');
        const amount = checkedAmount(body.amount, body.unit, i.dimension);
        if (station === 'store') {
          if (Number(i.balance) < amount)
            throw new UserError(
              'Waste is greater than the recorded store balance',
              409,
            );
          await client.query(
            'UPDATE store_items SET balance=balance-$1 WHERE id=$2',
            [amount, i.id],
          );
        } else {
          const b = await client.query(
            'SELECT balance FROM store_station_balances WHERE station=$1 AND item_id=$2 FOR UPDATE',
            [station, i.id],
          );
          if (!b.rowCount || Number(b.rows[0].balance) < amount)
            throw new UserError(
              'Waste is greater than the recorded station balance',
              409,
            );
          await client.query(
            'UPDATE store_station_balances SET balance=balance-$1 WHERE station=$2 AND item_id=$3',
            [amount, station, i.id],
          );
        }
        await client.query(
          "INSERT INTO store_movements(item_id,station,kind,amount,actor,reason) VALUES($1,$2,'waste',$3,$4,$5)",
          [i.id, station, amount, who.name, reason],
        );
      } else throw new UserError('Unknown action');
      await client.query('COMMIT');
      if (
        ['request', 'request_batch', 'edit_request', 'accept'].includes(action)
      )
        publish(CHANNELS.store);
      if (newRequestCreated) void sendStoreRequestPush();
      return NextResponse.json({ success: true });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    return failure(e);
  }
}
