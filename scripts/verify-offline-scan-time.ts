#!/usr/bin/env tsx
/** Offline scan-time regression guards. The real PostgreSQL route test and
 * native queue simulator complement these parser and source assertions. */
import { readFileSync } from "node:fs";
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

const clockApi = read("src/app/api/attendance/clock/route.ts");
const rules = read("src/lib/attendance.ts");
const firmware = read("hardware/fana_attendance_esp32/fana_attendance_esp32.ino");
const queue = read("hardware/fana_attendance_esp32/OfflineQueue.h");
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
    `${what} is marked untrusted by the legacy parser`,
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
  "a refused time has an arrival fallback for legacy callers, but remains untrusted",
  refused.every(([, raw]) => scannedTimeOf(raw, arrived).time instanceof Date)
);

pass(
  "the parser can retain authenticated scans older than three days without accepting nonsensical or future times",
  scannedTimeOf(epochSeconds(back(7 * DAY)), arrived, { allowOlder: true }).time.getTime() === back(7 * DAY).getTime() &&
    !scannedTimeOf("bad", arrived, { allowOlder: true }).trusted &&
    !scannedTimeOf(epochSeconds(new Date("2019-01-01T00:00:00Z")), arrived, { allowOlder: true }).trusted &&
    !scannedTimeOf(epochSeconds(new Date(arrived.getTime() + DAY)), arrived, { allowOlder: true }).trusted
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

/* ── 6. durable queue and timestamp path ─────────────────────────────────── */
pass("the device reads NTP without blocking the scanner", firmware.includes("unsigned long wallClockEpoch()") &&
  firmware.includes("if (!getLocalTime(&t, 0) || t.tm_year < (2020 - 1900)) return 0;"));
pass("the scanner records image-capture uptime and timestamp before enqueueing", firmware.includes("finger.capturedImageMillis()") &&
  firmware.includes("const unsigned long scannedAt = scanEpochAtUptime(capturedUptimeMs);") &&
  firmware.includes("esp_timer_get_time() / 1000ULL") && firmware.includes("saveToQueue(fingerprintId, name, memberId, scannedAt, uptimeMs)"));
pass("64-bit monotonic uptime and an atomic anchor survive millis wrap", firmware.includes("uint64_t uptimeAtSyncSeconds") &&
  firmware.includes("portENTER_CRITICAL(&clockMux)") && firmware.includes("if (!epoch) return 0;"));
pass("an unanchored scan is held until a durable anchor or manual review", firmware.includes("pendingUnknownTime = true") &&
  firmware.includes("saveClockAnchor(bootId, epoch") && firmware.includes("readClockAnchor(originalBoot") &&
  firmware.includes('copyToReview(head, "unknown_time")'));
pass("every delivery has a stable event ID and recorded time", firmware.includes('postDoc["eventId"] = eventId;') &&
  firmware.includes('postDoc["scannedAt"] = scannedAt;') && firmware.includes('postDoc["requireRecordedTime"] = true;') &&
  firmware.includes("mbedtls_md_info_from_type(MBEDTLS_MD_SHA256)"));
pass("no network request holds the queue lock", firmware.includes("offlineQueue->peek(head)") &&
  firmware.includes("http.POST(json)") && firmware.includes("offlineQueue->acknowledge(head)") && queue.includes("Guard guard(mutex_);"));
pass("failed writes and corrupt records cannot masquerade as saved scans", firmware.includes("LittleFS.begin(false)") &&
  firmware.includes("SCAN NOT SAVED") && queue.includes("written == record.length()") && queue.includes("return BLOCKED;"));
pass("failed or unauthorized HTTP requests leave the record queued", /if \(httpCode != 200\) \{[\s\S]{0,180}return false;/.test(firmware));
pass("changed mappings or out-of-order scans are retained for review", firmware.includes('copyToReview(head, "server_conflict")') &&
  clockApi.includes('status: "mapping_changed"') && clockApi.includes('status: "out_of_order"'));
pass("the route rejects invalid recorded times instead of substituting arrival", clockApi.includes("if (exactTime && !scan.trusted)") &&
  clockApi.includes('status: "invalid_scan_time"') && clockApi.includes('deviceId.endsWith("_offline")'));
pass("older scans require a configured token and duplicate event receipts are atomic", clockApi.includes("ATTENDANCE_DEVICE_TOKEN") &&
  clockApi.includes("pg_advisory_xact_lock") && clockApi.includes("tx.insert(attendanceScanEvents)") &&
  clockApi.includes("db.transaction(async (tx)"));
pass("the README documents the time, power loss, token and review limitations", deviceReadme.includes("**A kept scan carries its own time.**") &&
  deviceReadme.includes("Kept scans are delivered oldest first") && deviceReadme.includes("battery-backed RTC") &&
  deviceReadme.includes("queue review") && deviceReadme.includes("older than three days"));

/* ── 7. compiled host simulator ─────────────────────────────────────────── */
const run = spawnSync("python3", [path.join(ROOT, "hardware/fana_attendance_esp32/test/run_host_tests.py")], { encoding: "utf8" });
const out = `${run.stdout || ""}${run.stderr || ""}`;
pass("actual queue and R307 flow pass their compiled host simulations",
  run.status === 0 && out.includes("Offline queue tests passed") && out.includes("Enrollment flow tests passed"), out);

if (failures > 0) {
  console.error(`\n❌ OFFLINE SCAN TIME GUARD FAILED (${failures})\n`);
  process.exit(1);
}
console.log("\n✅ Offline scan time guard PASSED");
console.log("   • a kept scan travels with the moment of the finger, not the moment the internet came back");
console.log("   • pre-NTP scans use a durable same-boot anchor or are retained for review");
console.log("   • only an allowed device may backdate; >3 days requires its configured token");
console.log("   • day row, IN, OUT, lateness and the one-hour rule all follow that moment; the note keeps both times");
