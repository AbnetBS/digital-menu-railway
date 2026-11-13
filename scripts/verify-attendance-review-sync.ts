#!/usr/bin/env tsx
/**
 * End-to-end PostgreSQL (PGlite) verification for guaranteed scan recovery:
 *   1. Power-on without clock sync -> 3 employees scan -> power-off -> later
 *      boot with Wi-Fi: the 3 retained `unknown_time` scans upload to
 *      POST /api/attendance/review while the 4th scan (with clock) posts to
 *      POST /api/attendance/clock.
 *   2. GET /api/attendance/today returns the 4th scan in `logs` AND surfaces
 *      all 3 retained scans in `pendingReviews` with each role's entrance time.
 *   3. PATCH /api/attendance/review ("Confirm All on Sheet") writes all 3
 *      employees onto `attendance_logs`, updates Today Live & Paper Sheet, and
 *      clears `pendingReviews` to 0.
 *   4. POST /api/attendance/review (`action: "manual_record"`) requires admin
 *      session and records multiple employees onto Today Live & Paper Sheet.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

async function main() {
  const pglite = new PGlite();

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
  process.env.SESSION_SECRET = "test-session-secret-for-attendance-review-sync-32b";
  Object.assign(process.env, { NODE_ENV: "production" });

  let currentAdminCookie = "";
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  const resolvedHeaders = req.resolve("next/headers");
  req.cache[resolvedHeaders] = {
    id: resolvedHeaders,
    filename: resolvedHeaders,
    loaded: true,
    exports: {
      cookies: async () => ({
        get: (name: string) =>
          name === "fana_admin_auth" && currentAdminCookie ? { name, value: currentAdminCookie } : undefined,
        set: () => {},
        delete: () => {},
      }),
    },
  } as NodeJS.Module;

  try {
    const { ensureTablesExist } = await import("../src/db/migrate");
    const { signToken } = await import("../src/lib/session");
    const { POST: postClock } = await import("../src/app/api/attendance/clock/route");
    const { GET: getDeviceStatus } = await import("../src/app/api/attendance/device-status/route");
    const { GET: getBiometrics } = await import("../src/app/api/attendance/biometrics/route");
    const { getScannerStatus, onScannerStreamOpen } = await import("../src/lib/scanner-status");
    const { GET: getToday } = await import("../src/app/api/attendance/today/route");
    const { GET: getLogs } = await import("../src/app/api/attendance/logs/route");
    const { POST: postReview, PATCH: patchReview } = await import("../src/app/api/attendance/review/route");

    const mig = await ensureTablesExist();
    assert.equal(mig.success, true, mig.errors.join("\n"));

    await pglite.exec(`
      INSERT INTO attendance_roles(id, name) VALUES (1, 'Chef'), (2, 'Manager');
      INSERT INTO attendance_role_shifts(role_id, label, start_time, end_time, late_grace_minutes)
      VALUES (1, 'Morning', '06:00', '14:00', 30), (2, 'Day', '08:00', '17:00', 30);
      INSERT INTO attendance_members(id, name, role_id, active) VALUES
        (1, 'Ayelech', 1, true),
        (2, 'Bontu', 1, true),
        (3, 'Emawayesh', 1, true),
        (4, 'Owner', 2, true),
        (5, 'Meskerem', 1, true);
      INSERT INTO attendance_biometrics(member_id, fingerprint_id, finger_name) VALUES
        (1, 11, 'Right Index'),
        (2, 12, 'Right Index'),
        (3, 13, 'Right Index'),
        (4, 14, 'Right Index'),
        (5, 15, 'Right Index');
    `);

    const targetDate = "2026-11-03";
    const ownerEpoch = Math.floor(new Date("2026-11-03T08:10:00+03:00").getTime() / 1000);

    // 1. Three employees scanned on boot1 without clock; device uploads their
    //    retained /queue.review.jsonl records to POST /api/attendance/review.
    const ev1 = randomBytes(16).toString("hex");
    const ev2 = randomBytes(16).toString("hex");
    const ev3 = randomBytes(16).toString("hex");

    const revUpload = await postReview(
      new Request("https://fana.test/api/attendance/review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-attendance-device": "test-device-token",
        },
        body: JSON.stringify({
          deviceId: "entrance",
          items: [
            { reason: "unknown_time", record: { eventId: ev1, fingerprintId: 11, memberId: 1, staffName: "Ayelech", bootId: "boot111111111111", uptimeSeconds: 12 } },
            { reason: "unknown_time", record: { eventId: ev2, fingerprintId: 12, memberId: 2, staffName: "Bontu", bootId: "boot111111111111", uptimeSeconds: 19 } },
            { reason: "unknown_time", record: { eventId: ev3, fingerprintId: 13, memberId: 3, staffName: "Emawayesh", bootId: "boot111111111111", uptimeSeconds: 26 } },
          ],
        }),
      })
    );
    assert.equal(revUpload.status, 200);
    const revData = await revUpload.json();
    assert.equal(revData.ok, true);
    assert.deepEqual(revData.acceptedEventIds, [ev1, ev2, ev3]);

    // Duplicate retry of the same review batch must be idempotent.
    const revReplay = await postReview(
      new Request("https://fana.test/api/attendance/review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-attendance-device": "test-device-token",
        },
        body: JSON.stringify({
          deviceId: "entrance",
          items: [
            { reason: "unknown_time", record: { eventId: ev1, fingerprintId: 11, memberId: 1, staffName: "Ayelech" } },
          ],
        }),
      })
    );
    assert.equal(revReplay.status, 200);

    // Owner scans on boot2 with valid clock.
    const ownerClock = await postClock(
      new Request("https://fana.test/api/attendance/clock", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-attendance-device": "test-device-token",
        },
        body: JSON.stringify({
          eventId: randomBytes(16).toString("hex"),
          fingerprintId: 14,
          capturedMemberId: 4,
          scannedAt: ownerEpoch,
          deviceId: "entrance_offline",
          method: "fingerprint",
          requireRecordedTime: true,
        }),
      })
    );
    assert.equal(ownerClock.status, 200);

    // 2. Today Live shows Owner in `logs` AND surfaces all 3 chefs in `pendingReviews`
    //    with suggestedInTime = "06:00" (from Chef Morning shift).
    const todayBefore = await (
      await getToday(new Request(`https://fana.test/api/attendance/today?date=${targetDate}`))
    ).json();
    assert.equal(todayBefore.logs.length, 1);
    assert.equal(todayBefore.logs[0].memberName, "Owner");
    assert.equal(todayBefore.pendingReviews.length, 3);
    assert.equal(todayBefore.pendingReviews[0].suggestedInTime, "06:00");

    // Device token WITHOUT admin session cannot invoke manual_record or PATCH.
    const blockedManual = await postReview(
      new Request("https://fana.test/api/attendance/review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-attendance-device": "test-device-token",
        },
        body: JSON.stringify({ action: "manual_record", memberIds: [5], date: targetDate, useRoleStart: true }),
      })
    );
    assert.equal(blockedManual.status, 401);

    // Sign in as Admin and confirm all 3 pending scanner scans onto the sheet.
    currentAdminCookie = signToken(
      { kind: "admin", iat: Date.now() },
      process.env.SESSION_SECRET!
    );

    const confirmRes = await patchReview(
      new Request("https://fana.test/api/attendance/review", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: todayBefore.pendingReviews.map((r: { id: number; memberId: number }) => ({
            id: r.id,
            memberId: r.memberId,
            date: targetDate,
            clockInTime: "06:05",
          })),
        }),
      })
    );
    assert.equal(confirmRes.status, 200);
    const confirmData = await confirmRes.json();
    assert.equal(confirmData.resolvedCount, 3);

    // 3. Manual Record Attendance for Meskerem using role entrance time ("06:00").
    const manualRes = await postReview(
      new Request("https://fana.test/api/attendance/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "manual_record",
          memberIds: [5],
          date: targetDate,
          useRoleStart: true,
        }),
      })
    );
    assert.equal(manualRes.status, 200);

    // 4. Verify Today Live AND Paper Sheet now list all 5 employees On Time with 0 pending reviews.
    const todayAfter = await (
      await getToday(new Request(`https://fana.test/api/attendance/today?date=${targetDate}`))
    ).json();
    assert.equal(todayAfter.pendingReviews.length, 0);
    assert.equal(todayAfter.logs.length, 5);
    assert.ok(todayAfter.logs.every((l: { lateMinutes: number }) => l.lateMinutes === 0));

    const sheetRes = await (
      await getLogs(new Request(`https://fana.test/api/attendance/logs?from=${targetDate}&to=${targetDate}`))
    ).json();
    for (const memberId of [1, 2, 3, 4, 5]) {
      assert.ok(sheetRes.matrix[memberId]?.[targetDate]?.clockInTime, `Member ${memberId} must be on Paper Sheet`);
    }

    // 5. Close out "Still In" employees using role end time while preserving
    // Owner's real morning scan ("08:10").
    const closeOutRes = await postReview(
      new Request("https://fana.test/api/attendance/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "manual_record",
          memberIds: [1, 2, 3, 4, 5],
          date: targetDate,
          useRoleStart: true,
          useRoleEnd: true,
          keepExistingIn: true,
        }),
      })
    );
    assert.equal(closeOutRes.status, 200);

    const todayClosed = await (
      await getToday(new Request(`https://fana.test/api/attendance/today?date=${targetDate}`))
    ).json();
    const ownerClosed = todayClosed.logs.find((l: { memberId: number }) => l.memberId === 4);
    assert.equal(ownerClosed?.clockInTime, "08:10");
    assert.equal(ownerClosed?.clockOutTime, "17:00");
    assert.ok(Boolean(todayClosed.logs.every((l: { clockOutTime: string | null }) => l.clockOutTime)));

    // 6. Real-time Online / Offline scanner reachability check:
    //    - Opening SSE stream marks Online immediately (0 ms).
    //    - Closing SSE stream marks Offline automatically after 1.5s grace.
    //    - Silent plug-pull (no TCP FIN) expires automatically after beat window.
    const closeStream = onScannerStreamOpen(3000);
    assert.equal((await getScannerStatus(Date.now(), false)).online, true);
    closeStream();
    assert.equal((await getScannerStatus(Date.now() + 1_600, false)).online, false);

    const pollRes = await getBiometrics(
      new Request("https://fana.test/api/attendance/biometrics?pending=1&limit=1", {
        headers: { "x-attendance-device": "test-device-token", "x-scanner-beat-ms": "3000" },
      })
    );
    assert.equal(pollRes.status, 200);

    const statusRes = await getDeviceStatus();
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.online, true);

    const expiredStatus = await getScannerStatus(Date.now() + 7_000, false);
    assert.equal(expiredStatus.online, false);

    console.log("✅ Attendance review sync & manual recovery guard PASSED");
  } finally {
    await pglite.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
