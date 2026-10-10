/*
 * enroll_diagnostic.ino - FPC1020A enrollment diagnosis tool.
 * NOT part of the attendance product. Flash it instead of the product sketch
 * when enrollment fails, capture the Serial Monitor log, share the log.
 *
 * WHAT IT DOES
 *   Runs ONE six-scan enrollment under ID 999 and prints EVERY sensor reply
 *   with a millis() timestamp, the status byte, and the raw 8-byte frame.
 *   Three modes reproduce the three firmware strategies so the replies can
 *   be compared side by side:
 *
 *     a  Mode A = PR #50 style: SEARCH commands between scans wait for the
 *        finger to lift and to be placed again.
 *     b  Mode B = ee3873b style: NO commands between scans; a 4 s lift pause,
 *        then "PLACE FINGER", 300 ms settle, then the next ADD command.
 *     c  Mode C = current firmware style: NO commands between scans; the
 *        finger is placed ONCE and kept on the sensor for all six captures.
 *
 *   t  one COUNT command (is the sensor alive?)
 *   x  delete ID 999 (cleanup; also runs automatically before each mode)
 *   h  help
 *
 * WIRING (same as the product sketch)
 *   sensor TX -> GPIO16, sensor RX -> GPIO17, VCC, GND. UART 19200 8N1.
 *   No OLED, no WiFi: Serial Monitor at 115200 baud is the whole UI.
 *
 * USES THE Biovo1020A LIBRARY UNCHANGED. All replies come from the library's
 * own receive logic (getLastStatus / getLastRxPacket).
 */

#include <Biovo1020A.h>

#define SENSOR_RX_PIN 16
#define SENSOR_TX_PIN 17
#define DIAG_ID       999
#define SEARCH_WAIT_MS 1500   // one SEARCH command waits this long
#define WAIT_BUDGET_MS 60000  // give up a finger-wait after this long

HardwareSerial sensorSerial(2);
Biovo1020A finger(sensorSerial);

/* ── Logging helpers ─────────────────────────────────────────────────────── */

void stamp() {
  Serial.print("[");
  Serial.print(millis());
  Serial.print(" ms] ");
}

// Prints one sensor reply: status number, text, raw frame bytes, duration.
void logReply(const char *label, uint32_t tookMs) {
  const uint8_t st = finger.getLastStatus();
  const uint8_t *rx = finger.getLastRxPacket();

  stamp();
  Serial.print(label);
  Serial.print(" -> status ");
  Serial.print(st);
  Serial.print(" (0x");
  if (st < 0x10) Serial.print('0');
  Serial.print(st, HEX);
  Serial.print(") ");
  Serial.println(Biovo1020A::statusText(st));

  stamp();
  Serial.print("  raw rx frame: ");
  for (int i = 0; i < 8; i++) {
    if (rx[i] < 0x10) Serial.print('0');
    Serial.print(rx[i], HEX);
    Serial.print(' ');
  }
  Serial.print(" | took ");
  Serial.print(tookMs);
  Serial.println(" ms");
}

/* ── Sensor calls (every reply is logged) ────────────────────────────────── */

bool doCount(const char *why) {
  stamp();
  Serial.print("TX COUNT (");
  Serial.print(why);
  Serial.println(")");
  const uint32_t t0 = millis();
  const int16_t n = finger.getCount(3000);
  logReply("RX COUNT", millis() - t0);
  if (n >= 0) {
    stamp();
    Serial.print("  templates stored: ");
    Serial.println(n);
  }
  return n >= 0;
}

bool doDelete() {
  stamp();
  Serial.print("TX DELETE ID ");
  Serial.println(DIAG_ID);
  const uint32_t t0 = millis();
  const bool ok = finger.deleteUser(DIAG_ID, 5000);
  logReply("RX DELETE", millis() - t0);
  return ok;
}

// Sends one ADD step and logs the reply. Returns true when accepted (status 0).
bool doAdd(uint8_t scan, uint8_t step, uint32_t timeoutMs) {
  stamp();
  Serial.print("TX ADD_");
  Serial.print(step);
  Serial.print(" (scan ");
  Serial.print(scan);
  Serial.print("/6, timeout ");
  Serial.print(timeoutMs);
  Serial.println(" ms)");
  const uint32_t t0 = millis();
  const bool ok = finger.enroll(DIAG_ID, step, timeoutMs);
  char label[24];
  snprintf(label, sizeof(label), "RX ADD_%d", step);
  logReply(label, millis() - t0);
  return ok;
}

// SEARCH-based finger wait, as used by PR #50. Logs every SEARCH reply.
bool waitFingerOnSearch() {
  stamp();
  Serial.println("SEARCH loop: waiting for a finger to be placed...");
  const uint32_t start = millis();
  while (millis() - start < WAIT_BUDGET_MS) {
    uint16_t matchedId = 0;
    uint8_t permission = 0;
    const uint32_t t0 = millis();
    const bool matched = finger.search(matchedId, permission, SEARCH_WAIT_MS) && matchedId > 0;
    logReply("RX SEARCH", millis() - t0);
    const uint8_t st = finger.getLastStatus();
    if (matched || st == BIOVO_ACK_NOUSER || st == BIOVO_ACK_IMAGEMESS) return true;
    delay(30);
  }
  stamp();
  Serial.println("  no finger within the wait budget");
  return false;
}

