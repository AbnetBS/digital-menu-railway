/*
 * FANA CAFE & RESTAURANT - Attendance device (ESP32 WROOM + FPC1020A + OLED)
 * File: hardware/fana_attendance_esp32/fana_attendance_esp32.ino
 *
 * ── WIRING: the fingerprint sensor needs ONLY 4 WIRES ─────────────────────
 *   FPC1020A VCC  -> ESP32 3.3V   (5V only if your module is marked 5V)
 *   FPC1020A GND  -> ESP32 GND
 *   FPC1020A TX   -> ESP32 GPIO16 (RX2)
 *   FPC1020A RX   -> ESP32 GPIO17 (TX2)
 *   Pins 5 (TOUCH OUT) and 6 (V_TOUCH) stay UNCONNECTED. Do not wire them.
 *
 *   OLED VCC -> 3.3V, GND -> GND, SDA -> GPIO21, SCL -> GPIO22
 *   Buzzer + -> GPIO23, Buzzer - -> GND
 *   Green LED -> GPIO18 -> 220 ohm -> GND, Red LED -> GPIO19 -> 220 ohm -> GND
 *
 * ── LIBRARIES (Arduino Library Manager) ───────────────────────────────────
 *   - Biovo1020A: the PATCHED copy in hardware/fana_attendance_esp32/libraries
 *     (custom FPC1020A driver - NOT the Adafruit fingerprint library)
 *   - Adafruit SSD1306 + Adafruit GFX Library (OLED only)
 *   - WiFiManager by tzapu
 *   - ArduinoJson (v6 or v7)
 *
 * ── HOW IT IS FAST ────────────────────────────────────────────────────────
 *   The fingerprint loop never waits for the internet. A finger is read,
 *   matched by the sensor (<0.5 s) and the OLED shows "VERIFIED + name" with a
 *   beep at once. The server call runs in a background task on the other CPU
 *   core and its answer (IN 08:05 / OUT / Late) appears a moment later. The
 *   HTTPS connection is kept open, so no TLS handshake is repeated per scan.
 *   If the internet is down, the scan is saved with its real time and sent
 *   later. The person never waits for the network.
 *
 * ── SENSOR FACTS (official Biovo/FPC1020A protocol) ───────────────────────
 *   Enrollment status 6 = "this ID is already used" (NOT a bad image)
 *   Enrollment status 7 = "this finger is already saved under another ID"
 *   Status 8            = "no finger within the capture window" (keep waiting)
 *   Command 0x2E sets that capture window. This sketch sets it at boot so the
 *   sensor answers about once a second when nobody is touching it.
 *   Enrollment = 6 captures: step 1 once, step 2 four times, step 3 once.
 *
 * Serial Monitor (115200): type  help
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Biovo1020A.h>
#include <map>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <LittleFS.h>
#include <WebServer.h>
#include <time.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>

/* ═════════════════════════ CONFIGURATION ═════════════════════════════════ */

String serverURL   = "https://fanacafe.com.et"; // production site
String deviceId    = "entrance";
String deviceToken = "";  // set to the server's ATTENDANCE_DEVICE_TOKEN if the owner sets one

// Pins
#define BUZZER_PIN 23
#define GREEN_LED  18
#define RED_LED    19
#define SENSOR_RX_PIN 16   // ESP32 RX2 <- sensor TX
#define SENSOR_TX_PIN 17   // ESP32 TX2 -> sensor RX
#define SENSOR_BAUD   19200

// OLED
#define SCREEN_WIDTH  128
#define SCREEN_HEIGHT 64
#define OLED_RESET    -1

// Sensor timing
#define CAPTURE_WINDOW_UNITS 4      // 0x2E value: sensor waits ~1 s for a finger, then answers "no finger"
#define SEARCH_TIMEOUT_MS 2500      // our wait for a search answer (window known)
#define SEARCH_TIMEOUT_LEGACY_MS 1500 // if the module refuses 0x2E (old behaviour that worked)
#define MATCH_RETRIES 2             // silent re-reads before "Not registered" (finger still settling)
#define SAME_FINGER_COOLDOWN_MS 8000 // same finger again within 8 s is not sent twice
#define RESULT_SCREEN_MS 3500       // how long a result stays on the OLED

// Enrollment timing
#define ENROLL_CAPTURES 6
#define ENROLL_PLACE_TIMEOUT_MS 25000 // time to put the finger down for one capture
#define ENROLL_BAD_IMAGE_LIMIT 4      // bad images allowed per capture
#define ENROLL_LIFT_MS 900            // "Lift finger" pause between captures
#define ENROLL_ACK_WAIT_MS 15000      // wait for the server to confirm the mapping

// Network timing
#define PENDING_POLL_FALLBACK_MS 15000  // only while the real-time stream is down
#define EVENT_STREAM_STALL_MS 75000     // server pings every 25 s
#define OFFLINE_SYNC_MS 30000
#define MAPPING_REFRESH_MS 900000UL     // 15 min safety refresh
#define MAPPING_DOC_BYTES 12288         // room for ~300 fingerprint names
#define REPORT_RETRY_MS 20000

// FPC1020A status codes (the patched library defines most of them; the
// guards keep this sketch compiling with any copy of the library).
#define FP_ACK_SUCCESS       0x00
#define FP_ACK_FAIL          0x01
#define FP_ACK_FULL          0x04
#define FP_ACK_NOUSER        0x05
#define FP_ACK_ID_OCCUPIED   0x06  // enrollment: this ID already holds a finger
#define FP_ACK_FINGER_EXISTS 0x07  // enrollment: this finger is saved under another ID
#define FP_ACK_TIMEOUT       0x08  // no finger inside the capture window
#define FP_NO_REPLY          0xFF  // library: nothing came back
#define FP_GARBLED           0xFE  // library: wrong/garbled frame
#define FP_CMD_CAPTURE_WINDOW 0x2E

/* ═════════════════════════ TYPES (keep above all functions) ══════════════ */

enum ScanKind { SCAN_NONE, SCAN_MATCH, SCAN_REJECT, SCAN_BAD_IMAGE, SCAN_NO_REPLY };

enum ResultKind : uint8_t {
  RES_IN, RES_OUT, RES_ALREADY, RES_NOT_ON_SERVER, RES_OFFLINE, RES_ERROR
};

enum PostOutcome { POST_DONE, POST_RETRY };

// Fixed-size structs: they travel between the two tasks through FreeRTOS queues.
struct ClockEvent  { uint16_t fid; uint32_t epoch; uint32_t ms; };
struct ClockResult { uint16_t fid; uint8_t kind; char name[24]; char line2[22]; char line3[22]; };
struct EnrollJob   { int32_t jobId; int32_t memberId; uint16_t fid; char name[40]; };
struct EnrollReport{ int32_t jobId; int32_t memberId; uint16_t fid; uint8_t ok; char name[40]; char reason[40]; };
struct EnrollAck   { int32_t jobId; int16_t httpCode; char message[48]; };
struct EnrollOutcome { bool ok; uint16_t storedId; char reason[40]; char detail[40]; };

/* ═════════════════════════ GLOBALS ═══════════════════════════════════════ */

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
HardwareSerial sensorSerial(2);
Biovo1020A finger(sensorSerial);
WebServer server(80);

// Shared between the two tasks
SemaphoreHandle_t mapMutex = nullptr;
SemaphoreHandle_t fsMutex = nullptr;
std::map<int, String> fingerprintToStaff;   // fingerprint ID -> member name
QueueHandle_t clockQueue = nullptr;   // UI  -> net : scans to record
QueueHandle_t resultQueue = nullptr;  // net -> UI  : server answers for the OLED
QueueHandle_t jobQueue = nullptr;     // net -> UI  : "Add Fingerprint" jobs
QueueHandle_t reportQueue = nullptr;  // UI  -> net : enrollment results
QueueHandle_t ackQueue = nullptr;     // net -> UI  : server confirmed the mapping
volatile bool enrollBusy = false;
volatile bool serverReachable = false;
volatile bool serverTried = false;   // false until the first API call finished
volatile bool eventStreamUp = false;
volatile int offlineCount = 0;
uint32_t bootId = 0;

// Sensor state (UI task only)
bool sensorReady = false;
bool captureWindowKnown = false;
int templateCount = -1;
uint8_t consecutiveNoReply = 0;
unsigned long lastSensorCheck = 0;

// Scan state (UI task only)
bool rejectLatched = false;          // "Not registered" already shown for this placement
bool waitForLift = false;            // after enrolling: ignore the finger still lying there
uint16_t lastMatchId = 0;
unsigned long lastMatchMs = 0;
uint16_t resultFid = 0;              // which scan the OLED is showing
bool screenIsMessage = false;
unsigned long screenUntil = 0;
String idleSignature = "";

