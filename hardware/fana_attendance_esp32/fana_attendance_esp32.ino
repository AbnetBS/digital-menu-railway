/*
 * FANA CAFE & RESTAURANT - Attendance System
 * GitHub: hardware/fana_attendance_esp32/fana_attendance_esp32.ino (keep updated here for copy-paste upload)
 * Hardware: ESP32 WROOM + FPC1020A fingerprint sensor + 20x4 I2C LCD
 *           + transistor-driven buzzer + 2 LEDs
 *
 * FINGERPRINT SENSOR: 4 WIRES ARE ENOUGH
 *   Sensor label   ->  ESP32
 *   VCC  (pin 4)   ->  3.3V   (use 5V only if your module is marked 5V - see README)
 *   GND  (pin 1)   ->  GND
 *   TX   (pin 3)   ->  GPIO16 (ESP32 RX2)
 *   RX   (pin 2)   ->  GPIO17 (ESP32 TX2)
 *   Leave sensor pins 5 and 6 (the extra pins) unconnected. This sketch does
 *   not use them: the sensor itself reports when a finger is on it.
 *
 * 20x4 LCD (2004 module with a soldered I2C backpack) - THROUGH THE LEVEL SHIFTER
 *   ESP32 3V3        ->  level shifter LV
 *   Regulated 5 V    ->  level shifter HV   AND   LCD backpack VCC
 *   ESP32 GPIO21     ->  level shifter A1   ->  B1 ->  LCD backpack SDA
 *   ESP32 GPIO22     ->  level shifter A2   ->  B2 ->  LCD backpack SCL
 *   All GNDs together (LV side, HV side, LCD, ESP32).
 *   Channels 3 and 4 stay unused.
 *   NEVER wire the backpack's SDA/SCL straight to the ESP32: the backpack is a
 *   5 V device and its pull-ups put 5 V on the ESP32 pin. That is what the
 *   shifter is for. The sketch talks to the LCD with 3.3 V logic on the LV
 *   side (A1/A2) and assumes nothing about the backpack's I2C address: the
 *   hd44780 library finds it (0x27, 0x3F, 0x20, ...) during setup and the
 *   address it used is printed on the Serial Monitor.
 *   If the blue contrast pot is not set right the screen shows blank blocks
 *   with the backlight on - that is a contrast problem, not a wiring problem.
 *
 * BUZZER (on a transistor, NOT straight from the pin)
 *   GPIO23 -> 1 kohm -> 2N2222 base, 10 kohm from base to GND
 *   Buzzer + -> 5 V, buzzer - -> collector, emitter -> GND
 *   Magnetic buzzer only: 1N4007 across the buzzer, striped end to +5 V.
 *   Verify the transistor's pinout and the buzzer's voltage/type first.
 *   The level shifter is NOT the buzzer driver.
 *   This sketch drives GPIO23 HIGH/LOW, which suits an ACTIVE buzzer. For a
 *   PASSIVE buzzer uncomment BUZZER_IS_PASSIVE below (see the README check).
 *
 * OTHER WIRES
 *   Green LED -> GPIO18 -> 220 ohm -> GND
 *   Red LED   -> GPIO19 -> 220 ohm -> GND
 *
 * Libraries (Arduino Library Manager + one custom copy):
 *   - Biovo1020A PATCHED copy - install hardware/fana_attendance_esp32/libraries/Biovo1020A
 *   - hd44780 by Bill Perry  - the 20x4 I2C LCD (REPLACES Adafruit SSD1306/GFX)
 *   - WiFiManager by tzapu, ArduinoJson (v6)
 * Sensor UART: 19200 baud, 8N1.
 *
 * WHAT HAPPENS
 *   Scan:   the finger is matched and "VERIFIED" shows at once; the website
 *           answers in about one or two seconds (IN / OUT / late / not
 *           registered). The device then returns to "Place finger". One
 *           placement = one scan, however long the finger stays on the sensor.
 *   Add:    the admin presses Add Fingerprint on the website. The LCD shows
 *           the name and guides the captures: PLACE FINGER once, then KEEP
 *           STILL while the same finger is read five more times. Between the
 *           six ADD steps the sketch sends the sensor NOTHING else - any
 *           other command mid-enrollment makes the module refuse the next
 *           step. Every wait has a timeout, so the device never hangs. A
 *           failed job is reported back to the website and is not retried in
 *           a loop.
 *   Manual: Serial "enroll <id>" stores a finger; map it in admin afterwards.
 *
 * Setup:
 *   1. Install the libraries above.
 *   2. Board: ESP32 Dev Module. Upload this sketch.
 *   3. First boot: join WiFi "Fana-Attendance-Setup" (password fana12345) and
 *      enter the restaurant WiFi.
 */

#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Biovo1020A.h>
#include <map>
#include <LittleFS.h>
#include <WebServer.h>
/* 20x4 I2C LCD. hd44780 is the library: it finds the backpack's I2C address
 * and its expander chip by itself, so this sketch assumes neither. The i/o
 * class lives in a sub-folder - both includes are required, and Wire.h must be
 * included too (hd44780's i/o class headers do not pull it in themselves).
 * NOTE: the hd44780 class deliberately has NO println() - it is a compile
 * error there. Use print() (this sketch always does). */
#include <Wire.h>
#include <hd44780.h>
#include <hd44780ioClass/hd44780_I2Cexp.h>

/* ── Pins and display ─────────────────────────────────────────────────────── */
#define LCD_COLS      20   // 2004 module: 20 characters per row
#define LCD_ROWS      4    // ... and 4 rows
#define LCD_SDA_PIN   21   // level shifter A1 -> B1 -> backpack SDA
#define LCD_SCL_PIN   22   // level shifter A2 -> B2 -> backpack SCL
#define ENROLL_SCANS  6    // the LCD progress bar has one cell per capture
#define BUZZER_PIN    23
#define GREEN_LED     18
#define RED_LED       19
#define SENSOR_RX_PIN 16 // ESP32 receives here, from sensor TX (pin 3)
#define SENSOR_TX_PIN 17 // ESP32 sends here, to sensor RX (pin 2)

/* The library auto-locates the backpack (0x27, 0x3F, 0x20, 0x38, ...) and
 * auto-configures its PCF8574 / MCP23008. Leave the next line commented: the
 * address is then found, never assumed. If the diagnostic (see
 * diagnostics/lcd_check/lcd_check.ino) reports one address and you want the
 * sketch pinned to it, uncomment the line and put that address in.
 * hd44780_I2Cexp lcd(LCD_I2C_ADDRESS); // ... and define it as e.g. 0x27 */
// #define LCD_I2C_ADDRESS 0x27
#ifdef LCD_I2C_ADDRESS
hd44780_I2Cexp lcd(LCD_I2C_ADDRESS);
#else
hd44780_I2Cexp lcd;   // auto-locate + auto-configure: no address is assumed
#endif
bool lcdReady = false;

/* True while a six-capture enrollment is running (the Serial command and the
 * website job both set it). The LCD is never re-initialized mid-enrollment. */
bool enrollmentActive = false;
/* Clears that flag on every return path of a function that sets it. */
struct EnrollmentGuard {
  EnrollmentGuard() { enrollmentActive = true; }
  ~EnrollmentGuard() { enrollmentActive = false; }
};

HardwareSerial mySerial(2);
Biovo1020A finger(mySerial);
WebServer server(80);

/* ── Timing (milliseconds) ────────────────────────────────────────────────── */
#define SENSOR_POLL_MS          1500  // one fingerprint check waits at most this long
#define SERVER_TIMEOUT_MS       4000  // never wait longer than this for the website
#define RESULT_SHOW_MS          1500  // a normal result stays on the LCD this long
#define WARNING_SHOW_MS         2500  // a problem stays on the LCD this long
#define ENROLL_NO_FINGER_MS     30000 // give up after this long without any finger
#define ENROLL_PLACE_SETTLE_MS  2500  // fresh placement: settle time before an ADD command
#define ENROLL_KEEP_SETTLE_MS   600   // kept finger: settle time before the next ADD
#define ENROLL_LIFT_PAUSE_MS    2500  // "lift, place again" pause (no sensor command)
#define ENROLL_ADD_TIMEOUT_MS   30000 // one ADD command may wait this long for a finger
#define ENROLL_MAX_ATTEMPTS     6     // attempts allowed per capture
#define ENROLL_HOLD_STILL_AT    3     // unclear images before "lift and place again"
#define ENROLL_MAX_UNCLEAR      6     // unclear images allowed per capture
#define ENROLL_MAX_SESSIONS     3     // whole six-scan attempts before the job fails
#define ENROLL_LIFT_BUDGET_MS   20000 // how long "LIFT YOUR FINGER" may wait
#define ENROLL_SENSE_MS         1200  // one "is the glass empty?" SEARCH waits this long
#define ENROLL_TOTAL_BUDGET_MS  120000 // the whole job gives up after this long
#define MAPPING_RETRY_MS        10000 // retry a mapping the website did not get yet
#define PENDING_POLL_FALLBACK_MS 15000
#define EVENT_STREAM_STALL_MS   75000

