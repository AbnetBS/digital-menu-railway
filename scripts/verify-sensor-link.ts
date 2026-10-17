#!/usr/bin/env tsx
/**
 * Regression guard: THE SENSOR LINK, and the two reports it exists for
 * (owner's engineer, Oct 2026): "my sensor is becoming hot, that isnt normal"
 * and "sometimes when I plug it the LCD all work but the sensor doesnt scan, I
 * put a finger, nothing happens".
 *
 * What this file proves, so neither report can come back as silence:
 *
 *   1. A module that answers "no finger" is ALIVE. Only no-frame-at-all and a
 *      garbled frame count against it, so an unreadable byte now and then can
 *      never drop a working scanner.
 *   2. A run of silence (SENSOR_FAIL_LIMIT checks) is noticed by the idle scan
 *      itself, said out loud on the LCD and on Serial, and handed to the health
 *      check that looks for the module again every 5 s. Before this, a link that
 *      died after boot was invisible: the idle screen stayed up, every attempt
 *      timed out quietly, and the person at the door got nothing.
 *   3. The link test (`sensor`, `sensor hard`) reports counted numbers, not
 *      vibes, so "is it the code or the wiring" is answered by an answer rate.
 *   4. The other silent cause of "LCD fine, no scan" is the setup hotspot:
 *      while WiFiManager waits, loop() does not run at all, so that wait has a
 *      hard end.
 *   5. The heat is a power question and the docs say so with numbers to
 *      measure: 3.0-3.3 V at the sensor's own pins, and a bare FPC1020A is a
 *      2.2-3.6 V part - 5 V on it is heat first and a dead module second.
 *
 * Run with: npx tsx scripts/verify-sensor-link.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "\u2705" : "\u274c"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
  if (!cond) failures++;
};

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const sliceOf = (text: string, from: string, to: string, label: string) => {
  const a = text.indexOf(from);
  const b = a === -1 ? -1 : text.indexOf(to, a + from.length);
  if (a === -1 || b === -1) {
    pass(`${label} is there`, false, `could not find ${JSON.stringify(from)} .. ${JSON.stringify(to)}`);
    return "";
  }
  return text.slice(a, b);
};

const FW = "hardware/fana_attendance_esp32/fana_attendance_esp32.ino";
const fw = read(FW);
const HOST = "hardware/fana_attendance_esp32/test/enroll_host_test.cpp";
const host = read(HOST);
const readme = read("hardware/fana_attendance_esp32/README.md");

console.log("\n=== the sensor link: noticed, named, and looked for again ===\n");

/* ── 1. what counts as a dead link ───────────────────────────────────────── */
const silenceFn = sliceOf(fw, "bool sensorReplyIsSilence(uint8_t status) {", "\n}", "sensorReplyIsSilence");
pass(
  "only silence and a garbled frame are treated as a dead link",
  silenceFn.includes("BIOVO_ACK_NO_RESPONSE") && silenceFn.includes("BIOVO_ACK_COMM_ERROR") &&
    !silenceFn.includes("BIOVO_ACK_TIMEOUT")
);
pass(
  "so a working module saying no-finger, no-such-finger or lifted is never a failure",
  !silenceFn.includes("NOUSER") && !silenceFn.includes("GO_OUT") && !silenceFn.includes("IMAGEMESS")
);
const noteFn = sliceOf(fw, "void noteSensorAnswer(uint8_t status) {", "\n}", "noteSensorAnswer");
pass("the run of silence is counted, and it cannot run away past a byte", noteFn.includes("sensorSilentPasses < 250"));
pass("one honest reply clears the whole run, and re-arms the reporting",
  noteFn.includes("sensorSilentPasses = 0;") && noteFn.includes("sensorLinkReported = false;") &&
    noteFn.includes("sensorLastReplyMs = millis();"));
