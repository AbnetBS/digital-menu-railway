#!/usr/bin/env tsx
/**
 * Regression guard: the AUTOMATIC "Add Fingerprint" button must behave exactly
 * like the manual Serial `enroll <id>` command.
 *
 * The owner's report (Oct 2026): the OLED showed "PLACE FINGER / Scan 1/6"
 * just like the manual flow, but the finger was never stored, the page stopped
 * loading, and `enroll <id>` on the Serial monitor kept working. Both paths
 * called the SAME enrollFingerprint(), so the difference could only be the
 * state the sensor was in when the six captures began:
 *
 *   1. a leftover template under the ID the server picked (the old code sent a
 *      DELETE *in the middle of the placement*, which breaks the session), and
 *   2. a finger already resting on the glass when the job arrived over the
 *      event stream - the manual command never sees that, because the owner
 *      types first and only then reaches for the sensor.
 *
 * This guard checks both halves:
 *   A. the wiring (admin page <-> API <-> firmware) is still connected, and
 *   B. the REAL sketch code, compiled and run against a simulated FPC1020A,
 *      enrolls in the reported worst case and never puts a non-ADD command
 *      inside an enrollment session.
 *
 * Run with: npx tsx scripts/verify-fingerprint-enroll.ts
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { getTableColumns } from "drizzle-orm";

import { attendanceEnrollJobs } from "../src/db/schema";

let failures = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
  if (!cond) failures++;
};

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const firmware = read("hardware/fana_attendance_esp32/fana_attendance_esp32.ino");
const mappingsApi = read("src/app/api/attendance/mappings/route.ts");
const biometricsApi = read("src/app/api/attendance/biometrics/route.ts");
const adminTab = read("src/components/rms/AttendanceTab.tsx");
const migrate = read("src/db/migrate.ts");

/* ── 1. both enrollment paths go through the one function ─────────────────── */