/* ── Types (declared first so the Arduino IDE can build its prototypes) ──── */
enum EnrollResult : uint8_t {
  ENROLL_OK,
  ENROLL_NO_FINGER,
  ENROLL_UNCLEAR,
  ENROLL_LIFT_TIMEOUT,
  ENROLL_ID_IN_USE,
  ENROLL_SENSOR_FULL,
  ENROLL_SENSOR_ERROR,
  ENROLL_FAILED
};

/* ── Configuration ────────────────────────────────────────────────────────── */
String serverURL = "https://fanacafe.com.et";
String deviceId = "entrance";
// Leave empty unless the owner sets ATTENDANCE_DEVICE_TOKEN on the server.
// If he does, paste the same value here so the device is allowed to call in.
String deviceToken = "";

// FPC1020A status codes. The patched library defines these too; the #ifndef
// guards keep the sketch compiling with the original library.
#ifndef BIOVO_ACK_NOUSER
#define BIOVO_ACK_NOUSER     0x05 // search: finger seen, not enrolled
#endif
#ifndef BIOVO_ACK_IMAGEMESS
#define BIOVO_ACK_IMAGEMESS  0x06 // image too unclear to use
#endif
#ifndef BIOVO_ACK_USER_EXIST
#define BIOVO_ACK_USER_EXIST 0x07 // enroll: this ID already has a finger
#endif
#ifndef BIOVO_ACK_TIMEOUT
#define BIOVO_ACK_TIMEOUT    0x08 // search: no finger
#endif
#ifndef BIOVO_ACK_FULL
#define BIOVO_ACK_FULL       0x04 // database full
#endif
#ifndef BIOVO_ACK_GO_OUT
#define BIOVO_ACK_GO_OUT     0x0F // finger lifted
#endif
#ifndef BIOVO_ACK_COMM_ERROR
#define BIOVO_ACK_COMM_ERROR 0xFE // garbled reply
#endif
#ifndef BIOVO_ACK_NO_RESPONSE
#define BIOVO_ACK_NO_RESPONSE 0xFF // no reply at all
#endif

/* ── State ────────────────────────────────────────────────────────────────── */
bool sensorReady = false;
int templateCount = -1;

// One scan per placement: after a finger is reported, nothing else is reported
// until the sensor says the finger is gone. A finger left on the glass for
// minutes therefore clocks once and shows one message.
bool awaitingFingerLift = false;

// fingerprintId -> staff name, from the website (refreshed in real time).
std::map<int, String> fingerprintToStaff;

// Add Fingerprint jobs: a job is attempted once. A job that failed is reported
// to the website and never retried by this device, so it cannot loop.
bool enrollingFromServer = false;
int lastHandledJobId = 0;

// The exact reason for the outcome of the last enrollment, for the Serial log
// and for the website ("scan 2/6 not accepted: image unclear (status 6)").
// The admin page prints it, so a failure is never a silent spinner again.
String enrollDetail = "";

// A finger was enrolled on the sensor but the website did not get the mapping
// yet (no internet). The device keeps sending it until the website accepts it.
bool mappingPending = false;
int mapFingerprintId = 0;
int mapMemberId = 0;
String mapMemberName = "";
unsigned long mapNextTryMs = 0;

// Real-time event stream (Server-Sent Events) from /api/attendance/events.
HTTPClient eventHttp;
WiFiClient *eventStream = nullptr;
bool eventStreamActive = false;
unsigned long lastEventStreamTry = 0;
unsigned long lastEventStreamData = 0;
unsigned long eventStreamRetryMs = 5000;
unsigned long lastPendingCheck = 0;
String eventLine = "";

/* ── Prototypes ───────────────────────────────────────────────────────────── */
void showLines(const String &l1, const String &l2, const String &l3, const String &l4);
void showBig(const String &top, const String &big, const String &bottom);
void showEnrollScreen(const String &who, int id, uint8_t done, const String &prompt, const String &hint);
void showIdleScreen();
bool startLcd();
void checkLcdHealth();
void beepSuccess();
void beepError();
bool detectSensor(uint8_t tries);
bool sensorAnswers();
int glassHasFinger();
bool freeLeftoverTemplate(int id);
bool waitGlassEmpty(const String &who, int id, uint32_t budgetMs);
EnrollResult runCaptureSession(int id, const String &who, uint32_t deadlineMs);
EnrollResult enrollFingerprint(int id, const String &who);
const char *enrollReason(EnrollResult result);
void scanForFinger();
void handleVerifiedFinger(int fingerprintId);
int postClock(int fingerprintId, String &body);
void showClockAnswer(const String &fallbackName, const String &body);
void showRefused(const String &name, const String &body);
void showSensorWarning(const String &title, const String &line2, const String &line3);
bool checkPendingEnroll();
int postMappingToServer(int fingerprintId, int memberId, const String &memberName);
void reportJobStarted(int jobId, int fingerprintId);
void reportJobFailed(int jobId, const String &reason);
void retryPendingMapping();
void keepServerLinkAlive();
void stopEventStream();
void startEventStream();
void pumpEventStream();
void loadMappingsFromServer();
void saveToQueue(int fingerprintId, const String &staffName);
void syncOfflineQueue();
void periodicSync();
void handleSerialCommand();
void manualEnroll(int id);
void checkSensorHealth();
void emptyDatabase();
void listFingerprints();
void testSensor();
void handleRoot();
void handleStatus();
void addDeviceHeaders(HTTPClient &http);
const char *fingerStatusText(uint8_t s);

/* ── Setup and loop ───────────────────────────────────────────────────────── */
void setup() {
  Serial.begin(115200);
  Serial.println("\n\nFANA CAFE Attendance - FPC1020A + ESP32 WROOM");

  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(GREEN_LED, LOW);
  digitalWrite(RED_LED, LOW);

  // 20x4 I2C LCD on GPIO21/22, behind the level shifter (A1/A2 -> B1/B2).
  // The 100 kHz clock is what the backpack and the shifter like.
  Wire.begin(LCD_SDA_PIN, LCD_SCL_PIN);
  Wire.setClock(100000);
  startLcd();
  showLines("FANA CAFE", "Attendance", "Starting...", "");

  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS mount failed");
  }

  // Sensor: 19200 8N1 is the FPC1020A default. It can be slow to boot.
  mySerial.begin(19200, SERIAL_8N1, SENSOR_RX_PIN, SENSOR_TX_PIN);
  delay(500);
  finger.begin();
  delay(300);

  sensorReady = detectSensor(5);
  if (sensorReady) {
    Serial.print("Found FPC1020A fingerprint sensor, templates: ");
    Serial.println(templateCount);
    showLines("FPC1020A Found!", "Templates: " + String(templateCount), "", "");
    beepSuccess();
    delay(1000);
  } else {
    Serial.println("Did not find fingerprint sensor. Check wiring: TX->16 RX->17, GND, VCC, baud 19200.");
    showLines("FPC1020A NOT found", "Check wiring:", "TX->16  RX->17", "GND + VCC");
    beepError();
    delay(3000);
    // checkSensorHealth() keeps looking every 5 s, so a late sensor still works.
  }

  // WiFiManager: first boot creates the hotspot "Fana-Attendance-Setup".
  WiFiManager wm;
  // wm.resetSettings(); // Uncomment once to forget the WiFi, then upload again.
  bool connected = wm.autoConnect("Fana-Attendance-Setup", "fana12345");
  if (!connected) {
    Serial.println("Failed to connect WiFi");
    showLines("WiFi Failed", "Restarting...", "", "");
    delay(3000);
    ESP.restart();
  }
  Serial.print("WiFi connected, IP: ");
  Serial.println(WiFi.localIP());
  showLines("WiFi Connected!", WiFi.localIP().toString(), "", "");
  delay(1500);

  loadMappingsFromServer();

  // Local web page: status only. Enrolling and listing stay on the admin site
  // and the Serial monitor, so nobody on the WiFi can change fingerprints.
  server.on("/status", handleStatus);
  server.on("/", handleRoot);
  server.begin();
  Serial.println("Local status page started");

  showIdleScreen();
}