// Buzzer / LED (non-blocking)
unsigned long buzzerOffAt = 0, greenOffAt = 0, redOffAt = 0;
uint8_t beepsLeft = 0;
uint16_t beepOnMs = 0, beepGapMs = 0;
unsigned long nextBeepAt = 0;

// Network task state
WiFiClientSecure apiTls;
WiFiClient apiPlain;
HTTPClient api;
WiFiClientSecure streamTls;
WiFiClient streamPlain;
HTTPClient streamHttp;
WiFiClient *eventStream = nullptr;
bool eventStreamActive = false;
unsigned long lastEventStreamTry = 0;
unsigned long lastEventStreamData = 0;
unsigned long eventStreamRetryMs = 5000;
String eventLine = "";
unsigned long lastPendingCheck = 0;
unsigned long lastOfflineSync = 0;
unsigned long lastMappingRefresh = 0;
unsigned long lastWifiKick = 0;
bool wifiWasUp = false;
int32_t handledJobs[8] = {0};
uint8_t handledJobsNext = 0;
EnrollReport pendingReport;
bool havePendingReport = false;
uint8_t pendingReportTries = 0;
unsigned long pendingReportAt = 0;

/* ═════════════════════════ PROTOTYPES ════════════════════════════════════ */

void netTask(void *arg);
void netStep();
void scanStep();
ScanKind scanOnce(uint16_t &id);
void onMatch(uint16_t id);
void onReject(ScanKind kind);
void handleNetResults();
void handleEnrollJobs();
void handleSerialCommands();
void checkSensorHealth();
bool sensorFrame(uint8_t cmd, uint8_t p1, uint8_t p2, uint8_t p3, uint32_t timeoutMs, uint8_t *reply);
void configureCaptureWindow();
uint32_t searchTimeoutMs();
uint32_t enrollCommandTimeout(unsigned long startedAt);
bool waitSensorIdle(const String &who, uint16_t id);
EnrollOutcome enrollFinger(uint16_t id, const String &who, bool fromServer);
void runServerJob(const EnrollJob &job);
void runManualEnroll(int id);
String nameFor(int fid);
bool hasMapping(int fid);
void setMapping(int fid, const String &name);
int nextFreeId();
int mappingCount();
void copyText(char *dst, size_t size, const String &src);
uint32_t nowEpoch();
bool timeValid();
void pauseMs(uint32_t ms);
void serviceOutputs();
void beep(uint8_t times, uint16_t onMs, uint16_t gapMs);
void ledOn(int pin, uint16_t ms);
void beepSuccess();
void beepError();
void drawCentered(const String &text, int y, uint8_t size);
void showIdle(bool force);
void showMessage(const String &title, const String &big, const String &line1, const String &line2, uint32_t ms);
void showVerified(uint16_t id, const String &name);
void showResult(const ClockResult &r);
void showEnrollScreen(const String &who, uint16_t id, uint8_t done, const String &big, const String &hint, int secondsLeft);
void addDeviceHeaders(HTTPClient &http);
bool apiBegin(const String &path);
int apiRequest(bool post, const String &path, const String &body, String *response);
PostOutcome postClock(uint16_t fid, uint32_t epoch, bool fromQueue, bool reportToScreen);
void pushResult(uint16_t fid, uint8_t kind, const String &name, const String &line2, const String &line3);
void appendOffline(const ClockEvent &ev);
int countOfflineLines();
void syncOfflineQueue();
uint32_t resolveEpoch(uint32_t epoch, uint32_t ms, uint32_t boot);
bool loadMappingsFromServer();
void loadMappingsFromCache();
bool parseMappings(const String &json, bool saveToCache);
void checkPendingJob();
bool jobHandled(int32_t jobId);
void markJobHandled(int32_t jobId);
void handleEnrollReports();
int sendEnrollReport(const EnrollReport &r, String &message);
void startEventStream();
void stopEventStream();
void pumpEventStream();
void handleRoot();
void handleStatus();

/* ═════════════════════════ SETUP ═════════════════════════════════════════ */

void setup() {
  Serial.begin(115200);
  Serial.println();
  Serial.println("FANA CAFE Attendance - FPC1020A (4 wires) + ESP32");

  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(GREEN_LED, LOW);
  digitalWrite(RED_LED, LOW);

  mapMutex = xSemaphoreCreateMutex();
  fsMutex = xSemaphoreCreateMutex();
  clockQueue = xQueueCreate(24, sizeof(ClockEvent));
  resultQueue = xQueueCreate(6, sizeof(ClockResult));
  jobQueue = xQueueCreate(1, sizeof(EnrollJob));
  reportQueue = xQueueCreate(2, sizeof(EnrollReport));
  ackQueue = xQueueCreate(2, sizeof(EnrollAck));
  bootId = (uint32_t)esp_random();

  // OLED (400 kHz I2C so a full redraw takes ~25 ms, not ~100 ms)
  Wire.begin(21, 22);
  Wire.setClock(400000);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("OLED not found at 0x3C, trying 0x3D");
    display.begin(SSD1306_SWITCHCAPVCC, 0x3D);
  }
  showMessage("FANA CAFE", "START", "Attendance", "Starting...", 0);

  if (!LittleFS.begin(true)) Serial.println("LittleFS mount failed");
  loadMappingsFromCache();
  offlineCount = countOfflineLines();

  // Fingerprint sensor: 19200 8N1. The module can be slow to boot.
  sensorSerial.begin(SENSOR_BAUD, SERIAL_8N1, SENSOR_RX_PIN, SENSOR_TX_PIN);
  delay(400);
  finger.begin();
  for (int tries = 1; tries <= 5 && !sensorReady; tries++) {
    int16_t count = finger.getCount(1500);
    if (count >= 0) {
      sensorReady = true;
      templateCount = count;
    } else {
      Serial.printf("Fingerprint sensor not answering, try %d/5\n", tries);
      delay(400);
    }
  }
  if (sensorReady) {
    configureCaptureWindow();
    Serial.printf("FPC1020A ready, %d fingerprints stored\n", templateCount);
    showMessage("SENSOR OK", "READY", String(templateCount) + " fingers stored", "", 0);
    beepSuccess();
  } else {
    Serial.println("Fingerprint sensor NOT found. Check: TX->16, RX->17, GND, 3.3V");
    showMessage("SENSOR ERROR", "CHECK", "TX->16  RX->17", "GND + 3.3V", 0);
    beepError();
    delay(2500);
  }

  // WiFi: first boot opens the setup hotspot. With saved WiFi the device
  // starts at once and connects in the background, so a router that is
  // down never blocks attendance (scans are saved and sent later).
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFiManager wm;
  if (wm.getWiFiIsSaved()) {
    WiFi.begin();
    showMessage("WIFI", "WIFI", "Connecting...", "Scanning works now", 0);
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 8000) delay(100);
  } else {
    showMessage("WIFI SETUP", "SETUP", "Phone WiFi:", "Fana-Attendance-Setup", 0);
    wm.setConfigPortalTimeout(300);
    wm.autoConnect("Fana-Attendance-Setup", "fana12345");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi connected, IP ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi not connected yet - working offline, will keep trying");
  }
  configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");

  apiTls.setInsecure();      // the site's certificate is not pinned on this device
  streamTls.setInsecure();

  server.on("/", handleRoot);
  server.on("/status", handleStatus);
  server.begin();

  // All internet work runs on core 0; the fingerprint loop stays on core 1.
  xTaskCreatePinnedToCore(netTask, "net", 16384, nullptr, 1, nullptr, 0);

  showIdle(true);
}

/* ═════════════════════════ MAIN LOOP (fingerprint + OLED) ════════════════ */

void loop() {
  serviceOutputs();
  server.handleClient();
  handleSerialCommands();
  handleNetResults();
  handleEnrollJobs();
  checkSensorHealth();

  if (screenIsMessage && (long)(millis() - screenUntil) >= 0) showIdle(true);
  else if (!screenIsMessage) showIdle(false);

  if (sensorReady) scanStep();
  else delay(20);
}

/* ── Scanning ──────────────────────────────────────────────────────────── */

