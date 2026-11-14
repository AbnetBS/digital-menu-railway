#!/usr/bin/env tsx
/**
 * End-to-end PostgreSQL (PGlite) verification for guaranteed scan recovery:
 *   1. Power-on without clock sync -> 3 employees scan -> power-off -> later
 *      boot with Wi-Fi: the 3 retained `unknown_time` scans upload to
 *      POST /api/attendance/review while the 4th scan (with clock) posts to
 *      POST /api/attendance/clock.
 *   2. GET /api/attendance/today lists the 4th scan AND all 3 retained scans
 *      from registered employees with each role's entrance time, with no
 *      confirmation step; `pendingReviews` stays 0.
 *   3. (Confirmation is no longer needed for registered employees.)
 *   4. POST /api/attendance/review (`action: "manual_record"`) requires admin
 *      session and records multiple employees onto Today Live & Paper Sheet.
 *   5. A timed scanner scan of a registered employee is applied automatically
 *      (no confirmation); an unmapped finger stays pending.
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
    const { GET: getLeaderboard } = await import("../src/app/api/attendance/leaderboard/route");
    const { POST: postReview } = await import("../src/app/api/attendance/review/route");
    const { etDayKey, etDayKeyDaysAgo, etStartOfDaysAgo } = await import("../src/lib/timezone");

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
        (5, 'Meskerem', 1, true),
        (6, 'Tewodros', 1, true);
      INSERT INTO attendance_biometrics(member_id, fingerprint_id, finger_name) VALUES
        (1, 11, 'Right Index'),
        (2, 12, 'Right Index'),
        (3, 13, 'Right Index'),
        (4, 14, 'Right Index'),
        (5, 15, 'Right Index'),
        (6, 16, 'Right Index');
    `);

    // Uploads without a scan time are dated by the day they reach the server,
    // so the scenario runs on today (Addis Ababa day).
    const targetDate = etDayKey(new Date()) as string;
    const ownerEpoch = Math.floor(new Date(`${targetDate}T08:10:00+03:00`).getTime() / 1000);

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

    // 2. A registered person's single scan with NO device time stays hidden
    //    (no pending list, no sheet row) until their second scan arrives.
    const todayBefore = await (
      await getToday(new Request(`https://fana.test/api/attendance/today?date=${targetDate}`))
    ).json();
    assert.equal(todayBefore.pendingReviews.length, 0, "no-time scans are not listed for anyone to confirm");
    assert.equal(todayBefore.logs.length, 1, "only the Owner is on the sheet: single no-time scans are hidden");
    const heldRows = await pglite.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM attendance_review_queue WHERE status = 'no_time'"
    );
    assert.equal(heldRows.rows[0]?.n, 3, "the three single no-time scans are held");

    // Ayelech's second no-time scan from the same boot (later uptime) completes the pair.
    const ev4 = randomBytes(16).toString("hex");
    const secondScan = await postReview(
      new Request("https://fana.test/api/attendance/review", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-attendance-device": "test-device-token" },
        body: JSON.stringify({
          deviceId: "entrance",
          items: [
            { reason: "unknown_time", record: { eventId: ev4, fingerprintId: 11, memberId: 1, staffName: "Ayelech", bootId: "boot111111111111", uptimeSeconds: 300 } },
          ],
        }),
      })
    );
    assert.equal(secondScan.status, 200);
    const todayPair = await (
      await getToday(new Request(`https://fana.test/api/attendance/today?date=${targetDate}`))
    ).json();
    const ayelech = todayPair.logs.find((l: { memberId: number }) => l.memberId === 1);
    assert.ok(ayelech?.clockInTime && ayelech?.clockOutTime, "second no-time scan completes the pair: IN then OUT");
    assert.equal(todayPair.logs.length, 2, "Ayelech and the Owner are on the sheet; the chefs stay held");
    const appliedRows = await pglite.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM attendance_review_queue WHERE status = 'resolved' AND scanned_at IS NULL"
    );
    assert.equal(appliedRows.rows[0]?.n, 2, "exactly the two Ayelech scans are applied");

    // Device token WITHOUT admin session cannot invoke manual_record.
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

    // Sign in as Admin.
    currentAdminCookie = signToken(
      { kind: "admin", iat: Date.now() },
      process.env.SESSION_SECRET!
    );

    // 3. Manual Record Attendance for the three chefs and Meskerem. The chefs keep their estimated IN.
    const manualRes = await postReview(
      new Request("https://fana.test/api/attendance/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "manual_record",
          memberIds: [1, 2, 3, 5],
          date: targetDate,
          useRoleStart: true,
        }),
      })
    );
    assert.equal(manualRes.status, 200);

    // 4. Verify Today Live AND Paper Sheet now list all 5 employees with 0 pending reviews.
    const todayAfter = await (
      await getToday(new Request(`https://fana.test/api/attendance/today?date=${targetDate}`))
    ).json();
    assert.equal(todayAfter.pendingReviews.length, 0);
    assert.equal(todayAfter.logs.length, 5);
    const ownerLate = todayAfter.logs.find((l: { memberId: number }) => l.memberId === 4);
    assert.equal(ownerLate?.lateMinutes, 0);

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

    // 7. Forgotten clock-out across midnight (00:00 EAT / 6:00 LT):
    //    - Tewodros scans IN yesterday at 06:05 EAT and forgets to scan OUT.
    //    - Today at 06:10 EAT she puts her finger on the scanner again.
    //    - Today's scan MUST be recorded as a brand-new clock_in on today (NOT
    //      yesterday's clock_out / ~24h shift), yesterday's Paper Sheet cell MUST
    //      have outStatus "no_out" (totalHours null), today's cell MUST have
    //      outStatus "still_in", and Leaderboard MUST NOT count yesterday's open
    //      hours overnight into today.
    const yestKey = etDayKeyDaysAgo(1)!;
    const todayKey = etDayKeyDaysAgo(0)!;
    const yestInEpoch = Math.floor((etStartOfDaysAgo(1).getTime() + (6 * 60 + 5) * 60_000) / 1000);
    const nowEpoch = Math.floor(Date.now() / 1000);
    const todayInEpoch = Math.min(
      nowEpoch,
      Math.floor((etStartOfDaysAgo(0).getTime() + 5 * 60_000) / 1000)
    );

    const day1ScanRes = await postClock(
      new Request("https://fana.test/api/attendance/clock", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-attendance-device": "test-device-token",
        },
        body: JSON.stringify({
          eventId: randomBytes(16).toString("hex"),
          fingerprintId: 16,
          scannedAt: yestInEpoch,
        }),
      })
    );
    assert.equal(day1ScanRes.status, 200);
    const day1Json = await day1ScanRes.json();
    assert.equal(day1Json.action, "clock_in");
    assert.equal(day1Json.date, yestKey);

    const day2ScanRes = await postClock(
      new Request("https://fana.test/api/attendance/clock", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-attendance-device": "test-device-token",
        },
        body: JSON.stringify({
          eventId: randomBytes(16).toString("hex"),
          fingerprintId: 16,
          scannedAt: todayInEpoch,
        }),
      })
    );
    assert.equal(day2ScanRes.status, 200);
    const day2Json = await day2ScanRes.json();
    assert.equal(day2Json.action, "clock_in", "next day's first scan must be a new clock_in, never yesterday's clock_out");
    assert.equal(day2Json.date, todayKey);

    const twoDaySheet = await (
      await getLogs(new Request(`https://fana.test/api/attendance/logs?from=${yestKey}&to=${todayKey}`))
    ).json();
    const yestCell = twoDaySheet.matrix[6]?.[yestKey];
    const todayCell = twoDaySheet.matrix[6]?.[todayKey];
    assert.equal(yestCell?.clockOutTime, null);
    assert.equal(yestCell?.totalHours, null);
    assert.equal(yestCell?.outStatus, "no_out", "yesterday without OUT must be no_out after midnight");
    assert.equal(todayCell?.clockOutTime, null);
    assert.equal(todayCell?.outStatus, "still_in", "today without OUT must remain still_in");

    const yestLive = await (
      await getToday(new Request(`https://fana.test/api/attendance/today?date=${yestKey}`))
    ).json();
    assert.equal(yestLive.stats.stillIn, 0, "past date must not count forgotten OUTs as stillIn");
    assert.equal(yestLive.logs[0]?.outStatus, "no_out");

    const yestOnlyBoard = await (
      await getLeaderboard(new Request(`https://fana.test/api/attendance/leaderboard?from=${yestKey}&to=${yestKey}`))
    ).json();
    const chefGroup = yestOnlyBoard.groups.find((g: { roleName: string }) => g.roleName === "Chef");
    const tewodrosYest = chefGroup?.rows.find((r: { memberId: number }) => r.memberId === 6);
    assert.equal(tewodrosYest?.workedMinutes, 0);
    assert.equal(tewodrosYest?.openMinutes, 0, "yesterday's forgotten OUT must add 0 open minutes on Leaderboard");
    assert.equal(tewodrosYest?.stillIn, false);

    // 5. A timestamped scanner scan of a REGISTERED employee goes onto Today
    //    Live and the Paper Sheet automatically: no PATCH confirmation needed.
    //    An unmapped finger with a time stays pending for an admin.
    const autoDate = etDayKeyDaysAgo(6) as string;
    const autoEv = randomBytes(16).toString("hex");
    const unmappedEv = randomBytes(16).toString("hex");
    const autoEpoch = Math.floor(new Date(`${autoDate}T07:15:00+03:00`).getTime() / 1000);
    const autoUpload = await postReview(
      new Request("https://fana.test/api/attendance/review", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-attendance-device": "test-device-token" },
        body: JSON.stringify({
          deviceId: "entrance",
          items: [
            { reason: "server_conflict", record: { eventId: autoEv, fingerprintId: 12, memberId: 2, staffName: "Bontu", scannedAt: autoEpoch, bootId: "boot222222222222", uptimeSeconds: 40 } },
            { reason: "unmapped_finger", record: { eventId: unmappedEv, fingerprintId: 99, scannedAt: autoEpoch, bootId: "boot222222222222", uptimeSeconds: 41 } },
          ],
        }),
      })
    );
    assert.equal(autoUpload.status, 200);
    const autoLive = await (
      await getToday(new Request(`https://fana.test/api/attendance/today?date=${autoDate}`))
    ).json();
    const bontuAuto = autoLive.logs.find((l: { memberName: string }) => l.memberName === "Bontu");
    assert.ok(bontuAuto, "registered employee's timed scan must appear on Today Live without confirmation");
    assert.equal(bontuAuto.clockInTime, "07:15");
    assert.equal(autoLive.pendingReviews.length, 1, "only the unmapped finger may remain pending");
    assert.equal(autoLive.pendingReviews[0].fingerprintId, 99);

    console.log("✅ Attendance review sync & manual recovery guard PASSED");
  } finally {
    await pglite.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
