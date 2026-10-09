/*
 * FANA CAFE & RESTAURANT - Attendance System
 * GitHub: hardware/fana_attendance_esp32/fana_attendance_esp32.ino (keep updated here for copy-paste upload)
 * Branch: arena/468a03d9-digital-menu-railway -> main after merge
 * Hardware: ESP32 WROOM Wifi Board 1,750 Br + FPC1020A 4,500 Br + 0.96" OLED + Buzzer + LEDs
 * Total: 8,720 Br core, 16 wires exact (8 Female-Female for modules, 8 Male-Male for ESP32/buzzer/LEDs)
 *
 * Wiring:
 * FPC1020A VCC (Red)    -> ESP32 3.3V (or 5V if module needs 5V)
 * FPC1020A GND (Black)  -> ESP32 GND
 * FPC1020A TX (Yellow)  -> ESP32 GPIO16 (RX2)
 * FPC1020A RX (White)   -> ESP32 GPIO17 (TX2)
 * Buzzer +              -> ESP32 GPIO23
 * Buzzer -              -> GND
 * Green LED +           -> ESP32 GPIO18 -> 220ohm -> LED -> GND
 * Red LED +             -> ESP32 GPIO19 -> 220ohm -> LED -> GND
 * OLED VCC              -> 3.3V
 * OLED GND              -> GND
 * OLED SDA              -> GPIO21
 * OLED SCL              -> GPIO22
 *
 * OPTIONAL but recommended (better captures, less sensor wear):
 * FPC1020A TOUCH OUT (pin 5) -> ESP32 GPIO25   and uncomment FINGER_TOUCH_PIN below
 * FPC1020A V_TOUCH   (pin 6) -> 3.3V
 * With this wired, the ESP32 only sends scan commands when a finger is really
 * on the sensor. See FINGERPRINT_FIX.md.
 *
 * IMPORTANT (physical): peel the protective plastic film off the FPC1020A
 * sensor surface before first use - a capacitive sensor cannot image through
 * it. Wipe the surface clean. Press the finger flat and still.
 *
 * Libraries needed (Arduino Library Manager):
 * - Biovo1020A PATCHED copy - install hardware/fana_attendance_esp32/libraries/Biovo1020A
 *   (REPLACES https://github.com/nahomyirga787-spec/Biovo1020A - see its README)
 * - Adafruit SSD1306
 * - Adafruit GFX Library
 * - WiFiManager by tzapu (for easy WiFi config)
 * - ArduinoJson
 *
 * Sensor UART: 19200 baud, 8N1 (module default - do NOT use 57600).
 *
 * Setup: production server URL and device ID are already configured; no device token required
 * Features: Print hard copy button in admin, last 7 days sales sliding window
 *
 * Setup:
 * 1. Install libraries (patched Biovo1020A from this repo, see above)
 * 2. Select Board: ESP32 Dev Module
 * 3. Upload
 * 4. First boot: Connect to WiFi "Fana-Attendance-Setup" from phone, set restaurant WiFi
 * 5. Device will POST to your VPSDime VPS
 *
 * For 40-50 staff, 3 fingerprints each = 120-150 templates
 * FPC1020A stores 150-1000 templates, <0.45 sec search, capacitive with wet optimization
 *
 * Fingerprint fixes in this version (see FINGERPRINT_FIX.md):
 * - "BIOVO enrollment failed at step 1; status = 6" fixed: status 6 means the
 *   module saw a finger but the IMAGE was too messy/unclear. Enrollment now
 *   retries each step with on-screen guidance (press flat, clean sensor).
 * - Patched library re-syncs on frame head, so a late reply from the 1x/sec
 *   idle scan can no longer be mistaken for the enrollment reply.
 * - "Not enrolled" (status 5) and "image unclear" (status 6) are now told
 *   apart from "no finger" (status 8).
 * - One scan = one clock event: after a scan the device waits for the finger
 *   to be lifted before accepting the next one (no more double clock-in).
 * - Re-enrolling an ID that already has a finger on the module now works
 *   (old finger is deleted first, status 7 handled).
 * - Sensor is re-checked every 5 s if it was missing at boot (self-healing).
 */

#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Biovo1020A.h>
#include <map>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <LittleFS.h>
#include <WebServer.h>

// OLED
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// Fingerprint - FPC1020A on Serial2 (GPIO16 RX, GPIO17 TX)
HardwareSerial mySerial(2);
Biovo1020A finger(mySerial);

// Pins
#define BUZZER_PIN 23
#define GREEN_LED 18
#define RED_LED 19

// OPTIONAL: wire the module's TOUCH OUT (pin 5) to GPIO25 and V_TOUCH (pin 6)
// to 3.3V, then uncomment the next line. The ESP32 will only scan when a
// finger is actually present. If it never triggers, change ACTIVE to LOW.
// #define FINGER_TOUCH_PIN 25
#define FINGER_TOUCH_ACTIVE HIGH