ScanKind scanOnce(uint16_t &id) {
  uint16_t matched = 0;
  uint8_t permission = 0;
  bool ok = finger.search(matched, permission, searchTimeoutMs());
  uint8_t status = finger.getLastStatus();
  if (status == FP_NO_REPLY || status == FP_GARBLED) return SCAN_NO_REPLY;
  if (ok && matched > 0) {
    id = matched;
    return SCAN_MATCH;
  }
  if (ok) return SCAN_BAD_IMAGE;               // answer without an ID: unusable image
  if (status == FP_ACK_NOUSER) return SCAN_REJECT;
  return SCAN_NONE;                            // 0x08: nobody touched the sensor
}

void scanStep() {
  uint16_t id = 0;
  ScanKind kind = scanOnce(id);

  if (kind == SCAN_NO_REPLY) {
    rejectLatched = false;
    waitForLift = false;
    if (captureWindowKnown && ++consecutiveNoReply >= 4) {
      // The sensor should answer every ~1 s. Four silent rounds: check it.
      consecutiveNoReply = 0;
      if (finger.getCount(1500) < 0) {
        sensorReady = false;
        Serial.println("Fingerprint sensor stopped answering");
        showIdle(true);
      }
    }
    return;
  }
  consecutiveNoReply = 0;

  if (kind == SCAN_NONE) {      // sensor is empty: the next finger is a new scan
    rejectLatched = false;
    waitForLift = false;
    return;
  }
  if (waitForLift) return;      // the finger that was just enrolled is still on the glass

  if (kind != SCAN_MATCH) {
    if (rejectLatched) return;  // same finger still lying there: already told
    // The first image often catches a finger that is still landing. Read
    // again while it settles before saying "Not registered".
    showMessage("", "HOLD", "Hold still...", "", 2000);
    for (uint8_t i = 0; i < MATCH_RETRIES && kind != SCAN_MATCH; i++) {
      ScanKind again = scanOnce(id);
      if (again == SCAN_NONE || again == SCAN_NO_REPLY) {   // finger was lifted
        showIdle(true);
        return;
      }
      kind = again;
    }
  }

  if (kind == SCAN_MATCH) onMatch(id);
  else onReject(kind);
}

void onMatch(uint16_t id) {
  rejectLatched = false;
  unsigned long now = millis();
  if (id == lastMatchId && now - lastMatchMs < SAME_FINGER_COOLDOWN_MS) {
    // Finger still on the sensor (or pressed twice): already recorded.
    if (!screenIsMessage || resultFid != id) showVerified(id, nameFor(id));
    screenUntil = now + RESULT_SCREEN_MS;
    return;
  }
  lastMatchId = id;
  lastMatchMs = now;

  String name = nameFor(id);
  Serial.printf("MATCH ID %u %s\n", id, name.c_str());
  showVerified(id, name);
  beepSuccess();
  ledOn(GREEN_LED, 1500);

  ClockEvent ev;
  ev.fid = id;
  ev.epoch = nowEpoch();
  ev.ms = now;
  if (xQueueSend(clockQueue, &ev, 0) != pdTRUE) {
    appendOffline(ev);          // never lose a scan, even if the queue is full
  }
}

void onReject(ScanKind kind) {
  rejectLatched = true;
  resultFid = 0;
  if (kind == SCAN_BAD_IMAGE) {
    Serial.println("Scan: unclear image");
    showMessage("TRY AGAIN", "AGAIN", "Press finger flat", "and hold still", 2500);
  } else {
    Serial.println("Scan: finger not registered");
    showMessage("NOT REGISTERED", "NO", "Finger not added", "Ask the admin", 3000);
  }
  beepError();
  ledOn(RED_LED, 1500);
}

void handleNetResults() {
  ClockResult r;
  while (xQueueReceive(resultQueue, &r, 0) == pdTRUE) {
    Serial.printf("Server: ID %u %s | %s | %s\n", r.fid, r.name, r.line2, r.line3);
    // Show it if the OLED is still on that person's scan, or idle right after it.
    bool samePerson = r.fid == resultFid;
    bool idleAfterIt = !screenIsMessage && r.fid == lastMatchId && millis() - lastMatchMs < 20000;
    if (!samePerson && !idleAfterIt) continue;
    resultFid = r.fid;
    showResult(r);
    if (r.kind == RES_NOT_ON_SERVER || r.kind == RES_ERROR) {
      beepError();
      ledOn(RED_LED, 1500);
    }
  }
}

/* ── Sensor helpers ────────────────────────────────────────────────────── */

// One raw 8-byte frame for commands the library does not wrap (0x2E only).
// The sensor serial port is used by this task alone, so this never collides
// with the library.
bool sensorFrame(uint8_t cmd, uint8_t p1, uint8_t p2, uint8_t p3, uint32_t timeoutMs, uint8_t *reply) {
  uint8_t tx[8] = {0xF5, cmd, p1, p2, p3, 0x00, 0x00, 0xF5};
  tx[6] = tx[1] ^ tx[2] ^ tx[3] ^ tx[4] ^ tx[5];
  while (sensorSerial.available() > 0) sensorSerial.read();
  sensorSerial.write(tx, 8);
  sensorSerial.flush();
  uint8_t win[8] = {0};
  unsigned long start = millis();
  while (millis() - start < timeoutMs) {
    if (sensorSerial.available() <= 0) { delay(1); continue; }
    memmove(win, win + 1, 7);
    win[7] = (uint8_t)sensorSerial.read();
    if (win[0] == 0xF5 && win[7] == 0xF5 && win[1] == cmd &&
        win[6] == (uint8_t)(win[1] ^ win[2] ^ win[3] ^ win[4] ^ win[5])) {
      memcpy(reply, win, 8);
      return true;
    }
  }
  return false;
}

// Make the sensor answer "no finger" after ~1 s instead of waiting forever,
// so a command is never sent while the sensor is still busy with the last one.
void configureCaptureWindow() {
  uint8_t r[8];
  captureWindowKnown = false;
  if (!sensorFrame(FP_CMD_CAPTURE_WINDOW, 0, 0, 1, 400, r) || r[4] != FP_ACK_SUCCESS) {
    Serial.println("Sensor keeps its own capture window (0x2E not supported) - legacy timing");
    return;
  }
  uint8_t current = r[3];
  if (current != CAPTURE_WINDOW_UNITS) {
    if (sensorFrame(FP_CMD_CAPTURE_WINDOW, 0, CAPTURE_WINDOW_UNITS, 0, 400, r) && r[4] == FP_ACK_SUCCESS) {
      current = CAPTURE_WINDOW_UNITS;
    }
  }
  captureWindowKnown = current != 0;   // 0 would mean "wait forever"
  Serial.printf("Sensor capture window: %u (%s)\n", current, captureWindowKnown ? "fast mode" : "legacy timing");
}

uint32_t searchTimeoutMs() {
  return captureWindowKnown ? SEARCH_TIMEOUT_MS : SEARCH_TIMEOUT_LEGACY_MS;
}

// With a known window the sensor answers in ~1 s, so ask often. Without it,
// one command waits for the rest of the placement time (never resend while
// the sensor may still be busy).
uint32_t enrollCommandTimeout(unsigned long startedAt) {
  if (captureWindowKnown) return 3000;
  unsigned long used = millis() - startedAt;
  if (used >= ENROLL_PLACE_TIMEOUT_MS) return 500;
  return ENROLL_PLACE_TIMEOUT_MS - used;
}

// A busy sensor answers COUNT only after its current capture window ends.
// A module without the 0x2E window can stay busy with the last idle search
// until somebody touches it, so in that mode we ask for the finger: the touch
// finishes that search and enrollment continues right away.
bool waitSensorIdle(const String &who, uint16_t id) {
  for (int i = 0; i < 3; i++) {
    int16_t count = finger.getCount(1200);
    if (count >= 0) {
      templateCount = count;
      return true;
    }
    pauseMs(150);
  }
  if (captureWindowKnown) return false;
  unsigned long start = millis();
  while (millis() - start < ENROLL_PLACE_TIMEOUT_MS) {
    int left = (int)((ENROLL_PLACE_TIMEOUT_MS - (millis() - start)) / 1000);
    showEnrollScreen(who, id, 0, "PLACE", "Put finger flat", left);
    int16_t count = finger.getCount(1000);
    if (count >= 0) {
      templateCount = count;
      return true;
    }
  }
  return false;
}

void checkSensorHealth() {
  if (sensorReady || millis() - lastSensorCheck < 5000) return;
  lastSensorCheck = millis();
  int16_t count = finger.getCount(1500);
  if (count >= 0) {
    sensorReady = true;
    templateCount = count;
    configureCaptureWindow();
    Serial.println("Fingerprint sensor is back");
    showMessage("SENSOR OK", "READY", String(count) + " fingers stored", "", 1500);
    beepSuccess();
  }
}

