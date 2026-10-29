#!/usr/bin/env tsx
/** R307 production-firmware regression guard. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { getTableColumns } from "drizzle-orm";
import { attendanceEnrollJobs } from "../src/db/schema";

const root=path.resolve(__dirname,"..");
const read=(p:string)=>readFileSync(path.join(root,p),"utf8");
const firmware=read("hardware/fana_attendance_esp32/fana_attendance_esp32.ino");
const adapter=read("hardware/fana_attendance_esp32/R307Compat.h");
const mappings=read("src/app/api/attendance/mappings/route.ts");
const biometrics=read("src/app/api/attendance/biometrics/route.ts");
const admin=read("src/components/rms/AttendanceTab.tsx");
const migrate=read("src/db/migrate.ts");
let failed=0;
function check(name:string,ok:boolean){console.log(`${ok?"✅":"❌"} ${name}`);if(!ok)failed++;}

check("production firmware identifies R307",firmware.includes("R307 + ESP32 WROOM")&&firmware.includes("mySerial.begin(57600"));
check("production firmware uses Adafruit reader adapter",firmware.includes('#include "R307Compat.h"')&&adapter.includes("Adafruit_Fingerprint"));
check("old Biovo library is not used by production firmware",!firmware.includes("#include <Biovo1020A.h>"));
check("R307 enrollment uses two fresh captures",firmware.includes("#define ENROLL_STEPS            2")&&adapter.includes("FINGERPRINT_IMAGE2TZ, step")&&adapter.includes("FINGERPRINT_REGMODEL")&&adapter.includes("FINGERPRINT_STORE"));
check("stored template is confirmed on a fresh placement",firmware.includes("#define ENROLL_VERIFY_PLACEMENTS 1")&&firmware.includes("outcome = confirmEnrolledFinger(id, who, deadlineMs)"));
check("lift detection does not overwrite the first capture",adapter.includes("int fingerPresent()")&&firmware.includes("return finger.fingerPresent()")&&firmware.includes("waitGlassEmpty(who, id, ENROLL_LIFT_BUDGET_MS, step - 1)"));
check("the full reported capacity is searched",adapter.includes("FINGERPRINT_HISPEEDSEARCH, 1, 0, 0")&&adapter.includes("(uint8_t)(capacity_ >> 8)"));
check("a stale mapping cannot authorize deleting an existing employee's slot",firmware.includes("if (!loadMappingsFromServer())")&&firmware.includes("if (mappedNameForId(id, mappedName))"));
check("website and Serial use the same enrollment function",(firmware.match(/= enrollFingerprint\(/g)||[]).length===2);
check("actual R307 capacity limits website jobs and manual IDs",firmware.includes("finger.capacity()")&&adapter.includes("capacity_ = ((uint16_t)reply[5]"));
check("one held finger cannot clock repeatedly",firmware.includes("awaitingFingerLift")&&firmware.includes("if (awaitingFingerLift) return"));
const preparing=firmware.indexOf('showEnrollScreen(memberName, fingerprintId, 0, "PREPARING..."');
const receipt=firmware.indexOf("reportJobStarted(jobId, fingerprintId)");
const enrollment=firmware.indexOf("enrollFingerprint(fingerprintId, memberName)");
check("device shows preparation and announces receipt before sensor enrollment",preparing>=0&&receipt>preparing&&enrollment>receipt);
check("placement gets a full prompt window",firmware.includes("#define ENROLL_ADD_TIMEOUT_MS   60000")&&firmware.includes("finger.enroll((uint16_t)id, step, waitMs - elapsed)"));
check("device requests a single job",firmware.includes('/api/attendance/biometrics?pending=1&limit=1')&&biometrics.includes('searchParams.get("limit") === "1" ? 1 : 20'));
check("early no-finger status is retried during capture and confirmation",firmware.includes('finger.getLastStatus() != BIOVO_ACK_TIMEOUT')&&firmware.includes('searchGlass(matchedId, scanWait - elapsed)'));
check("successful enrollment alone posts a mapping",/if \(result == ENROLL_OK\) \{[\s\S]{0,160}postMappingToServer/.test(firmware));
check("offline mapping retry remains present",firmware.includes("mappingPending = true")&&firmware.includes("retryPendingMapping()"));
check("mapping success must confirm the matching employee and finger",firmware.includes('(reply["fingerprintId"] | 0) == fingerprintId')&&firmware.includes('(reply["memberId"] | 0) == memberId'));
check("failure reason is retried until website confirms the matching job",firmware.includes('doc["action"] = "job_failed"')&&firmware.includes("retryPendingEnrollmentFailure()")&&firmware.includes('(reply["jobId"] | 0) == pendingFailureJobId')&&mappings.includes('body.action === "job_failed"')&&mappings.includes("success: true, jobId, reason"));
check("job detail and started time remain in schema",getTableColumns(attendanceEnrollJobs).detail!==undefined&&getTableColumns(attendanceEnrollJobs).startedAt!==undefined&&migrate.includes('started_at: { type: "timestamp"'));
check("admin distinguishes receipt from readiness",admin.includes("Scanner received the request")&&admin.includes("job.startedAt")&&!admin.includes('"Device is ready • "'));
check("admin polls even while the event stream appears open",admin.includes('job.status !== "pending"')&&admin.includes('document.visibilityState !== "hidden"')&&admin.includes("setInterval"));
check("admin instructions match two captures and one confirmation",admin.includes("place the same finger twice")&&admin.includes("third time to confirm"));
check("manual instructions require a website connection",admin.includes("Connect the device to the website"));
check("server allocates pending IDs without collision",biometrics.includes("openJobs.map((j) => j.fingerprintId)"));
check("adapter distinguishes no finger, no match and unclear image",adapter.includes("FINGERPRINT_NOFINGER")&&adapter.includes("FINGERPRINT_NOTFOUND")&&adapter.includes("FINGERPRINT_IMAGEMESS"));
check("adapter supports template deletion and full erase",adapter.includes("FINGERPRINT_DELETE")&&adapter.includes("FINGERPRINT_EMPTY"));

if(failed){console.error(`\n❌ R307 fingerprint guard failed (${failed})`);process.exit(1);}
console.log("\n✅ R307 fingerprint enrollment guard passed");