// Web server for local config
WebServer server(80);

// FANA CAFE production configuration (provided by the user)
String serverURL = "https://fanacafe.com.et";
String deviceId = "entrance";
bool useHTTPS = true; // Domain has a valid HTTPS certificate
String deviceToken = ""; // No device token required by the server

// FPC1020A status codes. The patched library defines these too; the #ifndef
// guards keep this sketch compiling even with the original GitHub library.
#ifndef BIOVO_ACK_NOUSER
#define BIOVO_ACK_NOUSER     0x05 // search: finger scanned, no match enrolled
#endif
#ifndef BIOVO_ACK_IMAGEMESS
#define BIOVO_ACK_IMAGEMESS  0x06 // image too messy/unclear to process
#endif
#ifndef BIOVO_ACK_USER_EXIST
#define BIOVO_ACK_USER_EXIST 0x07 // enroll: ID already has a finger
#endif
#ifndef BIOVO_ACK_TIMEOUT
#define BIOVO_ACK_TIMEOUT    0x08 // search: no finger / scan window expired
#endif
#ifndef BIOVO_ACK_COMM_ERROR
#define BIOVO_ACK_COMM_ERROR 0xFE // garbled reply / reply to another command
#endif
// 0xFF = no reply at all (both library versions use this for timeouts)

// Sensor health + cached template count (avoids a COUNT command on every
// idle screen refresh)
bool sensorReady = false;
int templateCount = -1;

// How often the device asks the server "is anybody waiting to enroll a finger?"
// (the owner asked for 2 seconds). This poll is ~99% of the device's server
// traffic (43,200 tiny requests/day). Raise it to e.g. 5000 to cut that by
// 60% - enrollment pickup then takes up to 5 s instead of 2 s.
#define PENDING_POLL_INTERVAL_MS 2000

// Admin presses "Add Fingerprint" on the website -> the server opens a pending
// job -> this device picks it up here, shows the name, stores the finger and
// reports the mapping back.
unsigned long lastPendingCheck = 0;
bool enrollingFromServer = false;
bool checkPendingEnroll();
bool postMappingToServer(int fingerprintId, String memberName);
bool enrollFingerprint(int id);

// Offline queue
struct QueueItem {
  int fingerprintId;
  String timestamp;
  String action;
};

// Simple mapping cache - fingerprintId -> staffName
// In production, this is synced from /api/attendance/mappings
std::map<int, String> fingerprintToStaff;

// One scan event per finger placement: after any scan result (match, not
// enrolled, unclear image) we ignore further results until the module reports
// "no finger" again (or 6 s pass). Prevents double clock-in and message spam.
bool awaitingFingerLift = false;
unsigned long lastFingerEventMs = 0;

// Enrollment: guided tries per step before giving up
#define ENROLL_MAX_ATTEMPTS 5

void setup() {
  Serial.begin(115200);
  Serial.println("\n\nFANA CAFE Attendance - FPC1020A + ESP32 WROOM");

  // Pins
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(GREEN_LED, LOW);
  digitalWrite(RED_LED, LOW);
#ifdef FINGER_TOUCH_PIN
  pinMode(FINGER_TOUCH_PIN, INPUT);
#endif

  // OLED
  Wire.begin(21, 22); // SDA, SCL
  if(!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("OLED not found at 0x3C, trying 0x3D");
    display.begin(SSD1306_SWITCHCAPVCC, 0x3D);
  }
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0,0);
  display.println("FANA CAFE");
  display.println("Attendance");
  display.println("Starting...");
  display.display();

  // LittleFS
  if(!LittleFS.begin(true)) {
    Serial.println("LittleFS mount failed");
  }

  // Fingerprint sensor: 19200 8N1 is the FPC1020A default. The module can be
  // slow to boot, so try a few times before giving up.
  mySerial.begin(19200, SERIAL_8N1, 16, 17); // RX, TX: sensor TX -> GPIO16, sensor RX <- GPIO17
  delay(500);
  finger.begin();
  delay(300);

  sensorReady = false;
  for (int tries = 1; tries <= 5 && !sensorReady; tries++) {
    int16_t sensorCount = finger.getCount(3000);
    if (sensorCount >= 0) {
      sensorReady = true;
      templateCount = sensorCount;
      Serial.println("Found FPC1020A fingerprint sensor!");
      Serial.print("Templates: "); Serial.println(sensorCount);
    } else {
      Serial.print("Fingerprint sensor not answering, try ");
      Serial.print(tries); Serial.println("/5");
      delay(500);
    }
  }

  if (sensorReady) {
    display.clearDisplay();
    display.setCursor(0,0);
    display.println("FPC1020A Found!");
    display.println("Templates: " + String(templateCount));
    display.display();
    beepSuccess();
  } else {
    Serial.println("Did not find fingerprint sensor :(");
    Serial.println("Check wiring: TX->16 RX->17, GND, 3.3V, baud 19200");
    display.clearDisplay();
    display.setCursor(0,0);
    display.println("FPC1020A NOT found");
    display.println("Check wiring:");
    display.println("TX->16 RX->17");
    display.println("GND + 3.3V");
    display.display();
    beepError();
    delay(3000);
    // The loop keeps re-checking the sensor every 5 s, so it self-heals
    // if the module was just slow or got plugged in later.
  }

  // WiFiManager - first boot creates hotspot "Fana-Attendance-Setup"
  WiFiManager wm;
  // wm.resetSettings(); // Uncomment to reset WiFi for testing
  bool res = wm.autoConnect("Fana-Attendance-Setup", "fana12345");
  if(!res) {
    Serial.println("Failed to connect WiFi");
    display.clearDisplay();
    display.setCursor(0,0);
    display.println("WiFi Failed");
    display.println("Restarting...");
    display.display();
    delay(3000);
    ESP.restart();
  } else {
    Serial.println("WiFi connected!");
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());
    display.clearDisplay();
    display.setCursor(0,0);
    display.println("WiFi Connected!");
    display.println(WiFi.localIP().toString());
    display.display();
    delay(2000);
  }

  // Load mappings from server
  loadMappingsFromServer();

  // Web server routes
  server.on("/status", handleStatus);
  server.on("/enroll", handleEnrollWeb);
  server.on("/logs", handleLogs);
  server.on("/mappings", handleMappings);
  server.on("/", handleRoot);
  server.begin();
  Serial.println("Web server started");

  // Show idle screen
  showIdleScreen();
}