/* ═════════════════════════ ENROLLMENT ════════════════════════════════════ */

/*
 * Add one finger under `id`.
 *  1. Wait until the sensor is idle.
 *  2. Ask for the finger and SEARCH first: a finger that is already saved is
 *     never stored twice (a second copy would make scans show the wrong ID).
 *     An old copy that belongs to nobody is removed.
 *  3. Clear `id` on the sensor (an unmapped leftover there gave status 6).
 *  4. Six captures: 1x step 1, 4x step 2, 1x step 3. "No finger yet"
 *     (status 8) only keeps waiting - it never counts as a failed try.
 */
EnrollOutcome enrollFinger(uint16_t id, const String &who, bool fromServer) {
  EnrollOutcome out;
  out.ok = false;
  out.storedId = id;
  out.reason[0] = 0;
  out.detail[0] = 0;

  if (!sensorReady || !waitSensorIdle(who, id)) {
    copyText(out.reason, sizeof(out.reason), "Sensor not answering");
    copyText(out.detail, sizeof(out.detail), "Check sensor wires");
    return out;
  }
  Serial.printf("Enroll ID %u for %s\n", id, who.c_str());
  beep(2, 60, 80);

  for (uint8_t round = 0; round < 2; round++) {
    // ── step A: who is this finger? ───────────────────────────────────────
    unsigned long start = millis();
    int found = -1;            // 1 already saved, 0 new finger, -1 timeout, -2 sensor error
    uint16_t existing = 0;
    uint8_t noReply = 0;
    while (millis() - start < ENROLL_PLACE_TIMEOUT_MS) {
      int left = (int)((ENROLL_PLACE_TIMEOUT_MS - (millis() - start)) / 1000);
      showEnrollScreen(who, id, 0, "PLACE", "Put finger flat", left);
      uint16_t matched = 0;
      uint8_t permission = 0;
      bool ok = finger.search(matched, permission, enrollCommandTimeout(start));
      uint8_t st = finger.getLastStatus();
      serviceOutputs();
      if (ok && matched > 0) { existing = matched; found = 1; break; }
      if (!ok && st == FP_ACK_NOUSER) { found = 0; break; }
      if (st == FP_NO_REPLY || st == FP_GARBLED) {
        if (captureWindowKnown && ++noReply >= 3) { found = -2; break; }
        continue;
      }
      noReply = 0;
      if (ok) {   // image without an ID: unclear, keep the finger there
        showEnrollScreen(who, id, 0, "FLAT", "Press flat, hold", left);
        pauseMs(300);
      }
    }
    if (found == -1) {
      copyText(out.reason, sizeof(out.reason), "No finger - timed out");
      copyText(out.detail, sizeof(out.detail), "Start again");
      return out;
    }
    if (found == -2) {
      copyText(out.reason, sizeof(out.reason), "Sensor not answering");
      copyText(out.detail, sizeof(out.detail), "Check sensor wires");
      return out;
    }
    if (found == 1) {
      String owner = nameFor(existing);
      Serial.printf("Finger already saved as ID %u (%s)\n", existing, owner.length() ? owner.c_str() : "nobody");
      if (existing == id) {
        out.ok = true;            // this exact finger is already under this ID
        out.storedId = id;
        return out;
      }
      if (owner.length() == 0) {
        // A leftover copy from an old test/failed try: remove it, store fresh.
        showEnrollScreen(who, id, 0, "WAIT", "Removing old copy", -1);
        finger.deleteUser(existing, 3000);
      } else if (fromServer && owner.equalsIgnoreCase(who)) {
        out.ok = true;            // already this person's finger: just map it
        out.storedId = existing;
        return out;
      } else {
        copyText(out.reason, sizeof(out.reason), "Finger already used");
        copyText(out.detail, sizeof(out.detail), "by " + owner);
        return out;
      }
    }

    // ── step B: free the ID (anything there belongs to nobody) ───────────
    finger.deleteUser(id, 3000);

    // ── step C: six captures ──────────────────────────────────────────────
    static const uint8_t steps[ENROLL_CAPTURES] = {1, 2, 2, 2, 2, 3};
    bool restart = false;
    for (uint8_t c = 0; c < ENROLL_CAPTURES && !restart; c++) {
      if (c > 0) {
        showEnrollScreen(who, id, c, "LIFT", "Lift your finger", -1);
        pauseMs(ENROLL_LIFT_MS);
      }
      unsigned long capStart = millis();
      uint8_t bad = 0;
      uint8_t occupied = 0;
      noReply = 0;
      bool captured = false;
      while (millis() - capStart < ENROLL_PLACE_TIMEOUT_MS) {
        int left = (int)((ENROLL_PLACE_TIMEOUT_MS - (millis() - capStart)) / 1000);
        showEnrollScreen(who, id, c, c == 0 ? "HOLD" : "PLACE",
                         c == 0 ? "Keep finger still" : "Press same finger", left);
        bool ok = finger.enroll(id, steps[c], enrollCommandTimeout(capStart));
        uint8_t st = finger.getLastStatus();
        serviceOutputs();
        if (ok) { captured = true; break; }

        if (st == FP_ACK_TIMEOUT) { noReply = 0; continue; }         // no finger yet
        if (st == FP_NO_REPLY || st == FP_GARBLED) {
          if (captureWindowKnown && ++noReply >= 3) {
            copyText(out.reason, sizeof(out.reason), "Sensor not answering");
            copyText(out.detail, sizeof(out.detail), "Check sensor wires");
            return out;
          }
          continue;
        }
        noReply = 0;
        if (st == FP_ACK_ID_OCCUPIED && occupied < 2) {               // leftover at this ID
          occupied++;
          finger.deleteUser(id, 3000);
          continue;
        }
        if (st == FP_ACK_ID_OCCUPIED) {
          copyText(out.reason, sizeof(out.reason), "ID busy on sensor");
          copyText(out.detail, sizeof(out.detail), "Type: delete " + String(id));
          return out;
        }
        if (st == FP_ACK_FINGER_EXISTS) {
          const uint8_t *rx = finger.getLastRxPacket();
          uint16_t other = ((uint16_t)rx[2] << 8) | rx[3];
          String owner = (other > 0 && other != id) ? nameFor(other) : String("");
          if (round == 0 && other > 0 && other != id && owner.length() == 0) {
            finger.deleteUser(other, 3000);   // nobody's leftover: remove, start over once
            restart = true;
            break;
          }
          copyText(out.reason, sizeof(out.reason), "Finger already saved");
          copyText(out.detail, sizeof(out.detail), owner.length() ? "by " + owner : "as ID " + String(other));
          return out;
        }
        if (st == FP_ACK_FULL) {
          copyText(out.reason, sizeof(out.reason), "Sensor memory full");
          copyText(out.detail, sizeof(out.detail), "Delete unused IDs");
          return out;
        }
        // 0x01 or anything else: the image was not usable.
        if (++bad >= ENROLL_BAD_IMAGE_LIMIT) {
          copyText(out.reason, sizeof(out.reason), "Images not clear");
          copyText(out.detail, sizeof(out.detail), "Clean sensor, retry");
          return out;
        }
        showEnrollScreen(who, id, c, "FLAT", "Lift, press flat", left);
        beep(1, 200, 0);
        pauseMs(700);
      }
      if (restart) break;
      if (!captured) {
        copyText(out.reason, sizeof(out.reason), "No finger - timed out");
        copyText(out.detail, sizeof(out.detail), "Start again");
        return out;
      }
      Serial.printf("Capture %u/%u OK\n", c + 1, ENROLL_CAPTURES);
      beep(1, 60, 0);
    }
    if (restart) {
      showEnrollScreen(who, id, 0, "AGAIN", "Start over: lift", -1);
      pauseMs(1200);
      continue;
    }

    int16_t count = finger.getCount(1500);
    if (count >= 0) templateCount = count;
    out.ok = true;
    out.storedId = id;
    return out;
  }
  copyText(out.reason, sizeof(out.reason), "Could not add finger");
  copyText(out.detail, sizeof(out.detail), "Start again");
  return out;
}

