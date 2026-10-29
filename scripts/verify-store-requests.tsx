import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import StoreRequestBuilder from '../src/components/rms/StoreRequestBuilder';
import { STORE_SCHEMA_SQL } from '../src/lib/store/schema';
import { toBase } from '../src/lib/store/units';

async function main() {
  const items = [
    {
      id: 1,
      name: 'Egg',
      dimension: 'count' as const,
      balance: '60',
      image: '/egg.jpg',
    },
  ];
  const html = renderToStaticMarkup(
    <StoreRequestBuilder
      items={items}
      busy={false}
      serverError=""
      onSend={async () => true}
    />,
  );
  assert.match(html, /Egg/);
  assert.match(html, /Available: 60 pcs/);
  assert.match(html, /Add to request/);
  const ui = readFileSync('src/components/rms/StoreRequestBuilder.tsx', 'utf8');
  for (const text of [
    'Review and send',
    'Destination',
    'Send request',
    'Edit ',
    'Remove ',
    'resetKeyBeforeChange',
  ])
    assert.ok(ui.includes(text), text);
  const page = readFileSync('src/app/(internal)/store/page.tsx', 'utf8');
  for (const text of [
    'Select an ingredient',
    'Choose from all stock items',
    'Edit request',
    'Enable background alerts',
    'Test request alarm',
  ])
    assert.ok(page.includes(text), text);
  assert.ok(!page.includes('Find employee'));
  assert.ok(
    page.includes('/api/realtime?channel=store') &&
      page.includes('playAlarm()'),
  );
  const api = readFileSync('src/app/api/store/route.ts', 'utf8');
  for (const text of [
    'request_batch',
    'store_request_batches',
    'store_request_edits',
    'FOR UPDATE',
    'publish(CHANNELS.store)',
    'sendStoreRequestPush()',
  ])
    assert.ok(api.includes(text), text);
  assert.equal(toBase(2, 'kg', 'mass') + toBase(500, 'g', 'mass'), 2500);
  const db = new PGlite();
  try {
    await db.exec(
      'CREATE TABLE ticket_items(id serial PRIMARY KEY,station_status text,station_name text,menu_item_id integer,name text,category text,quantity integer,station_done_by text,removed boolean DEFAULT false)',
    );
    await db.exec(STORE_SCHEMA_SQL);
    await db.exec(STORE_SCHEMA_SQL);
    await db.exec(`INSERT INTO store_request_batches(idempotency_key,requester_id,payload_hash) VALUES('key-1',7,'hash');
      INSERT INTO store_requests(requester_id,requester_name,station) VALUES(7,'Accepter','juice');
      INSERT INTO store_request_edits(request_id,actor,before_lines,after_lines) VALUES(1,'Manager','[{"item":1}]','[{"item":2}]');
      INSERT INTO store_push_subscriptions(endpoint,p256dh,auth,staff_id,session_iat) VALUES('https://fcm.googleapis.com/example','key','auth',1,1);`);
    await assert.rejects(
      db.exec(
        "INSERT INTO store_request_batches(idempotency_key,requester_id,payload_hash) VALUES('key-1',7,'hash')",
      ),
    );
    assert.equal(
      (await db.query('SELECT * FROM store_request_edits')).rows.length,
      1,
    );
    assert.equal(
      (await db.query('SELECT * FROM store_push_subscriptions')).rows.length,
      1,
    );
  } finally {
    await db.close();
  }
  console.log(
    'Store request guard PASSED: catalog, editing, deduplication schema, realtime and background-alert setup',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