// SEARCH-based lift wait, as used by PR #50. Logs every SEARCH reply.
bool waitFingerOffSearch() {
  stamp();
  Serial.println("SEARCH loop: waiting for the finger to be LIFTED...");
  const uint32_t start = millis();
  uint8_t gone = 0;
  while (millis() - start < WAIT_BUDGET_MS) {
    uint16_t matchedId = 0;
    uint8_t permission = 0;
    const uint32_t t0 = millis();
    const bool matched = finger.search(matchedId, permission, SEARCH_WAIT_MS) && matchedId > 0;
    logReply("RX SEARCH", millis() - t0);
    const uint8_t st = finger.getLastStatus();
    const bool noFinger = !matched &&
        (st == BIOVO_ACK_TIMEOUT || st == BIOVO_ACK_GO_OUT || st == BIOVO_ACK_NO_RESPONSE);
    if (noFinger) {
      if (++gone >= 2) return true;
    } else {
      gone = 0;
    }
    delay(30);
  }
  stamp();
  Serial.println("  finger was not lifted within the wait budget");
  return false;
}

/* ── The three enrollment strategies under test ──────────────────────────── */

const uint8_t captureSteps[6] = {1, 2, 2, 2, 2, 3};

// Mode A - PR #50 style: SEARCH commands between scans.
void runModeA() {
  Serial.println();
  Serial.println("=== MODE A: SEARCH between scans (PR #50 style) ===");
  Serial.println("Follow the log: place when asked, lift when asked.");
  doDelete();

  for (uint8_t scan = 0; scan < 6; scan++) {
    if (scan == 0) {
      if (!waitFingerOnSearch()) return;
    } else {
      if (!waitFingerOffSearch()) return;
      if (!waitFingerOnSearch()) return;
    }
    delay(300); // settle, as in the PR #50 sketch
    if (!doAdd(scan + 1, captureSteps[scan], 15000)) {
      stamp();
      Serial.print("SCAN ");
      Serial.print(scan + 1);
      Serial.println("/6 FAILED - stopping this run (re-run 'a' to try again)");
      return;
    }
  }
  Serial.println("=== MODE A: all six scans ACCEPTED ===");
  doCount("after mode A");
}

// Mode B - ee3873b style: no commands between scans, 4 s lift pause.
void runModeB() {
  Serial.println();
  Serial.println("=== MODE B: no commands between scans, 4 s lift pause (ee3873b style) ===");
  Serial.println("Place your finger when the log says PLACE, lift when it says LIFT.");
  doDelete();

  for (uint8_t scan = 0; scan < 6; scan++) {
    if (scan == 0) {
      if (!waitFingerOnSearch()) return;
      delay(300);
    } else {
      stamp();
      Serial.println("LIFT your finger now - 4 s pause, no sensor commands...");
      delay(4000);
      stamp();
      Serial.println("PLACE FINGER now");
      delay(300);
    }
    if (!doAdd(scan + 1, captureSteps[scan], 15000)) {
      stamp();
      Serial.print("SCAN ");
      Serial.print(scan + 1);
      Serial.println("/6 FAILED - stopping this run (re-run 'b' to try again)");
      return;
    }
  }
  Serial.println("=== MODE B: all six scans ACCEPTED ===");
  doCount("after mode B");
}

// Mode C - current firmware style: one placement, finger kept on the sensor.
void runModeC() {
  Serial.println();
  Serial.println("=== MODE C: place ONCE and KEEP the finger on (current firmware style) ===");
  Serial.println("When asked, place one finger flat and DO NOT lift it until all six pass.");
  doDelete();

  stamp();
  Serial.println("Place your finger flat and still on the sensor NOW.");
  delay(2500); // settle window before ADD_1

  for (uint8_t scan = 0; scan < 6; scan++) {
    if (scan > 0) {
      stamp();
      Serial.println("KEEP STILL - same finger, do not lift. Next scan in 600 ms.");
      delay(600);
    }
    if (!doAdd(scan + 1, captureSteps[scan], 30000)) {
      stamp();
      Serial.print("SCAN ");
      Serial.print(scan + 1);
      Serial.println("/6 FAILED - stopping this run (re-run 'c' to try again)");
      return;
    }
  }
  Serial.println("=== MODE C: all six scans ACCEPTED ===");
  doCount("after mode C");
}

/* ── Serial UI ───────────────────────────────────────────────────────────── */

void printHelp() {
  Serial.println("Commands:");
  Serial.println("  a = mode A: SEARCH between scans (PR #50 style)");
  Serial.println("  b = mode B: no commands between scans, 4 s lift pause (ee3873b style)");
  Serial.println("  c = mode C: place once, keep the finger on (current firmware style)");
  Serial.println("  t = sensor COUNT test");
  Serial.println("  x = delete the test ID 999");
  Serial.println("  h = this help");
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("FPC1020A enrollment diagnostic (Biovo1020A library, unchanged)");
  sensorSerial.begin(19200, SERIAL_8N1, SENSOR_RX_PIN, SENSOR_TX_PIN);
  delay(500);
  finger.begin();
  delay(300);

  if (!doCount("startup")) {
    Serial.println("Sensor not answering. Check wiring: TX->16 RX->17, GND, VCC, baud 19200.");
  }
  printHelp();
}

void loop() {
  if (!Serial.available()) return;
  const char c = (char)Serial.read();
  switch (c) {
    case 'a': runModeA(); break;
    case 'b': runModeB(); break;
    case 'c': runModeC(); break;
    case 't': doCount("manual test"); break;
    case 'x': doDelete(); break;
    case 'h': printHelp(); break;
    case '\n': case '\r': break;
    default:
      Serial.println("Unknown command. Press h for help.");
      break;
  }
  Serial.println();
}
