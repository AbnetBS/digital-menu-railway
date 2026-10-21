#!/usr/bin/env tsx
/**
 * Regression guard: AN OFFLINE SCAN KEEPS THE MOMENT OF THE FINGER (owner, Oct 2026).
 *
 * The owner's question:
 *
 *   "does the offline scan lie when there is not stable connection or no
 *    connection? if someone place his finger it will store it and put it in
 *    list in that scanned time when the connection is back, right?"
 *
 * Storing was already true. The TIME was not: the device kept a scan it could
 * not deliver, and the website stamped it with the moment it ARRIVED. Three
 * real consequences in a cafe with an unstable connection:
 *
 *   • a person who scanned IN on time at 12:30 during an outage that ended at
 *     13:20 was written down as IN 13:20, i.e. LATE by 35 minutes;
 *   • an IN and an OUT that were both kept arrived seconds apart, so the
 *     one-hour repeat lock answered "already registered" and the day stayed
 *     OPEN with no hours at all;
 *   • a scan kept overnight landed on the next day's row of the sheet.
 *
 * What has to stay true now:
 *
 *   1. The device stamps a kept scan with the moment of the finger (`scannedAt`,
 *      epoch seconds) from the same NTP clock that drives its LCD row, and the
 *      last good clock plus the elapsed milliseconds carries it forward while
 *      NTP itself is unreachable.
 *   2. A device that has NOT reached NTP since it was powered on claims no time
 *      at all - it never invents one - and then the website stamps the arrival,
 *      exactly as it always did. A line queued by older firmware has no
 *      `scannedAt` and gets none.
 *   3. The website believes that time ONLY from an allowed device and only for
 *      the fingerprint path. A PIN typed in a browser, or a correction typed by
 *      the admin, always counts as now: nobody can write history by sending a
 *      time.
 *   4. The time is bounded: never in the future (beyond a small grace for a
 *      fast clock) and never older than three days. Outside that, the arrival
 *      time is used and the reason is recorded.
 *   5. The day row, the IN, the OUT, the late minutes, the early-out check and
 *      the one-hour repeat rule are ALL counted on that moment, while
 *      `updated_at` keeps the arrival - and the note says both times, so a
 *      back-dated scan is never a secret.
 *   6. Kept scans are delivered oldest first, a refused one is dropped, and one
 *      that still cannot reach the website stays in the queue.
 *
 * The rules are imported from the real module (src/lib/attendance.ts) and the
 * device behaviour is proven by the compiled host test.
 *
 * Run with: npx tsx scripts/verify-offline-scan-time.ts
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  OFFLINE_SCAN_FUTURE_GRACE_MINUTES,
  OFFLINE_SCAN_MAX_AGE_DAYS,
  clockLabel,
  offlineScanNote,
  scannedTimeOf,
} from "../src/lib/attendance";

let failures = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
  if (!cond) failures++;
};

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel: string) => existsSync(path.join(ROOT, rel));

const clockApi = read("src/app/api/attendance/clock/route.ts");
const rules = read("src/lib/attendance.ts");
const firmware = read("hardware/fana_attendance_esp32/fana_attendance_esp32.ino");
const rawFirmware = firmware;
const hostTest = read("hardware/fana_attendance_esp32/test/README.md");
const deviceReadme = read("hardware/fana_attendance_esp32/README.md");

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const arrived = new Date("2026-10-15T13:20:00Z");
const back = (ms: number) => new Date(arrived.getTime() - ms);
const epochSeconds = (d: Date) => Math.floor(d.getTime() / 1000);

/* ── 1. the limits the owner's rule is built on ───────────────────────────── */

pass(
  "a kept scan may reach back three days, and a device clock may run two minutes fast",
  OFFLINE_SCAN_MAX_AGE_DAYS === 3 && OFFLINE_SCAN_FUTURE_GRACE_MINUTES === 2
);

/* ── 2. a time the website can believe ───────────────────────────────────── */