void loop() {
  server.handleClient();
  keepServerLinkAlive();
  checkSensorHealth();
  checkLcdHealth();
  if (sensorReady) scanForFinger();
  retryPendingMapping();
  periodicSync();
  handleSerialCommand();
  delay(5);
}

/* ── 20x4 LCD helpers ─────────────────────────────────────────────────────── *
 * The screen is 20 characters wide and 4 rows tall, so every row is written
 * as EXACTLY 20 characters: a shorter line is padded with spaces, which wipes
 * whatever was there before. A row is only re-sent to the LCD when its text
 * really changed, and lcd.clear() runs once (in startLcd()), so the screen
 * never flickers while it is being updated.
 * Layout used by this sketch:
 *   idle        FANA CAFE Attendance / Place finger / Online|Offline / Templates
 *   result      name / big word / (continuation) / note
 *   enrollment  Enroll <who> / ID n [######] k/6 / instruction / hint
 * ------------------------------------------------------------------------- */
static char lcdShown[LCD_ROWS][LCD_COLS + 1];  // what is on the glass right now

// Cuts text to width characters and pads it with spaces to exactly width.
static String lcdFit(const String &text, uint8_t width) {
  String out = text.substring(0, width);
  while (out.length() < width) out += ' ';
  return out;
}

// Text centered inside width characters (cut first if it is too long).
static String lcdCenter(const String &text, uint8_t width) {
  String t = text.substring(0, width);
  String out;
  for (uint8_t i = 0; i < (width - t.length()) / 2; i++) out += ' ';
  out += t;
  return lcdFit(out, width);
}

// One full row, written only when it differs from what is already on the glass.
static void lcdWriteRow(uint8_t row, const String &text) {
  if (!lcdReady || row >= LCD_ROWS) return;
  const String fitted = lcdFit(text, LCD_COLS);
  if (fitted == String(lcdShown[row])) return; // no change on this row: no flicker
  lcd.setCursor(0, row);
  lcd.print(fitted);
  for (uint8_t c = 0; c < LCD_COLS; c++) lcdShown[row][c] = fitted[c];
  lcdShown[row][LCD_COLS] = '\0';
}

// Finds the backpack, sets the display up and reports the address it found.
bool startLcd() {
  const int status = lcd.begin(LCD_COLS, LCD_ROWS); // 20 columns, 4 rows
  if (status) {
    lcdReady = false;
    Serial.print("20x4 LCD not found (hd44780 begin status ");
    Serial.print(status);
    Serial.println("). Check: LCD VCC on regulated 5 V, GND, SDA on B1, SCL on B2,");
    Serial.println("LV on 3V3, HV on 5 V, every GND common, and the contrast pot.");
    Serial.println("Run diagnostics/lcd_check/lcd_check.ino to see the I2C addresses.");
    return false;
  }
  lcdReady = true;
  lcd.backlight();
  lcd.clear();
  // The glass is blank now: remember that, so the first draw writes every row.
  for (uint8_t r = 0; r < LCD_ROWS; r++) {
    for (uint8_t c = 0; c < LCD_COLS; c++) lcdShown[r][c] = ' ';
    lcdShown[r][LCD_COLS] = '\0';
  }
  Serial.print("20x4 LCD ready, backpack found at I2C address 0x");
  Serial.println(lcd.getProp(hd44780_I2Cexp::Prop_addr), HEX);
  return true;
}

// While the LCD is missing, look for it again every 10 s (loose wire, late
// power). Never during enrollment: the six captures must not be interrupted.
void checkLcdHealth() {
  static unsigned long lastTry = 0;
  if (lcdReady || enrollmentActive) return;
  if (millis() - lastTry < 10000) return;
  lastTry = millis();
  if (startLcd()) {
    Serial.println("20x4 LCD found");
    showIdleScreen();
  }
}

/* ── LCD helpers (all text fits 20 columns) ───────────────────────────────── */
void showLines(const String &l1, const String &l2, const String &l3, const String &l4) {
  lcdWriteRow(0, l1);
  lcdWriteRow(1, l2);
  lcdWriteRow(2, l3);
  lcdWriteRow(3, l4);
}

// Who on top, the big word in the middle of the screen (a word longer than
// one row continues on the next row), the note at the bottom.
void showBig(const String &top, const String &big, const String &bottom) {
  lcdWriteRow(0, top);
  lcdWriteRow(1, lcdCenter(big.substring(0, LCD_COLS), LCD_COLS));
  lcdWriteRow(2, lcdCenter(big.length() > LCD_COLS ? big.substring(LCD_COLS) : "", LCD_COLS));
  lcdWriteRow(3, bottom);
}

// Enrollment screen: who, ID, the six scans as a text progress bar, the
// instruction in the middle and the finer hint at the bottom. The old 128x64
// progress rectangle is a text bar now: one '#' per accepted capture.
void showEnrollScreen(const String &who, int id, uint8_t done, const String &prompt, const String &hint) {
  String bar;
  for (uint8_t i = 0; i < ENROLL_SCANS; i++) bar += (i < done ? '#' : '.');
  lcdWriteRow(0, who.length() > 0 ? "Enroll " + who : String("Enroll finger"));
  lcdWriteRow(1, "ID " + String(id) + " [" + bar + "] " + String(done) + "/" + String(ENROLL_SCANS));
  lcdWriteRow(2, lcdCenter(prompt, LCD_COLS));
  lcdWriteRow(3, hint);
}

void showIdleScreen() {
  lcdWriteRow(0, "FANA CAFE Attendance");
  lcdWriteRow(1, "Place finger");
  if (WiFi.status() == WL_CONNECTED) {
    lcdWriteRow(2, "Online  " + WiFi.localIP().toString());
  } else {
    lcdWriteRow(2, "Offline, scans saved");
  }
  if (sensorReady) {
    lcdWriteRow(3, "Templates: " + String(templateCount));
  } else {
    lcdWriteRow(3, "SENSOR OFFLINE!");
  }
}

/* ── Buzzer (GPIO23 -> 1 kohm -> 2N2222 base; the pin never drives the buzzer
 *    itself, the transistor does). HIGH/LOW is correct for the usual small
 *    ACTIVE buzzer, which has its own oscillator. A PASSIVE buzzer (no
 *    internal oscillator) stays silent on HIGH/LOW: uncomment the next line
 *    and the two beeps below use tone() instead. Confirm which one you have
 *    with the buzzer check in the README before wiring it up. ── */
// #define BUZZER_IS_PASSIVE 1

void beepSuccess() {
#ifdef BUZZER_IS_PASSIVE
  tone(BUZZER_PIN, 2000, 100);
#else
  digitalWrite(BUZZER_PIN, HIGH);
  delay(100);
  digitalWrite(BUZZER_PIN, LOW);
#endif
}

void beepError() {
#ifdef BUZZER_IS_PASSIVE
  tone(BUZZER_PIN, 1200, 300);
#else
  digitalWrite(BUZZER_PIN, HIGH);
  delay(300);
  digitalWrite(BUZZER_PIN, LOW);
#endif
}

/* ── Sensor health ────────────────────────────────────────────────────────── */
bool detectSensor(uint8_t tries) {
  for (uint8_t t = 1; t <= tries; t++) {
    const int16_t count = finger.getCount(1500);
    if (count >= 0) {
      sensorReady = true;
      templateCount = count;
      return true;
    }
    Serial.print("Fingerprint sensor not answering, try ");
    Serial.print(t);
    Serial.print("/");
    Serial.println(tries);
    delay(400);
  }
  sensorReady = false;
  return false;
}

// Answers true when the sensor replies to a COUNT command at all.
bool sensorAnswers() {
  return finger.getCount(1500) >= 0;
}

