import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { STORE_SCHEMA_SQL } from '../src/lib/store/schema';
import { toBase } from '../src/lib/store/units';
import { readFileSync } from 'node:fs';

async function main() {
  assert.equal(toBase(5, 'L', 'volume'), 5000);
  assert.equal(toBase(40, 'ml', 'volume'), 40);
  assert.equal(toBase(2, 'kg', 'mass'), 2000);
  assert.equal(toBase(60, 'pcs', 'count'), 60);
  assert.throws(() => toBase(1, 'kg', 'volume'));
  assert.throws(() => toBase(0.5, 'pcs', 'count'));
  assert.throws(() => toBase(-1, 'g', 'mass'));
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE ticket_items(id serial PRIMARY KEY, station_status text, station_name text, menu_item_id integer, name text, category text, quantity integer, station_done_by text, removed boolean DEFAULT false);
      INSERT INTO ticket_items(station_status,station_name,menu_item_id,name,quantity) VALUES('done','kitchen',1,'Old burger',10);`);
    await db.exec(STORE_SCHEMA_SQL);
    await db.exec(STORE_SCHEMA_SQL); // repeat safely
    assert.equal(
      (await db.query('SELECT * FROM store_done_events')).rows.length,
      0,
      'no retroactive deductions',
    );
    await db.exec(`INSERT INTO store_items(name,dimension,balance) VALUES ('Milk','volume',5000),('Egg','count',100);
      INSERT INTO store_recipes(menu_item_id,item_id,amount) VALUES(1,1,40),(1,2,2);
      INSERT INTO store_station_balances(station,item_id,balance) VALUES('kitchen',1,5000),('kitchen',2,30);
      INSERT INTO ticket_items(station_status,station_name,menu_item_id,name,category,quantity) VALUES('pending','kitchen',1,'Burger','Food',5);
      UPDATE ticket_items SET station_status='done' WHERE id=2;`);
    const balances = (
      await db.query<{ item_id: number; balance: string }>(
        "SELECT item_id,balance FROM store_station_balances WHERE station='kitchen' ORDER BY item_id",
      )
    ).rows;
    assert.equal(
      Number(balances[0].balance),
      4800,
      '5 burgers use 200 ml from 5 L',
    );
    assert.equal(
      Number(balances[1].balance),
      20,
      '5 burgers use 10 eggs from 30',
    );
    await db.exec(
      "UPDATE ticket_items SET station_status='pending' WHERE id=2; UPDATE ticket_items SET station_status='done' WHERE id=2;",
    );
    assert.equal(
      (await db.query('SELECT * FROM store_movements')).rows.length,
      2,
      'repeat Done is idempotent',
    );
    await db.exec(
      `INSERT INTO ticket_items(station_status,station_name,menu_item_id,name,quantity) VALUES('done','buna',1,'Buna',1),('done','kitchen',999,'Missing recipe',1);`,
    );
    assert.equal(
      Number(
        (
          await db.query<{ balance: string }>(
            "SELECT balance FROM store_station_balances WHERE station='buna' AND item_id=1",
          )
        ).rows[0].balance,
      ),
      -40,
      'buna is separate and shortages remain visible',
    );
    assert.equal(
      (
        await db.query<{ missing_recipe: boolean }>(
          "SELECT missing_recipe FROM store_done_events WHERE item_name='Missing recipe'",
        )
      ).rows[0].missing_recipe,
      true,
    );
    await db.exec(
      "INSERT INTO ticket_items(station_status,station_name,menu_item_id,name,quantity,removed) VALUES('done','kitchen',1,'Removed',1,true)",
    );
    assert.equal(
      (
        await db.query(
          "SELECT * FROM store_done_events WHERE item_name='Removed'",
        )
      ).rows.length,
      0,
    );
    await db.exec('BEGIN');
    await db.exec(
      "UPDATE ticket_items SET station_status='pending' WHERE id=1; UPDATE ticket_items SET station_status='done' WHERE id=1;",
    );
    await db.exec('ROLLBACK');
    assert.equal(
      (await db.query('SELECT * FROM store_done_events WHERE ticket_item_id=1'))
        .rows.length,
      0,
      'done and usage roll back together',
    );
    // Direct station purchases use the shared catalog, without adding to the main store.
    await db.exec(`INSERT INTO store_items(name,dimension,balance) VALUES('Coffee','mass',0);
      INSERT INTO store_station_imports(idempotency_key,station,item_id,amount,actor)
        VALUES('purchase-key','barista',3,2000,'Barista');
      INSERT INTO store_station_balances(station,item_id,balance) VALUES('barista',3,2000);
      INSERT INTO store_movements(item_id,station,kind,amount,actor,reason)
        VALUES(3,'barista','purchase',2000,'Barista','Direct station import');`);
    assert.equal(
      Number(
        (
          await db.query<{ balance: string }>(
            'SELECT balance FROM store_items WHERE id=3',
          )
        ).rows[0].balance,
      ),
      0,
    );
    assert.equal(
      Number(
        (
          await db.query<{ balance: string }>(
            "SELECT balance FROM store_station_balances WHERE station='barista' AND item_id=3",
          )
        ).rows[0].balance,
      ),
      2000,
    );
    await assert.rejects(
      db.exec(
        "INSERT INTO store_station_imports(idempotency_key,station,item_id,amount,actor) VALUES('purchase-key','barista',3,2000,'Barista')",
      ),
    );
    await db.exec(`INSERT INTO store_station_imports(idempotency_key,station,item_id,amount,actor,kind,reason)
      VALUES('waste-key','barista',3,100,'Barista','waste','Spoiled');`);
    await assert.rejects(
      db.exec(
        "INSERT INTO store_station_imports(idempotency_key,station,item_id,amount,actor,kind,reason) VALUES('waste-key','barista',3,100,'Barista','waste','Spoiled')",
      ),
    );
    const stationApi = readFileSync(
      'src/app/api/store/station/route.ts',
      'utf8',
    );
    assert.ok(
      stationApi.includes('pg_advisory_xact_lock') &&
        stationApi.includes('different details'),
    );
    const ticketsApi = readFileSync('src/app/api/tickets/route.ts', 'utf8');
    assert.ok(
      ticketsApi.includes("status === 'closed'") ||
        ticketsApi.includes('status === "closed"'),
    );
    assert.ok(
      ticketsApi.includes('cashier delivery') &&
        ticketsApi.includes('cashier print'),
    );
    const payrollApi = readFileSync('src/app/api/payroll/route.ts', 'utf8');
    assert.ok(
      payrollApi.includes('FROM payroll_breakages') &&
        payrollApi.includes('Breakage changed while paying'),
    );
    const api = readFileSync('src/app/api/store/route.ts', 'utf8');
    assert.ok(
      api.includes('FOR UPDATE') &&
        api.includes("await client.query('ROLLBACK')"),
    );
    assert.ok(api.includes('confirmExisting !== true'));
    assert.ok(api.includes('session_valid_after=now()'));
    console.log(
      'Store guard PASSED: unit conversion, real PostgreSQL trigger, separate stations, missing recipes, idempotency and rollback',
    );
  } finally {
    await db.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