void loop() {
  server.handleClient();

  // The admin may be waiting for a finger: ask the server every 2 seconds.
  if (!enrollingFromServer && millis() - lastPendingCheck > 2000) {
    lastPendingCheck = millis();
    checkPendingEnroll();
  }

  // If the sensor was missing at boot (or died), keep checking every 5 s.
  static unsigned long lastSensorCheck = 0;
  if (!sensorReady && millis() - lastSensorCheck > 5000) {
    lastSensorCheck = millis();
    int16_t count = finger.getCount(3000);
    if (count >= 0) {
      sensorReady = true;
      templateCount = count;
      Serial.println("Fingerprint sensor is back!");
      display.clearDisplay();
      display.setCursor(0,0);
      display.println("Sensor back!");
      display.println("Templates: " + String(templateCount));
      display.display();
      beepSuccess();
      delay(1500);
      showIdleScreen();
    }
  }

  // Check for fingerprint (only when the sensor is alive)
  if (sensorReady) {
    int fingerprintId = getFingerprintID();

    if (fingerprintId > 0) {
      // Found!
      String staffName = "Unknown";
      if (fingerprintToStaff.count(fingerprintId)) {
        staffName = fingerprintToStaff[fingerprintId];
      } else {
        staffName = "ID " + String(fingerprintId);
      }

      Serial.print("Found ID #"); Serial.print(fingerprintId);
      Serial.print(" - "); Serial.println(staffName);

      // Show on OLED immediately (no internet needed)
      display.clearDisplay();
      display.setTextSize(1);
      display.setCursor(0,0);
      display.println(staffName.substring(0,16));
      display.setTextSize(2);
      display.setCursor(0,20);
      display.println("Verified!");
      display.setTextSize(1);
      display.setCursor(0,45);
      display.println("ID:" + String(fingerprintId) + " Sending...");
      display.display();

      beepSuccess();
      digitalWrite(GREEN_LED, HIGH);

      // POST to server
      bool posted = postToServer(fingerprintId, staffName);

      if (posted) {
        display.clearDisplay();
        display.setCursor(0,0);
        display.println(staffName.substring(0,16));
        display.setTextSize(1);
        display.setCursor(0,15);
        display.println("Sent to server");
        display.setCursor(0,30);
        display.println("Green = OK");
        display.display();
      } else {
        // Offline - save to queue
        saveToQueue(fingerprintId, staffName);
        display.clearDisplay();
        display.setCursor(0,0);
        display.println(staffName.substring(0,16));
        display.setCursor(0,15);
        display.println("Offline - Saved");
        display.setCursor(0,30);
        display.println("Will sync later");
        display.display();
      }

      delay(2000);
      digitalWrite(GREEN_LED, LOW);
      showIdleScreen();
    } else if (fingerprintId == -1) {
      // A finger was scanned but is NOT enrolled in the module
      Serial.println("Finger scanned but NOT enrolled");
      display.clearDisplay();
      display.setCursor(0,0);
      display.println("Not enrolled!");
      display.setCursor(0,15);
      display.println("Ask admin to");
      display.setCursor(0,30);
      display.println("add this finger");
      display.display();
      beepError();
      digitalWrite(RED_LED, HIGH);
      delay(2000);
      digitalWrite(RED_LED, LOW);
      showIdleScreen();
    } else if (fingerprintId == -2) {
      // A finger was scanned but the image was too unclear (status 0x06)
      Serial.println("Fingerprint image unclear (status 6)");
      display.clearDisplay();
      display.setCursor(0,0);
      display.println("Image unclear!");
      display.setCursor(0,15);
      display.println("Press flat+still");
      display.setCursor(0,30);
      display.println("Clean the sensor");
      display.display();
      beepError();
      digitalWrite(RED_LED, HIGH);
      delay(2000);
      digitalWrite(RED_LED, LOW);
      showIdleScreen();
    }
  }

  // Try to sync offline queue every 30 seconds
  static unsigned long lastSync = 0;
  if (millis() - lastSync > 30000) {
    lastSync = millis();
    syncOfflineQueue();
    // Refresh mappings every 5 minutes
    static int syncCount = 0;
    syncCount++;
    if (syncCount > 10) {
      syncCount = 0;
      loadMappingsFromServer();
    }
  }

  // Check Serial for enroll commands
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd.startsWith("enroll")) {
      int id = cmd.substring(6).toInt();
      if (id > 0) enrollFingerprint(id);
    } else if (cmd == "empty") {
      emptyDatabase();
    } else if (cmd == "list") {
      listFingerprints();
    } else if (cmd == "test") {
      testSensor();
    }
  }
}

