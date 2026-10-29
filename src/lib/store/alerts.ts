import webpush from 'web-push';
import { pool } from '@/db';
import { getVapidKeys } from '@/lib/push';

// This table is separate from the owner's sales notifications, so enabling a
// Store alert never changes or reassigns an existing push subscription.
export async function sendStoreRequestPush(): Promise<void> {
  try {
    const keys = await getVapidKeys();
    if (!keys) return;
    const subs = await pool.query(`SELECT p.* FROM store_push_subscriptions p
      LEFT JOIN store_accounts a ON a.staff_id=p.staff_id
      LEFT JOIN staff_users s ON s.id=p.staff_id
      WHERE p.staff_id IS NULL OR (s.role='store_manager' AND p.session_iat >= extract(epoch from a.session_valid_after)*1000)`);
    webpush.setVapidDetails(
      'mailto:owner@fanacafe.example',
      keys.publicKey,
      keys.privateKey,
    );
    await Promise.all(
      subs.rows.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify({
              title: 'New store request',
              body: 'A stock request is waiting for the store manager.',
              tag: 'fana-store-request',
              url: '/store',
              urgent: true,
            }),
            { urgency: 'high', TTL: 900 },
          );
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410)
            await pool.query(
              'DELETE FROM store_push_subscriptions WHERE endpoint=$1',
              [s.endpoint],
            );
          else console.warn('[store alerts] push failed', status || 'network');
        }
      }),
    );
  } catch (e) {
    console.warn('[store alerts] delivery unavailable', e);
  }
}