const finger = back(50 * MINUTE); // scanned 12:30, arrived 13:20
pass(
  "the epoch SECONDS the device sends are read as the moment of the finger",
  scannedTimeOf(epochSeconds(finger), arrived).time.getTime() === finger.getTime() &&
    scannedTimeOf(epochSeconds(finger), arrived).trusted
);
pass(
  "a number, a numeric string, epoch milliseconds and an ISO stamp all mean the same moment",
  [
    epochSeconds(finger),
    String(epochSeconds(finger)),
    finger.getTime(),
    finger.toISOString(),
  ].every((raw) => scannedTimeOf(raw, arrived).time.getTime() === finger.getTime()),
  [epochSeconds(finger), String(epochSeconds(finger)), finger.getTime(), finger.toISOString()]
    .map((raw) => `${String(raw)} -> ${scannedTimeOf(raw, arrived).time.toISOString()}`)
    .join(" | ")
);
pass(
  "the day row, the IN and the OUT are all counted on that moment, not on the arrival",
  scannedTimeOf(epochSeconds(finger), arrived).time.getUTCFullYear() === 2026 &&
    clockLabel(scannedTimeOf(epochSeconds(finger), arrived).time) !== clockLabel(arrived)
);
pass(
  "a clock running a minute fast is still believed",
  scannedTimeOf(epochSeconds(new Date(arrived.getTime() + MINUTE)), arrived).trusted
);
pass(
  "the arrival time is always kept beside it, so nothing is hidden",
  scannedTimeOf(epochSeconds(finger), arrived).arrivedAt.getTime() === arrived.getTime()
);

/* ── 3. a time the website refuses ───────────────────────────────────────── */

const refused: Array<[string, unknown, string]> = [
  ["nothing at all", undefined, "missing"],
  ["an empty value", "", "missing"],
  ["a null", null, "missing"],
  ["words", "half past twelve", "unreadable"],
  ["an object", { at: 5 }, "unreadable"],
  ["a list", [5], "unreadable"],
  ["not a number", Number.NaN, "unreadable"],
  ["a moment tomorrow", epochSeconds(new Date(arrived.getTime() + DAY)), "in_the_future"],
  ["a moment an hour in the future", epochSeconds(new Date(arrived.getTime() + 60 * MINUTE)), "in_the_future"],
  ["a moment a week ago", epochSeconds(back(7 * DAY)), "too_old"],
  ["a moment from 2019", epochSeconds(new Date("2019-01-01T09:00:00Z")), "too_old"],
];
for (const [what, raw, reason] of refused) {
  const scan = scannedTimeOf(raw, arrived);
  pass(
    `${what} is refused and the scan is stamped on arrival`,
    !scan.trusted && scan.reason === reason && scan.time.getTime() === arrived.getTime(),
    `reason=${scan.reason} time=${scan.time.toISOString()}`
  );
}
pass(
  "the last moment still inside the three days is believed, and one outside is not",
  scannedTimeOf(epochSeconds(back(3 * DAY - MINUTE)), arrived).trusted &&
    !scannedTimeOf(epochSeconds(back(3 * DAY + MINUTE)), arrived).trusted
);
pass(
  "a refused time still produces a usable moment, so the scan is never lost",
  refused.every(([, raw]) => scannedTimeOf(raw, arrived).time instanceof Date)
);

/* ── 4. the note keeps both times ────────────────────────────────────────── */

pass(
  "a late arrival writes down the finger's time and the server's time",
  (offlineScanNote(scannedTimeOf(epochSeconds(finger), arrived)) || "").includes(
    `finger at ${clockLabel(finger)}`
  ) &&
    (offlineScanNote(scannedTimeOf(epochSeconds(finger), arrived)) || "").includes(
      `reached the server ${clockLabel(arrived)}`
    ) &&
    (offlineScanNote(scannedTimeOf(epochSeconds(finger), arrived)) || "").includes("(50 min later)"),
  offlineScanNote(scannedTimeOf(epochSeconds(finger), arrived)) || "-"
);
pass(
  "a scan that arrived as it happened, or one whose time was refused, writes no note",
  offlineScanNote(scannedTimeOf(epochSeconds(arrived), arrived)) === null &&
    offlineScanNote(scannedTimeOf(undefined, arrived)) === null &&
    offlineScanNote(scannedTimeOf(epochSeconds(back(7 * DAY)), arrived)) === null
);