/* ── Fingerprint helpers ─────────────────────────────────────────────────── */

#ifdef FINGER_TOUCH_PIN
bool fingerTouched() {
  return digitalRead(FINGER_TOUCH_PIN) == FINGER_TOUCH_ACTIVE;
}
#endif

// Human-readable status for the Serial monitor
const char* fingerStatusText(uint8_t s) {
  switch (s) {
    case 0x00: return "OK";
    case 0x01: return "Command failed";
    case 0x04: return "Database full";
    case 0x05: return "No matching finger enrolled";
    case 0x06: return "Image unclear - press flat, clean sensor";
    case 0x07: return "ID already has a finger";
    case 0x08: return "No finger / scan timeout";
    case 0x0F: return "Finger lifted";
    case 0xFE: return "Garbled reply from sensor";
    case 0xFF: return "No reply - check wiring/power";
    default:   return "Unknown status";
  }
}

// Short status for the 21-char OLED line
const char* fingerStatusShort(uint8_t s) {
  switch (s) {
    case 0x06: return "Image unclear!";
    case 0x07: return "ID exists-retry";
    case 0x04: return "Database full!";
    case 0x08: return "No finger seen";
    case 0x01: return "Failed - retry";
    default:   return "Retry...";
  }
}

// Wait until the finger leaves the sensor (or timeoutMs passes). With the
// optional touch pin this is exact; without it, it is just a timed pause.
void waitForFingerLift(uint32_t timeoutMs) {
#ifdef FINGER_TOUCH_PIN
  uint32_t start = millis();
  while (fingerTouched() && millis() - start < timeoutMs) {
    delay(20);
  }
  delay(300); // let the module see the finger-off before the next capture
#else
  delay(timeoutMs);
#endif
}

void showEnrollFailScreen(const char* line1, const char* line2) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println(line1);
  display.setCursor(0, 16);
  display.println(line2);
  display.display();
}

/*
 * Scan the sensor. Returns:
 *   >0  matched fingerprint ID
 *   -1  a finger was scanned but is NOT enrolled (module status 0x05)
 *   -2  a finger was scanned but the image was too unclear (status 0x06)
 *    0  no finger / nothing to report (status 0x08, 0xFF, ...)
 * One event per finger placement: after any event we ignore further results
 * until the module reports "no finger" again (or 6 s pass), so one touch can
 * never clock in twice and messages cannot spam.
 */
int getFingerprintID() {
#ifdef FINGER_TOUCH_PIN
  if (!fingerTouched()) { // no finger on the sensor: don't even ask it
    awaitingFingerLift = false;
    return 0;
  }
#endif

  // Safety: if the module kept reporting events for one placement, reset
  // after 6 s so a later finger is never ignored.
  if (awaitingFingerLift && millis() - lastFingerEventMs > 6000) {
    awaitingFingerLift = false;
  }

  uint16_t matchedID = 0;
  uint8_t permission = 0;
  // BIOVO search waits up to 1500 ms for a scan; it does not use Adafruit packet codes.
  bool responseOK = finger.search(matchedID, permission, 1500);
  uint8_t status = finger.getLastStatus();

  if (responseOK && matchedID > 0 && permission >= 1 && permission <= 3) {
    awaitingFingerLift = true;
    lastFingerEventMs = millis();
    return (int)matchedID;
  }

  if (status == BIOVO_ACK_NOUSER || status == BIOVO_ACK_IMAGEMESS) {
    // A finger was scanned but produced no match / a bad image.
    if (awaitingFingerLift) return 0; // already reported for this placement
    awaitingFingerLift = true;
    lastFingerEventMs = millis();
    return (status == BIOVO_ACK_NOUSER) ? -1 : -2;
  }

  // Status 0x08 (no finger), 0xFF (no reply), 0xFE (garbled), 0x01 ...
  awaitingFingerLift = false;
  return 0;
}