// "Add Fingerprint" pressed on the website.
void runServerJob(const EnrollJob &job) {
  enrollBusy = true;
  String who = String(job.name);
  showEnrollScreen(who, job.fid, 0, "READY", "Get finger ready", -1);
  pauseMs(800);

  EnrollOutcome o = enrollFinger(job.fid, who, true);

  EnrollReport rep;
  memset(&rep, 0, sizeof(rep));
  rep.jobId = job.jobId;
  rep.memberId = job.memberId;
  rep.fid = o.storedId;
  rep.ok = o.ok ? 1 : 0;
  copyText(rep.name, sizeof(rep.name), who);
  copyText(rep.reason, sizeof(rep.reason), String(o.reason) + " " + String(o.detail));
  EnrollAck ack;
  while (xQueueReceive(ackQueue, &ack, 0) == pdTRUE) {}   // drop stale answers
  xQueueSend(reportQueue, &rep, pdMS_TO_TICKS(1000));

  if (!o.ok) {
    Serial.printf("Enroll failed: %s %s\n", o.reason, o.detail);
    showMessage("ADD FAILED", "FAILED", o.reason, o.detail, 6000);
    beepError();
    ledOn(RED_LED, 2000);
    enrollBusy = false;
    return;
  }

  setMapping(o.storedId, who);   // usable for scans at once
  showMessage("SAVING", "SAVING", who.substring(0, 21), "Sending to server", 0);
  bool answered = false;
  unsigned long start = millis();
  while (millis() - start < ENROLL_ACK_WAIT_MS) {
    if (xQueueReceive(ackQueue, &ack, 0) == pdTRUE && ack.jobId == job.jobId) {
      answered = true;
      break;
    }
    pauseMs(50);
  }
  if (answered && ack.httpCode == 200) {
    showMessage("FINGERPRINT ADDED", "ADDED", who.substring(0, 21), "ID " + String(o.storedId), 5000);
    beepSuccess();
    ledOn(GREEN_LED, 2000);
  } else if (answered && ack.httpCode > 0) {
    showMessage("SERVER REFUSED", "CHECK", String(ack.message).substring(0, 21), "ID " + String(o.storedId), 7000);
    beepError();
  } else {
    showMessage("SAVED ON DEVICE", "SAVED", "Server not reached", "Will retry by itself", 6000);
  }
  enrollBusy = false;
}

// Serial "enroll 7": store the finger, then the admin maps ID 7 by hand.
void runManualEnroll(int id) {
  if (id < 1 || id > 1000) {
    Serial.println("Use an ID from 1 to 1000, e.g.  enroll 7   (type  free  for the next free ID)");
    return;
  }
  if (hasMapping(id)) {
    Serial.printf("ID %d already belongs to %s. Choose another ID (type  free).\n", id, nameFor(id).c_str());
    return;
  }
  enrollBusy = true;
  EnrollOutcome o = enrollFinger((uint16_t)id, "Manual", false);
  if (o.ok) {
    if (o.storedId != (uint16_t)id) {
      Serial.printf("This finger was already saved as ID %u.\n", o.storedId);
    }
    Serial.printf("Stored as ID %u. Map it: admin → Attendance → Staff Fingerprints\n", o.storedId);
    showMessage("STORED", "ID " + String(o.storedId), "Map it in admin:", "Staff Fingerprints", 7000);
    beepSuccess();
  } else {
    Serial.printf("Enroll failed: %s %s\n", o.reason, o.detail);
    showMessage("ADD FAILED", "FAILED", o.reason, o.detail, 6000);
    beepError();
  }
  enrollBusy = false;
}

void handleEnrollJobs() {
  EnrollJob job;
  if (xQueueReceive(jobQueue, &job, 0) == pdTRUE) {
    runServerJob(job);
    waitForLift = true;          // do not clock the person in with the enrolled finger
  }
}

/* ═════════════════════════ SERIAL COMMANDS ═══════════════════════════════ */

void handleSerialCommands() {
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  if (cmd.length() == 0) return;

  if (cmd.startsWith("enroll")) {
    runManualEnroll(cmd.substring(6).toInt());
    waitForLift = true;
  } else if (cmd.startsWith("delete")) {
    int id = cmd.substring(6).toInt();
    if (id < 1 || id > 1000) { Serial.println("Usage: delete 7"); return; }
    bool ok = finger.deleteUser((uint16_t)id, 3000);
    Serial.printf("Delete ID %d on sensor: %s\n", id, ok ? "done" : "nothing stored / failed");
    if (hasMapping(id)) Serial.println("Also remove this ID in admin -> Staff Fingerprints");
    int16_t c = finger.getCount(1500);
    if (c >= 0) templateCount = c;
  } else if (cmd == "count" || cmd == "list") {
    int16_t c = finger.getCount(1500);
    if (c >= 0) templateCount = c;
    Serial.printf("Fingerprints stored on sensor: %d, names known: %d\n", c, mappingCount());
  } else if (cmd == "free") {
    Serial.printf("Next free ID (not mapped on the server): %d\n", nextFreeId());
  } else if (cmd == "test" || cmd == "status") {
    int16_t c = finger.getCount(1500);
    Serial.printf("Sensor: %s (count %d, %s)\n", c >= 0 ? "OK" : "NO REPLY", c,
                  captureWindowKnown ? "fast mode" : "legacy timing");
    Serial.printf("WiFi: %s  Server: %s  Live stream: %s  Offline saved: %d\n",
                  WiFi.status() == WL_CONNECTED ? "connected" : "down",
                  serverReachable ? "reachable" : "not reached",
                  eventStreamUp ? "up" : "down", offlineCount);
    Serial.printf("Clock: %s  Free heap: %u\n", timeValid() ? "synced" : "not synced", (unsigned)ESP.getFreeHeap());
  } else if (cmd == "empty yes") {
    bool ok = finger.deleteAll(5000);
    Serial.println(ok ? "All fingerprints deleted from the sensor" : "Delete all failed");
    if (ok) templateCount = 0;
  } else if (cmd == "empty") {
    Serial.println("This deletes EVERY fingerprint on the sensor. Type  empty yes  to confirm.");
  } else if (cmd == "wifi reset") {
    Serial.println("Forgetting WiFi and restarting into setup mode...");
    WiFiManager wm;
    wm.resetSettings();
    delay(500);
    ESP.restart();
  } else {
    Serial.println("Commands: enroll <id> | delete <id> | count | free | test | empty | wifi reset");
  }
}

/* ═════════════════════════ MAPPINGS (shared) ═════════════════════════════ */

String nameFor(int fid) {
  String name = "";
  xSemaphoreTake(mapMutex, portMAX_DELAY);
  std::map<int, String>::iterator it = fingerprintToStaff.find(fid);
  if (it != fingerprintToStaff.end()) name = it->second;
  xSemaphoreGive(mapMutex);
  return name;
}

bool hasMapping(int fid) {
  return nameFor(fid).length() > 0;
}

void setMapping(int fid, const String &name) {
  xSemaphoreTake(mapMutex, portMAX_DELAY);
  fingerprintToStaff[fid] = name;
  xSemaphoreGive(mapMutex);
}

int mappingCount() {
  xSemaphoreTake(mapMutex, portMAX_DELAY);
  int n = (int)fingerprintToStaff.size();
  xSemaphoreGive(mapMutex);
  return n;
}

int nextFreeId() {
  for (int id = 1; id <= 1000; id++) if (!hasMapping(id)) return id;
  return -1;
}

/* ═════════════════════════ SMALL HELPERS ═════════════════════════════════ */

void copyText(char *dst, size_t size, const String &src) {
  strncpy(dst, src.c_str(), size - 1);
  dst[size - 1] = 0;
}

bool timeValid() {
  return time(nullptr) > 1700000000;
}

uint32_t nowEpoch() {
  time_t t = time(nullptr);
  return t > 1700000000 ? (uint32_t)t : 0;
}

// Wait without freezing the buzzer/LEDs (and let the net task breathe).
void pauseMs(uint32_t ms) {
  unsigned long start = millis();
  while (millis() - start < ms) {
    serviceOutputs();
    delay(10);
  }
}

/* ── Buzzer & LEDs (never block the scanner) ───────────────────────────── */

void beep(uint8_t times, uint16_t onMs, uint16_t gapMs) {
  beepsLeft = times;
  beepOnMs = onMs;
  beepGapMs = gapMs;
  nextBeepAt = millis();
  serviceOutputs();
}

void ledOn(int pin, uint16_t ms) {
  digitalWrite(pin, HIGH);
  unsigned long off = millis() + ms;
  if (pin == GREEN_LED) { greenOffAt = off; digitalWrite(RED_LED, LOW); redOffAt = 0; }
  if (pin == RED_LED) { redOffAt = off; digitalWrite(GREEN_LED, LOW); greenOffAt = 0; }
}

