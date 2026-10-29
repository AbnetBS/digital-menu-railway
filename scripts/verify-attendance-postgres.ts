// Optional end-to-end route/transaction test against a DISPOSABLE PostgreSQL
// server. The test creates and drops a uniquely named database; never use prod.
// TEST_DATABASE_URL=postgresql://... npm run test:attendance-postgres
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("Set TEST_DATABASE_URL to a disposable PostgreSQL server, never production.");
const database = `fana_att_test_${randomBytes(8).toString("hex")}`;
const control = new Pool({ connectionString: url });
let closeTestPool: (() => Promise<void>) | undefined;
let created = false;

async function main() {
  try {
    await control.query(`CREATE DATABASE "${database}"`);
    created = true;
    const testUrl = new URL(url!);
    testUrl.pathname = `/${database}`;
    process.env.DATABASE_URL = testUrl.toString();
    process.env.ATTENDANCE_DEVICE_TOKEN = "test-device-token";
    const { ensureTablesExist } = await import("../src/db/migrate");
    const { pool } = await import("../src/db");
    closeTestPool = () => pool.end();
    const { POST } = await import("../src/app/api/attendance/clock/route");
    const migration = await ensureTablesExist();
    assert.equal(migration.success, true, migration.errors.join("\n"));

    await pool.query("INSERT INTO attendance_roles(id,name) VALUES (1,'Test role')");
    await pool.query("INSERT INTO attendance_role_shifts(role_id,label,start_time,end_time) VALUES (1,'Day','08:00','16:00')");
    await pool.query("INSERT INTO attendance_members(id,name,role_id) VALUES (1,'Test employee',1),(2,'Other employee',1)");
    await pool.query("INSERT INTO attendance_biometrics(member_id,fingerprint_id) VALUES (1,55),(2,56)");
    const id = () => randomBytes(16).toString("hex");
    const at = (stamp: string) => Math.floor(new Date(stamp).getTime() / 1000);
    const scanIn = at("2026-10-15T08:00:00+03:00");
    const scanOut = at("2026-10-15T18:30:00+03:00");
    const eventIn = id(), eventOut = id();
    const base = { method: "fingerprint", fingerprintId: 55, capturedMemberId: 1, deviceId: "test_offline", requireRecordedTime: true };
    const post = (body: object, token = "test-device-token") => POST(new Request("http://local/api/attendance/clock", {
      method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "x-attendance-device": token } : {}) },
      body: JSON.stringify(body),
    }));
    const bodyIn = { ...base, eventId: eventIn, scannedAt: scanIn };
    const responses = await Promise.all(Array.from({ length: 12 }, () => post(bodyIn)));
    assert.ok(responses.every((response) => response.status === 200));
    const inResults = await Promise.all(responses.map((response) => response.json()));
    assert.ok(inResults.every((result) => result.action === "clock_in" && result.logId === inResults[0].logId));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM attendance_logs")).rows[0].n, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM attendance_scan_events")).rows[0].n, 1);
    let row = (await pool.query("SELECT * FROM attendance_logs WHERE member_id=1")).rows[0];
    assert.equal(new Date(row.clock_in).getTime(), scanIn * 1000, "IN must be the scan, not arrival");
    assert.equal(row.date, "2026-10-15");
    assert.match(row.notes, /Offline scan: finger at/);

    // A distinct scan inside the one-hour repeat lock must not become an OUT.
    const repeat = await post({ ...base, eventId: id(), scannedAt: scanIn + 120 });
    assert.equal(repeat.status, 200);
    assert.equal((await repeat.json()).action, "already_registered");
    assert.equal((await pool.query("SELECT clock_out FROM attendance_logs WHERE member_id=1")).rows[0].clock_out, null);

    // A lost success reply can be retried even if the mapping has since gone.
    await pool.query("DELETE FROM attendance_biometrics WHERE fingerprint_id=55");
    const retryAfterDelete = await post(bodyIn);
    assert.equal(retryAfterDelete.status, 200);
    assert.equal((await retryAfterDelete.json()).action, "clock_in");
    await pool.query("INSERT INTO attendance_biometrics(member_id,fingerprint_id) VALUES (1,55)");
    assert.equal((await post({ ...bodyIn, scannedAt: scanIn + 60 })).status, 409, "event IDs cannot change meaning");
    assert.equal((await post({ ...base, eventId: id(), capturedMemberId: 2, scannedAt: scanOut })).status, 409, "changed mapping must not credit the wrong person");
    assert.equal((await post({ ...base, eventId: id(), scannedAt: scanIn - 300 })).status, 409, "older scans must not be folded into a newer IN");
    assert.equal((await post({ ...base, eventId: id() })).status, 422);
    assert.equal((await post({ ...base, eventId: id(), scannedAt: "nonsense" })).status, 422);
    assert.equal((await post({ ...base, eventId: id(), scannedAt: Math.floor(Date.now() / 1000) + 86400 })).status, 422);
    assert.equal((await post({ ...bodyIn }, "bad-token")).status, 401);
    assert.equal((await post({ fingerprintId: 55, method: "fingerprint", deviceId: "test_offline" })).status, 422, "legacy unknown time cannot become arrival");

    // Inject a database fault AFTER writing clock-out. Both the attendance row
    // and the receipt must roll back with overtime, leaving the event retryable.
    await pool.query(`CREATE FUNCTION fail_test_overtime() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected overtime failure'; END $$`);
    await pool.query("CREATE TRIGGER fail_test_overtime BEFORE INSERT ON attendance_overtime FOR EACH ROW EXECUTE FUNCTION fail_test_overtime()");
    const bodyOut = { ...base, eventId: eventOut, scannedAt: scanOut };
    const failed = await post(bodyOut);
    assert.equal(failed.status, 500);
    row = (await pool.query("SELECT * FROM attendance_logs WHERE member_id=1")).rows[0];
    assert.equal(row.clock_out, null);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM attendance_scan_events WHERE event_id=$1", [eventOut])).rows[0].n, 0);
    await pool.query("DROP TRIGGER fail_test_overtime ON attendance_overtime");
    const outs = await Promise.all(Array.from({ length: 10 }, () => post(bodyOut)));
    assert.ok(outs.every((response) => response.status === 200));
    const results = await Promise.all(outs.map((response) => response.json()));
    assert.ok(results.every((result) => result.action === "clock_out" && result.overtimeMinutes === 150));
    row = (await pool.query("SELECT * FROM attendance_logs WHERE member_id=1")).rows[0];
    assert.equal(new Date(row.clock_out).getTime(), scanOut * 1000, "OUT must be the scan, not arrival");
    assert.equal(row.total_minutes, 630);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM attendance_overtime WHERE member_id=1")).rows[0].n, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM attendance_scan_events")).rows[0].n, 3);

    delete process.env.ATTENDANCE_DEVICE_TOKEN;
    const noToken = await post({ ...base, fingerprintId: 56, capturedMemberId: 2, eventId: id(), scannedAt: scanIn }, "");
    assert.equal(noToken.status, 403, "anonymous devices cannot backdate over three days");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM attendance_logs WHERE member_id=2")).rows[0].n, 0);
    console.log("Attendance PostgreSQL route tests passed: original IN/OUT times, concurrency and lost replies, rollback/retry, OT, auth and review conflicts.");
  } finally {
    if (closeTestPool) await closeTestPool();
    if (created) await control.query(`DROP DATABASE IF EXISTS "${database}"`);
    await control.end();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