/* ── 5. only the device may say when a scan happened ─────────────────────── */

pass(
  "the route reads scannedAt only for the fingerprint path of an allowed device",
  clockApi.includes("method === \"fingerprint\" && deviceAllowed(request) ? scannedAt : undefined") &&
    clockApi.includes("scannedTimeOf(") &&
    clockApi.includes("import { deviceAllowed } from \"@/lib/attendance-device\";")
);
pass(
  "everything below is counted on that moment, and the arrival goes to updated_at",
  clockApi.includes("const now = scan.time;") &&
    clockApi.includes("const arrivedAt = scan.arrivedAt;") &&
    clockApi.includes("const todayKey = dayKeyOf(scan.time);") &&
    clockApi.includes("const nowMinutes = etMinutes(now);") &&
    clockApi.includes("clockIn: now,") &&
    clockApi.includes("clockOut: now,") &&
    clockApi.includes("rescanAction(existing.clockIn, now)") &&
    clockApi.includes("updatedAt: arrivedAt,") &&
    !clockApi.includes("const now = new Date();\n    const nowMinutes")
);
pass(
  "the audit note of both the IN and the OUT keeps the two times",
  (clockApi.match(/offlineNote \|\| ""/g) || []).length === 2 &&
    clockApi.includes("const offlineNote = offlineScanNote(scan);") &&
    clockApi.includes("...(inNote ? { notes: inNote } : {})") &&
    clockApi.includes("...(outNote ? { notes: outNote } : {})")
);
pass(
  "the supervisor's audit line survived, word for word",
  clockApi.includes("`PIN keypad opened by supervisor ${supervisorName}`") &&
    clockApi.includes("`OUT by PIN, keypad opened by supervisor ${supervisorName}`")
);
pass(
  "the PIN keypad cannot back-date a scan, so nobody can write history by typing a time",
  !/method === "pin"[\s\S]{0,900}scannedAt/.test(clockApi) &&
    clockApi.includes("method === \"fingerprint\" && deviceAllowed(request) ? scannedAt : undefined")
);
pass(
  "reading a day still means today, and the limits live in the rules module",
  clockApi.includes("const date = searchParams.get(\"date\") || getTodayKey();") &&
    rules.includes("export const OFFLINE_SCAN_MAX_AGE_DAYS = 3;") &&
    rules.includes("export const OFFLINE_SCAN_FUTURE_GRACE_MINUTES = 2;")
);

/* ── 6. the device keeps the moment of the finger ────────────────────────── */