// Every 5 s while the sensor is missing, look for it again (self-healing).
void checkSensorHealth() {
  static unsigned long lastCheck = 0;
  if (sensorReady || millis() - lastCheck < 5000) return;
  lastCheck = millis();
  if (detectSensor(1)) {
    Serial.println("Fingerprint sensor is back!");
    showLines("Sensor back!", "Templates: " + String(templateCount), "", "");
    beepSuccess();
    delay(1000);
    showIdleScreen();
  }
}

/* ── Finger detection (sensor's own SEARCH; only the four data/power wires) ── */
const char *fingerStatusText(uint8_t s) {
  switch (s) {
    case 0x00: return "OK";
    case 0x01: return "Command failed";
    case 0x04: return "Database full";
    case 0x05: return "Finger not enrolled";
    case 0x06: return "Image unclear";
    case 0x07: return "ID already has a finger";
    case 0x08: return "No finger / timeout";
    case 0x0F: return "Finger lifted";
    case 0xFE: return "Garbled reply";
    case 0xFF: return "No reply - check wiring/power";
    default:   return "Unknown status";
  }
}

// Identification scan. The sensor reports a finger as a match (ID), NOUSER
// (finger seen but not enrolled) or IMAGEMESS (finger seen, image unclear).
void scanForFinger() {
  uint16_t matchedId = 0;
  uint8_t permission = 0;
  const bool matched = finger.search(matchedId, permission, SENSOR_POLL_MS) && matchedId > 0;
  const uint8_t st = finger.getLastStatus();

  if (matched) {
    if (awaitingFingerLift) return;
    awaitingFingerLift = true;
    handleVerifiedFinger((int)matchedId);
    return;
  }

  if (st == BIOVO_ACK_NOUSER || st == BIOVO_ACK_IMAGEMESS) {
    if (awaitingFingerLift) return;
    awaitingFingerLift = true;
    if (st == BIOVO_ACK_NOUSER) {
      showSensorWarning("NOT REGISTERED", "Finger not enrolled", "Ask admin to add it");
    } else {
      showSensorWarning("IMAGE UNCLEAR", "Press flat and still", "Clean the sensor");
    }
    return;
  }

  // No finger (or the sensor finished with the finger): the next placement is a new scan.
  if (st == BIOVO_ACK_TIMEOUT || st == BIOVO_ACK_GO_OUT || st == BIOVO_ACK_NO_RESPONSE) {
    awaitingFingerLift = false;
  }
}

void showSensorWarning(const String &title, const String &line2, const String &line3) {
  showLines(title, line2, line3, "");
  digitalWrite(RED_LED, HIGH);
  beepError();
  delay(WARNING_SHOW_MS);
  digitalWrite(RED_LED, LOW);
  showIdleScreen();
}

// A matched finger: show VERIFIED at once, send the scan, show the answer.
void handleVerifiedFinger(int fingerprintId) {
  String name;
  if (fingerprintToStaff.count(fingerprintId)) {
    name = fingerprintToStaff[fingerprintId];
  } else {
    name = "ID " + String(fingerprintId);
  }
  Serial.print("Finger matched ID ");
  Serial.print(fingerprintId);
  Serial.print(" - ");
  Serial.println(name);

  showBig(name, "VERIFIED", "Sending...");
  beepSuccess();
  digitalWrite(GREEN_LED, HIGH);

  String body;
  const int httpCode = postClock(fingerprintId, body);
  digitalWrite(GREEN_LED, LOW);

  if (httpCode == 200) {
    showClockAnswer(name, body);
  } else if (httpCode >= 400 && httpCode < 500) {
    showRefused(name, body);
  } else {
    // No internet, or the website is down: keep the scan and send it later.
    saveToQueue(fingerprintId, name);
    showLines(name, "Saved offline", "Will sync when", "internet is back");
    delay(RESULT_SHOW_MS);
    showIdleScreen();
  }
}

// Sends one scan. Returns the HTTP code (200 accepted, 4xx refused, 5xx server
// problem, negative = no connection). body receives the website's answer.
int postClock(int fingerprintId, String &body) {
  body = "";
  if (WiFi.status() != WL_CONNECTED) return -1;

  HTTPClient http;
  http.setTimeout(SERVER_TIMEOUT_MS);
  http.begin(serverURL + "/api/attendance/clock");
  addDeviceHeaders(http);

  DynamicJsonDocument doc(256);
  doc["fingerprintId"] = fingerprintId;
  doc["deviceId"] = deviceId;
  doc["method"] = "fingerprint";
  String json;
  serializeJson(doc, json);

  const int httpCode = http.POST(json);
  if (httpCode > 0) {
    body = http.getString();
  } else {
    Serial.print("HTTP failed: ");
    Serial.println(http.errorToString(httpCode));
  }
  http.end();
  Serial.print("Clock HTTP ");
  Serial.println(httpCode);
  return httpCode;
}

// The website accepted the scan: show IN, OUT, late, or "already registered".
void showClockAnswer(const String &fallbackName, const String &body) {
  DynamicJsonDocument doc(2048);
  if (deserializeJson(doc, body)) {
    showLines(fallbackName, "Recorded", "", "");
    beepSuccess();
    delay(RESULT_SHOW_MS);
    showIdleScreen();
    return;
  }

  String action = doc["action"] | "";
  String who = doc["memberName"] | "";
  if (who.length() == 0) who = fallbackName;
  String inLabel = doc["clockInLabel"] | "";
  String outLabel = doc["clockOutLabel"] | "";
  String hours = doc["totalHours"] | "";
  String message = doc["message"] | "Recorded";
  int late = doc["lateMinutes"] | 0;

  if (action == "clock_in") {
    String lateText = "On time";
    if (late > 0) lateText = "Late " + String(late) + " min";
    showBig(who, "IN " + inLabel, lateText);
    beepSuccess();
  } else if (action == "clock_out") {
    showBig(who, "OUT " + outLabel, "Total " + hours);
    beepSuccess();
  } else if (action == "already_registered") {
    // Two times no longer fit on one 20-character row, so each gets its own.
    showLines(who, "Already registered",
              inLabel.length() > 0 ? "IN  " + inLabel : String(""),
              outLabel.length() > 0 ? "OUT " + outLabel : String(""));
    beepSuccess();
  } else {
    showLines(who, message, "", "");
    beepSuccess();
  }

  digitalWrite(GREEN_LED, HIGH);
  delay(RESULT_SHOW_MS);
  digitalWrite(GREEN_LED, LOW);
  showIdleScreen();
}

// The website refused the scan (not on the list, bad PIN, ...). Not queued:
// a refused scan would only be refused again later.
void showRefused(const String &name, const String &body) {
  String reason = "Not accepted";
  DynamicJsonDocument doc(512);
  if (!deserializeJson(doc, body)) {
    reason = doc["error"] | "Not accepted";
  }
  Serial.print("Refused: ");
  Serial.println(reason);
  showLines(name, "NOT ACCEPTED", reason.substring(0, LCD_COLS), "Ask the admin");
  digitalWrite(RED_LED, HIGH);
  beepError();
  delay(WARNING_SHOW_MS);
  digitalWrite(RED_LED, LOW);
  showIdleScreen();
}