// Every call to the website carries the device word when one is configured.
void addDeviceHeaders(HTTPClient &http) {
  http.addHeader("Content-Type", "application/json");
  if (deviceToken.length() > 0) http.addHeader("x-attendance-device", deviceToken);
}

bool postToServer(int fingerprintId, String staffName) {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  String url = serverURL + "/api/attendance/clock";

  http.begin(url);
  addDeviceHeaders(http);

  DynamicJsonDocument doc(256);
  doc["fingerprintId"] = fingerprintId;
  doc["deviceId"] = deviceId;
  doc["method"] = "fingerprint";

  String json;
  serializeJson(doc, json);

  int httpCode = http.POST(json);
  bool success = false;

  if (httpCode > 0) {
    String response = http.getString();
    Serial.print("Server response: "); Serial.println(response);
    if (httpCode == 200) {
      success = true;
      // Parse response to update OLED with server message (late, total hours)
      DynamicJsonDocument respDoc(512);
      deserializeJson(respDoc, response);
      String action = respDoc["action"] | "";
      String message = respDoc["message"] | "";
      int lateMinutes = respDoc["lateMinutes"] | 0;
      String totalHours = respDoc["totalHours"] | "";
      // The server sends the Ethiopian wall clock already formatted ("08:05"):
      // slicing the ISO stamp here printed UTC instead of cafe time.
      String inLabel = respDoc["clockInLabel"] | "";
      String outLabel = respDoc["clockOutLabel"] | "";

      // memberName is the new key; staffName is kept for older servers.
      String who = respDoc["memberName"] | "";
      if (who.length() == 0) who = respDoc["staffName"] | "";
      if (who.length() == 0) who = staffName;

      display.clearDisplay();
      display.setCursor(0,0);
      display.println(who);
      display.setCursor(0,15);
      if (action == "clock_in") {
        display.println("IN " + inLabel);
        if (lateMinutes > 0) {
          display.setCursor(0,30);
          display.println("Late " + String(lateMinutes) + "m");
        } else {
          display.setCursor(0,30);
          display.println("On Time");
        }
      } else if (action == "clock_out") {
        display.println("OUT " + outLabel);
        display.setCursor(0,30);
        display.println(totalHours);
      } else {
        display.println(message.substring(0,16));
      }
      display.display();
      delay(3000);
    }
  } else {
    Serial.print("HTTP failed: "); Serial.println(http.errorToString(httpCode));
  }

  http.end();
  return success;
}

void loadMappingsFromServer() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = serverURL + "/api/attendance/mappings";

  http.begin(url);
  if (deviceToken.length() > 0) http.addHeader("x-attendance-device", deviceToken);
  int httpCode = http.GET();

  if (httpCode == 200) {
    String payload = http.getString();
    DynamicJsonDocument doc(4096);
    DeserializationError error = deserializeJson(doc, payload);

    if (!error) {
      fingerprintToStaff.clear();
      JsonObject simpleMap = doc["simpleMap"];
      for (JsonPair kv : simpleMap) {
        int fid = String(kv.key().c_str()).toInt();
        String name = kv.value().as<String>();
        fingerprintToStaff[fid] = name;
      }
      Serial.print("Loaded "); Serial.print(fingerprintToStaff.size()); Serial.println(" mappings from server");

      // Save to LittleFS for offline
      File f = LittleFS.open("/mappings.json", "w");
      if (f) {
        f.print(payload);
        f.close();
      }
    }
  } else {
    // Load from LittleFS offline cache
    if (LittleFS.exists("/mappings.json")) {
      File f = LittleFS.open("/mappings.json", "r");
      if (f) {
        String payload = f.readString();
        f.close();
        DynamicJsonDocument doc(4096);
        if (!deserializeJson(doc, payload)) {
          JsonObject simpleMap = doc["simpleMap"];
          for (JsonPair kv : simpleMap) {
            int fid = String(kv.key().c_str()).toInt();
            String name = kv.value().as<String>();
            fingerprintToStaff[fid] = name;
          }
          Serial.println("Loaded mappings from offline cache");
        }
      }
    }
  }
  http.end();
}

