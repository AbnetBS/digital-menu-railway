#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { GET } from "../src/app/api/attendance/device-time/route";

async function main() {
  const previous = process.env.ATTENDANCE_DEVICE_TOKEN;
  try {
    process.env.ATTENDANCE_DEVICE_TOKEN = "test-only-device-token";
    const denied = await GET(new Request("https://fana.test/api/attendance/device-time"));
    assert.equal(denied.status, 401);
    const before = Date.now();
    const response = await GET(new Request("https://fana.test/api/attendance/device-time", {
      headers: { "x-attendance-device": "test-only-device-token" },
    }));
    const after = Date.now();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") || "", /no-store/);
    const body = await response.json();
    assert.equal(body.service, "fana-attendance-time-v1");
    assert.equal(Number.isInteger(body.epochSeconds), true);
    assert.ok(body.millisecond >= 0 && body.millisecond < 1000);
    const stamp = body.epochSeconds * 1000 + body.millisecond;
    assert.ok(stamp >= before && stamp <= after, "the website returns its current time, not a cached answer");
  } finally {
    if (previous === undefined) delete process.env.ATTENDANCE_DEVICE_TOKEN;
    else process.env.ATTENDANCE_DEVICE_TOKEN = previous;
  }
  console.log("Attendance device time passed: fresh clock, no-cache and device authorization.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