/* ── Add Fingerprint from the website ─────────────────────────────────────── */
// Asks the website for a pending job and enrolls it. Runs when the real-time
// stream says something changed, and on a slow fallback poll if the stream is down.
bool checkPendingEnroll() {
  if (enrollingFromServer || mappingPending) return false;
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  http.setTimeout(SERVER_TIMEOUT_MS);
  http.begin(serverURL + "/api/attendance/biometrics?pending=1");
  if (deviceToken.length() > 0) http.addHeader("x-attendance-device", deviceToken);
  const int httpCode = http.GET();
  String payload = "";
  if (httpCode == 200) payload = http.getString();
  http.end();
  if (httpCode != 200) return false;

  DynamicJsonDocument doc(2048);
  if (deserializeJson(doc, payload)) return false;
  if ((doc["count"] | 0) <= 0) return false;

  JsonObject job = doc["jobs"][0].as<JsonObject>();
  if (job.isNull()) return false;
  const int jobId = job["jobId"] | 0;
  const int memberId = job["memberId"] | 0;
  const int fingerprintId = job["fingerprintId"] | 0;
  String memberName = job["memberName"] | "Member";

  if (jobId <= 0 || jobId == lastHandledJobId) return false;
  lastHandledJobId = jobId; // try this job once only

  Serial.print("Pending enrollment from the website: ");
  Serial.print(memberName);
  Serial.print(" as ID ");
  Serial.println(fingerprintId);

  enrollingFromServer = true;

  // Tell the website the device really has the job, so the admin page can say
  // "the device is ready, place the finger now" instead of spinning silently.
  // Nothing is sent to the sensor here, so it cannot disturb the enrollment.
  reportJobStarted(jobId, fingerprintId);

  EnrollResult result;
  if (fingerprintId < 1 || fingerprintId > 1000) {
    enrollDetail = "the website sent fingerprint ID " + String(fingerprintId) + " (must be 1-1000)";
    result = ENROLL_FAILED;
  } else if (fingerprintToStaff.count(fingerprintId)) {
    // Never overwrite a finger that already belongs to someone.
    enrollDetail = "ID " + String(fingerprintId) + " already belongs to " + fingerprintToStaff[fingerprintId];
    result = ENROLL_ID_IN_USE;
  } else {
    result = enrollFingerprint(fingerprintId, memberName);
  }

  bool added = false;
  if (result == ENROLL_OK) {
    const int code = postMappingToServer(fingerprintId, memberId, memberName);
    if (code == 200) {
      fingerprintToStaff[fingerprintId] = memberName;
      added = true;
      showBig(memberName, "ADDED", "ID " + String(fingerprintId) + " saved");
      beepSuccess();
      delay(2000);
    } else if (code >= 400 && code < 500) {
      // The website refused the mapping (for example the ID was taken).
      reportJobFailed(jobId, "website refused the mapping");
      showLines("Not saved on website", "Choose another ID", "in admin", "");
      beepError();
      delay(WARNING_SHOW_MS);
    } else {
      // The finger is stored on the sensor; the website will get the mapping soon.
      mappingPending = true;
      mapFingerprintId = fingerprintId;
      mapMemberId = memberId;
      mapMemberName = memberName;
      mapNextTryMs = millis() + MAPPING_RETRY_MS;
      fingerprintToStaff[fingerprintId] = memberName;
      added = true;
      showBig(memberName, "STORED", "Syncing to web...");
      beepSuccess();
      delay(2000);
    }
  } else {
    // The reason goes to the website in full, so the admin page can print
    // which of the six scans failed and what the sensor answered.
    String reason = enrollReason(result);
    if (enrollDetail.length() > 0) reason = enrollDetail;
    reportJobFailed(jobId, reason);
    showLines("Not added", reason, "Press the Add button", "on the website again");
    beepError();
    delay(WARNING_SHOW_MS);
  }

  enrollingFromServer = false;
  showIdleScreen();
  return added;
}

// The last step of Add Fingerprint: tell the website which finger is whose.
// Returns the HTTP code (negative = no connection).
int postMappingToServer(int fingerprintId, int memberId, const String &memberName) {
  if (WiFi.status() != WL_CONNECTED) return -1;

  HTTPClient http;
  http.setTimeout(SERVER_TIMEOUT_MS);
  http.begin(serverURL + "/api/attendance/mappings");
  addDeviceHeaders(http);

  DynamicJsonDocument doc(256);
  doc["fingerprintId"] = fingerprintId;
  doc["memberId"] = memberId;
  doc["memberName"] = memberName;
  doc["staffName"] = memberName;
  doc["deviceId"] = deviceId;
  String json;
  serializeJson(doc, json);
  const int httpCode = http.POST(json);
  http.end();

  Serial.print("Mapping posted, HTTP ");
  Serial.println(httpCode);
  return httpCode;
}

