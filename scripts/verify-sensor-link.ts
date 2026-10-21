#!/usr/bin/env tsx
/** R307 link/watchdog/documentation regression guard. */
import { readFileSync } from "node:fs";
import path from "node:path";
const root=path.resolve(__dirname,"..");
const read=(p:string)=>readFileSync(path.join(root,p),"utf8");
const fw=read("hardware/fana_attendance_esp32/fana_attendance_esp32.ino");
const adapter=read("hardware/fana_attendance_esp32/R307Compat.h");
const readme=read("hardware/fana_attendance_esp32/README.md");
let failures=0;const pass=(name:string,ok:boolean)=>{console.log(`${ok?"✅":"❌"} ${name}`);if(!ok)failures++;};
pass("R307 UART is 57600 on ESP32 RX16/TX17",fw.includes("mySerial.begin(57600, SERIAL_8N1, SENSOR_RX_PIN, SENSOR_TX_PIN)")&&fw.includes("SENSOR_RX_PIN 16")&&fw.includes("SENSOR_TX_PIN 17"));
pass("R307 adapter verifies and reads template count",adapter.includes("verifyPassword()")&&adapter.includes("getTemplateCount()"));
pass("no-finger is an alive sensor response",adapter.includes("FINGERPRINT_NOFINGER")&&adapter.includes("lastStatus_ = 0x08"));
pass("communication errors stay distinct from no finger",adapter.includes("FINGERPRINT_PACKETRECIEVEERR")&&adapter.includes("return 0xFE"));
pass("watchdog counts silence and clears on an honest reply",fw.includes("sensorSilentPasses++")&&fw.includes("sensorSilentPasses = 0"));
pass("dead link is shown and handed to self-healing",fw.includes("dropSensorLink")&&fw.includes('"SENSOR OFFLINE!"')&&fw.includes("checkSensorHealth()"));
pass("partial UART frames are drained before recovery",fw.includes("finger.drain("));
pass("slow count distinguishes a busy module from a dead module",fw.includes("Sensor is busy, not dead")&&fw.includes("sensorAnswers()"));
pass("scan timeout grows but is capped",fw.includes("SENSOR_POLL_MAX_MS")&&fw.includes("sensorPollMs * 2"));
pass("Serial link tests remain available",fw.includes('cmd == "sensor hard"')&&fw.includes('cmd.startsWith("sensor")'));
pass("status page exposes sensor health",fw.includes('doc["sensorReady"]')&&fw.includes('doc["sensorStatus"]')&&fw.includes('doc["sensorSilentPasses"]'));
pass("Wi-Fi setup portal cannot block scanning forever",fw.includes("setConfigPortalTimeout(180)")&&fw.includes("setConnectTimeout(12)"));
pass("documentation identifies the R307 and tested baud",readme.includes("ESP32 + R307")&&readme.includes("57600 baud"));
pass("documentation refuses to trust wire colours",readme.includes("Wire colours are not standardized"));
pass("documentation requires seller pinout and common ground",readme.includes("Verify the connector pinout")&&readme.includes("All grounds must be common"));
pass("documentation lists diagnostic commands",readme.includes("`sensor hard`")&&readme.includes("`test`")&&readme.includes("`list`"));
pass("production firmware no longer includes Biovo",!fw.includes("#include <Biovo1020A.h>"));
console.log(`\n${failures?"R307 SENSOR LINK GUARD FAILED":"R307 SENSOR LINK GUARD PASSED"} (${failures} failed)\n`);process.exit(failures?1:0);