void serviceOutputs() {
  unsigned long now = millis();
  if (buzzerOffAt && (long)(now - buzzerOffAt) >= 0) {
    digitalWrite(BUZZER_PIN, LOW);
    buzzerOffAt = 0;
    if (beepsLeft > 0) nextBeepAt = now + beepGapMs;
  }
  if (!buzzerOffAt && beepsLeft > 0 && (long)(now - nextBeepAt) >= 0) {
    digitalWrite(BUZZER_PIN, HIGH);
    buzzerOffAt = now + beepOnMs;
    beepsLeft--;
  }
  if (greenOffAt && (long)(now - greenOffAt) >= 0) { digitalWrite(GREEN_LED, LOW); greenOffAt = 0; }
  if (redOffAt && (long)(now - redOffAt) >= 0) { digitalWrite(RED_LED, LOW); redOffAt = 0; }
}

void beepSuccess() { beep(1, 90, 0); }
void beepError()   { beep(1, 450, 0); }

/* ═════════════════════════ OLED SCREENS ══════════════════════════════════ */

void drawCentered(const String &text, int y, uint8_t size) {
  display.setTextSize(size);
  int width = (int)text.length() * 6 * size;
  int x = (SCREEN_WIDTH - width) / 2;
  if (x < 0) x = 0;
  display.setCursor(x, y);
  display.print(text);
}

// Redrawn only when something on it changes (no flicker, no wasted I2C time).
void showIdle(bool force) {
  bool wifi = WiFi.status() == WL_CONNECTED;
  String status;
  if (!sensorReady) status = "SENSOR OFFLINE!";
  else if (offlineCount > 0) status = "Saved offline: " + String(offlineCount);
  else if (!wifi) status = "No WiFi - saving";
  else if (!serverTried) status = "Connecting...";
  else if (!serverReachable) status = "Server not reached";
  else status = "Online";
  String signature = status + (wifi ? "W" : "-");
  if (!force && signature == idleSignature) return;
  idleSignature = signature;
  screenIsMessage = false;
  resultFid = 0;

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print("FANA CAFE");
  display.setCursor(104, 0);
  display.print(wifi ? "WiFi" : "----");
  display.drawFastHLine(0, 10, SCREEN_WIDTH, SSD1306_WHITE);
  drawCentered("PLACE", 16, 2);
  drawCentered("FINGER", 34, 2);
  drawCentered(status, 55, 1);
  display.display();
}

// title (small, top) / big word (size 2) / two small lines. ms = 0 keeps it.
void showMessage(const String &title, const String &big, const String &line1, const String &line2, uint32_t ms) {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  if (title.length()) drawCentered(title, 0, 1);
  drawCentered(big, 14, big.length() <= 10 ? 2 : 1);
  drawCentered(line1, 38, 1);
  drawCentered(line2, 50, 1);
  display.display();
  screenIsMessage = true;
  screenUntil = millis() + (ms ? ms : 3600000UL);
}

void showVerified(uint16_t id, const String &name) {
  resultFid = id;
  String who = name.length() ? name.substring(0, 21) : "ID " + String(id);
  showMessage(who, "VERIFIED", "", name.length() ? "Recording..." : "Checking name...", RESULT_SCREEN_MS);
  resultFid = id;
}

void showResult(const ClockResult &r) {
  String big = String(r.line2);
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  drawCentered(String(r.name).substring(0, 21), 0, 1);
  display.drawFastHLine(0, 10, SCREEN_WIDTH, SSD1306_WHITE);
  drawCentered(big, big.length() <= 10 ? 18 : 22, big.length() <= 10 ? 2 : 1);
  drawCentered(String(r.line3), 44, 1);
  if (r.kind == RES_OFFLINE) drawCentered("Will send later", 55, 1);
  display.display();
  screenIsMessage = true;
  screenUntil = millis() + RESULT_SCREEN_MS;
}

// Enrollment guide: name, big instruction, hint, countdown and 6-step bar.
void showEnrollScreen(const String &who, uint16_t id, uint8_t done, const String &big, const String &hint, int secondsLeft) {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print(who.substring(0, 13));
  String idText = "ID " + String(id);
  display.setCursor(SCREEN_WIDTH - (int)idText.length() * 6, 0);
  display.print(idText);
  drawCentered(big, 12, 2);
  String line = hint;
  if (secondsLeft >= 0) line += " " + String(secondsLeft) + "s";
  drawCentered(line, 32, 1);
  drawCentered("Step " + String(done) + " of " + String(ENROLL_CAPTURES), 43, 1);
  for (uint8_t i = 0; i < ENROLL_CAPTURES; i++) {
    int x = 2 + i * 21;
    if (i < done) display.fillRect(x, 55, 18, 8, SSD1306_WHITE);
    else display.drawRect(x, 55, 18, 8, SSD1306_WHITE);
  }
  display.display();
  screenIsMessage = true;
  screenUntil = millis() + 3600000UL;
}

/* ═════════════════════════ NETWORK TASK (core 0) ═════════════════════════ */

void netTask(void *arg) {
  (void)arg;
  for (;;) {
    netStep();
    delay(20);
  }
}

void netStep() {
  bool wifiUp = WiFi.status() == WL_CONNECTED;
  if (wifiUp != wifiWasUp) {
    wifiWasUp = wifiUp;
    Serial.println(wifiUp ? "WiFi up" : "WiFi down");
    stopEventStream();
    apiTls.stop();
    if (wifiUp) {
      lastOfflineSync = 0;           // send saved scans right away
      lastMappingRefresh = 0;
      lastPendingCheck = 0;
    } else {
      serverReachable = false;
    }
  }

  ClockEvent ev;
  if (!wifiUp) {
    // No WiFi: every scan goes straight to the offline file.
    while (xQueueReceive(clockQueue, &ev, 0) == pdTRUE) {
      appendOffline(ev);
      pushResult(ev.fid, RES_OFFLINE, nameFor(ev.fid), "SAVED", "No WiFi");
    }
    if (millis() - lastWifiKick > 30000) {
      lastWifiKick = millis();
      WiFi.reconnect();
    }
    return;
  }

  // 1) Scans first - they are what people wait for.
  while (xQueueReceive(clockQueue, &ev, 0) == pdTRUE) {
    if (offlineCount > 0) {
      appendOffline(ev);             // keep the order: older saved scans go first
      syncOfflineQueue();
    } else if (postClock(ev.fid, ev.epoch, false, true) == POST_RETRY) {
      appendOffline(ev);
      pushResult(ev.fid, RES_OFFLINE, nameFor(ev.fid), "SAVED", "Server not reached");
    }
  }

  // 2) Enrollment results (mapping back to the website).
  handleEnrollReports();

  // 3) Real-time stream from the server (Add Fingerprint / mapping changed).
  if (eventStreamActive) {
    pumpEventStream();
    if (eventStreamActive && millis() - lastEventStreamData > EVENT_STREAM_STALL_MS) {
      Serial.println("Event stream stalled, reconnecting");
      stopEventStream();
    }
  } else if (millis() - lastEventStreamTry > eventStreamRetryMs && uxQueueMessagesWaiting(clockQueue) == 0) {
    startEventStream();
  }
  if (!eventStreamActive && millis() - lastPendingCheck > PENDING_POLL_FALLBACK_MS) {
    lastPendingCheck = millis();
    checkPendingJob();
  }

  // 4) Housekeeping.
  if (offlineCount > 0 && millis() - lastOfflineSync > OFFLINE_SYNC_MS) {
    lastOfflineSync = millis();
    syncOfflineQueue();
  }
  if (lastMappingRefresh == 0 || millis() - lastMappingRefresh > MAPPING_REFRESH_MS) {
    lastMappingRefresh = millis();
    if (!loadMappingsFromServer()) lastMappingRefresh = millis() - MAPPING_REFRESH_MS + 60000; // retry in 1 min
  }
}

void addDeviceHeaders(HTTPClient &http) {
  if (deviceToken.length() > 0) http.addHeader("x-attendance-device", deviceToken);
}

bool apiBegin(const String &path) {
  String url = serverURL + path;
  bool ok = serverURL.startsWith("https://") ? api.begin(apiTls, url) : api.begin(apiPlain, url);
  if (!ok) return false;
  api.setReuse(true);          // keep the TLS connection open between calls
  api.setConnectTimeout(6000);
  api.setTimeout(8000);
  addDeviceHeaders(api);
  return true;
}

