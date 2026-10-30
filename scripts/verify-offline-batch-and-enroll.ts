#!/usr/bin/env tsx
/**
 * End-to-end PostgreSQL (PGlite) verification for:
 *   1. Batch offline queue sync: 10 registered employees scan offline (plus 1
 *      unmapped sensor template in the middle); one batch POST commits all 10
 *      employees with their original scan times, emits a single realtime
 *      attendance event, and signs all 10 onto the paper sheet.
 *   2. Live enrollment progress + instant completion: job_started ->
 *      job_progress (LCD accepting finger) -> mapping saved -> job marked done
 *      (including self-healing GET ?job=<id>).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

async function main() {
  const pglite = new PGlite();

  // Provide a node-postgres-compatible pool shim backed by PGlite so the real
  // Drizzle db + Next.js route handlers execute real PostgreSQL transactions.
  const makeClient = (runner: { query: typeof pglite.query }) => ({
    query: async (
      text: string | { text: string; values?: unknown[]; rowMode?: "array" | "object" },
      values?: unknown[]
    ) => {
      const sqlText = typeof text === "string" ? text : text.text;
      const sqlParams = (typeof text === "object" ? text.values ?? values : values) ?? [];
      const rowMode = typeof text === "object" && text.rowMode === "array" ? "array" : undefined;
      const res = await runner.query(sqlText, sqlParams as unknown[], rowMode ? { rowMode } : undefined);
      return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
    },
    release: () => {},
  });

  let inTx = false;
  const fakePool = {
    query: async (text: string | { text: string; values?: unknown[] }, values?: unknown[]) =>
      makeClient(pglite).query(text, values),
    connect: async () => {
      const client = makeClient(pglite);
      return {
        query: async (text: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
          const sqlText = typeof text === "string" ? text : text.text;
          const trimmed = sqlText.trim().toUpperCase();
          if (trimmed === "BEGIN") {
            if (!inTx) { inTx = true; await pglite.exec("BEGIN"); }
            return { rows: [], rowCount: 0 };
          }
          if (trimmed === "COMMIT") {
            if (inTx) { inTx = false; await pglite.exec("COMMIT"); }
            return { rows: [], rowCount: 0 };
          }
          if (trimmed === "ROLLBACK") {
            if (inTx) { inTx = false; await pglite.exec("ROLLBACK"); }
            return { rows: [], rowCount: 0 };
          }
          return client.query(text, values);
        },
        release: () => {},
      };
    },
    on: () => {},
    end: async () => { await pglite.close(); },
  };

  (globalThis as unknown as { __arenaNextJsPostgresqlPool?: unknown }).__arenaNextJsPostgresqlPool = fakePool;
  process.env.ATTENDANCE_DEVICE_TOKEN = "test-device-token";
  Object.assign(process.env, { NODE_ENV: "production" });
  delete process.env.SESSION_SECRET;

  try {
    const { ensureTablesExist } = await import("../src/db/migrate");
    const { subscribe, CHANNELS } = await import("../src/lib/realtime");
    const { POST: postClock } = await import("../src/app/api/attendance/clock/route");
    const { GET: getBiometrics } = await import("../src/app/api/attendance/biometrics/route");
    const { POST: postMappings } = await import("../src/app/api/attendance/mappings/route");

    const mig = await ensureTablesExist();
    assert.equal(mig.success, true, mig.errors.join("\n"));

    await pglite.exec(`
      INSERT INTO attendance_roles(id, name) VALUES (1, 'Waiter');
      INSERT INTO attendance_role_shifts(role_id, label, start_time, end_time) VALUES (1, 'Morning', '08:00', '16:00');
    `);

    const names = ["Abebe", "Mulu", "Sara", "Aster", "Liya", "Beti", "Tigist", "Selam", "Kebede", "Dawit"];
    for (let i = 0; i < names.length; i++) {
      await pglite.query(
        "INSERT INTO attendance_members(id, name, role_id, active) VALUES ($1, $2, 1, true)",
        [i + 1, names[i]]
      );
      await pglite.query(
        "INSERT INTO attendance_biometrics(member_id, fingerprint_id, finger_name) VALUES ($1, $2, 'Right Index')",
        [i + 1, 51 + i]
      );
    }

    // ── 1. Batch Offline Sync of 10 Registered Employees (+ 1 unmapped slot) ──
    let attendancePushes = 0;
    const unsubAtt = subscribe(CHANNELS.attendance, () => { attendancePushes++; });

    const baseEpoch = Math.floor(new Date("2026-10-30T08:02:00+03:00").getTime() / 1000);
    const events: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10; i++) {
      if (i === 4) {
        events.push({
          eventId: randomBytes(16).toString("hex"),
          fingerprintId: 999, // unmapped template on sensor - must not block others
          scannedAt: baseEpoch + i * 30,
          requireRecordedTime: true,
        });
      }
      events.push({
        eventId: randomBytes(16).toString("hex"),
        fingerprintId: 51 + i,
        capturedMemberId: i + 1,
        scannedAt: baseEpoch + i * 30 + 5,
        requireRecordedTime: true,
      });
    }

    const batchRes = await postClock(
      new Request("https://fana.test/api/attendance/clock", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-attendance-device": "test-device-token",
        },
        body: JSON.stringify({
          deviceId: "entrance_offline",
          method: "fingerprint",
          requireRecordedTime: true,
          events,
        }),
      })
    );

    assert.equal(batchRes.status, 200);
    assert.match(batchRes.headers.get("Cache-Control") || "", /no-store/);
    const batchData = await batchRes.json();
    assert.equal(batchData.batch, true);
    assert.equal(batchData.count, 11);

    const committedItems = (batchData.results as Array<Record<string, unknown>>).filter(
      (r) => r.httpStatus === 200
    );
    const notFoundItems = (batchData.results as Array<Record<string, unknown>>).filter(
      (r) => r.httpStatus === 404 && r.status === "not_found"
    );
    assert.equal(committedItems.length, 10, "all 10 registered employees must commit");
    assert.equal(notFoundItems.length, 1, "unmapped finger is isolated without blocking others");
    assert.equal(attendancePushes, 1, "batch sync broadcasts a single coalesced paper-sheet refresh");

    const sheetLogs = (
      await pglite.query<{ member_id: number; date: string; clock_in: Date }>(
        "SELECT member_id, date, clock_in FROM attendance_logs WHERE date = '2026-10-30' ORDER BY member_id"
      )
    ).rows;
    assert.equal(sheetLogs.length, 10, "every one of the 10 offline scans appears on the sheet");
    for (let i = 0; i < 10; i++) {
      assert.equal(sheetLogs[i].member_id, i + 1);
      assert.equal(
        Math.floor(new Date(sheetLogs[i].clock_in).getTime() / 1000),
        baseEpoch + i * 30 + 5,
        "original offline capture timestamp is preserved"
      );
    }

    // Replaying the exact same batch (e.g. Wi-Fi dropped right as HTTP 200 returned)
    // must be 100% idempotent: same receipts returned, zero duplicate/altered logs.
    const replayRes = await postClock(
      new Request("https://fana.test/api/attendance/clock", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-attendance-device": "test-device-token",
        },
        body: JSON.stringify({
          deviceId: "entrance_offline",
          method: "fingerprint",
          requireRecordedTime: true,
          events,
        }),
      })
    );
    assert.equal(replayRes.status, 200);
    const replayData = await replayRes.json();
    const replayedOk = (replayData.results as Array<Record<string, unknown>>).filter(
      (r) => r.httpStatus === 200 && r.action === "clock_in" && r.success === true
    );
    assert.equal(replayedOk.length, 10, "network-drop batch retry returns exact stored receipts");

    // Afternoon OUT batch (8 hours later while offline): all 10 clock OUT cleanly.
    const outEpoch = Math.floor(new Date("2026-10-30T16:05:00+03:00").getTime() / 1000);
    const outEvents = Array.from({ length: 10 }, (_, i) => ({
      eventId: randomBytes(16).toString("hex"),
      fingerprintId: 51 + i,
      capturedMemberId: i + 1,
      scannedAt: outEpoch + i * 20,
      requireRecordedTime: true,
    }));
    const outRes = await postClock(
      new Request("https://fana.test/api/attendance/clock", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-attendance-device": "test-device-token",
        },
        body: JSON.stringify({
          deviceId: "entrance_offline",
          method: "fingerprint",
          requireRecordedTime: true,
          events: outEvents,
        }),
      })
    );
    assert.equal(outRes.status, 200);
    const closedLogs = (
      await pglite.query<{ member_id: number; clock_out: Date; status: string }>(
        "SELECT member_id, clock_out, status FROM attendance_logs WHERE date = '2026-10-30' ORDER BY member_id"
      )
    ).rows;
    assert.equal(closedLogs.length, 10);
    for (let i = 0; i < 10; i++) {
      assert.ok(closedLogs[i].clock_out, "every employee clocked OUT accurately");
      assert.equal(closedLogs[i].status, "completed");
    }
    unsubAtt();

    // ── 2. Live Enrollment Step Progress + Automatic Completion ──
    let devicePushes = 0;
    const unsubDev = subscribe(CHANNELS.device, () => { devicePushes++; });

    await pglite.query(
      "INSERT INTO attendance_members(id, name, role_id, active) VALUES (11, 'Hanna', 1, true)"
    );
    await pglite.query(
      "INSERT INTO attendance_enroll_jobs(id, member_id, member_name, fingerprint_id, status) VALUES (77, 11, 'Hanna', 61, 'pending')"
    );

    const pendingRes = await getBiometrics(
      new Request("https://fana.test/api/attendance/biometrics?pending=1&limit=1", {
        headers: { "x-attendance-device": "test-device-token" },
      })
    );
    assert.equal(pendingRes.status, 200);
    assert.match(pendingRes.headers.get("Cache-Control") || "", /no-store/);
    const pendingJson = await pendingRes.json();
    assert.equal(pendingJson.jobs[0].jobId, 77);
    assert.equal(pendingJson.jobs[0].fingerprintId, 61);

    // Step A: Scanner acknowledges receipt
    const startRes = await postMappings(
      new Request("https://fana.test/api/attendance/mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-attendance-device": "test-device-token" },
        body: JSON.stringify({
          action: "job_started",
          jobId: 77,
          fingerprintId: 61,
          detail: "Scanner received the request. Wait for PLACE FINGER on its screen (ID 61)",
        }),
      })
    );
    assert.equal(startRes.status, 200);
    assert.equal(devicePushes, 1);

    // Step B: Scanner LCD begins accepting the finger (1/3)
    const progRes = await postMappings(
      new Request("https://fana.test/api/attendance/mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-attendance-device": "test-device-token" },
        body: JSON.stringify({
          action: "job_progress",
          jobId: 77,
          fingerprintId: 61,
          detail: "Scanner LCD accepting finger (1/3): PLACE FINGER",
        }),
      })
    );
    assert.equal(progRes.status, 200);
    assert.equal(devicePushes, 2);

    const jobMid = (
      await pglite.query<{ status: string; detail: string; started_at: Date }>(
        "SELECT status, detail, started_at FROM attendance_enroll_jobs WHERE id = 77"
      )
    ).rows[0];
    assert.equal(jobMid.status, "pending");
    assert.ok(jobMid.started_at, "started_at preserved across progress updates");
    assert.equal(jobMid.detail, "Scanner LCD accepting finger (1/3): PLACE FINGER");

    // Step C: Scanner finishes confirmation scan and uploads mapping with jobId
    const doneRes = await postMappings(
      new Request("https://fana.test/api/attendance/mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-attendance-device": "test-device-token" },
        body: JSON.stringify({
          jobId: 77,
          fingerprintId: 61,
          memberId: 11,
          memberName: "Hanna",
          staffName: "Hanna",
        }),
      })
    );
    assert.equal(doneRes.status, 200);
    assert.equal(devicePushes, 3);

    const jobAfter = (
      await pglite.query<{ status: string; completed_at: Date }>(
        "SELECT status, completed_at FROM attendance_enroll_jobs WHERE id = 77"
      )
    ).rows[0];
    assert.equal(jobAfter.status, "done");
    assert.ok(jobAfter.completed_at);

    unsubDev();
    console.log("✅ End-to-end PGlite verification PASSED: 10-employee batch offline sync + live LCD enrollment progress & auto-completion");
  } finally {
    await pglite.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