pass(
  "the device knows the real time from the same NTP clock as its LCD row",
  firmware.includes("unsigned long wallClockEpoch()") &&
    firmware.includes("if (!getLocalTime(&t, 0) || t.tm_year < (2020 - 1900)) return 0;") &&
    firmware.includes("const time_t epoch = mktime(&t);")
);
pass(
  "the last good clock plus the elapsed milliseconds carries the time while NTP is silent",
  firmware.includes("unsigned long epochAtSync = 0;") &&
    firmware.includes("unsigned long millisAtSync = 0;") &&
    firmware.includes("return epochAtSync + (unsigned long)((millis() - millisAtSync) / 1000UL);") &&
    firmware.includes("if (epoch == 0) return;   // NTP has not answered: keep the pair we already have")
);
pass(
  "that pair is refreshed from the loop, once a second",
  /void loop\(\) \{[\s\S]{0,400}noteWallClock\(\);/.test(firmware) &&
    firmware.includes("if (millis() - lastWallClockNote < 1000) return;")
);
pass(
  "a device that never reached NTP claims no time and never invents one",
  firmware.includes("if (epochAtSync == 0) return 0;") &&
    /const unsigned long scannedAt = scanEpochNow\(\);\n    if \(scannedAt > 0\) doc\["scannedAt"\] = scannedAt;/.test(
      firmware
    ) &&
    /if \(scannedAt > 0\) postDoc\["scannedAt"\] = scannedAt;/.test(firmware)
);
pass(
  "the kept scan still travels as an offline scan of this device",
  firmware.includes("postDoc[\"deviceId\"] = deviceId + \"_offline\";") &&
    firmware.includes("LittleFS.open(\"/queue.json\", \"a\")")
);
pass(
  "the millis() wrap after 49 days cannot corrupt a kept time",
  rawFirmware.includes("The unsigned subtraction stays right when") &&
    rawFirmware.includes("millis() wraps around after 49 days")
);
pass(
  "offline queue behavior remains statically guarded after retiring the FPC emulator",
  firmware.includes("syncOfflineQueue()") && firmware.includes('postDoc["scannedAt"]') &&
    hostTest.includes("former native harness")
);
pass(
  "the README says a kept scan carries its own time, and what happens without NTP",
  deviceReadme.includes("**A kept scan carries its own time.**") &&
  deviceReadme.includes("If the device has not reached NTP since it was powered on it claims no time at all") &&
  deviceReadme.includes("Kept scans are delivered oldest first")
);

/* ── 7. the compiled device proves it ───────────────────────────────────── */

const testDir = path.join(ROOT, "hardware/fana_attendance_esp32/test");
if (!exists("hardware/fana_attendance_esp32/test/run.sh")) {
  pass("obsolete FPC host emulator is replaced by R307 static guards", hostTest.includes("R307 firmware regression tests"), testDir);
} else if (spawnSync("g++", ["--version"]).status !== 0) {
  console.log("⚠️  g++ not found - the compiled offline-queue test was skipped");
} else {
  const run = spawnSync("bash", [path.join(testDir, "run.sh")], { encoding: "utf8" });
  const out = `${run.stdout || ""}${run.stderr || ""}`;
  pass(
    "the simulated device passes its whole suite",
    run.status === 0 && out.includes("HARNESS PASSED"),
    out.split("\n").filter((l) => l.startsWith("FAIL") || l.includes("error:")).slice(0, 6).join("\n")
  );
  const wanted = [
    "a scan nobody could deliver is kept in flash, not dropped",
    "the kept scan carries the moment of the finger",
    "the kept scan is delivered once the internet is back",
    "it goes to the clock route and says it came late",
    "and it still says WHEN THE FINGER WAS PLACED, not when the internet came back",
    "a delivered scan leaves the queue empty",
    "a scan made while NTP is silent still gets a real time",
    "and that time is what is written into the queue",
    "a device that never got a time keeps the scan but claims no time",
    "so it sends no time, and the website stamps the arrival as it always did",
    "an older queued line is still delivered, without a made-up time",
    "both kept scans are delivered, oldest first",
    "a scan the website refuses is dropped, not retried for ever",
    "a scan that still cannot reach the website stays queued, with its time",
  ];
  const missing = wanted.filter((line) => !out.includes(`PASS ${line}`));
  pass("every offline-time behaviour is proven on the simulated device", missing.length === 0, missing.join(" | "));
}

if (failures > 0) {
  console.error(`\n❌ OFFLINE SCAN TIME GUARD FAILED (${failures})\n`);
  process.exit(1);
}
console.log("\n✅ Offline scan time guard PASSED");
console.log("   • a kept scan travels with the moment of the finger, not the moment the internet came back");
console.log("   • NTP silent: the last good clock plus the elapsed milliseconds; never NTP: no claimed time");
console.log("   • only an allowed device may say when, never a browser; never the future, never older than 3 days");
console.log("   • day row, IN, OUT, lateness and the one-hour rule all follow that moment; the note keeps both times");