// One API call on the shared keep-alive connection. A connection the server
// closed while idle fails fast; we then reconnect once.
int apiRequest(bool post, const String &path, const String &body, String *response) {
  int code = -1;
  for (int attempt = 0; attempt < 2; attempt++) {
    if (!apiBegin(path)) return -1;
    if (post) {
      api.addHeader("Content-Type", "application/json");
      code = api.POST(body);
    } else {
      code = api.GET();
    }
    if (code > 0) {
      if (response) *response = api.getString();
      api.end();
      serverReachable = code < 500;
      serverTried = true;
      return code;
    }
    Serial.printf("HTTP %s failed: %s\n", path.c_str(), api.errorToString(code).c_str());
    api.end();
    apiTls.stop();
    apiPlain.stop();
  }
  serverReachable = false;
  serverTried = true;
  return code;
}

void pushResult(uint16_t fid, uint8_t kind, const String &name, const String &line2, const String &line3) {
  ClockResult r;
  memset(&r, 0, sizeof(r));
  r.fid = fid;
  r.kind = kind;
  copyText(r.name, sizeof(r.name), name.length() ? name : "ID " + String(fid));
  copyText(r.line2, sizeof(r.line2), line2);
  copyText(r.line3, sizeof(r.line3), line3);
  xQueueSend(resultQueue, &r, 0);
}

// Record one scan. POST_RETRY = network/server trouble, keep it for later.
// A 4xx answer is final (e.g. finger not mapped) and is never re-sent.
PostOutcome postClock(uint16_t fid, uint32_t epoch, bool fromQueue, bool reportToScreen) {
  DynamicJsonDocument doc(256);
  doc["fingerprintId"] = fid;
  doc["deviceId"] = deviceId;
  doc["method"] = "fingerprint";
  if (epoch > 0) doc["scannedAt"] = epoch;   // real scan time (server checks it)
  if (fromQueue) doc["offline"] = true;
  String body;
  serializeJson(doc, body);

  String response;
  int code = apiRequest(true, "/api/attendance/clock", body, &response);
  if (code <= 0 || code >= 500) return POST_RETRY;

  DynamicJsonDocument res(1024);
  deserializeJson(res, response);
  String name = res["memberName"] | "";
  if (name.length() == 0) name = String((const char *)(res["staffName"] | ""));
  if (name.length() == 0) name = nameFor(fid);

  if (code == 200) {
    String action = res["action"] | "";
    String line2 = res["oled"]["line2"] | "";
    String line3 = res["oled"]["line3"] | "";
    uint8_t kind = RES_ALREADY;
    if (action == "clock_in") kind = RES_IN;
    else if (action == "clock_out") kind = RES_OUT;
    if (line2.length() == 0) line2 = String((const char *)(res["message"] | "Recorded"));
    Serial.printf("Clock ID %u -> %s\n", fid, action.c_str());
    if (reportToScreen) pushResult(fid, kind, name, line2, line3);
  } else {
    String error = res["error"] | "Refused";
    Serial.printf("Clock ID %u refused (%d): %s\n", fid, code, error.c_str());
    if (reportToScreen) {
      if (code == 404) pushResult(fid, RES_NOT_ON_SERVER, name, "NOT ADDED", "Ask admin to map ID " + String(fid));
      else pushResult(fid, RES_ERROR, name, "ERROR", error.substring(0, 21));
    }
  }
  return POST_DONE;
}

/* ── Offline queue (LittleFS, one JSON line per scan) ───────────────────── */

void appendOffline(const ClockEvent &ev) {
  DynamicJsonDocument doc(128);
  doc["f"] = ev.fid;
  doc["t"] = ev.epoch;
  doc["m"] = ev.ms;
  doc["b"] = bootId;
  String line;
  serializeJson(doc, line);
  xSemaphoreTake(fsMutex, portMAX_DELAY);
  File f = LittleFS.open("/queue.json", "a");
  if (f) {
    f.println(line);
    f.close();
    offlineCount++;
  }
  xSemaphoreGive(fsMutex);
  Serial.printf("Saved offline: ID %u (%d waiting)\n", ev.fid, offlineCount);
}

int countOfflineLines() {
  int n = 0;
  xSemaphoreTake(fsMutex, portMAX_DELAY);
  const char *files[2] = {"/queue.sending", "/queue.json"};
  for (int i = 0; i < 2; i++) {
    if (!LittleFS.exists(files[i])) continue;
    File f = LittleFS.open(files[i], "r");
    while (f && f.available()) {
      String line = f.readStringUntil('\n');
      line.trim();
      if (line.length()) n++;
    }
    if (f) f.close();
  }
  xSemaphoreGive(fsMutex);
  return n;
}

// Scans saved before the clock was synced get their time back from millis().
uint32_t resolveEpoch(uint32_t epoch, uint32_t ms, uint32_t boot) {
  if (epoch > 0) return epoch;
  if (boot == bootId && timeValid()) {
    uint32_t age = (millis() - ms) / 1000;
    return nowEpoch() - age;
  }
  return 0;
}

// Send saved scans oldest-first. Stops at the first network failure so the
// order is kept; new scans keep appending to /queue.json meanwhile.
void syncOfflineQueue() {
  xSemaphoreTake(fsMutex, portMAX_DELAY);
  if (!LittleFS.exists("/queue.sending") && LittleFS.exists("/queue.json")) {
    LittleFS.rename("/queue.json", "/queue.sending");
  }
  bool haveWork = LittleFS.exists("/queue.sending");
  String lines = "";
  if (haveWork) {
    File f = LittleFS.open("/queue.sending", "r");
    if (f) { lines = f.readString(); f.close(); }
  }
  xSemaphoreGive(fsMutex);
  if (!haveWork) { offlineCount = countOfflineLines(); return; }

  String unsent = "";
  bool stop = false;
  int sent = 0;
  int pos = 0;
  while (pos < (int)lines.length()) {
    int nl = lines.indexOf('\n', pos);
    if (nl < 0) nl = lines.length();
    String line = lines.substring(pos, nl);
    pos = nl + 1;
    line.trim();
    if (line.length() == 0) continue;
    if (stop) { unsent += line + "\n"; continue; }
    DynamicJsonDocument doc(160);
    if (deserializeJson(doc, line)) continue;          // damaged line: drop
    uint16_t fid = doc["f"].as<uint16_t>();
    if (fid == 0) continue;
    uint32_t ms = doc["m"].as<uint32_t>();     // as<uint32_t>: values above 2^31 stay intact
    uint32_t boot = doc["b"].as<uint32_t>();
    uint32_t epoch = resolveEpoch(doc["t"].as<uint32_t>(), ms, boot);
    bool fresh = boot == bootId && millis() - ms < 20000;   // the person may still be at the door
    if (postClock(fid, epoch, !fresh, fresh) == POST_RETRY) {
      stop = true;
      unsent += line + "\n";
      if (fresh) pushResult(fid, RES_OFFLINE, nameFor(fid), "SAVED", "Server not reached");
    } else {
      sent++;
    }
  }

  xSemaphoreTake(fsMutex, portMAX_DELAY);
  String newer = "";
  if (LittleFS.exists("/queue.json")) {
    File f = LittleFS.open("/queue.json", "r");
    if (f) { newer = f.readString(); f.close(); }
  }
  String rest = unsent + newer;
  if (rest.length() > 0) {
    File out = LittleFS.open("/queue.json", "w");
    if (out) { out.print(rest); out.close(); }
  } else {
    LittleFS.remove("/queue.json");
  }
  LittleFS.remove("/queue.sending");
  xSemaphoreGive(fsMutex);
  offlineCount = countOfflineLines();
  if (sent > 0) Serial.printf("Offline sync: %d sent, %d waiting\n", sent, offlineCount);
}

/* ── Mappings (fingerprint ID -> name) ─────────────────────────────────── */

bool parseMappings(const String &json, bool saveToCache) {
  StaticJsonDocument<32> filter;
  filter["simpleMap"] = true;   // ignore the big "mappings" array (saves RAM)
  DynamicJsonDocument doc(MAPPING_DOC_BYTES);
  DeserializationError err = deserializeJson(doc, json, DeserializationOption::Filter(filter));
  if (err) {
    Serial.printf("Mappings parse error: %s\n", err.c_str());
    return false;
  }
  std::map<int, String> fresh;
  JsonObject simpleMap = doc["simpleMap"].as<JsonObject>();
  for (JsonPair kv : simpleMap) {
    int fid = atoi(kv.key().c_str());
    if (fid > 0) fresh[fid] = kv.value().as<String>();
  }
  xSemaphoreTake(mapMutex, portMAX_DELAY);
  fingerprintToStaff.swap(fresh);
  xSemaphoreGive(mapMutex);

  if (saveToCache) {
    String compact;
    serializeJson(doc, compact);
    xSemaphoreTake(fsMutex, portMAX_DELAY);
    File f = LittleFS.open("/mappings.json", "w");
    if (f) { f.print(compact); f.close(); }
    xSemaphoreGive(fsMutex);
  }
  return true;
}