// Tells the website the device picked the job up, so the admin page stops
// guessing whether the scanner is even online. Sent BEFORE the first sensor
// command, so it can never disturb the six captures.
void reportJobStarted(int jobId, int fingerprintId) {
  if (jobId <= 0 || WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.setTimeout(SERVER_TIMEOUT_MS);
  http.begin(serverURL + "/api/attendance/mappings");
  addDeviceHeaders(http);

  DynamicJsonDocument doc(256);
  doc["action"] = "job_started";
  doc["jobId"] = jobId;
  doc["fingerprintId"] = fingerprintId;
  doc["deviceId"] = deviceId;
  doc["templates"] = templateCount;
  doc["detail"] = "Device is ready - lift the finger, then place it flat (ID " +
                  String(fingerprintId) + ")";
  String json;
  serializeJson(doc, json);
  const int httpCode = http.POST(json);
  http.end();

  Serial.print("Announced job ");
  Serial.print(jobId);
  Serial.print(" to the website, HTTP ");
  Serial.println(httpCode);
}

// Tells the website the job failed, so the admin page stops waiting.
void reportJobFailed(int jobId, const String &reason) {
  if (jobId <= 0 || WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.setTimeout(SERVER_TIMEOUT_MS);
  http.begin(serverURL + "/api/attendance/mappings");
  addDeviceHeaders(http);

  DynamicJsonDocument doc(256);
  doc["action"] = "job_failed";
  doc["jobId"] = jobId;
  doc["reason"] = reason;
  String json;
  serializeJson(doc, json);
  const int httpCode = http.POST(json);
  http.end();

  Serial.print("Reported failed job ");
  Serial.print(jobId);
  Serial.print(" (");
  Serial.print(reason);
  Serial.print("), HTTP ");
  Serial.println(httpCode);
}

// Retries a mapping the website has not accepted yet. A 200 or a 4xx ends the retries.
void retryPendingMapping() {
  if (!mappingPending || enrollingFromServer) return;
  if (millis() < mapNextTryMs) return;

  const int code = postMappingToServer(mapFingerprintId, mapMemberId, mapMemberName);
  if (code == 200 || (code >= 400 && code < 500)) {
    mappingPending = false;
    if (code == 200) {
      Serial.println("Pending mapping delivered to the website");
    } else {
      Serial.println("Website refused the pending mapping; dropped");
    }
  } else {
    mapNextTryMs = millis() + MAPPING_RETRY_MS;
  }
}

/* ── Enrollment: six guided scans (1 x ADD_1, 4 x ADD_2, 1 x ADD_3) ─────────
 *
 * What the real device showed us (statuses from the Serial log):
 *  - Sending SEARCH or any other command between the ADD steps of one
 *    enrollment breaks the session: the next ADD step answers status 1
 *    ("Command failed"). After ADD_1 goes out, the ONLY commands sent are
 *    the remaining ADD steps. The library's own EnrollUser example does
 *    the same: back-to-back enroll() calls with a plain pause, no search.
 *  - An ADD command sent while the finger is still moving down gets an
 *    unclear image: status 6. So each ADD command is sent only after the
 *    finger had time to rest flat and still on the glass.
 *
 * The finger is therefore placed ONCE and KEPT on the sensor for all six
 * captures. Recoveries (unclear image, misread scan) use timed pauses,
 * never extra sensor commands. This is the flow that enrolled fingers on
 * the device with the Serial `enroll <id>` command.
 *
 * ── WHY THE WEBSITE BUTTON FAILED WHILE THE SERIAL COMMAND WORKED ──────────
 *
 * Both paths always called this very same function, so the difference could
 * only be the state the sensor was in when the six captures began. There
 * were two, and both are fixed below by a pre-flight that runs BEFORE the
 * first ADD command (after ADD_1 no other command is allowed any more):
 *
 *  1. A LEFTOVER TEMPLATE UNDER THE SAME ID. The website picks the lowest ID
 *     that its own fingerprint table does not use. It cannot know about a
 *     template that sits on the sensor and was never mapped - an earlier
 *     failed job, or a Serial `enroll 1` nobody linked to a person. ADD_1
 *     then answers status 7 ("ID already has a finger"), the old code sent a
 *     DELETE *in the middle of the placement*, and every following ADD saw a
 *     finger that had not moved since: status 6 until the attempts ran out.
 *     The ID is now freed up front, before anybody is asked for a finger.
 *
 *  2. A FINGER ALREADY RESTING ON THE GLASS. With `enroll <id>` the owner
 *     types the command first and only then reaches for the sensor, so the
 *     module always captured a fresh finger. With the website button the
 *     person is usually standing at the scanner already - often with his
 *     finger on it - when the job arrives over the event stream, so ADD_1
 *     captured a picture that was taken before the command was even sent and
 *     every retry saw the very same unmoving finger: status 6 again.
 *     The device now waits for a real LIFT first, so both paths start from an
 *     empty glass and the module sees a finger coming down in both cases.
 *
 * And because one bad placement can still happen to anybody, a failed
 * session no longer fails the job: the whole six-scan sequence is retried
 * from a fresh lift and placement (ENROLL_MAX_SESSIONS times) before the
 * website is told it did not work.
 */
const char *enrollReason(EnrollResult result) {
  switch (result) {
    case ENROLL_NO_FINGER:     return "no finger was placed";
    case ENROLL_UNCLEAR:       return "fingerprint not clear";
    case ENROLL_LIFT_TIMEOUT:  return "finger was not lifted";
    case ENROLL_ID_IN_USE:     return "ID already in use";
    case ENROLL_SENSOR_FULL:   return "sensor memory full";
    case ENROLL_SENSOR_ERROR:  return "sensor not answering";
    default:                   return "enroll failed";
  }
}

/* ── Pre-flight helpers: legal ONLY before the first ADD command ──────────── */

// Reads the glass once with the sensor's own SEARCH.
//   1 = a finger is on the glass, 0 = the glass is empty, -1 = unreadable.
int glassHasFinger() {
  uint16_t matchedId = 0;
  uint8_t permission = 0;
  if (finger.search(matchedId, permission, ENROLL_SENSE_MS) && matchedId > 0) return 1;
  switch (finger.getLastStatus()) {
    case BIOVO_ACK_NOUSER:      return 1;  // finger seen, not enrolled
    case BIOVO_ACK_IMAGEMESS:   return 1;  // finger seen, image unclear
    case BIOVO_ACK_TIMEOUT:     return 0;
    case BIOVO_ACK_GO_OUT:      return 0;
    case BIOVO_ACK_NO_RESPONSE: return 0;
    default:                    return -1;
  }
}

// Empties the sensor slot for id. Both callers only get here for an ID that
// no person on the website is mapped to, so whatever is in that slot is a
// leftover from an earlier attempt and must go BEFORE the guided placement -
// a DELETE sent in the middle of it breaks the whole session.
bool freeLeftoverTemplate(int id) {
  const int16_t before = finger.getCount(3000);
  if (before >= 0) templateCount = before;

  Serial.print("Freeing sensor slot ID ");
  Serial.print(id);
  Serial.print(" (templates before: ");
  Serial.print(before);
  Serial.println(")");

  // Deleting an already empty slot simply answers "command failed"; harmless.
  if (!finger.deleteUser((uint16_t)id, 5000)) {
    Serial.print("Slot was already free (status ");
    Serial.print(finger.getLastStatus());
    Serial.println(")");
    return false;
  }
  Serial.println("Leftover template under this ID was deleted");
  const int16_t after = finger.getCount(3000);
  if (after >= 0) templateCount = after;
  return true;
}

// Waits until the glass is empty, so the module always sees a finger coming
// DOWN - never one that has been resting there since before the job arrived.
bool waitGlassEmpty(const String &who, int id, uint32_t budgetMs) {
  const uint32_t startedAt = millis();
  bool asked = false;
  for (;;) {
    const int state = glassHasFinger();
    if (state <= 0) {
      // Two quiet reads in a row would be nicer, but the module already waits
      // for a lift inside SEARCH, so one clean read is enough.
      if (asked) Serial.println("Finger lifted - glass is empty");
      return true;
    }
    if (!asked) {
      asked = true;
      Serial.println("A finger is already on the glass - asking for a lift first");
    }
    if (millis() - startedAt >= budgetMs) return false;
    showEnrollScreen(who, id, 0, "LIFT YOUR FINGER", "Then place it again");
    delay(300);
  }
}

/* ── One six-capture session. Sends the sensor NOTHING but the six ADD steps. ─ */
EnrollResult runCaptureSession(int id, const String &who, uint32_t deadlineMs) {
  const uint8_t captureSteps[6] = {1, 2, 2, 2, 2, 3};
  uint32_t noFingerSinceMs = 0; // 0 = a finger was answered recently

  for (uint8_t cap = 0; cap < 6; cap++) {
    uint8_t unclear = 0;
    uint8_t attempt = 0;
    bool captureDone = false;

    while (!captureDone && attempt < ENROLL_MAX_ATTEMPTS) {
      attempt++;

      if (millis() >= deadlineMs) {
        enrollDetail = "took too long at scan " + String(cap + 1) + "/6";
        return ENROLL_FAILED;
      }

      // Settle window before the ADD command: a capture taken while the
      // finger is still moving down comes back unclear (status 6).
      if (cap == 0 && attempt == 1) {
        showEnrollScreen(who, id, cap, "PLACE FINGER", "Flat, still, keep on");
        delay(ENROLL_PLACE_SETTLE_MS);
      } else {
        showEnrollScreen(who, id, cap, "KEEP STILL", "Do not lift it yet");
        delay(ENROLL_KEEP_SETTLE_MS);
      }

      Serial.print("Scan ");
      Serial.print(cap + 1);
      Serial.print("/6 (step ");
      Serial.print(captureSteps[cap]);
      Serial.print(", attempt ");
      Serial.print(attempt);
      Serial.print("/");
      Serial.print(ENROLL_MAX_ATTEMPTS);
      Serial.println(") sending ADD");

      const uint32_t cmdStart = millis();
      if (finger.enroll((uint16_t)id, captureSteps[cap], ENROLL_ADD_TIMEOUT_MS)) {
        Serial.print("Scan ");
        Serial.print(cap + 1);
        Serial.print("/6 accepted in ");
        Serial.print(millis() - cmdStart);
        Serial.println(" ms");
        captureDone = true;
        noFingerSinceMs = 0;
        break;
      }

      const uint8_t st = finger.getLastStatus();
      Serial.print("Scan ");
      Serial.print(cap + 1);
      Serial.print("/6 not accepted, status ");
      Serial.print(st);
      Serial.print(" (");
      Serial.print(fingerStatusText(st));
      Serial.print(") after ");
      Serial.print(millis() - cmdStart);
      Serial.println(" ms");

      enrollDetail = "scan " + String(cap + 1) + "/6 not accepted: " +
                     String(fingerStatusText(st)) + " (status " + String(st) + ")";

      if (st == BIOVO_ACK_USER_EXIST) {
        // The ID was freed before the placement, so this means somebody else
        // took the slot in the meantime. Never overwrite it.
        return ENROLL_ID_IN_USE;
      }
      if (st == BIOVO_ACK_FULL) return ENROLL_SENSOR_FULL;

      if (st == BIOVO_ACK_NO_RESPONSE || st == BIOVO_ACK_COMM_ERROR) {
        // No COUNT here: any command that is not an ADD ends the session.
        // Time is the only recovery, and the next session re-checks the sensor.
        delay(ENROLL_LIFT_PAUSE_MS);
        continue;
      }

      if (st == BIOVO_ACK_IMAGEMESS) {
        if (++unclear >= ENROLL_MAX_UNCLEAR) return ENROLL_UNCLEAR;
        if (unclear % ENROLL_HOLD_STILL_AT == 0) {
          // Three unclear images in a row: the finger moved or is not flat.
          // Only TIME passes here - no sensor command - and the person puts
          // it back down while this same capture is still waiting for it.
          showEnrollScreen(who, id, cap, "LIFT, PLACE AGAIN", "Flat and still");
          beepError();
          delay(ENROLL_LIFT_PAUSE_MS);
        } else {
          // Most unclear images are a finger that micro-moved. It is already
          // in place, so keep it there and resend this same capture shortly.
          showEnrollScreen(who, id, cap, "HOLD STILL", "Unclear, stay flat");
          delay(1000);
        }
        continue;
      }

      if (st == BIOVO_ACK_TIMEOUT) {
        // The module saw no finger. That is not a failed capture - nobody has
        // come to the scanner yet - so it must not eat into the attempt
        // budget. Give a full placement window, and give up when no finger
        // arrives for ENROLL_NO_FINGER_MS in total.
        attempt--;
        if (noFingerSinceMs == 0) noFingerSinceMs = millis();
        if (millis() - noFingerSinceMs >= ENROLL_NO_FINGER_MS) {
          enrollDetail = "no finger was placed within " + String(ENROLL_NO_FINGER_MS / 1000) + " s";
          return ENROLL_NO_FINGER;
        }
        showEnrollScreen(who, id, cap, "PLACE FINGER", "No finger seen yet");
        delay(ENROLL_PLACE_SETTLE_MS);
        continue;
      }

      // Status 1 (command failed) or anything else unexpected: the session is
      // broken. Stop it and let enrollFingerprint() start a brand new one.
      return ENROLL_FAILED;
    }

    if (!captureDone) {
      if (enrollDetail.length() == 0) {
        enrollDetail = "scan " + String(cap + 1) + "/6 was never accepted";
      }
      return ENROLL_FAILED;
    }
  }

  enrollDetail = "";
  return ENROLL_OK;
}

// Stores one finger under id. who is the name shown on the LCD ("" = manual).
// The website job and the Serial `enroll <id>` command both land here and are
// walked through exactly the same pre-flight, so they cannot drift apart.
EnrollResult enrollFingerprint(int id, const String &who) {
  // Keeps checkLcdHealth() away for the whole job (every return path clears it
  // again): the six captures must not be interrupted by anything.
  EnrollmentGuard enrollmentGuard;

  Serial.print("Enrolling ID ");
  Serial.println(id);
  Serial.println("Six scans: place the same finger flat and still, and keep it on the sensor for all six.");

  enrollDetail = "";

  // Drop stale replies from the idle scan loop and wait for a quiet line,
  // so the first reply we read really belongs to our first ADD command.
  finger.drain(150);

  // A finger still on the sensor when enrollment ends must not be clocked by
  // the very next idle search; the lift that ends enrollment resets this.
  awaitingFingerLift = true;

  /* ── Pre-flight 1: free the sensor slot (before anybody is asked for a
   *    finger, because a DELETE mid-placement breaks the session). ── */
  freeLeftoverTemplate(id);

  /* ── Pre-flight 2: start from an EMPTY glass, exactly like the Serial
   *    command does, so ADD_1 always sees a finger coming down. ── */
  if (!waitGlassEmpty(who, id, ENROLL_LIFT_BUDGET_MS)) {
    enrollDetail = "a finger stayed on the glass for " + String(ENROLL_LIFT_BUDGET_MS / 1000) + " s";
    return ENROLL_LIFT_TIMEOUT;
  }

  const uint32_t deadlineMs = millis() + ENROLL_TOTAL_BUDGET_MS;
  EnrollResult outcome = ENROLL_FAILED;

  for (uint8_t session = 1; session <= ENROLL_MAX_SESSIONS; session++) {
    if (session > 1) {
      // A broken session cannot be repaired: the module keeps the images it
      // already took. Only a fresh lift, a fresh placement and a new ADD_1
      // start a clean one.
      Serial.print("Session ");
      Serial.print(session - 1);
      Serial.print(" did not finish (");
      Serial.print(enrollDetail);
      Serial.print("). Starting attempt ");
      Serial.print(session);
      Serial.print(" of ");
      Serial.println(ENROLL_MAX_SESSIONS);
      showEnrollScreen(who, id, 0, "LIFT, PLACE AGAIN",
                       "Try " + String(session) + " of " + String(ENROLL_MAX_SESSIONS));
      beepError();
      delay(ENROLL_LIFT_PAUSE_MS);
      if (!waitGlassEmpty(who, id, ENROLL_LIFT_BUDGET_MS)) {
        enrollDetail = "a finger stayed on the glass for " + String(ENROLL_LIFT_BUDGET_MS / 1000) + " s";
        return ENROLL_LIFT_TIMEOUT;
      }
    }

    outcome = runCaptureSession(id, who, deadlineMs);

    if (outcome == ENROLL_OK) {
      Serial.println("Fingerprint enrolled successfully.");
      const int16_t newCount = finger.getCount(3000);
      if (newCount >= 0) templateCount = newCount;
      enrollDetail = "";
      return ENROLL_OK;
    }

    // Nobody came to the scanner, the sensor is dead or the slot is taken:
    // retrying cannot help, so tell the website at once.
    if (outcome == ENROLL_NO_FINGER || outcome == ENROLL_SENSOR_FULL ||
        outcome == ENROLL_ID_IN_USE || outcome == ENROLL_UNCLEAR) {
      return outcome;
    }
    if (millis() >= deadlineMs) {
      if (enrollDetail.length() == 0) enrollDetail = "enrollment took too long";
      return ENROLL_FAILED;
    }
  }

  if (enrollDetail.length() == 0) enrollDetail = enrollReason(outcome);
  return outcome;
}

// Serial "enroll <id>": store a finger on the sensor, map it in admin afterwards.
void manualEnroll(int id) {
  if (id < 1 || id > 1000) {
    Serial.println("Invalid ID. Use a number from 1 to 1000.");
    return;
  }
  if (!sensorReady) {
    Serial.println("Fingerprint sensor not responding; cannot enroll.");
    showLines("Sensor offline", "Check wiring", "", "");
    beepError();
    delay(WARNING_SHOW_MS);
    showIdleScreen();
    return;
  }
  if (fingerprintToStaff.count(id)) {
    const String who = fingerprintToStaff[id];
    Serial.println("ID " + String(id) + " already belongs to " + who + ". Choose another ID.");
    showLines("ID " + String(id) + " is in use", "by " + who, "Choose another ID", "");
    beepError();
    delay(WARNING_SHOW_MS);
    showIdleScreen();
    return;
  }

  const EnrollResult result = enrollFingerprint(id, "");
  if (result == ENROLL_OK) {
    // The sensor stores only the template. The admin must map this ID to a staff member.
    Serial.print("Stored as ID ");
    Serial.print(id);
    Serial.println(" - map it: admin → Attendance → Staff Fingerprints");
    showLines("Stored as ID " + String(id), "Map it in admin:", "Attendance > Staff", "Fingerprints");
    beepSuccess();
    delay(5000);
  } else {
    // The same detail the website gets, so the Serial log and the admin page
    // always tell the same story about the same failure.
    String reason = enrollReason(result);
    if (enrollDetail.length() > 0) reason = enrollDetail;
    Serial.print("Enroll failed: ");
    Serial.println(reason);
    showLines("Enroll failed", reason, "Try again", "");
    beepError();
    delay(WARNING_SHOW_MS);
  }
  showIdleScreen();
}

/* ── Real-time event stream (Server-Sent Events) ─────────────────────────── */
// The device keeps one stream open. The server pushes "data: refresh" when a
// job is queued or a mapping changes. Between events nothing is sent.
// A slow fallback poll runs only while the stream is down.
void keepServerLinkAlive() {
  static bool wifiWasConnected = false;
  const bool wifiConnected = WiFi.status() == WL_CONNECTED;
  if (wifiConnected && !wifiWasConnected && eventStreamActive) {
    stopEventStream(); // the WiFi drop killed the old sockets
  }
  wifiWasConnected = wifiConnected;
  if (!wifiConnected) return;

  if (eventStreamActive) {
    pumpEventStream();
    if (eventStreamActive && millis() - lastEventStreamData > EVENT_STREAM_STALL_MS) {
      Serial.println("Event stream stalled, reconnecting");
      startEventStream();
    }
  } else if (millis() - lastEventStreamTry > eventStreamRetryMs) {
    startEventStream();
  }

  if (!eventStreamActive && !enrollingFromServer && millis() - lastPendingCheck > PENDING_POLL_FALLBACK_MS) {
    lastPendingCheck = millis();
    checkPendingEnroll();
  }
}

void stopEventStream() {
  if (eventStreamActive) Serial.println("Event stream disconnected");
  eventStreamActive = false;
  eventStream = nullptr;
  eventLine = "";
  eventHttp.end();
  lastEventStreamTry = millis();
}

void startEventStream() {
  stopEventStream();
  if (WiFi.status() != WL_CONNECTED) return;
  Serial.println("Connecting real-time event stream...");
  eventHttp.begin(serverURL + "/api/attendance/events?channel=device");
  eventHttp.addHeader("Accept", "text/event-stream");
  if (deviceToken.length() > 0) eventHttp.addHeader("x-attendance-device", deviceToken);
  eventHttp.setTimeout(5000);
  const int code = eventHttp.GET();
  if (code == 200) {
    eventStream = eventHttp.getStreamPtr();
    eventStreamActive = true;
    lastEventStreamData = millis();
    eventStreamRetryMs = 5000;
    Serial.println("Real-time event stream connected");
  } else {
    Serial.print("Event stream connect failed, HTTP ");
    Serial.println(code);
    eventHttp.end();
    eventStreamActive = false;
    eventStreamRetryMs = min(eventStreamRetryMs * 2, 30000UL);
  }
  lastEventStreamTry = millis();
}

// Reads what is available without blocking. A "data:" line means something
// changed: refresh the names and look for a pending job.
void pumpEventStream() {
  if (!eventStreamActive || eventStream == nullptr) return;
  if (!eventStream->connected()) {
    stopEventStream();
    return;
  }
  bool gotRefresh = false;
  while (eventStream->available() > 0) {
    const char c = (char)eventStream->read();
    lastEventStreamData = millis();
    if (c == '\n') {
      if (eventLine.startsWith("data:")) gotRefresh = true;
      eventLine = "";
    } else if (c != '\r') {
      eventLine += c;
    }
  }
  if (gotRefresh && !enrollingFromServer) {
    Serial.println("Real-time event: refreshing names and jobs");
    loadMappingsFromServer();
    checkPendingEnroll();
  }
}

/* ── Names: fingerprintId -> staff, cached in LittleFS for offline use ────── */
void loadMappingsFromServer() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.setTimeout(SERVER_TIMEOUT_MS);
  http.begin(serverURL + "/api/attendance/mappings");
  if (deviceToken.length() > 0) http.addHeader("x-attendance-device", deviceToken);
  const int httpCode = http.GET();

  if (httpCode == 200) {
    String payload = http.getString();
    DynamicJsonDocument doc(8192);
    if (!deserializeJson(doc, payload)) {
      fingerprintToStaff.clear();
      JsonObject simpleMap = doc["simpleMap"];
      for (JsonPair kv : simpleMap) {
        fingerprintToStaff[String(kv.key().c_str()).toInt()] = kv.value().as<String>();
      }
      Serial.print("Loaded ");
      Serial.print(fingerprintToStaff.size());
      Serial.println(" mappings from server");

      File f = LittleFS.open("/mappings.json", "w");
      if (f) {
        f.print(payload);
        f.close();
      }
    }
  } else if (LittleFS.exists("/mappings.json")) {
    File f = LittleFS.open("/mappings.json", "r");
    if (f) {
      String payload = f.readString();
      f.close();
      DynamicJsonDocument doc(8192);
      if (!deserializeJson(doc, payload)) {
        fingerprintToStaff.clear();
        JsonObject simpleMap = doc["simpleMap"];
        for (JsonPair kv : simpleMap) {
          fingerprintToStaff[String(kv.key().c_str()).toInt()] = kv.value().as<String>();
        }
        Serial.println("Loaded mappings from offline cache");
      }
    }
  }
  http.end();
}

/* ── Offline queue: scans made while there was no internet ────────────────── */
void saveToQueue(int fingerprintId, const String &staffName) {
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

// Sends queued scans. A scan the website accepts (200) or refuses (4xx) is
// removed. Only scans that could not reach the website stay in the queue.
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
    const int fid = doc["fingerprintId"] | 0;

    HTTPClient http;
    http.setTimeout(SERVER_TIMEOUT_MS);
    http.begin(serverURL + "/api/attendance/clock");
    addDeviceHeaders(http);

    DynamicJsonDocument postDoc(256);
    postDoc["fingerprintId"] = fid;
    postDoc["deviceId"] = deviceId + "_offline";
    postDoc["method"] = "fingerprint";
    String json;
    serializeJson(postDoc, json);

    const int httpCode = http.POST(json);
    http.end();

    if (httpCode == 200) {
      Serial.print("Synced offline ID ");
      Serial.println(fid);
    } else if (httpCode >= 400 && httpCode < 500) {
      Serial.print("Offline scan for ID ");
      Serial.print(fid);
      Serial.print(" refused by the website (HTTP ");
      Serial.print(httpCode);
      Serial.println("), dropped");
    } else {
      remaining += line + "\n";
      allSynced = false;
    }
  }
  f.close();

  if (allSynced) {
    LittleFS.remove("/queue.json");
    Serial.println("Offline queue synced");
  } else {
    File out = LittleFS.open("/queue.json", "w");
    if (out) {
      out.print(remaining);
      out.close();
    }
  }
}

