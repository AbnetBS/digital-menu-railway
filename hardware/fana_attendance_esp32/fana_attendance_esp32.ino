/*
 * FANA CAFE & RESTAURANT - Attendance System
 * GitHub: hardware/fana_attendance_esp32/fana_attendance_esp32.ino (keep updated here for copy-paste upload)
 * Branch: arena/01a0e384-digital-menu-railway -> main after merge
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
 * Libraries needed (Arduino Library Manager):
 * - Adafruit Fingerprint Sensor Library
 * - Adafruit SSD1306
 * - Adafruit GFX Library
 * - WiFiManager by tzapu (for easy WiFi config)
 * - ArduinoJson
 * 
 * Setup: copy from GitHub, edit serverURL to Coolify domain, upload
 * Features: Print hard copy button in admin, last 7 days sales sliding window
 */
 * Setup:
 * 1. Install libraries
 * 2. Select Board: ESP32 Dev Module
 * 3. Upload
 * 4. First boot: Connect to WiFi "Fana-Attendance-Setup" from phone, set restaurant WiFi
 * 5. Device will POST to your VPSDime VPS
 * 
 * For 40-50 staff, 3 fingerprints each = 120-150 templates
 * FPC1020A stores 150-1000 templates, <0.45 sec search, capacitive with wet optimization
 */

#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Adafruit_Fingerprint.h>
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
Adafruit_Fingerprint finger = Adafruit_Fingerprint(&mySerial);

// Pins
#define BUZZER_PIN 23
#define GREEN_LED 18
#define RED_LED 19

// Web server for local config
WebServer server(80);

// Config - CHANGE THESE
String serverURL = "https://yourdomain.com"; // Your VPSDime Coolify domain with https
String deviceId = "entrance";
bool useHTTPS = true;
// Optional: if the owner sets ATTENDANCE_DEVICE_TOKEN on the server, put the
// same word here. Empty = the server accepts the device as it always did.
String deviceToken = "";

// Admin presses "Add Fingerprint" on the website -> the server opens a pending
// job -> this device picks it up here, shows the name, stores the finger and
// reports the mapping back. Poll every 2 seconds, as the owner asked.
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

  // Fingerprint
  mySerial.begin(57600, SERIAL_8N1, 16, 17); // RX, TX
  finger.begin(57600);
  
  if (finger.verifyPassword()) {
    Serial.println("Found FPC1020A fingerprint sensor!");
    display.clearDisplay();
    display.setCursor(0,0);
    display.println("FPC1020A Found!");
    display.println("Templates: " + String(finger.templateCount));
    display.display();
    beepSuccess();
  } else {
    Serial.println("Did not find fingerprint sensor :(");
    display.clearDisplay();
    display.setCursor(0,0);
    display.println("FPC1020A NOT found");
    display.println("Check wiring:");
    display.println("TX->16 RX->17");
    display.display();
    beepError();
    delay(3000);
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

  // Check for fingerprint
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
    // Not found
    Serial.println("Fingerprint not found");
    display.clearDisplay();
    display.setCursor(0,0);
    display.println("Not found!");
    display.setCursor(0,15);
    display.println("Try again");
    display.setCursor(0,30);
    display.println("Clean finger");
    display.display();
    beepError();
    digitalWrite(RED_LED, HIGH);
    delay(2000);
    digitalWrite(RED_LED, LOW);
    showIdleScreen();
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
    }
  }
}

int getFingerprintID() {
  uint8_t p = finger.getImage();
  if (p != FINGERPRINT_OK) return 0;

  p = finger.image2Tz();
  if (p != FINGERPRINT_OK) return 0;

  p = finger.fingerFastSearch();
  if (p != FINGERPRINT_OK) {
    if (p == FINGERPRINT_NOTFOUND) return -1;
    return 0;
  }

  return finger.fingerID;
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

bool enrollFingerprint(int id) {
  Serial.print("Enrolling ID #"); Serial.println(id);
  
  display.clearDisplay();
  display.setCursor(0,0);
  display.println("Enroll ID " + String(id));
  display.setCursor(0,15);
  display.println("Place finger");
  display.display();

  int p = -1;
  while (p != FINGERPRINT_OK) {
    p = finger.getImage();
  }

  p = finger.image2Tz(1);
  if (p != FINGERPRINT_OK) {
    Serial.println("Error image2Tz 1");
    return false;
  }

  display.clearDisplay();
  display.setCursor(0,0);
  display.println("Remove finger");
  display.display();
  delay(2000);

  while (finger.getImage() != FINGERPRINT_NOFINGER) {
    delay(100);
  }

  display.clearDisplay();
  display.setCursor(0,0);
  display.println("Place same finger");
  display.setCursor(0,15);
  display.println("again");
  display.display();

  p = -1;
  while (p != FINGERPRINT_OK) {
    p = finger.getImage();
  }

  p = finger.image2Tz(2);
  if (p != FINGERPRINT_OK) {
    Serial.println("Error image2Tz 2");
    return false;
  }

  p = finger.createModel();
  if (p != FINGERPRINT_OK) {
    Serial.println("Error createModel");
    return false;
  }

  p = finger.storeModel(id);
  if (p == FINGERPRINT_OK) {
    Serial.println("Stored!");
    display.clearDisplay();
    display.setCursor(0,0);
    display.println("Enrolled ID " + String(id));
    display.setCursor(0,15);
    display.println("Success!");
    display.display();
    beepSuccess();
    delay(2000);
    showIdleScreen();
    return true;
  }
  Serial.println("Error storing");
  beepError();
  showIdleScreen();
  return false;
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
  finger.emptyDatabase();
  Serial.println("Database emptied");
  display.clearDisplay();
  display.setCursor(0,0);
  display.println("DB Emptied!");
  display.display();
  beepError();
  delay(2000);
  showIdleScreen();
}

void listFingerprints() {
  Serial.print("Templates: "); Serial.println(finger.templateCount);
  display.clearDisplay();
  display.setCursor(0,0);
  display.println("Templates: " + String(finger.templateCount));
  display.display();
  delay(2000);
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
  display.println("Templates:" + String(finger.templateCount));
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
  html += "<p>Templates: " + String(finger.templateCount) + "</p>";
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
  doc["templates"] = finger.templateCount;
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