bool loadMappingsFromServer() {
  String response;
  int code = apiRequest(false, "/api/attendance/mappings", "", &response);
  if (code != 200) return false;
  if (!parseMappings(response, true)) return false;
  lastMappingRefresh = millis();
  Serial.printf("Loaded %d names from server\n", mappingCount());
  return true;
}

void loadMappingsFromCache() {
  String json = "";
  xSemaphoreTake(fsMutex, portMAX_DELAY);
  if (LittleFS.exists("/mappings.json")) {
    File f = LittleFS.open("/mappings.json", "r");
    if (f) { json = f.readString(); f.close(); }
  }
  xSemaphoreGive(fsMutex);
  if (json.length() && parseMappings(json, false)) {
    Serial.printf("Loaded %d names from offline cache\n", mappingCount());
  }
}

/* ── "Add Fingerprint" jobs from the website ───────────────────────────── */

bool jobHandled(int32_t jobId) {
  for (uint8_t i = 0; i < 8; i++) if (handledJobs[i] == jobId) return true;
  return false;
}

void markJobHandled(int32_t jobId) {
  handledJobs[handledJobsNext] = jobId;
  handledJobsNext = (handledJobsNext + 1) % 8;
}

void checkPendingJob() {
  if (enrollBusy || uxQueueMessagesWaiting(jobQueue) > 0) return;
  String response;
  int code = apiRequest(false, "/api/attendance/biometrics?pending=1", "", &response);
  if (code != 200) return;
  DynamicJsonDocument doc(4096);
  if (deserializeJson(doc, response)) return;
  JsonArray jobs = doc["jobs"].as<JsonArray>();
  for (JsonObject j : jobs) {
    EnrollJob job;
    memset(&job, 0, sizeof(job));
    job.jobId = j["jobId"] | 0;
    job.memberId = j["memberId"] | 0;
    job.fid = j["fingerprintId"] | 0;
    copyText(job.name, sizeof(job.name), String((const char *)(j["memberName"] | "Member")));
    if (job.jobId <= 0 || job.fid == 0 || job.fid > 1000 || jobHandled(job.jobId)) continue;
    markJobHandled(job.jobId);
    loadMappingsFromServer();    // fresh names, so "already saved" checks are right
    Serial.printf("Website asks: add finger for %s as ID %u (job %ld)\n", job.name, job.fid, (long)job.jobId);
    xQueueSend(jobQueue, &job, 0);
    return;
  }
}

int sendEnrollReport(const EnrollReport &r, String &message) {
  DynamicJsonDocument doc(512);
  String path;
  if (r.ok) {
    path = "/api/attendance/mappings";
    doc["fingerprintId"] = r.fid;
    doc["memberId"] = r.memberId;
    doc["memberName"] = r.name;
    doc["staffName"] = r.name;
    doc["jobId"] = r.jobId;
    doc["deviceId"] = deviceId;
  } else {
    path = "/api/attendance/biometrics";
    doc["action"] = "device_failed";
    doc["jobId"] = r.jobId;
    doc["reason"] = r.reason;
    doc["deviceId"] = deviceId;
  }
  String body;
  serializeJson(doc, body);
  String response;
  int code = apiRequest(true, path, body, &response);
  DynamicJsonDocument res(512);
  message = "";
  if (code > 0 && !deserializeJson(res, response)) {
    message = String((const char *)(res["error"] | ""));
    if (message.length() == 0) message = String((const char *)(res["message"] | ""));
  }
  Serial.printf("Enroll report (%s) -> HTTP %d %s\n", r.ok ? "added" : "failed", code, message.c_str());
  return code;
}

void handleEnrollReports() {
  EnrollReport r;
  bool fresh = xQueueReceive(reportQueue, &r, 0) == pdTRUE;
  if (!fresh) {
    if (!havePendingReport || millis() - pendingReportAt < REPORT_RETRY_MS) return;
    r = pendingReport;           // retry a mapping the server did not get yet
  }
  if (r.jobId <= 0) return;      // manual Serial enrollment: nothing to report
  String message;
  int code = sendEnrollReport(r, message);
  bool networkTrouble = code <= 0 || code >= 500;
  if (fresh) {
    EnrollAck ack;
    memset(&ack, 0, sizeof(ack));
    ack.jobId = r.jobId;
    ack.httpCode = (int16_t)code;
    copyText(ack.message, sizeof(ack.message), message);
    xQueueSend(ackQueue, &ack, 0);
  }
  if (networkTrouble && r.ok) {
    if (fresh) { pendingReport = r; pendingReportTries = 0; }
    havePendingReport = ++pendingReportTries <= 30;   // ~10 minutes of retries
    pendingReportAt = millis();
  } else if (!fresh || r.ok) {
    havePendingReport = false;
  }
}

/* ── Real-time event stream (SSE) ──────────────────────────────────────── */

void stopEventStream() {
  if (eventStreamActive) Serial.println("Event stream disconnected");
  eventStreamActive = false;
  eventStreamUp = false;
  eventStream = nullptr;
  eventLine = "";
  streamHttp.end();
  streamTls.stop();
  lastEventStreamTry = millis();
}

void startEventStream() {
  stopEventStream();
  String url = serverURL + "/api/attendance/events?channel=device";
  bool ok = serverURL.startsWith("https://") ? streamHttp.begin(streamTls, url) : streamHttp.begin(streamPlain, url);
  if (!ok) return;
  streamHttp.addHeader("Accept", "text/event-stream");
  addDeviceHeaders(streamHttp);
  streamHttp.setConnectTimeout(6000);
  streamHttp.setTimeout(6000);
  int code = streamHttp.GET();
  if (code == 200) {
    eventStream = streamHttp.getStreamPtr();
    eventStreamActive = true;
    eventStreamUp = true;
    lastEventStreamData = millis();
    eventStreamRetryMs = 5000;
    Serial.println("Real-time event stream connected");
    // Catch up on anything that happened while the stream was down.
    loadMappingsFromServer();
    checkPendingJob();
  } else {
    Serial.printf("Event stream connect failed, HTTP %d\n", code);
    streamHttp.end();
    eventStreamActive = false;
    eventStreamRetryMs = eventStreamRetryMs * 2 > 60000UL ? 60000UL : eventStreamRetryMs * 2;
  }
  lastEventStreamTry = millis();
}

void pumpEventStream() {
  if (!eventStreamActive || eventStream == nullptr) return;
  if (!eventStream->connected()) {
    stopEventStream();
    return;
  }
  bool gotEvent = false;
  int budget = 512;
  while (eventStream->available() > 0 && budget-- > 0) {
    char c = (char)eventStream->read();
    lastEventStreamData = millis();
    if (c == '\n') {
      if (eventLine.startsWith("data:")) gotEvent = true;
      eventLine = "";
    } else if (c != '\r' && eventLine.length() < 120) {
      eventLine += c;
    }
  }
  if (gotEvent) {
    Serial.println("Server event: refreshing names and jobs");
    loadMappingsFromServer();
    checkPendingJob();
  }
}

/* ═════════════════════════ LOCAL STATUS PAGE (read-only) ═════════════════ */

void handleRoot() {
  String html = "<h1>FANA CAFE Attendance</h1>";
  html += "<p>Device: " + deviceId + "</p>";
  html += "<p>Sensor: " + String(sensorReady ? "online" : "OFFLINE") + "</p>";
  html += "<p>Fingerprints on sensor: " + String(templateCount) + "</p>";
  html += "<p>Server: " + String(serverReachable ? "reachable" : "not reached") + "</p>";
  html += "<p>Scans waiting to send: " + String(offlineCount) + "</p>";
  html += "<p><a href='/status'>Status JSON</a></p>";
  server.send(200, "text/html", html);
}

void handleStatus() {
  DynamicJsonDocument doc(384);
  doc["deviceId"] = deviceId;
  doc["ip"] = WiFi.localIP().toString();
  doc["sensorReady"] = sensorReady;
  doc["fastMode"] = captureWindowKnown;
  doc["templates"] = templateCount;
  doc["wifi"] = WiFi.status() == WL_CONNECTED;
  doc["server"] = (bool)serverReachable;
  doc["liveStream"] = (bool)eventStreamUp;
  doc["offlineQueued"] = (int)offlineCount;
  doc["clockSynced"] = timeValid();
  doc["names"] = mappingCount();
  String json;
  serializeJson(doc, json);
  server.send(200, "application/json", json);
}
