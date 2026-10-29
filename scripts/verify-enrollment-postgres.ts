// Optional test against a DISPOSABLE PostgreSQL server. Creates/drops a
// uniquely named database. Never point TEST_DATABASE_URL at production.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("Set TEST_DATABASE_URL to a disposable PostgreSQL server, never production.");
const database = `fana_enroll_test_${randomBytes(8).toString("hex")}`;
const control = new Pool({ connectionString: url });
let closePool: (() => Promise<void>) | undefined;
let created = false;

async function main() {
  try {
    await control.query(`CREATE DATABASE "${database}"`);
    created = true;
    const testUrl = new URL(url!);
    testUrl.pathname = `/${database}`;
    process.env.DATABASE_URL = testUrl.toString();
    process.env.ATTENDANCE_DEVICE_TOKEN = "test-device-token";
    // There is no Next request/cookie context in this direct route test. Make
    // admin auth fail closed, so only the supplied device token can authorize it.
    Object.assign(process.env, { NODE_ENV: "production" });
    delete process.env.SESSION_SECRET;
    const { ensureTablesExist } = await import("../src/db/migrate");
    const { pool } = await import("../src/db");
    closePool = () => pool.end();
    const { GET } = await import("../src/app/api/attendance/biometrics/route");
    const { POST: postMapping } = await import("../src/app/api/attendance/mappings/route");
    const migration = await ensureTablesExist();
    assert.equal(migration.success, true, migration.errors.join("\n"));
    await pool.query("INSERT INTO attendance_members(id,name) VALUES (1,'Test employee'), (2,'Existing employee')");
    await pool.query("INSERT INTO attendance_biometrics(member_id,fingerprint_id) VALUES (2,999)");
    // Older unfinished jobs can make a full pending response too big for the
    // ESP32 JSON buffer. The scanner requests just the latest pending job.
    await pool.query(`INSERT INTO attendance_enroll_jobs(member_id,member_name,fingerprint_id,status)
                      SELECT 1, 'Test employee', n, 'pending' FROM generate_series(1,25) AS n`);
    const get = (query: string) => GET(new Request(`https://fana.test/api/attendance/biometrics?${query}`, {
      headers: { "x-attendance-device": "test-device-token" },
    }));
    const response = await get("pending=1&limit=1");
    assert.equal(response.status, 200);
    const single = await response.json();
    assert.equal(single.count, 1);
    assert.equal(single.jobs.length, 1);
    assert.equal(single.jobs[0].fingerprintId, 25);
    assert.equal(single.jobs[0].memberName, "Test employee");
    assert.ok(Buffer.byteLength(JSON.stringify(single)) < 2048, "one job remains small for the scanner");
    const legacy = await (await get("pending=1")).json();
    assert.equal(legacy.count, 20, "existing clients keep their previous response");
    const post = (body: object, token = "test-device-token") => postMapping(new Request("https://fana.test/api/attendance/mappings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-attendance-device": token },
      body: JSON.stringify(body),
    }));
    assert.equal((await post({ action: "job_started", jobId: single.jobs[0].jobId }, "wrong-token")).status, 401);
    let result = await post({ action: "job_started", jobId: single.jobs[0].jobId, detail: "Received; follow scanner screen" });
    assert.equal(result.status, 200);
    let row = (await pool.query("SELECT * FROM attendance_enroll_jobs WHERE id=$1", [single.jobs[0].jobId])).rows[0];
    assert.equal(row.status, "pending");
    assert.ok(row.started_at);
    assert.equal(row.detail, "Received; follow scanner screen");
    result = await post({ action: "job_failed", jobId: single.jobs[0].jobId, reason: "Sensor not responding" });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { success: true, jobId: single.jobs[0].jobId, reason: "Sensor not responding" });
    row = (await pool.query("SELECT * FROM attendance_enroll_jobs WHERE id=$1", [single.jobs[0].jobId])).rows[0];
    assert.equal(row.status, "failed");
    assert.equal(row.detail, "Sensor not responding");
    // The device can retry a lost reply without changing the failure or
    // overwriting a finished/cancelled job.
    assert.equal((await post({ action: "job_failed", jobId: single.jobs[0].jobId, reason: "Changed" })).status, 200);
    assert.equal((await pool.query("SELECT detail FROM attendance_enroll_jobs WHERE id=$1", [single.jobs[0].jobId])).rows[0].detail, "Sensor not responding");
    const following = await (await get("pending=1&limit=1")).json();
    assert.equal(following.jobs[0].fingerprintId, 24);
    result = await post({ fingerprintId: 24, memberId: 1, memberName: "Test employee" });
    assert.equal(result.status, 200);
    row = (await pool.query("SELECT * FROM attendance_enroll_jobs WHERE id=$1", [following.jobs[0].jobId])).rows[0];
    assert.equal(row.status, "done");
    const saved = (await pool.query("SELECT member_id,fingerprint_id FROM attendance_biometrics ORDER BY fingerprint_id")).rows;
    assert.deepEqual(saved.map((m) => [m.member_id, m.fingerprint_id]), [[1, 24], [2, 999]]);
    console.log("Enrollment PostgreSQL passed: one-job/legacy polling, receipt, retry-safe failure, successful mapping and existing ownership.");
  } finally {
    if (closePool) await closePool();
    if (created) await control.query(`DROP DATABASE IF EXISTS "${database}"`);
    await control.end();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