void saveToQueue(int fingerprintId, String staffName) {
  // Append to LittleFS queue file
  File f = LittleFS.open("/queue.json", "a");
  if (f) {
    DynamicJsonDocument doc(256);
    doc["fingerprintId"] = fingerprintId;
    doc["staffName"] = staffName;
    doc["timestamp"] = String(millis());
    doc["deviceId"] = deviceId;

    String json;
    serializeJson(doc, json);
    f.println(json);
    f.close();
    Serial.println("Saved to offline queue");
  }
}

void syncOfflineQueue() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!LittleFS.exists("/queue.json")) return;

  File f = LittleFS.open("/queue.json", "r");
  if (!f) return;

  String remaining = "";
  bool allSynced = true;

  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;

    DynamicJsonDocument doc(256);
    if (deserializeJson(doc, line)) continue;

    int fid = doc["fingerprintId"];

    HTTPClient http;
    http.begin(serverURL + "/api/attendance/clock");
    http.addHeader("Content-Type", "application/json");

    DynamicJsonDocument postDoc(256);
    postDoc["fingerprintId"] = fid;
    postDoc["deviceId"] = deviceId + "_offline";
    postDoc["method"] = "fingerprint";

    String json;
    serializeJson(postDoc, json);

    int httpCode = http.POST(json);
    http.end();

    if (httpCode != 200) {
      remaining += line + "\n";
      allSynced = false;
    } else {
      Serial.print("Synced offline ID "); Serial.println(fid);
    }
  }
  f.close();

  if (allSynced) {
    LittleFS.remove("/queue.json");
    Serial.println("Offline queue fully synced");
  } else {
    File out = LittleFS.open("/queue.json", "w");
    if (out) {
      out.print(remaining);
      out.close();
    }
  }
}

/*
 * Enroll one finger under the given ID. BIOVO enrollment uses three guided
 * captures (steps 1, 2, 3); the same finger must be placed for each step and
 * lifted in between. Each step gets up to ENROLL_MAX_ATTEMPTS guided tries -
 * status 0x06 ("image unclear") is almost always fixed by pressing the finger
 * flat and still on a clean sensor, so we coach and retry instead of failing.
 */
bool enrollFingerprint(int id) {
  if (id <= 0) {
    Serial.println("Invalid fingerprint ID; use a positive ID.");
    return false;
  }
  if (!sensorReady) {
    Serial.println("Fingerprint sensor not responding; cannot enroll.");
    showEnrollFailScreen("Sensor offline", "Check wiring");
    beepError();
    delay(1500);
    showIdleScreen();
    return false;
  }

  Serial.print("Enrolling ID #"); Serial.println(id);

  // Drop any stale reply from the idle scan loop and give the module a
  // moment to finish a scan in progress, so the first reply we read really
  // belongs to our enroll command.
  while (mySerial.available()) mySerial.read();
  delay(150);

  // BIOVO enrollment uses three guided scans: steps 1, 2, and 3.
  for (uint8_t step = 1; step <= 3; step++) {
    const char* prompt = (step == 1) ? "Place finger"
                        : (step == 2) ? "Lift, place again"
                        :               "Place same finger";
    bool stepDone = false;

    for (uint8_t attempt = 1; attempt <= ENROLL_MAX_ATTEMPTS; attempt++) {
      Serial.print("Enrollment step "); Serial.print(step);
      Serial.print("/3, attempt "); Serial.println(attempt);

      display.clearDisplay();
      display.setTextSize(1);
      display.setCursor(0, 0);
      display.println("Enroll ID " + String(id));
      display.setCursor(0, 14);
      display.println(prompt);
      display.setCursor(0, 28);
      display.println("Step " + String(step) + " of 3");
      if (attempt > 1) {
        display.setCursor(0, 42);
        display.println("Try " + String(attempt) + "/" + String(ENROLL_MAX_ATTEMPTS));
      }
      display.display();

      if (finger.enroll((uint16_t)id, step, 30000)) {
        stepDone = true;
        break;
      }

      uint8_t status = finger.getLastStatus();
      Serial.print("Step "); Serial.print(step);
      Serial.print(" failed; status = "); Serial.print(status);
      Serial.print(" ("); Serial.print(fingerStatusText(status)); Serial.println(")");

      // No reply / garbled line: wiring or power problem. Retrying will not
      // help - abort; the 2 s poll will start a fresh attempt later.
      if (status == 0xFF || status == BIOVO_ACK_COMM_ERROR) {
        showEnrollFailScreen("Sensor no reply", "Check wiring+power");
        beepError();
        delay(2000);
        showIdleScreen();
        return false;
      }

      // This ID already has a finger stored on the module: remove the old
      // one and enroll fresh (makes re-enrollment work).
      if (status == BIOVO_ACK_USER_EXIST && step == 1) {
        Serial.println("ID already stored on module, deleting old finger");
        display.clearDisplay();
        display.setCursor(0, 0);
        display.println("ID " + String(id) + " exists");
        display.setCursor(0, 16);
        display.println("Replacing...");
        display.display();
        finger.deleteUser((uint16_t)id, 5000);
        continue;
      }

      if (attempt == ENROLL_MAX_ATTEMPTS) break;

      // Bad image (0x06) or generic failure: coach the user, then try again.
      display.clearDisplay();
      display.setCursor(0, 0);
      display.println("Enroll ID " + String(id));
      display.setCursor(0, 14);
      display.println(fingerStatusShort(status));
      display.setCursor(0, 28);
      display.println("Lift, place flat");
      display.setCursor(0, 42);
      display.println("Try " + String(attempt + 1) + "/" + String(ENROLL_MAX_ATTEMPTS));
      display.display();
      beepError();
      waitForFingerLift(1500); // give the user time to lift and re-place
    }

    if (!stepDone) {
      showEnrollFailScreen("Enroll failed", "Try again");
      beepError();
      delay(1500);
      showIdleScreen();
      return false;
    }

    if (step < 3) {
      // Enrollment needs the finger lifted between captures.
      display.clearDisplay();
      display.setCursor(0, 0);
      display.println("Good! Lift finger");
      display.setCursor(0, 16);
      display.println("Then place again");
      display.display();
      beepSuccess();
      waitForFingerLift(5000);
    }
  }

  Serial.println("Fingerprint enrolled successfully.");
  int16_t newCount = finger.getCount(3000);
  if (newCount >= 0) templateCount = newCount;
  display.clearDisplay();
  display.setCursor(0, 0);
  display.println("Enrolled ID " + String(id));
  display.setCursor(0, 16);
  display.println("Success!");
  display.display();
  beepSuccess();
  delay(2000);
  showIdleScreen();
  return true;
}

