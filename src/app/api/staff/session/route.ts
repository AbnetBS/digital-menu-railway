import { NextResponse } from 'next/server';
import { pool } from '@/db';
import { ensureTablesExist } from '@/db/migrate';
import { requireStaff, refreshStoreSession } from '@/lib/session';

// Restore the current station account in a fresh browser tab; never trust a
// name stored in the browser without rechecking its signed session and role.
export async function GET() {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  if (!['kitchen', 'barista', 'juice'].includes(auth.session.role))
    return NextResponse.json(
      { error: 'Station login required' },
      { status: 403 },
    );
  try {
    const migration = await ensureTablesExist();
    if (!migration.success) throw new Error('Database migration failed');
    const user = await pool.query(
      'SELECT id,name,role FROM staff_users WHERE id=$1 AND role=$2',
      [auth.session.staffId, auth.session.role],
    );
    if (!user.rowCount)
      return NextResponse.json(
        { error: 'Station account is no longer available' },
        { status: 401 },
      );
    return refreshStoreSession(
      NextResponse.json(
        { staff: user.rows[0] },
        { headers: { 'Cache-Control': 'no-store' } },
      ),
      auth.session,
    );
  } catch {
    return NextResponse.json(
      { error: 'Could not verify your station session' },
      { status: 503 },
    );
  }
}