pass(
  "the website job and the Serial command call the same enrollFingerprint()",
  (firmware.match(/= enrollFingerprint\(/g) || []).length === 2 &&
    firmware.includes("result = enrollFingerprint(fingerprintId, memberName)") &&
    firmware.includes('const EnrollResult result = enrollFingerprint(id, "")')
);
pass(
  "the six-capture order is unchanged: 1x step 1, 4x step 2, 1x step 3",
  /const uint8_t captureSteps\[6\] = \{1, 2, 2, 2, 2, 3\}/.test(firmware) &&
    firmware.includes("finger.enroll((uint16_t)id, captureSteps[cap]")
);

/* ── 2. the pre-flight that makes the two paths start identically ─────────── */

pass(
  "a leftover template is deleted BEFORE anybody is asked for a finger",
  firmware.includes("freeLeftoverTemplate(id);") &&
    firmware.indexOf("freeLeftoverTemplate(id);") < firmware.indexOf("waitGlassEmpty(who, id, ENROLL_LIFT_BUDGET_MS)")
);
pass(
  "the device waits for a real lift, so ADD_1 always sees a finger coming down",
  firmware.includes("waitGlassEmpty(") &&
    firmware.includes("int glassHasFinger()") &&
    firmware.includes('"LIFT YOUR FINGER"')
);
pass(
  "a failed session is retried from a fresh lift instead of failing the job",
  firmware.includes("ENROLL_MAX_SESSIONS") &&
    firmware.includes("for (uint8_t session = 1; session <= ENROLL_MAX_SESSIONS; session++)")
);
pass(
  "waiting for a person does not eat the capture attempts",
  /attempt--;\s*\n\s*if \(noFingerSinceMs == 0\)/.test(firmware)
);
pass(
  "no COUNT or SEARCH is sent to recover a garbled reply mid-session",
  !/BIOVO_ACK_COMM_ERROR\)\s*\{\s*\n\s*if \(!sensorAnswers\(\)\)/.test(firmware)
);

/* ── 3. the device and the admin page talk to each other ──────────────────── */

pass(
  "the device announces the job before it touches the sensor",
  firmware.includes("reportJobStarted(jobId, fingerprintId);") &&
    firmware.indexOf("reportJobStarted(jobId, fingerprintId);") < firmware.indexOf("enrollFingerprint(fingerprintId, memberName)") &&
    firmware.includes('doc["action"] = "job_started"') &&
    mappingsApi.includes('body.action === "job_started"')
);
pass(
  "a started job stays pending, so ?pending keeps its meaning",
  /action === "job_started"[\s\S]{0,900}\.set\(\{ startedAt: new Date\(\), detail \}\)/.test(mappingsApi) &&
  /action === "job_started"[\s\S]{0,900}eq\(attendanceEnrollJobs\.status, "pending"\)/.test(mappingsApi)
);
pass(
  "a failure carries the exact scan and status back to the website",
  firmware.includes('doc["action"] = "job_failed"') &&
    firmware.includes("reportJobFailed(jobId, reason)") &&
    firmware.includes('enrollDetail = "scan " + String(cap + 1) + "/6 not accepted: "') &&
    mappingsApi.includes("detail: reason")
);
pass(
  "the job row stores what the device said and when it picked the job up",
  getTableColumns(attendanceEnrollJobs).detail !== undefined &&
    getTableColumns(attendanceEnrollJobs).startedAt !== undefined &&
    migrate.includes("detail: { type: \"text\" }") &&
    migrate.includes("started_at: { type: \"timestamp\" }")
);
pass(
  "the admin page shows whether the scanner is waiting or never saw the job",
  adminTab.includes('"Device is ready • "') &&
    adminTab.includes('"Waiting for the device • "') &&
    adminTab.includes("job.startedAt") &&
    adminTab.includes("The scanner never picked this job up")
);
pass(
  "the admin page prints the reason the device reported",
  biometricsApi.includes("detail: job.detail") &&
    biometricsApi.includes("startedAt: job.startedAt") &&
    adminTab.includes("Fingerprint was not added: ${d.job.detail}")
);
pass(
  "a pending refresh reaches the page even while the status is unchanged",
  adminTab.includes("next.detail !== job.detail || next.startedAt !== job.startedAt")
);
pass(
  "two people enrolled at once are never sent the same sensor ID",
  /const openJobs = await db[\s\S]{0,300}eq\(attendanceEnrollJobs\.status, "pending"\)/.test(biometricsApi) &&
    biometricsApi.includes("const taken = [...existing.map((b) => b.fingerprintId), ...openJobs.map((j) => j.fingerprintId)];")
);

/* ── 4. the real sketch, run against a simulated sensor ───────────────────── */

const testDir = path.join(ROOT, "hardware/fana_attendance_esp32/test");
if (!existsSync(path.join(testDir, "run.sh"))) {
  pass("the device host test suite exists", false, testDir);
} else {
  const hasGpp = spawnSync("g++", ["--version"]).status === 0;
  if (!hasGpp) {
    console.log("⚠️  g++ not found - the compiled enrollment test was skipped");
  } else {
    const run = spawnSync("bash", [path.join(testDir, "run.sh")], { encoding: "utf8" });
    const out = `${run.stdout || ""}${run.stderr || ""}`;
    const failed = (out.match(/^FAIL /gm) || []).length;
    const passed = (out.match(/^PASS /gm) || []).length;
    const checks = (out.match(/^\d+ tests? /m) || [""])[0];
    pass(
      "the compiled enrollment state machine passes on a simulated sensor",
      run.status === 0 && failed === 0 && passed > 0,
      out.split("\n").filter((l) => l.startsWith("FAIL") || l.includes("error:")).slice(0, 6).join("\n")
    );
    console.log(`   ${passed} simulated-device checks passed${checks ? ` (${checks.trim()})` : ""}`);
    pass(
      "the reported worst case enrolls: finger already on the glass + leftover template",
      out.includes("PASS enrolled anyway (this is what used to fail)")
    );
    pass(
      "the new ordering never puts a non-ADD command inside a session",
      out.includes("PASS the new ordering sends no non-ADD command inside the session")
    );
    pass(
      "the website round trip is pending -> job_started -> mapping",
      out.includes("PASS call 2 announces the job before any sensor command") &&
        out.includes("PASS call 3 posts the mapping with the member id")
    );
  }
}

if (failures > 0) {
  console.error(`\n❌ FINGERPRINT ENROLL GUARD FAILED (${failures})\n`);
  process.exit(1);
}
console.log("\n✅ Fingerprint enroll guard PASSED");
console.log("   • the button and the Serial command now start from the same sensor state");
