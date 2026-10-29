import { NextResponse } from 'next/server';
import { pool } from '@/db';
import {
  readAdminSession,
  readStaffSession,
  requireStaffOrAdmin,
} from '@/lib/session';
import { ensureStoreSchema } from '@/lib/store/schema';
import { ensureTablesExist } from '@/db/migrate';

async function manager() {
  const staff = await readStaffSession();
  if (staff?.role === 'store_manager') {
    const r = await pool.query(
      "SELECT 1 FROM store_accounts a JOIN staff_users s ON s.id=a.staff_id WHERE a.staff_id=$1 AND s.role='store_manager' AND $2 >= extract(epoch from a.session_valid_after)*1000",
      [staff.staffId, staff.iat],
    );
    if (r.rowCount) return { id: staff.staffId, iat: staff.iat };
    return null;
  }
  const admin = await readAdminSession();
  return admin ? { id: null, iat: admin.iat } : null;
}
async function validManager() {
  const initial = await readStaffSession();
  const admin = await readAdminSession();
  if (initial?.role !== 'store_manager' && !admin) return null;
  const migrated = await ensureTablesExist();
  if (!migrated.success) throw new Error('Database migration failed');
  await ensureStoreSchema();
  return manager();
}
export async function POST(request: Request) {
  const guard = await requireStaffOrAdmin();
  if (!guard.ok) return guard.response;
  try {
    const who = await validManager();
    if (!who)
      return NextResponse.json(
        { error: 'Store manager sign-in required' },
        { status: 401 },
      );
    const data = await request.json().catch(() => null);
    const endpoint = String(data?.subscription?.endpoint || '');
    const p256dh = String(data?.subscription?.keys?.p256dh || '');
    const auth = String(data?.subscription?.keys?.auth || '');
    let u: URL;
    try {
      u = new URL(endpoint);
    } catch {
      return NextResponse.json(
        { error: 'Invalid push subscription' },
        { status: 400 },
      );
    }
    if (
      u.protocol !== 'https:' ||
      u.port ||
      u.username ||
      u.password ||
      !(
        [
          'fcm.googleapis.com',
          'updates.push.services.mozilla.com',
          'web.push.apple.com',
        ].includes(u.hostname) ||
        u.hostname.endsWith('.push.apple.com') ||
        u.hostname.endsWith('.notify.windows.com')
      ) ||
      endpoint.length > 2048 ||
      !p256dh ||
      p256dh.length > 256 ||
      !auth ||
      auth.length > 256
    )
      return NextResponse.json(
        { error: 'Invalid push subscription' },
        { status: 400 },
      );
    await pool.query(
      `INSERT INTO store_push_subscriptions(endpoint,p256dh,auth,staff_id,session_iat) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,staff_id=excluded.staff_id,session_iat=excluded.session_iat`,
      [endpoint, p256dh, auth, who.id, who.iat],
    );
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('[store alerts]', e);
    return NextResponse.json(
      { error: 'Could not enable store notifications' },
      { status: 500 },
    );
  }
}
export async function DELETE(request: Request) {
  const guard = await requireStaffOrAdmin();
  if (!guard.ok) return guard.response;
  try {
    const who = await validManager();
    if (!who)
      return NextResponse.json(
        { error: 'Store manager sign-in required' },
        { status: 401 },
      );
    const data = await request.json().catch(() => null);
    const endpoint = String(data?.endpoint || '');
    if (endpoint)
      await pool.query(
        'DELETE FROM store_push_subscriptions WHERE endpoint=$1',
        [endpoint],
      );
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: 'Could not disable store notifications' },
      { status: 500 },
    );
  }
}
