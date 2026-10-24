#!/usr/bin/env tsx
/**
 * WIFI RECOVERY GUARD (owner, Oct 2026).
 *
 * The owner's report: "sometime when wifi is disconnected and come again my
 * system still says wifi not connected ... it can be always plug in and out to
 * connect", and "when I try to add their fingerprint I need to be near the
 * router". Both are the ESP32's link, not the website.
 *
 * This guard keeps the fixes in place: no modem sleep, full transmit power,
 * an escalation that always ends somewhere, an honest LCD, a safety-net poll
 * for fingerprint jobs, and the hardware advice that actually raises the
 * signal (the radio is 2.4 GHz only).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
const pass = (name: string, ok: boolean) => {
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (!ok) failures++;
};

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const fw = read("hardware/fana_attendance_esp32/fana_attendance_esp32.ino");
const readme = read("hardware/fana_attendance_esp32/README.md");

/* ── 1. the radio settings that decide range and a fast answer ───────────── */

pass("modem sleep is off, so the radio answers at once", fw.includes("WiFi.setSleep(false)"));
pass("the radio transmits at full power", fw.includes("WiFi.setTxPower(WIFI_POWER_19_5dBm)"));
pass("the driver reconnects by itself", fw.includes("WiFi.setAutoReconnect(true)"));
pass("the tuning is applied after the first connection", /applyWifiTuning\(\);\s*\n\s*showLines\("WiFi Connected!"/.test(fw));

/* ── 2. the link heals in steps instead of waiting for a power cycle ─────── */

pass("a dedicated watchdog runs every pass of loop()", fw.includes("void serviceWifi()") && fw.includes("  serviceWifi();\n  keepServerLinkAlive();"));
pass("it is tried often while the link is down", fw.includes("#define WIFI_RECONNECT_MS") && fw.includes("WiFi.reconnect();"));
pass("after a while the radio itself is reset, not the whole board", fw.includes("WiFi.disconnect(true, false)") && fw.includes("WiFi.mode(WIFI_STA)") && fw.includes("wifiRadioResets++;"));
pass("the credentials are kept through that reset", fw.includes("resetting the radio (credentials kept)"));
pass("a restart is only the last resort, after ten minutes", fw.includes("#define WIFI_RESTART_MS         600000UL") && fw.includes("WiFi has been down for 10 minutes: restarting the board"));
pass("the escalation is ordered: reconnect, then radio reset, then restart", fw.indexOf("WiFi.reconnect();") < fw.indexOf("WiFi.disconnect(true, false)") && fw.indexOf("WiFi.disconnect(true, false)") < fw.indexOf("restarting the board"));
pass("the board no longer reboots just because the router is out at boot", !/if \(!connected\) \{\s*\n\s*Serial\.println\("Failed to connect WiFi"\);\s*\n\s*showLines\("WiFi Failed", "Restarting\.\.\.", "", ""\);\s*\n\s*delay\(3000\);\s*\n\s*ESP\.restart\(\);/.test(fw) && fw.includes("Still scanning"));

/* ── 3. coming back repairs what the drop killed ─────────────────────────── */

pass("the real-time stream is dropped when the link is lost", fw.includes("void stopEventStream();") && fw.includes("stopEventStream();\n    WiFi.disconnect(true, false);"));
pass("NTP is asked again when the link returns", /WiFi is back after[\s\S]{0,700}startTimeSync\(\);/.test(fw));
pass("the names and open hours are reloaded when the link returns", /WiFi is back after[\s\S]{0,900}loadMappingsFromServer\(\);/.test(fw) && /WiFi is back after[\s\S]{0,900}loadRestScheduleFromServer\(\);/.test(fw));
pass("a stronger access point on the same name is preferred when the link is weak", fw.includes("void rejoinStrongestAp()") && fw.includes("WIFI_AP_HUNT_GAIN") && fw.includes("WiFi.scanNetworks()"));
pass("and never in the middle of an enrollment", fw.includes("!enrollingFromServer && millis() - lastApHunt"));

/* ── 4. the LCD tells the truth, including a live retry counter ──────────── */

pass("the idle screen uses one honest line", fw.includes("lcdWriteRow(2, wifiStatusLine());"));
pass(
  "the strength sits beside the connection word",
  fw.includes('return String("Connected ") + String(rssi) + "dB " + wifiMeter(rssi);')
);
pass("and the four bars are drawn as filled blocks and underscores", fw.includes("String wifiMeter(int rssi)") && fw.includes("(char)0xFF") && fw.includes("'_'"));
pass("the bars fall with the signal, from four to none", ["-55", "-65", "-75", "-85"].every((t) => fw.includes(`if (rssi < ${t}) bars`)));
pass(
  "the line is exactly one 20 character LCD row",
  "Connected ".length + "-58dB ".length + 4 === 20 && fw.includes(' *   "Connected " 10 + "-58dB " 6 + the four cells 4 = 20.')
);
pass("a short link still says Connected instead of inventing a reading", fw.includes('if (rssi >= 0) return String("Connected");'));
pass("a very weak reading is clamped so the bars are never lost", fw.includes("if (rssi < -99) rssi = -99;"));
pass("the status page prints the same bars", fw.includes("wifiMeter(WiFi.RSSI())"));
pass("the weak threshold is still defined for the access point hunt", fw.includes("#define WIFI_WEAK_RSSI"));
pass("it counts the seconds while it is down, so nobody unplugs the board", fw.includes('String("Wifi down ") + String((millis() - wifiDownSince) / 1000) + "s"'));

/* ── 5. a fingerprint job is never left waiting on a silent socket ───────── */

pass("the pending-job poll is a safety net, not only a fallback", fw.includes("if (!enrollingFromServer && millis() - lastPendingCheck > PENDING_POLL_FALLBACK_MS)") && !fw.includes("if (!eventStreamActive && !enrollingFromServer && millis() - lastPendingCheck"));
pass("a stalled stream is noticed in 45 s, not 75", fw.includes("#define EVENT_STREAM_STALL_MS   45000"));
pass("a weak link waits 8 s for the website instead of 4", fw.includes("#define SERVER_TIMEOUT_MS       8000"));
pass("the device is ready message is sent twice if the first is lost", fw.includes("int httpCode = http.POST(json);") && fw.includes("httpCode = http.POST(json);"));
pass("the setup attempt is patient with a slow router", fw.includes("wm.setConnectTimeout(20)"));

/* ── 6. the owner can see the signal and fix the room ────────────────────── */

pass("the status JSON reports signal, channel, access point and reconnects", fw.includes('doc["wifiRssi"]') && fw.includes('doc["wifiChannel"]') && fw.includes('doc["wifiBssid"]') && fw.includes('doc["wifiReconnects"]'));
pass("the local page shows the signal in plain words", fw.includes('html += "<p>Signal: "'));
pass("the Serial monitor has a wifi report", fw.includes("void printWifiReport()") && fw.includes('cmd == "wifi"'));
pass("and a scan that shows what the board can hear", fw.includes("void printWifiScan()") && fw.includes('cmd == "wifi scan"'));
pass("and a way to reconnect on demand", fw.includes('cmd == "wifi join"'));
pass("the README says the radio is 2.4 GHz only", readme.includes("2.4 GHz only") && readme.includes("The ESP32 has no 5 GHz radio"));
pass("the README recommends an access point near the door", readme.includes("A 2.4 GHz access point near the door"));
pass("the README explains the dBm numbers", readme.includes("−50 dBm is excellent"));
pass("the README shows the LCD row he will see", readme.includes("Connected -58dB") && readme.includes("Connected -88dB"));
pass("the README warns about the power supply", readme.includes("A weak 5 V supply browns out the radio"));
pass("the README covers the antenna and the metal box", readme.includes("Keep the board out of a metal box"));

console.log("");
if (failures > 0) {
  console.error(`\n❌ WIFI RECOVERY GUARD FAILED (${failures})\n`);
  process.exit(1);
}
console.log("✅ WiFi recovery guard PASSED");
console.log("   • no modem sleep, full transmit power");
console.log("   • reconnect, then radio reset, then (only after 10 min) a restart");
console.log("   • the LCD shows Connected, the dBm and four bars on one row");
console.log("   • fingerprint jobs are polled every 15 s even when the stream looks alive");