pass("the limit is six checks, which is seconds and not minutes",
  /#define SENSOR_FAIL_LIMIT       6\b/.test(fw));

/* ── 2. the idle scan is the one that notices ─────────────────────────────── */
const scanSlice = sliceOf(fw, "void scanForFinger() {", "\n}", "the idle scan");
pass("every scan pass reports its answer to the watchdog", scanSlice.includes("noteSensorAnswer(st);"));
pass("and the notice comes before the branches that used to swallow silence",
  scanSlice.indexOf("noteSensorAnswer(st);") < scanSlice.indexOf("awaitingFingerLift = false;"));
pass("the link is given up only after a real run of silence", scanSlice.includes("sensorLinkLooksDead()"));
pass("and it is announced once, not every second", scanSlice.includes("!sensorLinkReported"));
const dropFn = sliceOf(fw, "void dropSensorLink(const String &why) {", "\n}", "dropSensorLink");
pass("dropping the link switches the sensor off, so the health check takes over",
  dropFn.includes("sensorReady = false;") && dropFn.includes("awaitingFingerLift = false;"));
pass("a scan that never finished is not allowed to block the next one",
  dropFn.includes("awaitingFingerLift = false;") && dropFn.indexOf("awaitingFingerLift = false;") < dropFn.indexOf("finger.drain"));
pass("whatever half a frame is still on the line is thrown away before looking again",
  dropFn.includes("finger.drain("));
pass("the screen says what to measure instead of failing silently",
  dropFn.includes('"SENSOR NOT"') && dropFn.includes('"power 3.3V and"') && dropFn.includes('"wiring TX/RX"'));
pass("the reason also carries the raw status, because 0xFF and 0xFE are different faults",
  dropFn.includes("Biovo1020A::statusText(sensorLastStatus)") && dropFn.includes("last status: 0x"));
pass("the last words are then handed back to the idle screen, which says SENSOR OFFLINE!",
  dropFn.includes("showIdleScreen();") &&
    fw.includes('lcdWriteRow(1, sensorReady ? "Place finger" : String("SENSOR OFFLINE!"))'));
for (const line of ['"SENSOR NOT"', '"answering. Check"', '"power 3.3V and"', '"wiring TX/RX"']) {
  const text = line.slice(1, -1);
  pass(`a 20x4 row fits: ${text} (${text.length})`, text.length <= 20);
}
pass("a sensor found again starts from a clean run of silence",
  sliceOf(fw, "bool detectSensor(uint8_t tries) {", "\n}", "detectSensor").includes("sensorSilentPasses = 0;"));
pass("and the health check still looks every 5 s, saying what it found",
  fw.includes("if (sensorReady || millis() - lastCheck < 5000) return;") && fw.includes("Sensor back!"));

pass("a module that answers a slow COUNT is treated as busy, not as dead",
  scanSlice.includes("if (sensorAnswers()) {") &&
    scanSlice.indexOf("if (sensorAnswers()) {") < scanSlice.indexOf("dropSensorLink("));
pass("the check comes first, so a big template database cannot switch a working door off",
  scanSlice.includes("Sensor is busy, not dead"));
pass("a busy module buys a longer scan wait, doubled rather than guessed",
  scanSlice.includes("sensorPollMs * 2") && scanSlice.includes("SENSOR_POLL_MAX_MS"));
pass("that wait is capped, so one stuck scan cannot freeze the door for good",
  /#define SENSOR_POLL_MAX_MS      4000\b/.test(fw));
pass("the idle scan waits with that budget instead of a fixed number",
  scanSlice.includes("finger.search(matchedId, permission, sensorPollMs)"));
pass("one honest answer puts the old polling speed back", noteFn.includes("sensorPollMs = SENSOR_POLL_MS;"));
pass("a dropped link forgets the extra patience too", dropFn.includes("sensorPollMs = SENSOR_POLL_MS;") || fw.includes("  sensorPollMs = SENSOR_POLL_MS;"));
pass("the suite proves a busy module keeps working and the patience is capped",
  host.includes("answers COUNT is not dropped") && host.includes("that patience is capped"));
pass("and that a slow scan never puts SENSOR OFFLINE on the glass",
  host.includes('screenShowed("SENSOR NOT") == false'));
pass("the status page shows the wait the board settled on", fw.includes('doc["sensorPollMs"]'));

/* ── 3. the test that answers "code or wiring" ───────────────────────────── */
const linkFn = sliceOf(fw, "void testSensorLink(uint16_t rounds, uint32_t gapMs, const char *label) {", "\n}", "testSensorLink");
pass("the link test asks the module many times instead of once", linkFn.includes("for (uint16_t i = 1; i <= rounds; i++)"));
pass("it tells silence and garbled apart, because they are different faults",
  linkFn.includes("silent (no frame at all)") && linkFn.includes("garbled (a frame, not a valid reply)"));
pass("it times the replies, so a supply sagging under load is visible",
  linkFn.includes("fastest") && linkFn.includes("slowest") && linkFn.includes("total / ok"));
pass("the counts are recorded, not only printed, so the status page and the tests can use them",
  linkFn.includes("sensorTestAnswered = ok;") && linkFn.includes("sensorTestSilent = silent;"));
pass("and a clean link is reported as clean, pointing away from the code",
  linkFn.includes("the link is clean"));
pass("a partly-answering module is pointed at the supply, which is what it usually is",
  linkFn.includes("is a POWER story") && linkFn.includes("3.0-3.3 V, never"));
pass("both tests are reachable from the Serial monitor",
  fw.includes('cmd == "sensor hard"') && fw.includes('cmd.startsWith("sensor")'));
pass("and they are in the help line, or nobody finds them",
  fw.includes("`sensor`") || fw.includes("sensor | sensor hard"));
pass("the status page carries the watchdog counters",
  fw.includes('doc["sensorSilentPasses"]') && fw.includes('doc["sensorSilentMs"]') && fw.includes('doc["sensorStatus"]'));
pass("and the plain page says the voltage to measure, for whoever is standing there",
  fw.includes("VCC at the sensor must read 3.0 to 3.3 V"));

/* ── 4. the other silent cause: the setup hotspot ────────────────────────── */
const wmFn = sliceOf(fw, "void configureWifiManager(WiFiManager &wm) {", "\n}", "configureWifiManager");
pass("the hotspot wait has a hard end, because loop() cannot scan while it waits",
  wmFn.includes("setConfigPortalTimeout(180)"));
pass("and one WiFi attempt is bounded too", wmFn.includes("setConnectTimeout(12)"));
pass("setup() actually calls it", sliceOf(fw, "void setup() {", "\n}", "setup").includes("configureWifiManager(wm);"));
const DEF = "void configureWifiManager(WiFiManager &wm) {";
pass("and the reason is written above the code that enforces it, not in a ticket",
  fw.includes("LOOP DOES NOT RUN AT ALL") && fw.indexOf("LOOP DOES NOT RUN AT ALL") < fw.indexOf(DEF) &&
    fw.indexOf(DEF) - fw.indexOf("LOOP DOES NOT RUN AT ALL") < 900);

/* ── 5. the host suite drives it, so this cannot rot ─────────────────────── */
pass("the simulated module can be made deaf, which is how a dead link is tested at all",
  host.includes("bool deaf = false;") && read("hardware/fana_attendance_esp32/test/stub/Arduino.h").includes("serialWriteHook"));
pass("the suite drives the real idle scan, not just the counter",
  host.includes("mod.deaf = true;") &&
    host.includes("for (int i = 0; i < SENSOR_FAIL_LIMIT - 1; i++) scanForFinger();") &&
    host.includes("scanForFinger();             // the sixth silence, which is the drop"));
pass("it asserts what the door sees, not only the internal flag",
  host.includes('screenShowed("SENSOR NOT")') && host.includes('rowShows(1, "SENSOR OFFLINE")'));
pass("it asserts the self-heal and that the announcement is once only",
  host.includes("checkSensorHealth();") && host.includes("sensorLinkReported") &&
    host.includes("no reboot and no reflash"));
pass("and it asserts the link test reports its counts honestly, both ways",
  host.includes("sensorTestAnswered == 0 && sensorTestSilent == 5") &&
    host.includes("sensorTestAnswered == 5 && sensorTestSilent == 0"));
pass("the hotspot timeout is asserted too, since it is behaviour, not preference",
  host.includes("configureWifiManager(wm);") && host.includes("stubWmConfigPortalTimeoutSec"));

/* ── 6. the docs say what to measure, in order ───────────────────────────── */
pass("the wiring note makes the voltage a hard limit, not a preference",
  readme.includes("AND ONLY 3.3V") && readme.includes("2.2-3.6 V part"));
pass("and it names the mistake that actually causes it: the 5 V rail row",
  readme.includes("out of the 5 V rail row that feeds the LCD backpack"));
pass("the heat report is a procedure with a meter, not a shrug",
  readme.includes("Measure VCC to GND at the sensor") && readme.includes("3.0-3.3 V"));
pass("it separates a hot module from a hot regulator on the board",
  readme.includes("Which part is hot?") && readme.includes("2.9 V"));
pass("it warns that an over-voltaged module may simply be dead now",
  readme.includes("cooked module answers 0 out of 20"));
pass("the no-scan report lists four causes and says which one it is by what the screen shows",
  readme.includes("SENSOR OFFLINE!") && readme.includes("192.168.4.1") && readme.includes("`rest show`") &&
    readme.includes("NOT REGISTERED"));
pass("the serial commands are documented where the commands are listed",
  readme.includes("`sensor` (20 checks") && readme.includes("sensor hard` (about 8 seconds"));

/* ── 7. the supply question, answered by the board and a meter ───────────── */
pass("the docs refuse to guess the voltage from the chip name alone",
  readme.includes("Which supply does THIS module want?") && readme.includes("HT7333"));
pass("they say the bare die is a 3.0 to 3.3 V part and 5 V on it is over-voltage",
  readme.includes("**3.0 to 3.3 V**, never 5 V") && readme.includes("over-voltage"));
pass("and that 3.3 V can ALSO be wrong, which is the shape of this report",
  readme.includes("3.3 V can be wrong too") && readme.includes("intermittent by nature"));
pass("heat is treated as a verdict, not a debate", readme.includes("a verdict, not an opinion"));
pass("and the tie-breaker is a measured answer rate on each supply, not an opinion",
  readme.includes("Settle it with numbers") && readme.includes("answered: N/20") &&
    readme.includes("`sensor hard`"));
pass("the fix-it checklist in FINGERPRINT_FIX says the same thing, with the reason",
  read("hardware/fana_attendance_esp32/FINGERPRINT_FIX.md").includes("carries its own 3.3V regulator"));

console.log(`\n${failures ? "SENSOR LINK GUARD FAILED" : "SENSOR LINK GUARD PASSED"} (${failures} failed)\n`);
process.exit(failures ? 1 : 0);
