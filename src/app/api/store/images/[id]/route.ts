import { NextResponse } from 'next/server';
import { pool } from '@/db';
import { readAdminSession, readStaffSession } from '@/lib/session';

// Photos used to be embedded in every /api/store response. They have not moved
// or been rewritten: this endpoint reads the existing row only when the browser
// needs the image, and lets that browser reuse it between Store refreshes.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await readAdminSession();
  const staff = await readStaffSession();
  if (!admin && !staff) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0)
    return NextResponse.json({ error: 'Invalid image' }, { status: 400 });

  try {
    if (!admin && staff) {
      if (staff.role === 'store_manager' || staff.role === 'stock_accepter') {
        const account = await pool.query(
          `SELECT 1 FROM store_accounts a JOIN staff_users s ON s.id=a.staff_id
           WHERE s.id=$1 AND s.role=$2 AND extract(epoch from a.session_valid_after)*1000 <= $3`,
          [staff.staffId, staff.role, staff.iat],
        );
        if (!account.rowCount) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      } else if (['kitchen', 'barista', 'juice'].includes(staff.role)) {
        const account = await pool.query('SELECT 1 FROM staff_users WHERE id=$1 AND role=$2', [staff.staffId, staff.role]);
        if (!account.rowCount) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      } else {
        return NextResponse.json({ error: 'Store access required' }, { status: 403 });
      }
    }

    const result = await pool.query('SELECT image FROM store_items WHERE id=$1', [id]);
    const image = String(result.rows[0]?.image || '');
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image);
    if (!match) return NextResponse.json({ error: 'Image not found' }, { status: 404 });
    const bytes = Buffer.from(match[2], 'base64');
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': match[1],
        'Content-Length': String(bytes.length),
        'Cache-Control': 'private, max-age=1800',
        Vary: 'Cookie',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('[store image]', error);
    return NextResponse.json({ error: 'Could not load image' }, { status: 500 });
  }
}