void periodicSync() {
  static unsigned long lastSync = 0;
  static int syncCount = 0;
  if (millis() - lastSync <= 30000) return;
  lastSync = millis();
  syncOfflineQueue();
  // Full name refresh every 15 minutes, as a fallback to the real-time stream.
  syncCount++;
  if (syncCount > 30) {
    syncCount = 0;
    loadMappingsFromServer();
  }
}

// Each device call carries the device token when one is set.
void addDeviceHeaders(HTTPClient &http) {
  http.addHeader("Content-Type", "application/json");
  if (deviceToken.length() > 0) http.addHeader("x-attendance-device", deviceToken);
}

/* ── Serial monitor commands (115200 baud) ────────────────────────────────── */
void handleSerialCommand() {
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  if (cmd.startsWith("enroll")) {
    manualEnroll(cmd.substring(6).toInt());
  } else if (cmd == "empty") {
    Serial.println("This deletes ALL fingerprints on the sensor. To confirm, type: empty confirm");
  } else if (cmd == "empty confirm") {
    emptyDatabase();
  } else if (cmd == "list") {
    listFingerprints();
  } else if (cmd == "test") {
    testSensor();
  } else if (cmd.length() > 0) {
    Serial.println("Commands: enroll <id> | list | test | empty confirm");
  }
}