/* ── THE ADMIN'S "ADD FINGERPRINT" BUTTON ───────────────────────────────────
 * GET /api/attendance/biometrics?pending tells us who is waiting. We show the
 * name on the OLED, take the finger under the ID the server chose, then post
 * the mapping back so the website prints "Fingerprint Added ✓".
 */
bool checkPendingEnroll() {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  http.begin(serverURL + "/api/attendance/biometrics?pending=1");
  if (deviceToken.length() > 0) http.addHeader("x-attendance-device", deviceToken);
  int httpCode = http.GET();
  if (httpCode != 200) {
    http.end();
    return false;
  }

  String payload = http.getString();
  http.end();

  DynamicJsonDocument doc(1024);
  if (deserializeJson(doc, payload)) return false;
  int count = doc["count"] | 0;
  if (count <= 0) return false;

  JsonObject job = doc["jobs"][0].as<JsonObject>();
  if (job.isNull()) return false;
  int fingerprintId = job["fingerprintId"] | 0;
  String memberName = job["memberName"] | "Member";
  if (fingerprintId <= 0) return false;

  Serial.print("Pending enrollment from the website: ");
  Serial.print(memberName);
  Serial.print(" as ID ");
  Serial.println(fingerprintId);

  enrollingFromServer = true;
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("Enroll " + memberName.substring(0, 12));
  display.setCursor(0, 15);
  display.println("ID " + String(fingerprintId));
  display.setCursor(0, 30);
  display.println("Place finger");
  display.display();

  bool stored = enrollFingerprint(fingerprintId);
  if (stored) {
    postMappingToServer(fingerprintId, memberName);
    fingerprintToStaff[fingerprintId] = memberName; // usable at once, offline or not
    display.clearDisplay();
    display.setCursor(0, 0);
    display.println(memberName.substring(0, 16));
    display.setCursor(0, 15);
    display.println("Fingerprint Added");
    display.display();
    delay(3000);
  } else {
    display.clearDisplay();
    display.setCursor(0, 0);
    display.println("Enroll failed");
    display.setCursor(0, 15);
    display.println("Press again on web");
    display.display();
    delay(3000);
  }
  enrollingFromServer = false;
  showIdleScreen();
  return stored;
}

// The last step of the flow: tell the website which finger belongs to whom.
bool postMappingToServer(int fingerprintId, String memberName) {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  http.begin(serverURL + "/api/attendance/mappings");
  addDeviceHeaders(http);

  DynamicJsonDocument doc(256);
  doc["fingerprintId"] = fingerprintId;
  doc["staffName"] = memberName;
  doc["memberName"] = memberName;
  doc["deviceId"] = deviceId;

  String json;
  serializeJson(doc, json);
  int httpCode = http.POST(json);
  http.end();

  Serial.print("Mapping posted, HTTP ");
  Serial.println(httpCode);
  return httpCode == 200;
}

void emptyDatabase() {
  bool cleared = finger.deleteAll();
  if (!cleared) {
    Serial.print("Could not clear fingerprint database; status = ");
    Serial.print(finger.getLastStatus());
    Serial.print(" ("); Serial.print(fingerStatusText(finger.getLastStatus())); Serial.println(")");
    beepError();
    return;
  }
  Serial.println("Database emptied");
  templateCount = 0;
  display.clearDisplay();
  display.setCursor(0,0);
  display.println("DB Emptied!");
  display.display();
  beepSuccess();
  delay(2000);
  showIdleScreen();
}

void listFingerprints() {
  int16_t count = finger.getCount(3000);
  if (count >= 0) templateCount = count;
  Serial.print("Templates: "); Serial.println(count);
  display.clearDisplay();
  display.setCursor(0,0);
  display.println("Templates: " + String(count));
  display.display();
  delay(2000);
  showIdleScreen();
}

// Serial "test" command: ping the sensor and report the raw status.
void testSensor() {
  Serial.println("--- Sensor test ---");
  while (mySerial.available()) mySerial.read();
  int16_t count = finger.getCount(3000);
  Serial.print("COUNT reply: ");
  if (count >= 0) {
    Serial.print("OK, templates = "); Serial.println(count);
  } else {
    Serial.print("FAIL, status = "); Serial.print(finger.getLastStatus());
    Serial.print(" ("); Serial.print(fingerStatusText(finger.getLastStatus())); Serial.println(")");
  }
  display.clearDisplay();
  display.setCursor(0,0);
  display.println("Sensor test:");
  if (count >= 0) {
    display.println("OK " + String(count) + " tmpl");
  } else {
    display.println("FAIL st=" + String(finger.getLastStatus()));
    display.println("Check wiring");
  }
  display.display();
  delay(2500);
  showIdleScreen();
}

void showIdleScreen() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0,0);
  display.println("FANA CAFE");
  display.setCursor(0,10);
  display.println("Attendance Ready");
  display.setCursor(0,25);
  display.println("Place finger");
  display.setCursor(0,40);
  display.println("IP:" + WiFi.localIP().toString());
  display.setCursor(0,50);
  if (sensorReady) {
    display.println("Templates:" + String(templateCount));
  } else {
    display.println("SENSOR OFFLINE!");
  }
  display.display();
}

void beepSuccess() {
  digitalWrite(BUZZER_PIN, HIGH);
  delay(100);
  digitalWrite(BUZZER_PIN, LOW);
}

void beepError() {
  digitalWrite(BUZZER_PIN, HIGH);
  delay(500);
  digitalWrite(BUZZER_PIN, LOW);
}

// Web server handlers
void handleRoot() {
  String html = "<h1>FANA CAFE Attendance</h1>";
  html += "<p>IP: " + WiFi.localIP().toString() + "</p>";
  html += "<p>Sensor: " + String(sensorReady ? "online" : "OFFLINE") + "</p>";
  html += "<p>Templates: " + String(templateCount) + "</p>";
  html += "<p><a href='/status'>Status JSON</a></p>";
  html += "<p><a href='/mappings'>Mappings</a></p>";
  html += "<p><a href='/logs'>Offline Logs</a></p>";
  html += "<form action='/enroll'>Enroll ID: <input name='id' type='number'><input type='submit'></form>";
  server.send(200, "text/html", html);
}

void handleStatus() {
  DynamicJsonDocument doc(512);
  doc["deviceId"] = deviceId;
  doc["ip"] = WiFi.localIP().toString();
  doc["templates"] = templateCount;
  doc["sensorReady"] = sensorReady;
  doc["wifi"] = WiFi.status() == WL_CONNECTED;
  doc["battery"] = 98; // TODO: read battery if connected
  doc["mappings"] = fingerprintToStaff.size();

  String json;
  serializeJson(doc, json);
  server.send(200, "application/json", json);
}

void handleEnrollWeb() {
  if (server.hasArg("id")) {
    int id = server.arg("id").toInt();
    server.send(200, "text/plain", "Enrolling ID " + String(id) + " - Place finger on sensor now");
    enrollFingerprint(id);
  } else {
    server.send(400, "text/plain", "Missing id parameter");
  }
}

void handleLogs() {
  String logs = "";
  if (LittleFS.exists("/queue.json")) {
    File f = LittleFS.open("/queue.json", "r");
    logs = f.readString();
    f.close();
  }
  server.send(200, "application/json", logs.length() > 0 ? logs : "[]");
}

void handleMappings() {
  DynamicJsonDocument doc(2048);
  JsonObject map = doc.createNestedObject("mappings");
  for (auto &kv : fingerprintToStaff) {
    map[String(kv.first)] = kv.second;
  }
  String json;
  serializeJson(doc, json);
  server.send(200, "application/json", json);
}