void emptyDatabase() {
  if (!finger.deleteAll()) {
    Serial.print("Could not clear fingerprint database; status = ");
    Serial.println(finger.getLastStatus());
    beepError();
    return;
  }
  Serial.println("Database emptied");
  templateCount = 0;
  showLines("DB Emptied!", "", "", "");
  beepSuccess();
  delay(2000);
  showIdleScreen();
}

void listFingerprints() {
  const int16_t count = finger.getCount(3000);
  if (count >= 0) templateCount = count;
  Serial.print("Templates: ");
  Serial.println(count);
  showLines("Templates: " + String(count), "", "", "");
  delay(2000);
  showIdleScreen();
}

void testSensor() {
  Serial.println("--- Sensor test ---");
  while (mySerial.available()) mySerial.read();
  const int16_t count = finger.getCount(3000);
  if (count >= 0) {
    Serial.print("COUNT reply OK, templates = ");
    Serial.println(count);
    showLines("Sensor test: OK", String(count) + " templates", "", "");
  } else {
    Serial.print("COUNT failed, status = ");
    Serial.print(finger.getLastStatus());
    Serial.print(" (");
    Serial.print(fingerStatusText(finger.getLastStatus()));
    Serial.println(")");
    showLines("Sensor test: FAIL", "status " + String(finger.getLastStatus()), "Check wiring", "");
  }
  delay(2500);
  showIdleScreen();
}

/* ── Local status page (no secrets, no enrolling) ─────────────────────────── */
void handleRoot() {
  String html = "<h1>FANA CAFE Attendance</h1>";
  html += "<p>IP: " + WiFi.localIP().toString() + "</p>";
  html += "<p>Sensor: " + String(sensorReady ? "online" : "OFFLINE") + "</p>";
  html += "<p>Templates: " + String(templateCount) + "</p>";
  html += "<p><a href='/status'>Status JSON</a></p>";
  server.send(200, "text/html", html);
}

void handleStatus() {
  DynamicJsonDocument doc(256);
  doc["deviceId"] = deviceId;
  doc["ip"] = WiFi.localIP().toString();
  doc["templates"] = templateCount;
  doc["sensorReady"] = sensorReady;
  doc["wifi"] = WiFi.status() == WL_CONNECTED;
  doc["mappings"] = fingerprintToStaff.size();
  String json;
  serializeJson(doc, json);
  server.send(200, "application/json", json);
}
