/*
 * FANA CAFE & RESTAURANT - Attendance System
 * GitHub: hardware/fana_attendance_esp32/fana_attendance_esp32.ino (keep updated here for copy-paste upload)
 * Hardware: ESP32 WROOM + R307 optical fingerprint sensor + 20x4 I2C LCD
 *           + transistor-driven buzzer + 2 LEDs
 *
 * FINGERPRINT SENSOR: 4 WIRES ARE ENOUGH
 *   Sensor label   ->  ESP32
 *   R307 VCC -> regulated supply specified by the seller (normally 5V)
 *   R307 GND -> GND (all grounds common)
 *   R307 TX  -> GPIO16 (ESP32 RX2)
 *   R307 RX  -> GPIO17 (ESP32 TX2; ESP32 is already 3.3V UART logic)
 *   VERIFY the connector pinout; R307 wire colours are not standardized.
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
 *   - Adafruit Fingerprint Sensor Library by Adafruit
 *   - hd44780 by Bill Perry  - the 20x4 I2C LCD (REPLACES Adafruit SSD1306/GFX)
 *   - WiFiManager by tzapu, ArduinoJson (v6)
 * Sensor UART: 57600 baud, 8N1 (common R307 factory default).
 *
 * WHAT HAPPENS
 *   Scan:   the finger is matched locally and the answer shows at once - the
 *           employee's name, the recorded time and "Verifying....", then either
 *           "Sent to website" (with IN / OUT / already registered) or "Stored
 *           offline queue" (the scan keeps its original time and uploads by
 *           itself). One placement = one scan, however long
 *           the finger stays on the sensor. The reader is ready for the next
 *           person the instant the finger is lifted: while a MATCHED finger
 *           rests on the glass the sketch only polls "is anything there?"
 *           instead of crediting the same person twice, the light is forced
 *           back on after every capture, and feedback does not pause the scan
 *           (a warning is a screen with a timer, not a pause). Wi-Fi strength
 *           changes WHERE the scan is kept, never how long the door takes.
 *   Add:    the admin presses Add Fingerprint on the website. The LCD guides
 *           R307's two enrollment captures: PLACE FINGER, LIFT, then place
 *           the same finger again at a slightly different angle. The R307
 *           combines both views into one rotation-tolerant template. The
 *           device then confirms the stored ID on fresh placements. If that
 *           fails twice, the last attempt takes both pictures from ONE steady
 *           press. Every wait has a timeout, so the device never hangs.
 *
 *           A reader that does not light up is the failure the owner reported,
 *           so the placement window repairs what can be repaired: the light is
 *           requested two different ways before and during every placement,
 *           a reader that has seen nothing for 6 s is re-synchronized, and at
 *           10 s the LCD stops asking for a finger it cannot see and says
 *           "Reader sees nothing" instead. A window that saw nothing at all is
 *           asked once more (TRY AGAIN) before the job is called failed. A
 *           failed job is reported back to the website with its reason - and
 *           with the number of no-finger and unclear answers the reader gave -
 *           and is not retried in a loop.
 *   Manual: Serial "enroll <id>" stores a finger even with no website (it uses
 *           the names saved in flash); map it in admin afterwards.
 *   Idle:   "Fana Cafe Attendance / Place finger - ready / Connected -58dB #### / Time
 *           HH:MM:SS" (owner, Oct 2026). Row 2 ALWAYS carries the connection
 *           status, the live dBm number and the four signal blocks (and
 *           "Offline 34s - saved" / "No wifi - scans safe" when the link is
 *           down, because a kept scan is not a fault). Row 3 is the wall clock
 *           from NTP on Ethiopian time (UTC+3, no daylight saving), and it
 *           alternates every 2.5 s with an alert when one is needed ("Scans
 *           need review", "Queue needs help", "Sync waiting"), so neither the
 *           clock nor the alert is ever lost. The IP address and the template
 *           count live on the device's own status page and on Serial.
 *   After:  the result card, drawn the instant the finger matches (owner, Oct
 *           2026), four rows:
 *             row 0  employee name          from the list saved in flash
 *             row 1  Time HH:MM:SS          the moment the image was taken
 *             row 2  Verifying....          with the green LED + one beep
 *             row 3  Please wait            then "Sending to site"
 *           When the green indication finishes (1.5 s) row 2 reports where the
 *           scan really is: "Sent to website" (with Attendance IN / OUT on row
 *           3) once the website confirms THAT exact scan, or "Stored offline
 *           queue" when nothing was confirmed - with the reason on row 3 ("No
 *           Wi-Fi now" or "Site not replying"). The scan is written to flash
 *           before any network work and keeps its ORIGINAL scan time, and the
 *           delivery task uploads it by itself when Wi-Fi returns, so nobody
 *           rescans. Owner, Oct 2026: a scan that WAS delivered must never be
 *           called "saved on device".
 *   Wrong:  an unregistered, wrong-side, unclear or garbled press shows a RED
 *           LED and a distinct two-pulse buzzer as fast as the reader answers
 *           (every fixed cost in front of it was cut: no second capture, an
 *           800 ms image deadline, a 1.5 s conversion deadline, a ~600 ms
 *           recovery cap and a 1.2 s warning throttle - see WARNING_REPEAT_MS
 *           and R307Compat.h. The refusal prints its own timing on Serial)
 *           ("Not registered / Ask the admin" or "Image unclear / Press flat and
 *           still"), and the card clears itself after the warning. The scanner
 *           keeps looking the whole time, and a good scan replaces it at once.
 *           The reader's own evidence decides whether a finger was there, so a
 *           bad press can never produce a blank, silent, dark glass. A definite
 *           no-match is answered immediately (no second capture), which is what
 *           makes the red light feel instant.
 *
 * READER LIGHT
 *   The blue light must never stop (owner, Oct 2026). Three layouts are tried -
 *   plain LED-ON, then breathing blue with unlimited cycles, then steady blue -
 *   and the one that worked is remembered and used first, so a normal re-assert
 *   is a single short frame. It is re-sent every 0.7 s while idle and FORCED
 *   0.3 s after every capture (matched or refused), past the miss backoff.
 *   Light frames never drain the line and never mark the link dirty, so a
 *   reader that refuses them cannot stall the door. `lamp` on Serial reports
 *   which layout the installed reader accepted.
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
#include <Adafruit_Fingerprint.h>
#include "R307Compat.h"
#include "OfflineQueue.h"
#include <mbedtls/md.h>
#include <atomic>
#include <map>
#include <string.h>
#include <LittleFS.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/queue.h>
/* The buzzer is switched off by a one-shot software timer, so a beep can never
 * hold the scanner (see beep()/buzzerSilence()). */
#include <freertos/timers.h>
#include <sys/time.h>
#include <WebServer.h>
/* The rest windows put the board into a real deep sleep, so the sleep API is
 * part of the sketch. The host test stubs this header (test/stub/esp_sleep.h):
 * a test can then read what the sketch decided instead of losing the process. */
#include <esp_sleep.h>
/* The wall clock of the idle screen comes from NTP. Ethiopia is UTC+3 all year
 * round (no daylight saving, ever), so one fixed offset is the whole timezone:
 * no zone database and no summer/winter switch to get wrong. */
#include <time.h>
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

/* True while an enrollment session is running (the Serial command and the
 * website job both set it). The LCD is never re-initialized mid-enrollment. */
bool enrollmentActive = false;
/* Set when a placement window had to say "Reader sees nothing". It outlives the
 * window so the failure screen and the website can name the actual fault
 * instead of the generic "no finger was placed": a person who never pressed and
 * a reader that cannot see produce the same R307 status, and only the sketch
 * knows which one it was. */
bool enrollReaderBlind = false;
/* Clears that flag on every return path of a function that sets it. */
struct EnrollmentGuard {
  EnrollmentGuard() { enrollmentActive = true; }
  ~EnrollmentGuard() { enrollmentActive = false; }
};

// Only plain, fixed-size data crosses from the delivery task to the scanner.
// The network task never writes the LCD or waits for a person to read it.
enum DeliveryKind : uint8_t { DELIVERY_IN, DELIVERY_OUT, DELIVERY_ALREADY, DELIVERY_REVIEW };
struct DeliveryNotice {
  char eventId[33];
  char name[65];
  uint32_t scannedAt;
  DeliveryKind kind;
};

// BEGIN SCAN FEEDBACK STATE (also compiled by the host regression tests)
class ScanFeedback {
 public:
  /* NOTICE is a warning about THIS placement (unregistered finger, unclear
   * image, a scan that could not be written). It lives here, in the same state
   * machine as the results, because the door must never PAUSE to show it: the
   * old code sat in delay(WARNING_SHOW_MS) with no command going to the reader,
   * which is exactly the "the sensor goes dark for five seconds and I have to
   * press during the dark time" report. A notice expires on its own while the
   * scan loop keeps running underneath it. */
  enum Phase : uint8_t { IDLE, SENDING, SAVED, SENT_IN, SENT_OUT, ALREADY, REVIEW, NOTICE };
  /* How long the door may claim "SENDING TO WEBSITE" before it admits that no
   * receipt has arrived. This was 1.8 s, which is shorter than one round trip
   * to a weak router: a scan that WAS delivered a moment later had already
   * been shown as "SAVED OFFLINE", which is exactly the owner's report - "even
   * though there is Wi-Fi the system says saved on device". A real SENT only
   * ever comes from the website's own receipt; until then the honest states are
   * SENDING (link up, waiting) and SAVED (nothing confirmed, still queued). */
  static const uint32_t WAIT_FOR_RECEIPT_MS = 8000U;
  /* How long the green LED + success beep last. When they end the screen stops
   * saying "Please wait" and reports where the scan actually is (owner, Oct
   * 2026: "once the initial green indication finishes, replace Verifying...
   * with either Sent to website or Stored in offline queue"). */
  static const uint32_t GREEN_SHOW_MS = 1500U;
  /* Shown the instant the reader matches a finger and the name is known from
   * the list saved in flash - BEFORE the LittleFS write, so the employee sees
   * their name and "Verifying...." with no wait at all. The final state follows
   * within milliseconds (see saved()). */
  void verifying(const DeliveryNotice &notice, bool connected, uint32_t now) {
    current_ = notice;
    linkUpAtSave_ = connected;
    phase_ = SENDING;
    shownAt_ = now;
  }
  void saved(const DeliveryNotice &notice, bool connected, uint32_t now) {
    current_ = notice;
    linkUpAtSave_ = connected;
    phase_ = connected ? SENDING : SAVED;
    shownAt_ = now;
  }
  // True once the green indication has finished for the scan on screen.
  bool greenPhaseOver(uint32_t now) const {
    return phase_ == SENDING && (uint32_t)(now - shownAt_) >= GREEN_SHOW_MS;
  }
  // Was there a usable link when this scan was stored? Only used to explain on
  // the LCD WHY the scan is sitting in the queue.
  bool linkWasUp() const { return linkUpAtSave_; }
  bool mayShow(const DeliveryNotice &notice, uint32_t now) const {
    // A warning about the finger that is on the glass right now outranks a
    // receipt for somebody else's earlier scan: the person at the door must be
    // able to read why it did not work. The receipt is shown right after.
    if (phase_ == NOTICE) return false;
    return phase_ == IDLE || strcmp(current_.eventId, notice.eventId) == 0 ||
           (uint32_t)(now - shownAt_) >= 1500U;
  }
  // Show a short warning without stopping the scanner.
  void notice(const char *title, const char *line2, const char *line3, uint32_t now, uint32_t ms) {
    putLine(noticeTitle_, sizeof(noticeTitle_), title);
    putLine(noticeLine2_, sizeof(noticeLine2_), line2);
    putLine(noticeLine3_, sizeof(noticeLine3_), line3);
    noticeMs_ = ms;
    phase_ = NOTICE;
    shownAt_ = now;
  }
  void delivered(const DeliveryNotice &notice, uint32_t now) {
    current_ = notice;
    switch (notice.kind) {
      case DELIVERY_IN: phase_ = SENT_IN; break;
      case DELIVERY_OUT: phase_ = SENT_OUT; break;
      case DELIVERY_ALREADY: phase_ = ALREADY; break;
      case DELIVERY_REVIEW: phase_ = REVIEW; break;
    }
    shownAt_ = now;
  }
  bool tick(uint32_t now) {
    if (phase_ == NOTICE) {
      if ((uint32_t)(now - shownAt_) >= noticeMs_) {
        phase_ = IDLE;   // the door goes back to its idle screen, still scanning
        return true;
      }
      return false;
    }
    if (phase_ == SENDING && (uint32_t)(now - shownAt_) >= WAIT_FOR_RECEIPT_MS) {
      // No confirmed reply after a full round-trip budget: the scan is safe on
      // the device and will go by itself, but nobody may call it "sent".
      phase_ = SAVED;
      shownAt_ = now;
      return true;
    }
    if (phase_ != IDLE && phase_ != SENDING && (uint32_t)(now - shownAt_) >= 3000U) {
      phase_ = IDLE;
      return true;
    }
    return false;
  }
  Phase phase() const { return phase_; }
  const DeliveryNotice &current() const { return current_; }
  const char *noticeTitle() const { return noticeTitle_; }
  const char *noticeLine2() const { return noticeLine2_; }
  const char *noticeLine3() const { return noticeLine3_; }
 private:
  // No Arduino/String dependency here: this block is also compiled by the host
  // tests, so one plain copy loop keeps it portable.
  static void putLine(char *dst, size_t cap, const char *src) {
    size_t i = 0;
    if (src) {
      for (; i + 1 < cap && src[i]; ++i) dst[i] = src[i];
    }
    dst[i] = '\0';
  }
  DeliveryNotice current_{};
  char noticeTitle_[21] = "";
  char noticeLine2_[21] = "";
  char noticeLine3_[21] = "";
  uint32_t noticeMs_ = 2500;
  bool linkUpAtSave_ = false;
  Phase phase_ = IDLE;
  uint32_t shownAt_ = 0;
};
// END SCAN FEEDBACK STATE

enum QueueSyncResult : uint8_t { QUEUE_EMPTY, QUEUE_PROGRESS, QUEUE_WAIT };
enum QueueStatus : uint8_t { QUEUE_OFFLINE, QUEUE_IDLE, QUEUE_SENDING, QUEUE_CLOCK_WAIT, QUEUE_ERROR, QUEUE_STORAGE_ERROR };

HardwareSerial mySerial(2);
R307Compat finger(mySerial);
WebServer server(80);

// The door owns the reader/LCD; potentially slow Wi-Fi work runs separately.
// The queue lock is held only for flash operations, never for an HTTP request.
SemaphoreHandle_t sensorMutex = nullptr;
SemaphoreHandle_t mappingMutex = nullptr;
SemaphoreHandle_t queueMutex = nullptr;
OfflineQueue *offlineQueue = nullptr;
TaskHandle_t deliveryTaskHandle = nullptr;
QueueHandle_t deliveryNotices = nullptr;
ScanFeedback scanFeedback;
std::atomic<uint8_t> queueStatus{QUEUE_OFFLINE};
std::atomic<int> queueLastHttpCode{0};
std::atomic<bool> websiteClockUsed{false};
bool scanGreenOn = false;
uint32_t scanGreenSince = 0;
// The red LED belongs to a warning notice and is switched off by the loop, not
// by a blocking delay (see showSensorWarning()).
bool warningLedOn = false;
uint32_t warningLedSince = 0;
String bootId;
std::atomic<bool> networkJoinRequested{false};
std::atomic<bool> networkScanRequested{false};
std::atomic<bool> networkRestReloadRequested{false};
std::atomic<bool> queueNeedsReview{false};

/* ── Timing (milliseconds) ────────────────────────────────────────────────── */
#define SENSOR_POLL_MS          1500  // one fingerprint check waits at most this long
/* Silent passes in a row before the link is called dead. This used to be 6,
 * which a reader that is merely busy (a full search plus a light re-assert on a
 * crowded 57600-baud line) could trip on its own: the sketch then declared the
 * sensor dead, put "SENSOR NOT answering" on the LCD, and stopped talking to it
 * - the exact "it goes dark for about five seconds and then comes back" report.
 * A truly dead link is still noticed, just after 20 passes (= a few seconds of
 * genuine silence) and only once a cheap COUNT has also gone unanswered. */
#define SENSOR_FAIL_LIMIT       20    // silent passes in a row before the link is called dead
/* The door must be ready for the next person the instant the green light goes
 * on. While a finger is still on the glass (the "do not clock this one twice"
 * latch), the sketch does not run full matches any more: it only asks the
 * reader whether something is on the glass. That one cheap command comes back
 * in tens of milliseconds, so the lift is noticed at once and the reader is
 * free for the second employee of the group. */
#define LIFT_POLL_MS            220UL
/* Some R307 variants extinguish their own illumination after a capture or after
 * answering "no finger". The re-assert below is what keeps the glass lit: right
 * after a scan (burst) and every few seconds while the door is idle. Without it
 * the reader sat dark for up to five seconds and the next person's scan looked
 * "slow" - or, during Add Fingerprint, never happened at all. */
#define READER_LAMP_BURST_MS    300UL
/* Reassert the reader light on the same idle cadence as the working firmware. */
#define READER_LAMP_IDLE_MS     700UL
/* A reader that answers the light command is never left dark for long: the
 * first two misses are retried at the normal cadence, and only a reader that
 * keeps failing drops to this gap (it costs a timeout per try, and its glass is
 * no longer something this sketch can control). A fixed number, NOT a multiple
 * of the idle cadence - shortening the cadence must never lengthen a dark gap.
 *
 * This was 4 s, which the owner experienced as "the sensor goes black and comes
 * back after about five seconds". Two missed light frames after a rejected
 * finger (a busy or garbled line) were enough to reach it. A light re-assert
 * right after a capture is now FORCED past this backoff, and the backoff itself
 * is short enough that the glass can never stay dark for a whole placement. */
#define LAMP_RETRY_BACKOFF_MS   1200UL
/* A reader that has refused the light command this many times in a row is
 * treated as one that controls its own illumination: the sketch keeps asking,
 * but only every LAMP_UNSUPPORTED_REPROBE_MS, so probing can never become the
 * thing that makes the door slow. `lamp` on Serial resets this and probes now. */
#define LAMP_UNSUPPORTED_MISSES 6
#define LAMP_UNSUPPORTED_REPROBE_MS 30000UL
/* How long one optional light command may wait for its acknowledgement. A
 * reader that supports it answers in milliseconds; keeping this short means a
 * reader that does NOT support it can never eat the scan loop while somebody is
 * standing at the door. */
#define READER_LAMP_TIMEOUT_MS  260UL
/* A weak WiFi answers slowly. Four seconds was short enough that the website was
 * given up on while the router was still delivering the reply, which is why an
 * enrollment could fail far from the router. */
#define SERVER_TIMEOUT_MS       8000  // never wait longer than this for the website
#define RESULT_SHOW_MS          1500  // enrollment/legacy result feedback
#define QUEUE_RETRY_MS          3000  // retry website failures without waiting for another scan
#define QUEUE_OFFLINE_POLL_MS   1000  // notice Wi-Fi recovery even if other network work is busy
#define WEBSITE_TIME_RETRY_MS   10000 // fallback if NTP is blocked after boot
#define WARNING_SHOW_MS         3000  // a problem stays on the LCD this long
/* A finger that stays on the glass and is not registered is looked at again on
 * every pass, forever: the door must never stop scanning. This only throttles
 * how often the SAME screen is re-announced (buzzer + red LED), so a resting
 * finger does not beep in the employee's face repeatedly.
 *
 * It was 4000 ms, which made a genuinely NEW bad press silent when the reader
 * did not report the lift in between - the owner's "it takes long before the
 * red LED and buzzer". A lift (GO_OUT / no-finger) clears the throttle outright
 * (warningKind = 0xFF), and this window only catches a hand that never left the
 * glass. */
#define WARNING_REPEAT_MS       1200
/* Like the owner's earlier working flow: two R307 captures, then one fresh
 * confirmation. The website is told "added" only when the reader itself
 * finds the new ID. No biometric acceptance/security setting is lowered.
 *
 * The waits below are deliberately short. They used to be 2.5 s each, which put
 * more than seven seconds of dead time inside a three placement job and made the
 * sensor look asleep exactly when it was asked for a finger. */
#define ENROLL_STEPS            2
#define ENROLL_VERIFY_PLACEMENTS 1
#define ENROLL_SCANS            (ENROLL_STEPS + ENROLL_VERIFY_PLACEMENTS)
#define ENROLL_PLACE_SETTLE_MS  700   // short beat after the prompt, then the reader polls
#define ENROLL_LIFT_PAUSE_MS    900   // pause for the lift between two steps (no sensor command)
/* 30 s per placement window, and a window that saw nothing is asked once more
 * (ENROLL_NO_FINGER_WINDOWS). A full minute of silence before the first retry
 * is a minute the admin spends believing the scanner is broken; two shorter
 * windows give the reader (and the person) a second chance without that wait,
 * and the worst case - nobody at the door at all - is still under a minute. */
#define ENROLL_ADD_TIMEOUT_MS   30000 // how long one placement window waits for a finger
#define ENROLL_NO_FINGER_WINDOWS 2    // windows worth trying when nothing is seen
/* Inside a placement window, if the reader has seen nothing at all: re-sync it
 * and its light once (ENROLL_RESYNC_MS), then stop promising that the glass
 * works and say on the LCD that the reader sees nothing (ENROLL_NO_SIGHT_MS).
 * These are the numbers that make "the sensor does not light up, then it says
 * no fingerprint" visible at the door instead of only in the log. */
#define ENROLL_RESYNC_MS        6000  // nothing seen for this long: re-sync the reader
#define ENROLL_NO_SIGHT_MS      10000 // nothing seen for this long: say so on the LCD
#define ENROLL_MAX_ATTEMPTS     6     // attempts allowed per step
#define ENROLL_HOLD_STILL_AT    3     // unclear images before "lift and place again"
#define ENROLL_MAX_UNCLEAR      6     // unclear images allowed per step
#define ENROLL_MAX_SESSIONS     3     // whole three-step sessions before the job fails
#define ENROLL_LIFT_BUDGET_MS   12000 // how long "LIFT YOUR FINGER" may wait
#define ENROLL_SENSE_MS         1200  // one "is the glass empty?" SEARCH waits this long
#define ENROLL_LAMP_NUDGE_MS    4000  // nothing seen for this long: ask for the reader light again
#define ENROLL_VERIFY_BUDGET_MS 90000 // the confirm scans may take this long in total
#define ENROLL_VERIFY_RETRIES   3     // extra placements when one is not found
#define ENROLL_TOTAL_BUDGET_MS  300000 // the whole job gives up after this long
#define MAPPING_RETRY_MS        10000 // retry a mapping the website did not get yet
/* Two retries stop being useful at some point. Without these caps a website
 * reply that never comes back the way this sketch expects (a captive portal's
 * 200, an older server) would keep ONE pending item alive for ever, and both
 * of those flags block every new enrollment job - "Add Fingerprint does
 * nothing any more", with no way out but a reboot. */
#define MAPPING_MAX_TRIES       30    // 30 x 10 s = five minutes of a stuck mapping
#define FAILURE_REPORT_MAX_TRIES 24   // 24 x 5 s = two minutes of a stuck report
#define PENDING_POLL_FALLBACK_MS 5000
/* The stream is one long socket. On a weak link it stalls long before it closes,
 * and a stalled stream is a door that hears about a new fingerprint late. Two
 * minutes was longer than the admin page is willing to wait. */
#define EVENT_STREAM_STALL_MS   45000

/* ── WiFi that comes back on its own (owner, Oct 2026) ────────────────────── *
 * The owner's report: "sometime when wifi is disconnected and come again my
 * system still says wifi not connected". The ESP32's own auto-reconnect gives
 * up in some router-reboot cases, and the driver can stay stuck; the board then
 * sits on a dead socket until somebody unplugs it, which is exactly what he was
 * doing ("it can be always plug in and out"). So the board now heals itself in
 * three steps, and the LCD says which one it is on. */
#define WIFI_RECONNECT_MS       8000UL   // ask the driver to reconnect this often
#define WIFI_RADIO_RESET_MS     45000UL  // after this long down: reset the radio
#define WIFI_RADIO_RETRY_MS     30000UL  // allow a slow router time to associate
#define WIFI_WEAK_RSSI          (-78)    // below this the link is called weak
#define WIFI_AP_HUNT_MS         300000UL // look for a stronger access point this often
#define WIFI_AP_HUNT_GAIN       8        // only move if it is this much stronger
#define IDLE_CLOCK_REFRESH_MS   1000   // the idle screen's clock row moves once a second
/* How long the "Scans need review" / queue alert stays up before the idle row
 * alternates back to the clock. Both must be readable: the alert is a call for
 * a human, the clock is what proves the board is alive. */
#define IDLE_ALERT_ALT_MS       2500UL

/* Rest windows: automatic awake hours generated from Role & Time shifts,
 * padded one hour before and after. Activity shows the same intervals. */
#define REST_FILE               "/rest.json"  // the schedule, cached for offline nights
#define REST_MAX_ROWS           12            // generated-window safety cap shared with the API
#define REST_SLICE_MAX_MS       600000UL      // sleep at most 10 min in one go
#define REST_MIN_SLEEP_MS       120000UL      // under 2 min a restart costs more than it saves
#define REST_SLICE_FLOOR_MS     30000UL       // the website can hurry the board, not make it churn
#define REST_AFTER_MESSAGE_MS   8000UL        // a result on the LCD is never cut short

/* ── Types (declared first so the Arduino IDE can build its prototypes) ──── */
enum EnrollResult : uint8_t {
  ENROLL_OK,
  ENROLL_NO_FINGER,
  ENROLL_UNCLEAR,
  ENROLL_LIFT_TIMEOUT,
  ENROLL_ID_IN_USE,
  ENROLL_SENSOR_FULL,
  ENROLL_SENSOR_ERROR,
  /* Every ADD command was accepted, but the module cannot find this finger
   * again on a fresh scan. Before the confirm scan existed this was the
   * device's "it says added, then it says NOT REGISTERED". */
  ENROLL_NOT_CONFIRMED,
  ENROLL_FAILED
};

/* Keep custom parameter types above the first function definition. Arduino IDE
 * inserts generated prototypes before setup(); types declared later in the
 * sketch are invisible to those prototypes. */
struct RestWindow {
  uint16_t fromMin;
  uint16_t toMin;
  bool enabled;
};

/* ── Configuration ────────────────────────────────────────────────────────── */
String serverURL = "https://fanacafe.com.et";
String deviceId = "entrance";
// Leave empty unless the owner sets ATTENDANCE_DEVICE_TOKEN on the server.
// If he does, paste the same value here so the device is allowed to call in.
String deviceToken = "";
// Optional PEM root CA for serverURL. Configure this before putting a token on
// an untrusted network; nullptr preserves the legacy core's insecure HTTPS mode.
const char *serverRootCA = nullptr;

/* NTP, for the clock on the bottom row of the LCD. Both servers are public;
 * the second one is only asked when the first does not answer. If the cafe's
 * router blocks NTP (UDP 123) the row says "Time not set yet" and everything
 * else keeps working - the clock is a convenience, never a dependency. */
const char *NTP_SERVER_A = "pool.ntp.org";
const char *NTP_SERVER_B = "time.nist.gov";
#define ET_UTC_OFFSET_SEC 10800   // Addis Ababa: UTC+3, no daylight saving

// Reader-neutral status codes used by the LCD and diagnostics. The patched library defines these too; the #ifndef
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
#ifndef BIOVO_ACK_MISMATCH
#define BIOVO_ACK_MISMATCH   0x09 // R307: the two captured views did not match
#endif
#ifndef BIOVO_ACK_FLASH_ERROR
#define BIOVO_ACK_FLASH_ERROR 0x0A // R307 could not write its memory
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
// Optional R307 LED-ON; some optical variants ignore this command.
bool readerLightSupported = false;
unsigned long lastLightRequestMs = 0;
uint16_t lampMisses = 0;   // LED-ON requests the reader did not acknowledge
/* A module that is asked something and says NOTHING is a different animal from
 * one that answers "no finger". The first is a dead link (power, wiring, a
 * module that reset itself mid-scan); the second is a working scanner with an
 * empty glass. Before this counter existed, a link that died after boot was
 * invisible: the LCD kept showing the idle screen, every scan attempt timed out
 * quietly, and the person at the door got no answer at all - "the LCD works but
 * the sensor does not scan" with nothing on screen and nothing in the log. */
uint8_t sensorSilentPasses = 0;
uint8_t sensorLastStatus = 0xFF;      // the raw status byte of the last answer
unsigned long sensorLastReplyMs = 0;  // the last frame that made any sense
bool sensorLinkReported = false;      // the LCD/Serial have been told about this loss
/* What the last `sensor` link test measured. Kept as variables, not only as
 * printed text: the status page shows them, and the host suite can assert on
 * the count the test reported instead of on a log line nobody parses. */
/* How long one scan attempt waits for the module. It starts at the polling
 * budget and grows when the module proves it is only busy: a SEARCH across a
 * few hundred templates can take longer than 1.5 s, and mistaking that for a
 * dead link would switch a working door off. */
uint16_t sensorPollMs = SENSOR_POLL_MS;
#define SENSOR_POLL_MAX_MS      4000  // never wait longer than this for one scan
uint16_t sensorTestRounds = 0;
uint16_t sensorTestAnswered = 0;
uint16_t sensorTestSilent = 0;
uint16_t sensorTestGarbled = 0;
int templateCount = -1;

// True once NTP has answered, so the LCD can show the wall clock.
bool timeReady = false;

/* UTC time and the 64-bit monotonic uptime at the same moment. The critical
 * section keeps the pair consistent when the network task reads it. */
unsigned long epochAtSync = 0;
uint64_t uptimeAtSyncSeconds = 0;
portMUX_TYPE clockMux = portMUX_INITIALIZER_UNLOCKED;
// Only the scanner task changes this flag; anchor files survive later reboots.
bool pendingUnknownTime = false;

// Throttle for noteWallClock(): reading the clock once a second is plenty.
unsigned long lastWallClockNote = 0;

/* True while the IDLE screen is what the glass shows. Only then does the once
 * a second clock refresh redraw it: a result message or an enrollment screen
 * must never be overwritten by the clock row. */
bool idleVisible = false;

// One scan per placement: after a finger is reported, nothing else is reported
// until the sensor says the finger is gone. A finger left on the glass for
// minutes therefore clocks once and shows one message.
//
// This latch belongs to a MATCH only. A refused placement (unregistered or
// unclear finger) must never set it: the door has to keep looking at whatever
// is on the glass, at any moment, without a dark window.
bool awaitingFingerLift = false;
// Which refusal is currently announced (0xFF = none) and when it was announced.
// Only the announcement is throttled; the searching never is.
uint8_t warningKind = 0xFF;
uint32_t warningShownAt = 0;

// fingerprintId -> staff name, from the website (refreshed in real time).
std::map<int, String> fingerprintToStaff;
std::map<int, int> fingerprintToMember;
/* The last enrollment attempt changes the physical interaction: instead of
 * "place, lift, place again" it takes both captures from ONE steady press.
 * The repository's own diagnostic notes record this as the flow the shipped
 * firmware used before October 2026, and on a reader whose optics lose the
 * finger between two placements it is the difference between "not added" and a
 * stored finger. It is only used after the normal flow has already failed
 * twice, so the preferred, rotation-tolerant flow is still what runs first. */
bool enrollKeepFingerDown = false;

/* True once a COMPLETE name list has been read at least once - from the website
 * or from the copy in flash. Add Fingerprint uses this: it has to know whether
 * an ID already belongs to somebody before it can clear that slot, and a weak
 * link must not be allowed to turn "Add Fingerprint" into a failure when the
 * door already has the list saved. */
bool mappingListKnown = false;

// Add Fingerprint jobs: a job is attempted once. A job that failed is reported
// to the website and never retried by this device, so it cannot loop.
bool enrollingFromServer = false;
int lastHandledJobId = 0;
// If reporting a failed enrollment is interrupted, retry the report rather
// than silently abandoning the pending website job. Used by the network task.
int pendingFailureJobId = 0;
String pendingFailureReason = "";
uint32_t pendingFailureRetryAt = 0;
uint16_t pendingFailureTries = 0;

// The exact reason for the outcome of the last enrollment, for the Serial log
// and for the website ("step 2/3 not accepted: image unclear (status 6)",
// or "sensor did not find the finger after saving it (status 5: NOT REGISTERED)").
// The admin page prints it, so a failure is never a silent spinner again.
String enrollDetail = "";

// A finger was enrolled on the sensor but the website did not get the mapping
// yet (no internet). The device keeps sending it until the website accepts it.
bool mappingPending = false;
uint16_t mapPendingTries = 0;
int mapFingerprintId = 0;
int mapMemberId = 0;
int mapJobId = 0;
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

/* ── WiFi health, for the LCD and the status page ─────────────────────────── */
std::atomic<unsigned long> wifiDownSince{0};      // millis() when the link went down, 0 = up
unsigned long lastWifiTry = 0;
unsigned long lastWifiLog = 0;
unsigned long lastApHunt = 0;
std::atomic<uint16_t> wifiReconnects{0};          // times the link came back by itself
unsigned long lastWifiRadioReset = 0; // do not reset faster than association can finish
std::atomic<uint16_t> wifiRadioResets{0};         // times the radio had to be reset
std::atomic<int> wifiLastRssi{0};                 // last dBm reading, 0 = unknown

/* ── Prototypes ───────────────────────────────────────────────────────────── */
void showLines(const String &l1, const String &l2, const String &l3, const String &l4);
void showBig(const String &top, const String &big, const String &bottom);
void showEnrollScreen(const String &who, int id, uint8_t done, const String &prompt, const String &hint);
void showIdleScreen();
void startTimeSync();
void applyWifiTuning();
void serviceWifi();
void networkTask(void *arg);
void deliveryTask(void *arg);
void wakeDeliveryTask();
void updateScanFeedback();
void renderScanFeedback();
bool syncTimeFromWebsite();
void loadCachedMappings();
bool mappedNameForId(int id, String &name);
bool mappedPersonForId(int id, String &name, int &memberId);
void rememberMapping(int id, const String &name, int memberId);
String wifiStatusLine();
String wifiMeter(int rssi);
String idleAlertLine();
void rejoinStrongestAp();
String wallClockText();
unsigned long wallClockEpoch();
void noteWallClock();
unsigned long scanEpochAtUptime(uint64_t uptimeMs);
unsigned long scanEpochNow();
void refreshIdleClock();
bool startLcd();
void checkLcdHealth();
void beepSuccess();
void beepError();
bool detectSensor(uint8_t tries);
void keepReaderLampOn(uint32_t minGapMs, bool force = false);
void nudgeReaderLamp();
void maintainReaderLight();
void reassertReaderLight();
bool sensorAnswers();
int glassHasFinger();
bool freeLeftoverTemplate(int id);
int waitGlassEmpty(const String &who, int id, uint32_t budgetMs, uint8_t progress);
int searchGlass(uint16_t &matchedId, uint32_t waitMs);
bool enrollMappingsAreCurrent();
bool saveMappingCache();
EnrollResult runCaptureSession(int id, const String &who, uint32_t deadlineMs);
EnrollResult confirmEnrolledFinger(int id, const String &who, uint32_t deadlineMs);
EnrollResult enrollFingerprint(int id, const String &who);
const char *enrollReason(EnrollResult result);
void scanForFinger();
void handleVerifiedFinger(int fingerprintId, uint64_t capturedUptimeMs);
int postClock(int fingerprintId, String &body);
void showClockAnswer(const String &fallbackName, const String &body);
void showRefused(const String &name, const String &body);
void showSensorWarning(const String &title, const String &line2, const String &line3);
bool checkPendingEnroll();
int postMappingToServer(int fingerprintId, int memberId, const String &memberName);
void reportJobStarted(int jobId, int fingerprintId);
void reportJobFailed(int jobId, const String &reason);
void retryPendingEnrollmentFailure();
void retryPendingMapping();
void keepServerLinkAlive();
void stopEventStream();
void startEventStream();
void pumpEventStream();
bool loadMappingsFromServer(uint32_t timeoutMs = SERVER_TIMEOUT_MS);
bool saveToQueue(int fingerprintId, const String &staffName, int memberId, unsigned long scannedAt, uint64_t uptimeMs, String &eventId);
QueueSyncResult syncOfflineQueue();
void periodicSync();
void maybeRest();
void loadRestScheduleFromServer();
void loadRestCache();
void handleSerialCommand();
void printWifiReport();
void printWifiScan();
void manualEnroll(int id);
void checkSensorHealth();
void emptyDatabase();
void listFingerprints();
void testSensor();
void watchSensor(int seconds);
void testSensorLink(uint16_t rounds, uint32_t gapMs, const char *label);
void configureWifiManager(WiFiManager &wm);
void handleRoot();
void handleStatus();
void addDeviceHeaders(HTTPClient &http);
void beginServerRequest(HTTPClient &http, const String &path);
const char *fingerStatusText(uint8_t s);

/* ── Setup and loop ───────────────────────────────────────────────────────── */
void setup() {
  Serial.begin(115200);
  Serial.println("\n\nFANA CAFE Attendance - R307 + ESP32 WROOM");

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

  // Never format automatically on a mount failure: it could erase queued scans.
  if (!LittleFS.begin(false)) {
    Serial.println("LittleFS mount failed; offline scans cannot be saved. Ask admin to inspect storage.");
  }

  // R307: 57600 8N1 is the common factory default.
  mySerial.begin(57600, SERIAL_8N1, SENSOR_RX_PIN, SENSOR_TX_PIN);
  delay(800);

  // detectSensor also reads the reader's capacity, including after a late boot.
  sensorReady = detectSensor(5);
  if (sensorReady) {
    Serial.print("Found R307 fingerprint sensor, templates: ");
    Serial.println(templateCount);
    showLines("R307 Found!", "Ready to scan", "", "");
    beepSuccess();
    delay(1000);
  } else {
    Serial.println("Did not find fingerprint sensor. Check wiring: TX->16 RX->17, GND, VCC, baud 57600.");
    showLines("R307 NOT found", "Check wiring:", "TX->16  RX->17", "GND + VCC");
    beepError();
    delay(3000);
    // checkSensorHealth() keeps looking every 5 s, so a late sensor still works.
  }

  if (deviceToken.length() > 0 && (!serverURL.startsWith("https://") || !serverRootCA || !serverRootCA[0]))
    Serial.println("WARNING: device token configured without verified HTTPS and a trusted root CA");
  // Start the scanner immediately, even when the router is absent or a setup
  // portal is waiting. Load the names already cached in flash without HTTP.
  sensorMutex = xSemaphoreCreateMutex();
  mappingMutex = xSemaphoreCreateMutex();
  queueMutex = xSemaphoreCreateMutex();
  deliveryNotices = xQueueCreate(16, sizeof(DeliveryNotice));
  char id[17];
  snprintf(id, sizeof(id), "%08lx%08lx", (unsigned long)esp_random(), (unsigned long)esp_random());
  bootId = String(id);
  if (queueMutex) offlineQueue = new OfflineQueue(LittleFS, queueMutex);
  queueNeedsReview = LittleFS.exists("/queue.review.jsonl");
  loadCachedMappings();
  loadRestCache();
  showIdleScreen();

  if (!sensorMutex || !mappingMutex || !queueMutex || !offlineQueue) {
    Serial.println("Could not create scanner locks: network disabled; inspect memory. Scans may not be saved.");
    return; // never run two tasks against an unprotected reader/queue
  }
  if (!deliveryNotices) Serial.println("Could not create delivery display queue; confirmations will be logged on Serial");
  const BaseType_t deliveryStarted = xTaskCreatePinnedToCore(deliveryTask, "attendance-delivery", 12288, nullptr, 1, &deliveryTaskHandle, 0);
  if (deliveryStarted != pdPASS) {
    queueStatus = QUEUE_ERROR;
    Serial.println("Delivery task could not start; scans remain local. Inspect memory.");
  }
  const BaseType_t started = xTaskCreatePinnedToCore(networkTask, "attendance-network", 16384, nullptr, 1, nullptr, 0);
  if (started != pdPASS) Serial.println("Network task could not start; scans remain local. Inspect memory.");
}

void loop() {
  // None of these calls opens an HTTP connection or waits for Wi-Fi. A remote
  // enrollment temporarily holds this lock because it intentionally owns the
  // sensor; ordinary reconnects and queue delivery never take it.
  if (!sensorMutex || xSemaphoreTake(sensorMutex, 0) == pdTRUE) {
    noteWallClock();
    checkSensorHealth();
    checkLcdHealth();
    updateScanFeedback();
    refreshIdleClock();
    if (sensorReady) {
      maintainReaderLight();
      scanForFinger();
    }
    updateScanFeedback();
    handleSerialCommand();
    maybeRest();
    if (sensorMutex) xSemaphoreGive(sensorMutex);
  }
  delay(5);
}

void networkTask(void *) {
  WiFiManager wm;
  configureWifiManager(wm);
  // autoConnect can wait for an unavailable router, but it runs ONLY in this
  // task. The nonblocking portal is serviced below while the door keeps reading.
  wm.setConfigPortalBlocking(false);
  const bool connected = wm.autoConnect("Fana-Attendance-Setup", "fana12345");
  startTimeSync(); // certificate validation may need the correct clock
  if (connected) {
    applyWifiTuning();
    loadMappingsFromServer();
    loadRestScheduleFromServer();
  } else Serial.println("WiFi not connected yet. Still scanning and retrying in the background.");
  server.on("/status", handleStatus);
  server.on("/", handleRoot);
  bool statusServerStarted = false;
  for (;;) {
    wm.process();
    const bool portalActive = wm.getConfigPortalActive();
    // WiFiManager's portal also uses port 80. Do not start a second listener
    // until the portal is closed, or first-time Wi-Fi setup can break.
    if (!portalActive && !statusServerStarted) {
      server.begin();
      statusServerStarted = true;
    } else if (portalActive && statusServerStarted) {
      server.stop();
      statusServerStarted = false;
    }
    // Do not reset the radio while a first-time setup portal owns it.
    if (!portalActive) serviceWifi();
    if (statusServerStarted) server.handleClient();
    if (networkJoinRequested.exchange(false)) {
      stopEventStream();
      WiFi.disconnect(false, false);
      delay(100);
      WiFi.begin();
    }
    if (networkScanRequested.exchange(false)) {
      printWifiScan();
    }
    if (networkRestReloadRequested.exchange(false)) {
      loadRestScheduleFromServer();
    }
    retryPendingEnrollmentFailure();
    keepServerLinkAlive();
    retryPendingMapping();
    periodicSync();
    delay(25);
  }
}

/* ── 20x4 LCD helpers ─────────────────────────────────────────────────────── *
 * The screen is 20 characters wide and 4 rows tall, so every row is written
 * as EXACTLY 20 characters: a shorter line is padded with spaces, which wipes
 * whatever was there before. A row is only re-sent to the LCD when its text
 * really changed, and lcd.clear() runs once (in startLcd()), so the screen
 * never flickers while it is being updated.
 * Layout used by this sketch:
 *   idle        Fana Cafe Attendance / Place finger - ready / Wifi (Not) Connected / Time HH:MM:SS
 *   result      name / big word / (continuation) / note
 *   enrollment  Enroll <who> / ID n [....] k/4 / instruction / hint
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
// power). Never during enrollment: the captures must not be interrupted.
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
/* ── Automatic scanner rest windows ────────────────────────────────────────
 * The server derives these windows from every saved Role & Time shift: each
 * shift is padded one hour before and after, then overlapping or adjacent
 * windows (including across midnight) are merged. Role schedules recur daily
 * because there are no weekday fields. The ESP32 receives the already-generated
 * windows in GET /api/attendance/activity's existing device payload and caches
 * that payload in LittleFS; the fingerprint reader sleeps only in the gaps.
 *
 * A missing/empty schedule fails open to awake all day, and a schedule too
 * large for REST_MAX_ROWS also arrives as an all-day awake window. That prevents
 * a missing or truncated schedule from locking the door. The tablet PIN and
 * paper sheet do not depend on this scanner schedule.
 *
 * An awake board refreshes from the live device event. A board already in deep
 * sleep cannot hear a push: it fetches changes at its next timer wake (at most
 * the normal 10-minute slice, or sooner at a scheduled boundary). A fresh
 * change then shortens subsequent slices to 45 seconds. The cached schedule
 * continues to work offline. Sleep is entered only between actions, never
 * during a scan, enrollment, queue flush, or an LCD result message.
 */

RestWindow restWindows[REST_MAX_ROWS];
uint8_t restWindowCount = 0;
/* True once a schedule has been read, from the server or from the flash cache.
 * Until then the device never sleeps: guessing with nothing to go on is how a
 * door ends up closed. */
bool restScheduleKnown = false;
/* The admin's "keep it awake" override and its "for N minutes" form. Both
 * come from the website and are cached across timer wakes. */
bool restKeptAwake = false;
// Always-on attendance is the safe default, independent of Wi-Fi and website
// schedules. A technician may explicitly opt back into sleep with `rest on`.
std::atomic<bool> scannerAlwaysOn{true};
unsigned long restWakeUntilEpoch = 0;
/* The longest sleep the website will allow after the next schedule read, in
 * seconds: about 45 s after an admin changes role hours or opens a "place your
 * finger" job, 600 s on a quiet night. A timer already running in deep sleep
 * cannot be shortened remotely. 0 means "use the default". */
uint16_t restSliceSeconds = 0;
/* The last moment the LCD showed something, so a rest never cuts a result off
 * while the person is still reading it. */
unsigned long lastLcdMessageMs = 0;
/* What the last decision was, for Serial and the status page. */
uint32_t restLastSleepMs = 0;
uint16_t restLastWakeMinute = 0;

/* Minutes since midnight on the Addis clock. The device carries no timezone
 * database: UTC+3, no daylight saving, is the whole rule - the same one the
 * LCD's clock row and the offline scan stamps use. */
uint16_t minuteOfAddisDay(unsigned long epoch) {
  return (uint16_t)(((epoch + (unsigned long)ET_UTC_OFFSET_SEC) / 60UL) % 1440UL);
}

String minuteLabel(uint16_t minuteOfDay) {
  char buf[6];
  snprintf(buf, sizeof(buf), "%02u:%02u", (unsigned)((minuteOfDay / 60) % 24), (unsigned)(minuteOfDay % 60));
  return String(buf);
}

/* "09:05" -> 545. Anything else is 0xFFFF, and a row that does not read as a
 * time is dropped rather than guessed at. */
uint16_t hhmmToMinutes(const String &text) {
  String t = text;
  t.trim();
  if (t.length() != 5 || t[2] != ':') return 0xFFFF;
  const int h = t.substring(0, 2).toInt();
  const int m = t.substring(3, 5).toInt();
  if (h < 0 || h > 23 || m < 0 || m > 59) return 0xFFFF;
  return (uint16_t)(h * 60 + m);
}

/* Half-open [from, to): the last minute of an open hour is the minute BEFORE it
 * closes, so 12:00-15:00 is awake at 14:59 and resting at 15:00. A `to`
 * earlier than its `from` runs across midnight (22:00-06:00). from == to is the
 * WHOLE day, never nothing. */
bool windowHasMinute(uint16_t fromMin, uint16_t toMin, uint16_t minuteOfDay) {
  if (fromMin == toMin) return true;
  if (fromMin < toMin) return minuteOfDay >= fromMin && minuteOfDay < toMin;
  return minuteOfDay >= fromMin || minuteOfDay < toMin;
}

/* Should the scanner be awake at this minute?
 *
 * Role & Time generates the active rows. No generated window, or no enabled
 * cached row, means yes - all day. That is a fail-open safety rule: a missing or
 * stale schedule cannot lock the owner out. Keep-awake overrides handle
 * temporary access; the website's isAwakeAt() applies the same empty-schedule
 * rule, and the two must not disagree. */
bool scheduleAwaits(const RestWindow *rows, uint8_t count, uint16_t minuteOfDay) {
  bool anyEnabled = false;
  for (uint8_t i = 0; i < count; i++) {
    if (!rows[i].enabled) continue;
    anyEnabled = true;
    if (windowHasMinute(rows[i].fromMin, rows[i].toMin, minuteOfDay)) return true;
  }
  return !anyEnabled;
}

/* Minutes until the answer flips. Walking the clock one minute at a time is on
 * purpose: 1440 cheap steps, no boundary arithmetic to get wrong, and a window
 * that wraps midnight needs no special case. 1440 means "it never flips". */
uint16_t minutesUntilScheduleChange(const RestWindow *rows, uint8_t count, uint16_t minuteOfDay) {
  const bool awake = scheduleAwaits(rows, count, minuteOfDay);
  for (uint16_t step = 1; step <= 1440; step++) {
    const uint16_t at = (uint16_t)((minuteOfDay + step) % 1440);
    if (scheduleAwaits(rows, count, at) != awake) return step;
  }
  return 1440;
}

/* How long one sleep may be, right now. The website asks for it short while
 * something is expected (a change it just made, a finger job waiting for a
 * person), and the clamp is what keeps a badly behaved or brand new server from
 * turning the door into a reboot every few seconds: never under 30 s, never
 * over the slice cap. */
uint32_t restSliceMs() {
  if (restSliceSeconds == 0) return REST_SLICE_MAX_MS;
  uint32_t ms = (uint32_t)restSliceSeconds * 1000UL;
  if (ms < REST_SLICE_FLOOR_MS) ms = REST_SLICE_FLOOR_MS;
  if (ms > REST_SLICE_MAX_MS) ms = REST_SLICE_MAX_MS;
  return ms;
}

/* THE DECISION, apart from the sleeping, so the host suite can drive it:
 * should this board sleep now, for how long, and at which minute of the day is
 * the door open again? The sleep is capped at one slice; the wake MINUTE is the
 * real schedule boundary, because that is the hour the person at the door is
 * told about - a slice ending at 03:07 does not make the door open at 03:07. */
bool restShouldSleep(const RestWindow *rows, uint8_t count, uint16_t minuteOfDay, uint32_t maxSleepMs,
                     uint32_t *sleepMsOut, uint16_t *wakeMinuteOut) {
  if (scheduleAwaits(rows, count, minuteOfDay)) return false;
  const uint16_t waitMin = minutesUntilScheduleChange(rows, count, minuteOfDay);
  const uint32_t waitMs = (uint32_t)waitMin * 60000UL;
  // Waking up costs a few seconds of WiFi and NTP, so a wait shorter than two
  // minutes is churn rather than rest: stay up and let the boundary pass.
  if (waitMs < REST_MIN_SLEEP_MS) return false;
  uint32_t ms = waitMs;
  if (ms > maxSleepMs) ms = maxSleepMs;
  if (sleepMsOut) *sleepMsOut = ms;
  if (wakeMinuteOut) *wakeMinuteOut = (uint16_t)((minuteOfDay + waitMin) % 1440);
  return true;
}

String restScheduleSummary() {
  if (!restScheduleKnown) return String("no schedule read yet - staying awake");
  if (restWindowCount == 0) return String("always awake (no hours listed)");
  String out;
  for (uint8_t i = 0; i < restWindowCount; i++) {
    if (i) out += " ";
    out += minuteLabel(restWindows[i].fromMin);
    out += "-";
    out += minuteLabel(restWindows[i].toMin);
    if (!restWindows[i].enabled) out += "(off)";
  }
  return out;
}

/* { "device": { "windows": [ { "from": "06:00", "to": "10:00", "enabled": true } ],
 *              "keptAwake": false, "wakeUntilEpoch": 0 } }
 * The answer of GET /api/attendance/activity is stored verbatim, so this reads
 * both the live call and the flash cache with the same code. `device` is
 * preferred; the flat keys are accepted too, which is what an older server
 * answer would look like. */
bool parseRestPayload(const String &payload) {
  DynamicJsonDocument doc(3072);
  if (deserializeJson(doc, payload)) return false;
  JsonObject root = doc.as<JsonObject>();
  JsonObject device = root["device"];
  // The website answers with a `device` object shaped for this parser; an older
  // server's flatter answer is read the same way, so a mixed fleet still works.
  JsonObject src = device["windows"].isNull() ? root : device;
  if (src["windows"].isNull()) return false;   // no list at all is not the same as an empty one

  size_t total = src["windows"].size();
  if (total > REST_MAX_ROWS) total = REST_MAX_ROWS;
  uint8_t n = 0;
  for (size_t i = 0; i < total; i++) {
    JsonObject w = src["windows"][i].as<JsonObject>();
    const uint16_t from = hhmmToMinutes(w["from"].as<String>());
    const uint16_t to = hhmmToMinutes(w["to"].as<String>());
    if (from == 0xFFFF || to == 0xFFFF) {
      Serial.print("Rest row skipped, not a time: ");
      Serial.print(w["from"].as<const char *>());
      Serial.print("/");
      Serial.println(w["to"].as<const char *>());
      continue;
    }
    restWindows[n].fromMin = from;
    restWindows[n].toMin = to;
    restWindows[n].enabled = w["enabled"].isNull() ? true : w["enabled"].as<bool>();
    n++;
  }
  restWindowCount = n;
  restKeptAwake = src["keptAwake"].isNull() ? false : src["keptAwake"].as<bool>();
  restWakeUntilEpoch = src["wakeUntilEpoch"] | 0UL;
  // "sleep at most N seconds on subsequent slices for a while". A request
  // cannot interrupt a timer that was already started before this fetch.
  restSliceSeconds = (uint16_t)(src["sliceSeconds"] | 0UL);
  restScheduleKnown = true;
  return true;
}

/* The schedule as it was last heard from the website. A board that cannot ask
 * the server still knows when its door is open. */
void loadRestCache() {
  if (!LittleFS.exists(REST_FILE)) return;
  File f = LittleFS.open(REST_FILE, "r");
  if (!f) return;
  const String payload = f.readString();
  f.close();
  if (parseRestPayload(payload)) {
    Serial.print("Rest schedule from flash: ");
    Serial.println(restScheduleSummary());
  }
}

void loadRestScheduleFromServer() {
  // The owner asked for a continuously available scanner; website schedules
  // have no power to put it to sleep unless `rest on` is explicitly selected.
  if (scannerAlwaysOn) return;
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.setTimeout(SERVER_TIMEOUT_MS);
  beginServerRequest(http, "/api/attendance/activity");
  if (deviceToken.length() > 0) http.addHeader("x-attendance-device", deviceToken);
  const int httpCode = http.GET();
  if (httpCode == 200) {
    const String payload = http.getString();
    http.end();
    if (sensorMutex && xSemaphoreTake(sensorMutex, pdMS_TO_TICKS(2000)) != pdTRUE) return;
    const bool parsed = parseRestPayload(payload);
    if (sensorMutex) xSemaphoreGive(sensorMutex);
    if (parsed) {
      File f = LittleFS.open(REST_FILE, "w");
      if (f) {
        f.print(payload);
        f.close();
      }
      Serial.println("Rest schedule loaded");
    } else {
      Serial.println("Rest schedule answer was not readable; keeping the last one");
    }
    return;
  }
  http.end();
  // A server that has no such route yet, or a 500, must not turn into "the
  // schedule is empty". The last good answer, cached in flash, still rules.
  if (!sensorMutex || xSemaphoreTake(sensorMutex, pdMS_TO_TICKS(2000)) == pdTRUE) {
    if (!restScheduleKnown) loadRestCache();
    if (sensorMutex) xSemaphoreGive(sensorMutex);
  }
}

/* Deep sleep, and it does not return: the board restarts as if it was just
 * powered up, re-reads the schedule, and carries on from there. */
void goRest(uint32_t sleepMs, uint16_t wakeMinute) {
  restLastSleepMs = sleepMs;
  restLastWakeMinute = wakeMinute;
  Serial.print("Resting for ");
  Serial.print(sleepMs / 1000UL);
  Serial.print(" s; the door is open again at ");
  Serial.println(minuteLabel(wakeMinute));
  showLines("RESTING", "Door closed", "Open again at " + minuteLabel(wakeMinute), "");
  delay(1500);
  if (lcdReady) lcd.noBacklight();   // a dark screen, not a frozen one
  esp_sleep_enable_timer_wakeup((uint64_t)sleepMs * 1000ULL);
  esp_deep_sleep_start();
}

/* Called at the end of every loop pass, when nothing is in progress. */
void maybeRest() {
  if (scannerAlwaysOn) return;
  if (!restScheduleKnown) return;
  if (enrollmentActive || enrollingFromServer) return;   // never sleep mid-job
  if (millis() - lastLcdMessageMs < REST_AFTER_MESSAGE_MS) return;  // let it be read
  const unsigned long epoch = scanEpochNow();
  if (epoch == 0UL) return;    // no trusted clock since boot: a wrong clock must not close a door
  if (restKeptAwake) return;   // the admin is keeping it awake
  if (restWakeUntilEpoch != 0UL && epoch < restWakeUntilEpoch) return;

  const uint16_t minute = minuteOfAddisDay(epoch);
  uint32_t sleepMs = 0;
  uint16_t wakeMinute = 0;
  if (!restShouldSleep(restWindows, restWindowCount, minute, restSliceMs(), &sleepMs, &wakeMinute)) return;
  goRest(sleepMs, wakeMinute);
}

/* `rest` on the Serial monitor: what the board believes, and a way to override
 * it without a reflash when somebody is standing at the door. */
void restCommand(const String &argIn) {
  String arg = argIn;
  arg.trim();
  arg.toLowerCase();
  if (arg.length() == 0 || arg == "show") {
    Serial.print("Always-on mode: ");
    Serial.println(scannerAlwaysOn ? "ON (scanner stays awake)" : "OFF (schedule may sleep it)");
    Serial.print("Rest windows: ");
    Serial.println(restScheduleSummary());
    Serial.print("Now: ");
    const unsigned long epoch = scanEpochNow();
    if (epoch == 0UL) {
      Serial.println("no clock yet from NTP, so rest is refused");
      return;
    }
    const uint16_t minute = minuteOfAddisDay(epoch);
    Serial.print(minuteLabel(minute));
    Serial.println(scheduleAwaits(restWindows, restWindowCount, minute) ? " - awake" : " - resting");
    Serial.print("Kept awake by: ");
    Serial.println(restKeptAwake ? "the admin switch" : "nobody");
    Serial.print("Sleeps for at most: ");
    Serial.print((unsigned long)(restSliceMs() / 1000UL));
    Serial.println(restSliceSeconds > 0 ? " s, because the website expects a change" : " s");
    return;
  }
  if (arg == "off") {
    scannerAlwaysOn = true;
    restKeptAwake = true;
    restWakeUntilEpoch = 0UL;
    Serial.println("Rest is OFF: the scanner stays awake. Type `rest on` to let the hours rule again.");
    showLines("Rest OFF", "Scanner stays awake", "", "");
    return;
  }
  if (arg == "on") {
    scannerAlwaysOn = false;
    restKeptAwake = false;
    restWakeUntilEpoch = 0UL;
    Serial.println("Rest explicitly enabled; the scanner can sleep outside the website schedule.");
    networkRestReloadRequested = true;
    return;
  }
  if (arg == "reload") {
    networkRestReloadRequested = true;
    return;
  }
  Serial.println("Rest commands: rest show | rest off | rest on | rest reload");
}

void showLines(const String &l1, const String &l2, const String &l3, const String &l4) {
  idleVisible = false;
  lastLcdMessageMs = millis();   // something else is on the glass now: no clock refresh
  lcdWriteRow(0, l1);
  lcdWriteRow(1, l2);
  lcdWriteRow(2, l3);
  lcdWriteRow(3, l4);
}

// Who on top, the big word in the middle of the screen (a word longer than
// one row continues on the next row), the note at the bottom.
void showBig(const String &top, const String &big, const String &bottom) {
  idleVisible = false;
  lcdWriteRow(0, top);
  lcdWriteRow(1, lcdCenter(big.substring(0, LCD_COLS), LCD_COLS));
  lcdWriteRow(2, lcdCenter(big.length() > LCD_COLS ? big.substring(LCD_COLS) : "", LCD_COLS));
  lcdWriteRow(3, bottom);
}

// Enrollment screen: who, ID, the two captures plus the confirm scan as a text
// progress bar, the instruction in the middle and the finer hint at the
// bottom. The old 128x64 progress rectangle is a text bar now: one '#' per
// accepted capture (the last cell is the confirm scan).
void showEnrollScreen(const String &who, int id, uint8_t done, const String &prompt, const String &hint) {
  String bar;
  for (uint8_t i = 0; i < ENROLL_SCANS; i++) bar += (i < done ? '#' : '.');
  idleVisible = false;   // an enrollment is never interrupted by the clock
  lcdWriteRow(0, who.length() > 0 ? "Enroll " + who : String("Enroll finger"));
  lcdWriteRow(1, "ID " + String(id) + " [" + bar + "] " + String(done) + "/" + String(ENROLL_SCANS));
  lcdWriteRow(2, lcdCenter(prompt, LCD_COLS));
  lcdWriteRow(3, hint);
}

/* ── THE IDLE SCREEN (owner, Oct 2026) ───────────────────────────────────── *
 *   row 0   Fana Cafe Attendance            whose door this is
 *   row 1   Place finger - ready            what to do - or SENSOR OFFLINE!
 *                                           when the scanner itself is not
 *                                           answering, so nobody keeps
 *                                           pressing a dead glass
 *   row 2   Connected -58dB #### / Offline 34s - saved
 *                                           "depends on the situation, that
 *                                           will be more clear and useful":
 *                                           one plain word about whether the
 *                                           scan will reach the website, and
 *                                           when it will not, that the scan is
 *                                           kept on the device anyway
 *   row 3   Time HH:MM:SS                   the wall clock ("this will be very
 *                                           useful"), from NTP, on Ethiopian
 *                                           time - or "Time not set yet" while
 *                                           NTP has not answered
 *
 * The old row 2 carried the device's IP address and the old row 3 the template
 * count. Both are still on the local status page and on the Serial monitor,
 * where the person who needs them looks; the person at the door needs the two
 * things above instead.
 * ───────────────────────────────────────────────────────────────────────── */
/* The line that matters when something needs a human: a scan kept for review,
 * a damaged queue, or a website that keeps refusing. Empty when all is well. */
String idleAlertLine() {
  if (queueNeedsReview) return String("Scans need review");
  const uint8_t status = queueStatus.load();
  if (status == QUEUE_STORAGE_ERROR) return String("Queue needs help");
  if (status == QUEUE_ERROR) return String("Sync waiting");
  return String("");
}

/* IDLE CARD (owner, Oct 2026) - four rows, and the Wi-Fi row is ALWAYS there:
 *
 *   row 0  Fana Cafe Attendance
 *   row 1  Place finger - ready          (or SENSOR OFFLINE!)
 *   row 2  Connected -58dB ████          live status, number and four blocks
 *   row 3  Time 09:41:07                 alternating with an alert when needed
 *
 * The owner asked for the connection status, the signal number and the four
 * blocks to be restored, AND for the "Scans need review" line. They used to
 * compete for the same row, so the signal disappeared exactly when something
 * needed attention. Now the signal keeps its own row always, and an alert
 * shares row 3 with the clock, alternating every IDLE_ALERT_ALT_MS so both stay
 * readable and the clock never stops moving. */
void showIdleScreen() {
  lcdWriteRow(0, "Fana Cafe Attendance");
  // The prompt says what the reader is doing: always listening, never "wait".
  lcdWriteRow(1, sensorReady ? "Place finger - ready" : String("SENSOR OFFLINE!"));
  // Connection status + dBm + four blocks, in one 20-character row.
  lcdWriteRow(2, wifiStatusLine());
  const String clock = wallClockText();
  const String clockLine = clock.length() > 0 ? "Time " + clock : String("Time not set yet");
  const String alert = idleAlertLine();
  // Alternate: the alert gets every other 2.5 s slot, the clock keeps the rest.
  const bool alertTurn = alert.length() > 0 && ((millis() / IDLE_ALERT_ALT_MS) % 2UL) == 1UL;
  lcdWriteRow(3, alertTurn ? alert : clockLine);
  idleVisible = true;    // the clock refresh may redraw this screen from now on
}

// The queue stores UTC epoch seconds; the cafe's wall clock is UTC+3.
String capturedTimeText(uint32_t epoch) {
  if (!epoch) return "Time not set yet";
  const uint32_t day = (epoch + ET_UTC_OFFSET_SEC) % 86400UL;
  char value[15];
  snprintf(value, sizeof(value), "Time %02u:%02u:%02u",
           (unsigned)(day / 3600U), (unsigned)((day / 60U) % 60U), (unsigned)(day % 60U));
  return String(value);
}

void renderScanFeedback() {
  const DeliveryNotice &notice = scanFeedback.current();
  const String name = String(notice.name);
  const String when = capturedTimeText(notice.scannedAt);
  switch (scanFeedback.phase()) {
    case ScanFeedback::IDLE: showIdleScreen(); break;
    /* THE CARD THE OWNER ASKED FOR (Oct 2026), four rows:
     *
     *   row 0  employee name          recognised locally, from the saved list
     *   row 1  Time HH:MM:SS          the moment the image was taken
     *   row 2  Verifying....          then Sent to website / Stored offline queue
     *   row 3  what happens next
     *
     * "Recognise it locally and immediately show the employee's name, scan time
     *  and Verifying...." - that is the first frame, shown before any network
     * work. The green LED and one success beep run with it. When the green
     * indication finishes (ScanFeedback::GREEN_SHOW_MS) the screen stops saying
     * "Please wait" and reports where the scan actually is:
     *
     *   Sent to website         the website confirmed THIS exact scan
     *   Stored offline queue    nothing was confirmed: it is safe in the queue
     *                           and uploads by itself when the link returns
     *
     * A Wi-Fi association alone is never shown as "sent": only the website's own
     * receipt for this event flips the screen to Sent. A slow link keeps
     * "Verifying...." (with "Sending to site" underneath) until the receipt
     * arrives or the round-trip budget runs out - it never claims the scan was
     * stored while the website is still answering (owner's earlier report:
     * "even with Wi-Fi it says saved on device"). */
    case ScanFeedback::SENDING:
      showLines(name, when, "Verifying....",
                scanFeedback.greenPhaseOver(millis()) ? String("Sending to site") : String("Please wait"));
      break;
    /* OFFLINE: the queue already holds the scan with its ORIGINAL scan time, so
     * the card says exactly that and row 3 explains why. The delivery task
     * uploads it by itself the moment Wi-Fi returns - nobody has to rescan. */
    case ScanFeedback::SAVED:
      showLines(name, when, "Stored offline queue",
                scanFeedback.linkWasUp() ? String("Site not replying") : String("No Wi-Fi now"));
      break;
    case ScanFeedback::SENT_IN: showLines(name, when, "Sent to website", "Attendance IN"); break;
    case ScanFeedback::SENT_OUT: showLines(name, when, "Sent to website", "Attendance OUT"); break;
    case ScanFeedback::ALREADY: showLines(name, when, "Sent to website", "Already registered"); break;
    case ScanFeedback::REVIEW: showLines(name, when, "Needs review", "Ask the admin"); break;
    /* A warning about the placement that just happened (Not registered / Image
     * unclear / Sensor not answering). The last row says the door is still live,
     * because it is: the scan loop never stopped. The card clears itself when
     * its timer ends, so nothing stale is left on the glass. */
    case ScanFeedback::NOTICE:
      showLines(String(scanFeedback.noticeTitle()), String(scanFeedback.noticeLine2()),
                String(scanFeedback.noticeLine3()), "Door keeps scanning");
      break;
  }
}

// Called only by the scanner task. Delivery notices may arrive in the
// background; a different person's fresh result gets time to be read first.
void updateScanFeedback() {
  const uint32_t now = millis();
  if (scanGreenOn && (uint32_t)(now - scanGreenSince) >= ScanFeedback::GREEN_SHOW_MS) {
    digitalWrite(GREEN_LED, LOW);
    scanGreenOn = false;
    /* The green indication is over: redraw at once so "Please wait" becomes the
     * real state ("Sending to site" / "Sent to website" / "Stored offline
     * queue") without waiting for the next event. */
    renderScanFeedback();
  }
  // The red light belongs to the warning message: both end together, and
  // neither one delays the next scan.
  if (warningLedOn && (uint32_t)(now - warningLedSince) >= WARNING_SHOW_MS) {
    digitalWrite(RED_LED, LOW);
    warningLedOn = false;
  }
  if (scanFeedback.tick(now)) renderScanFeedback();
  DeliveryNotice notice;
  if (deliveryNotices && xQueuePeek(deliveryNotices, &notice, 0) == pdTRUE && scanFeedback.mayShow(notice, now)) {
    if (xQueueReceive(deliveryNotices, &notice, 0) == pdTRUE) {
      scanFeedback.delivered(notice, now);
      renderScanFeedback();
    }
  }
}

/* ── WiFi that comes back on its own (owner, Oct 2026) ───────────────────── *
 * Why this exists: the board used to rely on the ESP32 core's auto-reconnect
 * alone. After a router reboot, a channel change or a long power cut the
 * driver can stay attached to a socket the router has already forgotten, and
 * `WiFi.status()` never leaves WL_CONNECTED-adjacent states. The LCD then said
 * "Wifi Not Connected" until somebody unplugged the board, which is exactly
 * what the owner was doing.
 *
 * The board is on mains at the door, so it never has to save radio power. Two
 * settings matter more than anything else for range and for a link that
 * answers: no modem sleep, and full transmit power.
 */
void applyWifiTuning() {
  if (WiFi.status() == WL_CONNECTED) {
    // Modem sleep is the reason a quiet link answers late: the radio sleeps
    // between beacons and the request waits for it to wake. A door scanner is
    // plugged in, so it keeps the radio awake.
    WiFi.setSleep(false);
    // The strongest transmit setting the radio has. This is what decides
    // whether the far end of the restaurant can enroll a fingerprint.
    WiFi.setTxPower(WIFI_POWER_19_5dBm);
    WiFi.setAutoReconnect(true);
    wifiLastRssi = WiFi.RSSI();
    Serial.print("WiFi tuned: sleep off, TX 19.5 dBm, signal ");
    Serial.print(wifiLastRssi.load());
    Serial.println(" dBm");
  } else {
    WiFi.setAutoReconnect(true);
  }
}

/* THE SIGNAL, AS FOUR CELLS (owner, Oct 2026).
 * He asked for the strength to sit BESIDE the connection word on the glass, so
 * the row has to carry three things in twenty characters: the connection, the
 * number, and a shape he can read from across the room without knowing what
 * dBm means.
 *
 * A filled block for a bar, an underscore for a missing one:
 *
 *   Connected -58dB ████       next to the router, everything is fine
 *   Connected -72dB ██__       usable, but work to do
 *   Connected -88dB ____       this is the "only works near the router" case
 *
 * The thresholds follow the usual ESP32 behaviour: -55 and better is excellent,
 * -65 good, -75 usable, -85 the edge, below that enrollment starts to fail. */
String wifiMeter(int rssi) {
  int bars = 4;
  if (rssi < -55) bars = 3;
  if (rssi < -65) bars = 2;
  if (rssi < -75) bars = 1;
  if (rssi < -85) bars = 0;
  String out;
  for (int i = 0; i < 4; i++) out += (i < bars) ? (char)0xFF : '_';
  return out;
}

/* The link, as one line for the 20 character LCD.
 *   Connected -58dB ████    connected and healthy
 *   Connected -84dB ____    connected but weak: this is the row that tells him
 *                           to move the access point closer
 *   Offline 34s - saved     no link right now, and the scan is safe on the
 *                           device anyway (the counter shows the board is
 *                           still working on it, so nobody unplugs it)
 *   No wifi - scans safe    never joined since boot; the door still works
 *
 * The owner's rule (Oct 2026): Wi-Fi is needed to ADD a fingerprint, not to
 * take attendance. So the offline rows say what is true at the door - the scan
 * is kept - instead of a bare "not connected" that reads like a fault.
 *
 * The budget, exactly 20 characters:
 *   "Connected " 10 + "-58dB " 6 + the four cells 4 = 20. */
String wifiStatusLine() {
  if (WiFi.status() != WL_CONNECTED) {
    const unsigned long downSince = wifiDownSince.load();
    if (downSince == 0) return String("No wifi - scans safe");
    return String("Offline ") + String((millis() - downSince) / 1000) + "s - saved";
  }
  const int lastRssi = wifiLastRssi.load();
  int rssi = lastRssi != 0 ? lastRssi : WiFi.RSSI();
  // 0 means "the radio has not reported yet", not a real reading.
  if (rssi >= 0) return String("Connected");
  // A row of 20 cells cannot hold four digits; -99 is already unusable, so a
  // worse reading is shown as the worst one instead of losing the bars.
  if (rssi < -99) rssi = -99;
  return String("Connected ") + String(rssi) + "dB " + wifiMeter(rssi);
}

/* One stronger access point on the same name is worth moving to. The password
 * is not needed: WiFi.begin() with the stored credentials re-scans the band and
 * the driver joins the strongest access point that answers to that name (its
 * default sort order is by signal). */
void rejoinStrongestAp() {
  const String current = WiFi.SSID();
  if (current.length() == 0) return;
  const int found = WiFi.scanNetworks();
  int best = WiFi.RSSI();
  bool better = false;
  for (int i = 0; i < found; i++) {
    if (WiFi.SSID(i) == current && WiFi.RSSI(i) > best + WIFI_AP_HUNT_GAIN) {
      best = WiFi.RSSI(i);
      better = true;
    }
  }
  WiFi.scanDelete();
  if (!better) return;
  Serial.print("A stronger access point (");
  Serial.print(best);
  Serial.println(" dBm) is on the same name: rejoining");
  stopEventStream();
  WiFi.disconnect(false, false);
  delay(100);
  WiFi.begin();
}

/* Called every pass of loop(). It owns three jobs:
 *   1. notice the link coming back and repair everything that died with it
 *      (the real-time stream, NTP, the names, the open hours, the queue);
 *   2. reconnect with an escalation that always ends somewhere, instead of the
 *      driver retrying the same dead socket for ever;
 *   3. keep the LCD honest about which of those is happening. */
void serviceWifi() {
  const bool up = WiFi.status() == WL_CONNECTED;

  if (up) {
    if (wifiDownSince != 0) {
      const unsigned long downMs = millis() - wifiDownSince;
      wifiDownSince = 0;
      wifiReconnects++;
      Serial.print("WiFi is back after ");
      Serial.print(downMs / 1000);
      Serial.println(" s. Repairing the stream, the clock and the names.");
      applyWifiTuning();
      // Wake the independent delivery task immediately; mapping/schedule
      // HTTP calls below cannot hold saved attendance behind them.
      wakeDeliveryTask();
      startTimeSync();
      loadMappingsFromServer();
      loadRestScheduleFromServer();
    }
    wifiLastRssi = WiFi.RSSI();
    // A link that is up but weak drops again. Look for a better access point
    // every few minutes, and never while a fingerprint is being enrolled.
    if (!enrollingFromServer && millis() - lastApHunt > WIFI_AP_HUNT_MS) {
      lastApHunt = millis();
      if (wifiLastRssi != 0 && wifiLastRssi < WIFI_WEAK_RSSI) rejoinStrongestAp();
    }
    return;
  }

  if (wifiDownSince == 0) {
    wifiDownSince = millis();
    lastWifiTry = 0;
    lastWifiRadioReset = 0;
    Serial.println("WiFi lost. Still scanning; reconnecting in the background.");
  }
  const unsigned long downMs = millis() - wifiDownSince;
  if (lastWifiTry != 0 && millis() - lastWifiTry < WIFI_RECONNECT_MS) return;
  lastWifiTry = millis();

  if (downMs < WIFI_RADIO_RESET_MS) {
    Serial.print("WiFi down ");
    Serial.print(downMs / 1000);
    Serial.println(" s: asking the driver to reconnect");
    WiFi.reconnect();
  } else {
    // Keep trying the RADIO, not the whole ESP32. Rebooting during a long
    // outage stops scans and discards the clock that was already synchronized.
    if (lastWifiRadioReset != 0 && millis() - lastWifiRadioReset < WIFI_RADIO_RETRY_MS) return;
    lastWifiRadioReset = millis();
    Serial.println("WiFi still down: resetting the radio (credentials kept)");
    wifiRadioResets++;
    stopEventStream();
    WiFi.disconnect(true, false);
    delay(150);
    WiFi.mode(WIFI_STA);
    WiFi.begin();
    applyWifiTuning();
  }
}

/* Ask NTP for the time (UTC+3). Called once after the WiFi is up and again
 * whenever the WiFi comes back; the ESP32 core keeps it fresh after that. */
void startTimeSync() {
  configTime(ET_UTC_OFFSET_SEC, 0, NTP_SERVER_A, NTP_SERVER_B);
  Serial.println("NTP time sync started (Addis Ababa, UTC+3)");
}

/* "14:05:30" on the Ethiopian wall clock, or "" while NTP has not answered.
 * The timeout is 0 on purpose: getLocalTime() must never block the loop, or a
 * dead NTP server would stop the scanner from seeing a finger. */
String wallClockText() {
  struct tm t;
  if (!getLocalTime(&t, 0) || t.tm_year < (2020 - 1900)) {
    timeReady = false;
    return String("");
  }
  timeReady = true;
  char buf[9];
  snprintf(buf, sizeof(buf), "%02d:%02d:%02d", t.tm_hour, t.tm_min, t.tm_sec);
  return String(buf);
}

/* The real time as seconds since 1970, or 0 while NTP has not answered since
 * boot. Same source as the LCD row and the same rule: never block the loop. */
unsigned long wallClockEpoch() {
  struct tm t;
  if (!getLocalTime(&t, 0) || t.tm_year < (2020 - 1900)) return 0;
  const time_t epoch = mktime(&t);
  if (epoch <= 0) return 0;
  return (unsigned long)epoch;
}

/* Remember the real time (called from loop, once a second) so that a scan made
 * while NTP is silent can still be stamped with the right moment. */
void noteWallClock() {
  if (millis() - lastWallClockNote < 1000) return;
  lastWallClockNote = millis();
  const unsigned long epoch = wallClockEpoch();
  if (epoch == 0) return;   // NTP has not answered: keep the pair we already have
  const uint64_t uptime = (uint64_t)esp_timer_get_time() / 1000000ULL;
  if (pendingUnknownTime && offlineQueue && uptime <= 0xFFFFFFFFULL) {
    // This anchor also resolves all earlier no-clock scans from this boot,
    // even if power is lost after the NTP sync and before delivery.
    if (offlineQueue->saveClockAnchor(bootId, epoch, (uint32_t)uptime)) {
      pendingUnknownTime = false;
      wakeDeliveryTask();
    } else
      Serial.println("Could not save clock anchor; unknown-time scans remain queued");
  }
  portENTER_CRITICAL(&clockMux);
  epochAtSync = epoch;
  uptimeAtSyncSeconds = uptime;
  portEXIT_CRITICAL(&clockMux);
  timeReady = true;
}

/* Estimate a scan's capture time from the latest same-boot clock anchor.
 * 64-bit uptime survives millis() wrap and allows a just-before-sync capture. */
unsigned long scanEpochAtUptime(uint64_t uptimeMs) {
  portENTER_CRITICAL(&clockMux);
  const unsigned long epoch = epochAtSync;
  const uint64_t anchor = uptimeAtSyncSeconds;
  portEXIT_CRITICAL(&clockMux);
  if (!epoch) return 0;
  const uint64_t captured = uptimeMs / 1000ULL;
  if (captured >= anchor) return epoch + (unsigned long)(captured - anchor);
  const uint64_t difference = anchor - captured;
  return difference < epoch ? epoch - (unsigned long)difference : 0;
}

unsigned long scanEpochNow() {
  return scanEpochAtUptime((uint64_t)esp_timer_get_time() / 1000ULL);
}

/* The clock row moves, so the idle screen is redrawn once a second WHILE the
 * idle screen is what the glass shows. lcdWriteRow() skips a row whose text did
 * not change, so only that one row is ever rewritten: no flicker, and no result
 * or enrollment message is ever overwritten by the clock. */
void refreshIdleClock() {
  static unsigned long lastClockDraw = 0;
  if (!idleVisible || enrollmentActive || !lcdReady) return;
  if (millis() - lastClockDraw < IDLE_CLOCK_REFRESH_MS) return;
  lastClockDraw = millis();
  showIdleScreen();
}

/* ── Buzzer (GPIO23 -> 1 kohm -> 2N2222 base; the pin never drives the buzzer
 *    itself, the transistor does). HIGH/LOW is correct for the usual small
 *    ACTIVE buzzer, which has its own oscillator. A PASSIVE buzzer (no
 *    internal oscillator) stays silent on HIGH/LOW: uncomment the next line
 *    and the two beeps below use tone() instead. Confirm which one you have
 *    with the buzzer check in the README before wiring it up. ── */
// #define BUZZER_IS_PASSIVE 1

/* The beeps must not stop the scanner (owner, Oct 2026): "the employees cannot
 * wait for the timing - the system must scan at any moment". The old versions
 * held the loop with delay(100)/delay(300) with no command going to the reader,
 * so a wrong finger was followed by a short dark gap in which nothing was read.
 * The active-buzzer path now uses a one-shot software timer to switch the pin
 * low, and the passive path uses tone(pin, freq, ms), which is already timed by
 * the core. Either way the loop keeps talking to the sensor while it sounds. */
static TimerHandle_t buzzerTimer = nullptr;
static TimerHandle_t rejectionTimer = nullptr;

static void buzzerSilence(TimerHandle_t) {
  digitalWrite(BUZZER_PIN, LOW);
}

static void beep(uint16_t ms, uint16_t freq) {
#ifdef BUZZER_IS_PASSIVE
  tone(BUZZER_PIN, freq, ms);
#else
  digitalWrite(BUZZER_PIN, HIGH);
  if (!buzzerTimer) buzzerTimer = xTimerCreate("beep", pdMS_TO_TICKS(ms), pdFALSE, nullptr, buzzerSilence);
  if (buzzerTimer) {
    // Starting a one-shot that is already running restarts it, so a new beep
    // simply replaces whatever was left of the previous one.
    xTimerChangePeriod(buzzerTimer, pdMS_TO_TICKS(ms), 0);
    xTimerStart(buzzerTimer, 0);
  } else {
    digitalWrite(BUZZER_PIN, LOW);   // no timer available: never leave it on
  }
#endif
}

// Two distinct pulses even with an active buzzer (which cannot change pitch).
// The timer callback plays the second pulse without holding the scanner loop.
static void rejectionSecondPulse(TimerHandle_t) { beep(220, 1200); }

void beepSuccess() {
  if (rejectionTimer) xTimerStop(rejectionTimer, 0);
  beep(100, 2000);
}

void beepError() {
  if (rejectionTimer) xTimerStop(rejectionTimer, 0);
  beep(300, 1200);
}

void beepRejected() {
  if (!rejectionTimer) rejectionTimer = xTimerCreate("reject", pdMS_TO_TICKS(180), pdFALSE, nullptr, rejectionSecondPulse);
  if (rejectionTimer) xTimerStop(rejectionTimer, 0);
  beep(80, 1200);
  if (rejectionTimer) xTimerStart(rejectionTimer, 0);
}

/* ── Sensor health ────────────────────────────────────────────────────────── */
bool detectSensor(uint8_t tries) {
  for (uint8_t t = 1; t <= tries; t++) {
    // Re-verify and re-read parameters on recovery too: the R307 may have
    // booted after the ESP32 or reset during a scan.
    //
    // The waits are short on purpose. A health check runs inside the scanner
    // lock, so a generous timeout here is a stretch of time with no scan and no
    // light command - the reader looks (and is) dark while it is being asked
    // whether it is alive. 1.5 s + 2 s is more than a healthy module needs.
    const bool initialized = finger.begin(1500);
    const int16_t count = initialized ? finger.getCount(2000) : -1;
    if (count >= 0) {
      sensorReady = true;
      templateCount = count;
      sensorSilentPasses = 0;
      sensorLastReplyMs = millis();
      sensorLinkReported = false;
      sensorPollMs = SENSOR_POLL_MS;
      // This command is optional on R307 variants. Keep scanning even if the
      // reader does not support an independently controlled blue LED.
      // Twice: a reader that has just powered up often ignores the first
      // optional command. Either way the sketch keeps asking later - a reader
      // whose blue light went out is a reader whose glass looks dead.
      const bool lit = finger.requestLightOn(READER_LAMP_TIMEOUT_MS) ||
                       finger.requestLightOn(READER_LAMP_TIMEOUT_MS);
      if (lit) readerLightSupported = true;
      lastLightRequestMs = millis();
      if (lit) lampMisses = 0;
      if (!lit) Serial.println("Reader does not confirm LED-ON yet; capture remains enabled and the light is asked again");
      return true;
    }
    Serial.print("Fingerprint sensor not answering, try ");
    Serial.print(t);
    Serial.print("/");
    Serial.print(tries);
    Serial.print(" - ");
    Serial.println(R307Compat::statusText(finger.getLastStatus()));
    delay(120);
  }
  sensorReady = false;
  return false;
}

/* Keep the glass lit (owner, Oct 2026).
 *
 * The owner's report: "after the scanning and verification is done there is
 * seconds that the sensor turned off", and, for Add Fingerprint, "the sensor
 * doesn't light up". Some R307 variants switch their illumination off by
 * themselves after a capture or after answering "no finger"; this sketch asked
 * them to switch it back on only once every five seconds, and never at all
 * while an enrollment was running. The reader then sat dark exactly when the
 * LCD was asking for a finger, answered "no finger" for a full minute, and the
 * job failed with a message that looked like nobody had pressed the glass.
 *
 * So the light is now re-asserted:
 *   - immediately after every scan (minGapMs = READER_LAMP_BURST_MS), so the
 *     next employee of a group sees a ready reader,
 *   - right before and during every enrollment placement,
 *   - periodically while idle.
 *
 * The command is optional, so nothing about scanning depends on the answer -
 * but the sketch never STOPS asking either. It used to give up for good after
 * one refusal at boot (readerLightSupported = false), which is how a reader
 * whose blue light went out stayed dark until the board was power-cycled. */
void keepReaderLampOn(uint32_t minGapMs, bool force) {
  /* force = "something was just captured, re-light the glass now". It skips the
   * miss backoff (but not the minimum gap), because the moment the reader takes
   * an image is exactly the moment some variants switch their own LED off. */
  uint32_t gap = lampMisses < 2 ? minGapMs : (uint32_t)LAMP_RETRY_BACKOFF_MS;
  if (force && minGapMs < gap) gap = minGapMs;
  if (lampMisses >= LAMP_UNSUPPORTED_MISSES) gap = (uint32_t)LAMP_UNSUPPORTED_REPROBE_MS;
  if ((uint32_t)(millis() - lastLightRequestMs) < gap) return;
  lastLightRequestMs = millis();
  // Wi-Fi is irrelevant: the light is local to the reader. The short timeout is
  // deliberate: a normal reader answers this in milliseconds, and the request
  // is skipped outright while a reply is still on the wire.
  if (finger.requestLightOn(READER_LAMP_TIMEOUT_MS)) {
    lampMisses = 0;
    readerLightSupported = true;
  } else if (lampMisses < 1000) {
    lampMisses++;
    if (lampMisses == 1)
      Serial.println("Reader light did not answer; still scanning and re-asking every moment");
  }
}

/* Used inside a placement window: if the reader has not seen an image for a
 * while, ask for its light once more even when it never confirmed the command
 * at boot. Some modules answer the LED command only after they have been left
 * alone for a moment, and one extra frame on the UART costs nothing. */
void nudgeReaderLamp() {
  /* A reader that refuses the optional light command costs a timeout every
   * time it is asked, and a timeout inside a placement window is time the
   * person's finger spends unread. Refusals back off; successes keep the fast
   * cadence. */
  if (lampMisses >= 3 && (uint32_t)(millis() - lastLightRequestMs) < (uint32_t)LAMP_RETRY_BACKOFF_MS) return;
  lastLightRequestMs = millis();
  if (finger.requestLightOn(READER_LAMP_TIMEOUT_MS)) {
    readerLightSupported = true;
    lampMisses = 0;
  } else if (lampMisses < 1000) {
    lampMisses++;
  }
}

void maintainReaderLight() {
  // The idle cadence. A burst right after a scan uses keepReaderLampOn() with a
  // much shorter gap, so the reader is lit again in the same second.
  keepReaderLampOn(READER_LAMP_IDLE_MS);
}

/* Called right after every capture attempt - matched, unregistered, unclear or
 * empty glass. Some readers switch their own illumination off the moment an
 * image has been taken, and the person standing there then waits at a dark
 * glass. The burst cadence makes the light come back in the same breath, before
 * the next search starts. */
void reassertReaderLight() {
  // Forced: this runs right after a capture, matched or refused, and that is
  // when the reader's own illumination is most likely to have gone out.
  keepReaderLampOn(READER_LAMP_BURST_MS, true);
}

// Answers true when the sensor replies to a COUNT command at all.
bool sensorAnswers() {
  return finger.getCount(1500) >= 0;
}

/* Was this answer the module not talking at all? "No finger" (TIMEOUT), "no
 * matching finger" (NOUSER) and even "finger lifted" are perfectly good replies:
 * they prove the wire, the baud and the module are alive. Only silence and
 * unreadable bytes mean the link is gone - so a flaky frame now and then must
 * never be read as a dead sensor. */
bool sensorReplyIsSilence(uint8_t status) {
  return status == BIOVO_ACK_NO_RESPONSE || status == BIOVO_ACK_COMM_ERROR;
}

/* Every scan pass reports its answer here, and one honest reply resets the
 * whole run of silence. */
void noteSensorAnswer(uint8_t status) {
  sensorLastStatus = status;
  if (sensorReplyIsSilence(status)) {
    if (sensorSilentPasses < 250) sensorSilentPasses++;
    return;
  }
  sensorSilentPasses = 0;
  sensorLastReplyMs = millis();
  sensorLinkReported = false;
  sensorPollMs = SENSOR_POLL_MS;   // an alive module needs no extra patience
}

bool sensorLinkLooksDead() {
  return sensorSilentPasses >= SENSOR_FAIL_LIMIT;
}

/* Give the link up, out loud, and hand it to checkSensorHealth(), which looks
 * for the module again every 5 s. This is the difference between a door that
 * silently ignores people and a door that says what is wrong with it. */
void dropSensorLink(const String &why) {
  sensorReady = false;
  sensorLinkReported = true;
  sensorPollMs = SENSOR_POLL_MS;
  // Preserve a pending lift through an outage: silence cannot prove a finger
  // left the glass. An honest no-finger reply will clear it after recovery.
  Serial.print("Fingerprint sensor link dropped: ");
  Serial.println(why);
  Serial.print("  last status: 0x");
  if (sensorLastStatus < 0x10) Serial.print("0");
  Serial.print(sensorLastStatus, HEX);
  Serial.print(" (");
  Serial.print(R307Compat::statusText(sensorLastStatus));
  Serial.println(")");
  Serial.println("  check the R307 seller pinout and rated VCC (normally regulated 5 V);");
  Serial.println("  GND common with the ESP32; TX->16, RX->17; try `sensor` for");
  Serial.println("  the link test, which counts answers instead of guessing.");
  // Whatever half a frame is still sitting on the line has to go, or the first
  // reply after the module comes back is read as an answer to an old command.
  finger.drain(60);
  /* No delay here. This used to sit on the LCD for 2.5 s inside the scanner
   * lock - the "it goes dark, then five seconds later it comes back" report in
   * miniature. The message is now a notice that expires on its own while the
   * health check keeps looking for the module in the background. */
  scanFeedback.notice("SENSOR NOT", "answering. Check", "power + common GND", millis(), WARNING_SHOW_MS);
  renderScanFeedback();
  // Make it audible too: a door that has stopped verifying must never be
  // silent about it. Both are timer driven, so neither blocks the recovery scan.
  digitalWrite(RED_LED, HIGH);
  warningLedOn = true;
  warningLedSince = millis();
  beepError();
}

// Every 5 s while the sensor is missing, look for it again (self-healing).
void checkSensorHealth() {
  static unsigned long lastCheck = 0;
  if (sensorReady || millis() - lastCheck < 5000) return;
  lastCheck = millis();
  if (detectSensor(1)) {
    Serial.println("Fingerprint sensor is back!");
    // What the person at the door needs is that the glass works again, not the
    // template count (that lives on Serial and on the status page). Shown as a
    // self-expiring notice: a delay() here would keep the glass unread while
    // somebody is already pressing it.
    scanFeedback.notice("SENSOR READY", "Place finger", "Scanning now", millis(), 1500);
    renderScanFeedback();
    beepSuccess();
    reassertReaderLight();
  }
}

/* ── Finger detection (sensor's own SEARCH; only the four data/power wires) ── */
const char *fingerStatusText(uint8_t s) {
  switch (s) {
    case 0x00: return "OK";
    case 0x01: return "Command failed";
    case 0x04: return "Invalid sensor slot / memory problem";
    case 0x05: return "Finger not enrolled";
    case 0x06: return "Image unclear";
    case 0x07: return "ID already has a finger";
    case 0x08: return "No finger / timeout";
    case 0x09: return "The two captures did not match";
    case 0x0A: return "Sensor flash write failed";
    case 0x0F: return "Finger lifted";
    case 0xFE: return "Garbled reply";
    case 0xFF: return "No reply - check wiring/power";
    default:   return "Unknown status";
  }
}

// Identification scan. The sensor reports a finger as a match (ID), NOUSER
// (finger seen but not enrolled) or IMAGEMESS (finger seen, image unclear).
void scanForFinger() {
  /* ── The latch: one placement, one scan (and a reader that is ready again at
   *    once) ────────────────────────────────────────────────────────────────
   * While a finger is still on the glass (or a result is being read), a full
   * match is pointless: it cannot be credited twice, and it keeps the reader
   * busy for most of a second while the next employee of a group is already
   * waiting. So this path asks ONE cheap question - "is anything on the glass?"
   * - and returns. The moment the finger is lifted the latch clears and the
   * next placement is matched normally, with no dead time in between. The same
   * poll keeps GETIMAGE running on the reader, which is what keeps its
   * illumination and its finger detection alive. */
  if (awaitingFingerLift) {
    // Two honest "empty" replies, not one: a single glitched frame must never
    // re-arm the door while the same finger is still lying on the glass, or the
    // same person would be clocked twice.
    static uint8_t emptyReplies = 0;
    const int state = finger.fingerPresent(LIFT_POLL_MS);
    if (state == 0) {
      if (++emptyReplies >= 2) {
        emptyReplies = 0;
        awaitingFingerLift = false;
        keepReaderLampOn(READER_LAMP_BURST_MS, true);
        Serial.println("Glass is clear: ready for the next finger");
        return;
      }
      delay(60);
      return;
    }
    emptyReplies = 0;
    if (state < 0) {
      // Silence is not proof of a lift: keep the latch (a held finger must not
      // be clocked twice) but let the dead-link detection see this pass like
      // any other answer, so a reader that died while a finger rested on it is
      // reported instead of quietly ending the day's scans.
      noteSensorAnswer(finger.getLastStatus());
      if (sensorLinkLooksDead() && !sensorLinkReported) {
        dropSensorLink(String("no answer for ") + String((unsigned)sensorSilentPasses) + " checks in a row");
      }
    }
    delay(60);   // do not hammer the reader while a finger is resting on it
    return;
  }

  uint16_t matchedId = 0;
  uint8_t permission = 0;
  const uint32_t searchStartedMs = millis();
  const bool matched = finger.search(matchedId, permission, sensorPollMs) && matchedId > 0;
  const uint8_t st = finger.getLastStatus();
  noteSensorAnswer(st);
  // A completed image may switch off some readers' illumination. A match is
  // re-lit just before its result screen; a refusal is re-lit (forced) in the
  // refusal branch below, together with its warning.
  if (matched) lastLightRequestMs = millis() - READER_LAMP_IDLE_MS;
  // SENSOR_FAIL_LIMIT passes in a row with nothing back is not "no finger at
  // the door", it is no module. Say so, once, and let the health check look for
  // it. (The enrollment paths do not need this: a silent module there already
  // fails the job with a reason the admin page shows.)
  if (sensorLinkLooksDead()) {
    /* Before a module is given up for dead, ask it something cheap and wait
     * properly for the answer. COUNT is answered even while a search is still
     * grinding through a big database, so a module that answers THIS is busy,
     * not gone: the scan budget grows and the door keeps working. Only a module
     * that ignores a slow COUNT too is treated as a dead link. */
    if (sensorAnswers()) {
      Serial.println("Sensor is busy, not dead: it answered a slow COUNT. Waiting longer for scans.");
      sensorSilentPasses = 0;
      sensorLastReplyMs = millis();
      if (sensorPollMs < SENSOR_POLL_MAX_MS) {
        sensorPollMs = (uint16_t)min((long)SENSOR_POLL_MAX_MS, (long)sensorPollMs * 2);
      }
      return;
    }
    if (!sensorLinkReported) {
      dropSensorLink(String("no answer for ") + String((unsigned)sensorSilentPasses) + " checks in a row");
    }
    return;
  }

  if (matched) {
    if (awaitingFingerLift) return;
    awaitingFingerLift = true;
    warningKind = 0xFF;          // the next refusal is a brand new placement
    // Convert the successful GETIMAGE reply's wrapping millis() to the
    // 64-bit boot clock. Matching, printing and queue I/O happen afterwards.
    const uint64_t nowUptimeMs = (uint64_t)esp_timer_get_time() / 1000ULL;
    const uint32_t elapsedMs = (uint32_t)(millis() - finger.capturedImageMillis());
    const uint64_t capturedUptimeMs = nowUptimeMs >= elapsedMs ? nowUptimeMs - elapsedMs : 0;
    handleVerifiedFinger((int)matchedId, capturedUptimeMs);
    return;
  }

  /* ── A rejected placement never closes the door ────────────────────────────
   *
   * Owner, Oct 2026, twice:
   *   "when I put my finger wrongly or an unregistered finger the sensor goes
   *    dark for about five seconds and I have to time my finger during the dark
   *    time"
   *   "when an unregistered, wrong-side or unclear finger is placed, the sensor
   *    becomes black and even the buzzer and LED do not light up."
   *
   * TWO different faults produced that, and both are fixed here:
   *
   * 1. THE LATCH. An unregistered (NOUSER) or unclear (IMAGEMESS) placement used
   *    to set awaitingFingerLift - the latch that means "this person has already
   *    been clocked". The sketch then stopped running matches and only watched
   *    for a lift, so the door was asleep for as long as a hand was near the
   *    glass. The latch belongs to MATCHES only: a finger that was not verified
   *    cannot be credited twice.
   *
   * 2. THE SILENT FAILURE. Some readers answer a bad press with a garbled frame,
   *    an empty reply or a definite no-match, and the old code treated any
   *    status it did not expect as "nobody touched the glass": no warning, no
   *    red LED, no buzzer, nothing on the LCD. The reader's own evidence decides
   *    that now - if it captured an image (or pressed an unclear one), a finger
   *    WAS there and the door says so, whatever the status byte claims.
   *
   * The refusal is announced (LCD + red LED + two timer-driven buzzer pulses),
   * the light is forced back on immediately, and the very next loop pass runs a
   * full match again. A good scan taken while the warning is still on screen
   * replaces it on the spot.
   *
   * The announcement is throttled so a finger resting on the glass is not
   * buzzed in the employee's face twice a second; the SEARCHING is not. */
  const bool refused = st == BIOVO_ACK_NOUSER || st == BIOVO_ACK_IMAGEMESS;
  /* Silence (0xFF) is NOT evidence of a finger: that is a wiring/power case and
   * the dead-link path owns it. A garbled frame (0xFE) or "command failed"
   * (0x01) means the reader was talking but could not finish - the person at
   * the door gets an answer instead of a blank glass. */
  const bool fingerWasThere = refused || finger.searchSawFinger() ||
                              st == BIOVO_ACK_COMM_ERROR || st == 0x01;
  if (fingerWasThere) {
    /* Two message groups, not one per status byte: a reader can report the same
     * wrong press as NOUSER, NOMATCH, a garbled frame or "command failed", and
     * the employee must not be buzzed again just because the byte changed. */
    const uint8_t group = st == BIOVO_ACK_IMAGEMESS ? 1 : 2;
    const bool repeat = warningKind == group && (uint32_t)(millis() - warningShownAt) < WARNING_REPEAT_MS;
    if (!repeat) {
      warningKind = group;
      warningShownAt = millis();
      /* The wording the owner asked for (Oct 2026):
       *   "Show Not registered. Ask the admin as quickly as possible."
       * Red LED + two warning beeps go with it, and the card clears itself
       * after WARNING_SHOW_MS - the door is never left showing a stale warning. */
      if (st == BIOVO_ACK_IMAGEMESS) {
        showSensorWarning("Image unclear", "Press flat and still", "Clean the glass");
      } else if (refused || st == 0x09) {
        showSensorWarning("Not registered", "Ask the admin", "Finger not enrolled");
      } else {
        // A finger was seen but the reader could not finish the check (garbled
        // or lost frame). Same visible answer: the door did not accept it.
        showSensorWarning("Not registered", "Press again, flat", "Ask admin if repeats");
      }
      /* One line per refusal on Serial: the raw status, which the LCD cannot
       * show and which is the only way to tell a bad finger from a bad wire -
       * plus how long the reader took to answer. That number is the whole point
       * of the owner's "it must answer as fast as it can": if it is large, the
       * reader or its wiring is the cause, not the sketch. */
      Serial.print("Finger refused in ");
      Serial.print((unsigned long)(millis() - searchStartedMs));
      Serial.print(" ms: status 0x");
      if (st < 0x10) Serial.print("0");
      Serial.print(st, HEX);
      Serial.print(" (");
      Serial.print(R307Compat::statusText(st));
      Serial.print("), image seen: ");
      Serial.print(finger.searchImagesSeen());
      Serial.print(", unclear: ");
      Serial.println(finger.searchUnclear());
    }
    reassertReaderLight();
    return;
  }

  // No finger (or the sensor finished with the finger): the next placement is a new scan.
  // A communication timeout is NOT evidence that the person lifted: clearing
  // the latch on silence could clock the same held finger a second time.
  if (st == BIOVO_ACK_TIMEOUT || st == BIOVO_ACK_GO_OUT) {
    awaitingFingerLift = false;
    warningKind = 0xFF; // a fresh placement deserves its own warning
  }
  // Keep the original light refresh behavior used by the working firmware.
  reassertReaderLight();
}

/* A warning about a placement, shown WITHOUT stopping the door.
 *
 * Owner, Oct 2026: "if I put an unregistered finger the sensor becomes dark and
 * after about 5 seconds it comes back - I have to put my finger during the dark
 * time." The old version sat in delay(WARNING_SHOW_MS): two and a half seconds
 * with no command going to the reader (so its illumination and its finger
 * detection went quiet), plus the latch, plus the result screen - the hand-timed
 * dark window he describes. A finger placed during it was not even looked at.
 *
 * Now the warning is a STATE with an expiry: the LCD and the red LED say what
 * happened, the message disappears by itself, and scanForFinger() keeps running
 * underneath it on every pass of loop(), so the next finger is read the moment
 * it lands on the glass. */
void showSensorWarning(const String &title, const String &line2, const String &line3) {
  scanFeedback.notice(title.c_str(), line2.c_str(), line3.c_str(), millis(), WARNING_SHOW_MS);
  renderScanFeedback();
  // Do not leave green and red lit together if the next person is rejected.
  if (scanGreenOn) {
    digitalWrite(GREEN_LED, LOW);
    scanGreenOn = false;
  }
  digitalWrite(RED_LED, HIGH);
  warningLedOn = true;
  warningLedSince = millis();
  beepRejected(); // two timer-driven pulses, distinct from a successful scan
}

// Use the image-capture time, before matching, network and display delays.
// Every scan is durably queued FIRST, including while Wi-Fi looks connected.
// The network task delivers it in order without blocking the reader.
void handleVerifiedFinger(int fingerprintId, uint64_t capturedUptimeMs) {
  const unsigned long scannedAt = scanEpochAtUptime(capturedUptimeMs);
  const uint64_t uptimeMs = capturedUptimeMs;
  String name;
  int memberId = 0;
  if (!mappedPersonForId(fingerprintId, name, memberId)) name = "ID " + String(fingerprintId);
  Serial.print("Finger matched ID ");
  Serial.print(fingerprintId);
  Serial.print(" - ");
  Serial.println(name);

  /* ── THE CARD COMES FIRST (owner, Oct 2026) ────────────────────────────────
   * "Recognise it locally and immediately show the employee's name, scan time
   *  and Verifying....". The name is already known from the list in flash and
   * the time is the moment the image was taken, so the card is drawn before the
   * flash write and before any network work. Nothing on it claims a result yet:
   * "Verifying...." is exactly true at this point. */
  const bool linkUp = WiFi.status() == WL_CONNECTED && deliveryTaskHandle;
  DeliveryNotice notice{};
  notice.eventId[0] = '\0';
  snprintf(notice.name, sizeof(notice.name), "%s", name.c_str());
  notice.scannedAt = (uint32_t)scannedAt;
  scanFeedback.verifying(notice, linkUp, millis());
  renderScanFeedback();

  String eventId;
  if (!saveToQueue(fingerprintId, name, memberId, scannedAt, uptimeMs, eventId)) {
    showSensorWarning(name, "SCAN NOT SAVED", "Tell the admin");
    return;
  }
  if (!scannedAt) pendingUnknownTime = true;
  /* Now the scan is durable and has its event id: the card moves to its real
   * state - "Sending to site" while a receipt is awaited, "Stored offline
   * queue" when there is no link - and the delivery task takes it from here. */
  snprintf(notice.eventId, sizeof(notice.eventId), "%s", eventId.c_str());
  scanFeedback.saved(notice, linkUp, millis());
  renderScanFeedback();
  // A green light confirms a safe local write. Only a validated server reply
  // changes the LCD to SENT. The delivery task starts immediately and never
  // holds the scanner while the website is slow.
  digitalWrite(GREEN_LED, HIGH);
  scanGreenOn = true;
  scanGreenSince = millis();
  // A good scan replaces whatever warning was on the glass, so its red light
  // goes with it instead of burning until its own timer ends.
  if (warningLedOn) {
    digitalWrite(RED_LED, LOW);
    warningLedOn = false;
  }
  wakeDeliveryTask();
  // Light the glass again for the next person before the buzzer is even done.
  // Forced: the reader has just taken an image and may have killed its own LED.
  keepReaderLampOn(READER_LAMP_BURST_MS, true);
  beepSuccess();
  /* The number the owner asked for: how long this person waited between the
   * image being taken and the green light. Under four seconds is the target;
   * this line is how a slow reader, a big template database or a busy flash is
   * recognised without guessing. */
  const uint64_t doneUptimeMs = (uint64_t)esp_timer_get_time() / 1000ULL;
  if (doneUptimeMs >= capturedUptimeMs) {
    Serial.print("Scan saved and shown in ");
    Serial.print((unsigned long)(doneUptimeMs - capturedUptimeMs));
    Serial.println(" ms from the finger image");
  }
}

// Sends one scan. Returns the HTTP code (200 accepted, 4xx refused, 5xx server
// problem, negative = no connection). body receives the website's answer.
int postClock(int fingerprintId, String &body) {
  body = "";
  if (WiFi.status() != WL_CONNECTED) return -1;

  HTTPClient http;
  http.setTimeout(SERVER_TIMEOUT_MS);
  beginServerRequest(http, "/api/attendance/clock");
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
  // Non-blocking, like every other warning on the door: the scanner must not go
  // quiet while a refusal is on the screen (see showSensorWarning()).
  showSensorWarning(name, "NOT ACCEPTED", reason.substring(0, LCD_COLS));
}

/* ── Add Fingerprint from the website ─────────────────────────────────────── */
// Asks the website for a pending job on an event and on the periodic safety poll.
bool checkPendingEnroll() {
  if (enrollingFromServer || mappingPending || pendingFailureJobId) return false;
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  http.setTimeout(SERVER_TIMEOUT_MS);
  // One job is enough for this single reader; keep the response small even
  // if many older pending jobs are still on the server.
  beginServerRequest(http, "/api/attendance/biometrics?pending=1&limit=1");
  if (deviceToken.length() > 0) http.addHeader("x-attendance-device", deviceToken);
  const int httpCode = http.GET();
  String payload = "";
  if (httpCode == 200) payload = http.getString();
  http.end();
  if (httpCode != 200) {
    Serial.print("Could not check enrollment jobs, HTTP ");
    Serial.println(httpCode);
    return false;
  }

  DynamicJsonDocument doc(2048);
  if (deserializeJson(doc, payload)) {
    Serial.println("Could not read enrollment job reply; check website version and connection");
    return false;
  }
  if ((doc["count"] | 0) <= 0) return false;

  JsonObject job = doc["jobs"][0].as<JsonObject>();
  if (job.isNull()) return false;
  const int jobId = job["jobId"] | 0;
  const int memberId = job["memberId"] | 0;
  const int fingerprintId = job["fingerprintId"] | 0;
  String memberName = job["memberName"] | "Member";

  if (jobId <= 0 || jobId == lastHandledJobId) return false;
  // Only enrollment owns the reader for an extended time. Normal network I/O
  // never acquires this lock, so a stalled connection cannot stop scans.
  if (!sensorMutex || xSemaphoreTake(sensorMutex, pdMS_TO_TICKS(5000)) != pdTRUE) return false;
  lastHandledJobId = jobId; // try this job once only

  Serial.print("Pending enrollment from the website: ");
  Serial.print(memberName);
  Serial.print(" as ID ");
  Serial.println(fingerprintId);

  enrollingFromServer = true;
  // Show that the command reached this scanner BEFORE any network request or
  // slot checks can stall. Do not ask for a finger until preflight is complete.
  showEnrollScreen(memberName, fingerprintId, 0, "PREPARING...", "Please wait");

  // Acknowledge receipt; this does not mean the first capture is ready yet.
  // The admin and employee should follow the LCD's PLACE/LIFT instructions.
  reportJobStarted(jobId, fingerprintId);

  EnrollResult result;
  if (!sensorReady && !detectSensor(1)) {
    enrollDetail = "sensor not responding; check Serial `sensor`, power and UART wiring";
    result = ENROLL_SENSOR_ERROR;
  } else if (memberId <= 0) {
    enrollDetail = "invalid employee in enrollment request";
    result = ENROLL_FAILED;
  } else if (fingerprintId < 1 || fingerprintId >= (int)finger.capacity()) {
    enrollDetail = "ID " + String(fingerprintId) + " is outside this R307's usable slots 1-" + String((int)finger.capacity() - 1);
    result = ENROLL_FAILED;
  } else {
    // enrollFingerprint checks the live mappings, not the possibly stale cache.
    result = enrollFingerprint(fingerprintId, memberName);
  }

  bool added = false;
  if (result == ENROLL_OK) {
    showEnrollScreen(memberName, fingerprintId, ENROLL_SCANS, "SENDING TO WEB", "Please wait");
    const int code = postMappingToServer(fingerprintId, memberId, memberName);
    if (code == 200) {
      rememberMapping(fingerprintId, memberName, memberId);
      // Keep the offline name cache in step with what the website just agreed
      // to, so this person's scans show their name even before the next full
      // list download.
      saveMappingCache();
      added = true;
      showBig(memberName, "ADDED", "scans fine - ID " + String(fingerprintId));
      beepSuccess();
      delay(2000);
    } else if (code >= 400 && code < 500) {
      // The website refused the mapping (for example the ID was taken).
      showLines("Web refused mapping", "Template on sensor", "Check web / Serial", "");
      beepError();
      reportJobFailed(jobId, "website refused the mapping");
      delay(WARNING_SHOW_MS);
    } else {
      // The finger is stored on the sensor; the website will get the mapping soon.
      mappingPending = true;
      mapPendingTries = 0;
      mapFingerprintId = fingerprintId;
      mapMemberId = memberId;
      mapJobId = jobId;
      mapMemberName = memberName;
      mapNextTryMs = millis() + MAPPING_RETRY_MS;
      // Do not cache an unconfirmed owner. A later refusal must not make an
      // offline scan look as though it belongs to this employee.
      added = true;
      showBig(memberName, "OK", "Syncing to web...");
      beepSuccess();
      delay(2000);
    }
  } else {
    // The reason goes to the website in full, so the admin page can print
    // which step failed and what the sensor answered.
    String reason = enrollReason(result);
    if (enrollDetail.length() > 0) reason = enrollDetail;
    if (enrollReaderBlind) {
      reason = reason + " (the reader never saw anything on the glass)";
    }
    // The LCD takes 20 characters per row and the full detail is for the
    // website and the Serial log, so the glass says the shortest true thing.
    showLines("ENROLL FAILED",
              enrollReaderBlind ? String("Reader saw nothing") : String(enrollReason(result)),
              "Check website", "and try again");
    beepError();
    reportJobFailed(jobId, reason);
    // Leave the explanation visible long enough to read it at the door.
    delay(6000);
  }

  enrollingFromServer = false;
  showIdleScreen();
  xSemaphoreGive(sensorMutex);
  return added;
}

// The last step of Add Fingerprint: tell the website which finger is whose.
// Returns the HTTP code (negative = no connection).
int postMappingToServer(int fingerprintId, int memberId, const String &memberName) {
  if (WiFi.status() != WL_CONNECTED) return -1;

  HTTPClient http;
  http.setTimeout(SERVER_TIMEOUT_MS);
  beginServerRequest(http, "/api/attendance/mappings");
  addDeviceHeaders(http);

  DynamicJsonDocument doc(768);
  doc["fingerprintId"] = fingerprintId;
  doc["memberId"] = memberId;
  doc["memberName"] = memberName;
  doc["staffName"] = memberName;
  doc["deviceId"] = deviceId;
  String json;
  serializeJson(doc, json);
  const int httpCode = http.POST(json);
  const String body = httpCode == 200 ? http.getString() : String("");
  http.end();

  Serial.print("Mapping posted, HTTP ");
  Serial.println(httpCode);
  if (httpCode == 408 || httpCode == 429) return -1; // transient: retry, don't declare a refusal
  if (httpCode == 200) {
    DynamicJsonDocument reply(1024);
    const bool confirmed = !deserializeJson(reply, body) && (reply["success"] | false) &&
                           (reply["fingerprintId"] | 0) == fingerprintId &&
                           memberId > 0 && (reply["memberId"] | 0) == memberId;
    if (!confirmed) {
      Serial.println("Website did not confirm this employee and fingerprint; will retry");
      return -1; // an unrelated HTTP 200 is not a mapping acknowledgement
    }
  }
  return httpCode;
}

// Tells the website the device picked the job up. The LCD already says
// PREPARING; the actual place/lift instructions follow the safety checks.
void reportJobStarted(int jobId, int fingerprintId) {
  if (jobId <= 0 || WiFi.status() != WL_CONNECTED) return;

  /* This runs BEFORE the first PLACE FINGER prompt, so it must not hold the
   * door for the eight second website budget (twice, because the retry below).
   * The receipt is a courtesy to the admin page; the job row already exists on
   * the website whether or not it arrives. A weak link gets three seconds. */
  HTTPClient http;
  http.setTimeout(3000);
  beginServerRequest(http, "/api/attendance/mappings");
  addDeviceHeaders(http);

  DynamicJsonDocument doc(512);
  doc["action"] = "job_started";
  doc["jobId"] = jobId;
  doc["fingerprintId"] = fingerprintId;
  doc["deviceId"] = deviceId;
  doc["templates"] = templateCount;
  doc["detail"] = "Scanner received the request. Wait for PLACE FINGER on its screen (ID " +
                  String(fingerprintId) + ")";
  String json;
  serializeJson(doc, json);
  int httpCode = http.POST(json);
  if (httpCode <= 0) {
    // A weak link drops single requests. The admin page is waiting for this
    // one, so ask once more before letting it show "waiting for the device".
    http.end();
    delay(400);
    beginServerRequest(http, "/api/attendance/mappings");
    addDeviceHeaders(http);
    httpCode = http.POST(json);
  }
  http.end();

  Serial.print("Announced job ");
  Serial.print(jobId);
  Serial.print(" to the website, HTTP ");
  Serial.println(httpCode);
}

// A failed enrollment must not remain silently pending on the website if its
// first report was lost. Retry the report, not the fingerprint capture.
void reportJobFailed(int jobId, const String &reason) {
  if (jobId <= 0) return;
  pendingFailureJobId = jobId;
  pendingFailureTries = 0;
  pendingFailureReason = reason.substring(0, 160);
  pendingFailureRetryAt = millis();
  retryPendingEnrollmentFailure();
}

void retryPendingEnrollmentFailure() {
  if (!pendingFailureJobId || WiFi.status() != WL_CONNECTED ||
      (int32_t)(millis() - pendingFailureRetryAt) < 0) return;

  HTTPClient http;
  http.setTimeout(SERVER_TIMEOUT_MS);
  beginServerRequest(http, "/api/attendance/mappings");
  addDeviceHeaders(http);

  DynamicJsonDocument doc(512);
  doc["action"] = "job_failed";
  doc["jobId"] = pendingFailureJobId;
  doc["reason"] = pendingFailureReason;
  String json;
  serializeJson(doc, json);
  const int httpCode = http.POST(json);
  const String body = httpCode == 200 ? http.getString() : String("");
  http.end();

  DynamicJsonDocument reply(512);
  const bool confirmed = httpCode == 200 && !deserializeJson(reply, body) &&
                         (reply["success"] | false) && (reply["jobId"] | 0) == pendingFailureJobId;
  Serial.print("Reporting failed enrollment ");
  Serial.print(pendingFailureJobId);
  Serial.print(", HTTP ");
  Serial.println(httpCode);
  if (confirmed) {
    pendingFailureJobId = 0;
    pendingFailureReason = "";
    pendingFailureTries = 0;
  } else if (++pendingFailureTries >= FAILURE_REPORT_MAX_TRIES) {
    // The job will expire on the website by itself. Holding every later
    // enrollment behind a report that this server never confirms is worse.
    Serial.println("Giving up on the enrollment failure report; new jobs may be picked up again");
    pendingFailureJobId = 0;
    pendingFailureReason = "";
    pendingFailureTries = 0;
  } else {
    Serial.println("Enrollment failure report not confirmed; will retry");
    pendingFailureRetryAt = millis() + 5000UL;
  }
}

// Retry only the website mapping, never the sensor capture. A verified 200
// finishes it; a definite refusal reports the failure to the original job.
void retryPendingMapping() {
  if (!mappingPending || enrollingFromServer) return;
  if ((int32_t)(millis() - mapNextTryMs) < 0) return;

  const int code = postMappingToServer(mapFingerprintId, mapMemberId, mapMemberName);
  if (code == 200) {
    mappingPending = false;
    mapPendingTries = 0;
    rememberMapping(mapFingerprintId, mapMemberName, mapMemberId);
    saveMappingCache();
    Serial.println("Pending mapping delivered to the website");
  } else if (code >= 400 && code < 500) {
    mappingPending = false;
    mapPendingTries = 0;
    Serial.println("Website refused the pending mapping");
    reportJobFailed(mapJobId, "website refused the mapping");
  } else if (++mapPendingTries >= MAPPING_MAX_TRIES) {
    /* The finger IS stored on the reader (the confirm scan proved it), only the
     * website never confirmed which employee owns it. Say exactly that, release
     * the reader for the next job, and let the admin finish the mapping by hand
     * - the template and its ID are real. */
    mappingPending = false;
    mapPendingTries = 0;
    Serial.println("Giving up on the website mapping; the finger stays stored on the sensor");
    Serial.print("  the sensor holds it as ID ");
    Serial.print(mapFingerprintId);
    Serial.println(" - map that ID in admin > Staff Fingerprints");
    // This runs in the network task, which never writes to the LCD: the message
    // goes to the website (the job is closed as failed with this text) and to
    // the Serial monitor, and the door keeps scanning.
    reportJobFailed(mapJobId, "the finger is stored on the scanner as ID " + String(mapFingerprintId) +
                              ", but the website did not confirm the employee: map that ID in admin > Staff Fingerprints");
  } else {
    mapNextTryMs = millis() + MAPPING_RETRY_MS;
  }
}

/* ── Enrollment: the module's two captures, then a confirm scan ──────────────
 *
 * WHY THIS FILE USED TO SAY "ADDED" AND THE SCANNER THEN SAID "NOT REGISTERED"
 *
 * The owner's report (October 2026): the admin pressed ADD FINGERPRINT, the
 * device walked through the six guided scans, the page printed Fingerprint
 * Added ✓ - and the next time that person scanned his finger, the LCD said
 * NOT REGISTERED / Finger not enrolled.
 *
 * "NOT REGISTERED" is not a website message. It is what THIS device prints
 * when the fingerprint reader itself answers a scan with status 5 (NOUSER): the module
 * saw a finger and found no template for it. So the finger was never really
 * stored, even though every command of the enrollment had answered "OK".
 *
 * The R307 enrollment protocol uses two character buffers. Capture 1 records
 * one view; capture 2 records a slightly shifted view, then the module creates
 * and stores one rotation-tolerant model. The compatibility wrapper performs
 * that sequence and exposes only the small interface used by this sketch.
 *
 * So a session is now the two documented captures, each from its own placement,
 * and the two rules this module really does enforce still hold (they are what
 * PR #50 broke and what the module's answers confirm):
 *
 *  1. The employee lifts between the two captures so buffer 2 receives a
 *     genuinely fresh view, not the same unmoving image.
 *  2. Each capture waits for a flat, still finger; unclear images are rejected
 *     and explained instead of being silently accepted.
 *
 * AND THE RULE THAT WAS MISSING, which is the real fix:
 *
 *  3. "OK" from an ADD command is not proof that the finger is enrolled. After
 *     the second capture the device runs a CONFIRM SCAN (a SEARCH - legal again,
 *     the session is over) against a fresh placement, and the module has to
 *     answer with THIS id. Only then is the mapping posted to the website.
 *     A finger the module cannot find again fails the job with that reason on
 *     the LCD and on the admin page, so "added" can no longer mean "not
 *     registered".
 */

const char *enrollReason(EnrollResult result) {
  switch (result) {
    case ENROLL_NO_FINGER:     return "no finger was placed";
    case ENROLL_UNCLEAR:       return "fingerprint not clear";
    case ENROLL_LIFT_TIMEOUT:  return "finger was not lifted";
    case ENROLL_ID_IN_USE:     return "ID already in use";
    case ENROLL_SENSOR_FULL:   return "sensor rejected the slot or memory";
    case ENROLL_SENSOR_ERROR:  return "sensor communication or memory error";
    case ENROLL_NOT_CONFIRMED: return "finger does not scan successfully";
    default:                   return "enroll failed";
  }
}

/* ── Reading the glass ──────────────────────────────────────────────────────
 * One SEARCH, read the way the idle scan loop reads it: the module puts the
 * matched ID and its permission tier in the same reply, so "a match" means
 * search() said yes AND an id came back. Status 5 means the module saw a
 * finger it has no template for, 6 means it saw one it could not use.
 *
 *   2 = matched, matchedId is the template it found
 *   1 = a finger is on the glass, not enrolled
 *   0 = no finger
 *  -1 = a finger is there, image unclear
 *  -2 = the sensor did not answer properly
 */
int searchGlass(uint16_t &matchedId, uint32_t waitMs) {
  uint8_t permission = 0;
  matchedId = 0;
  const bool matched = finger.search(matchedId, permission, waitMs) && matchedId > 0;
  if (matched) return 2;
  switch (finger.getLastStatus()) {
    case BIOVO_ACK_NOUSER:    return 1;
    case BIOVO_ACK_IMAGEMESS: return -1;
    case BIOVO_ACK_TIMEOUT:
    case BIOVO_ACK_GO_OUT:    return 0;
    // Silence or a bad packet is NOT an empty glass.
    case BIOVO_ACK_NO_RESPONSE:
    case BIOVO_ACK_COMM_ERROR: return -2;
    default:                  return -2;
  }
}

/* ── Pre-flight helpers: legal ONLY before the first ADD command ──────────── */

// GETIMAGE checks for contact without converting/searching or overwriting
// character buffer 1. It is safe even between the two R307 captures.
int glassHasFinger() {
  return finger.fingerPresent();
}

// Empties the sensor slot for id. Both callers only get here for an ID that
// no person on the website is mapped to, so whatever is in that slot is a
// leftover from an earlier attempt and must go BEFORE the guided placement -
// a DELETE sent in the middle of it breaks the whole session.
bool freeLeftoverTemplate(int id) {
  const int16_t before = finger.getCount(3000);
  if (before < 0) {
    enrollDetail = "sensor did not answer the pre-enrollment count";
    return false;
  }
  templateCount = before;

  Serial.print("Freeing sensor slot ID ");
  Serial.print(id);
  Serial.print(" (templates before: ");
  Serial.print(before);
  Serial.println(")");

  // Some R307s report DELETEFAIL for an already empty slot. Any other failed
  // acknowledgement is not evidence of an empty slot and must stop the job.
  if (!finger.deleteUser((uint16_t)id, 5000)) {
    const uint8_t status = finger.getLastStatus();
    if (finger.getLastRawStatus() != FINGERPRINT_DELETEFAIL) {
      enrollDetail = "could not prepare sensor slot: " + String(fingerStatusText(status));
      return false;
    }
    Serial.println("Slot delete was refused (the slot may already be empty)");
    return true;
  }
  Serial.println("Leftover template under this ID was deleted");
  const int16_t after = finger.getCount(3000);
  if (after >= 0) templateCount = after;
  return true;
}

// 1 = two honest no-finger replies, 0 = lift timed out, -1 = sensor error.
// A disconnected reader is never mistaken for an empty glass. GETIMAGE does
// not overwrite either character buffer, so this is safe between the R307 captures.
int waitGlassEmpty(const String &who, int id, uint32_t budgetMs, uint8_t progress) {
  const uint32_t startedAt = millis();
  uint8_t emptyReads = 0;
  uint8_t errors = 0;
  showEnrollScreen(who, id, progress, "LIFT YOUR FINGER", "Then place it again");
  keepReaderLampOn(READER_LAMP_BURST_MS);   // a dark glass cannot report a lift
  while ((uint32_t)(millis() - startedAt) < budgetMs) {
    // A dark glass cannot report a lift either: keep asking for the light while
    // this waits, at the idle cadence (a no-op when the reader confirms it).
    keepReaderLampOn(READER_LAMP_IDLE_MS);
    const int state = glassHasFinger();
    if (state == 0) {
      errors = 0;
      if (++emptyReads >= 2) {
        Serial.println("Finger lifted - glass is empty");
        return 1;
      }
    } else if (state > 0) {
      emptyReads = 0;
      errors = 0;
    } else {
      emptyReads = 0;
      if (++errors >= 2) {
        enrollDetail = "sensor did not respond while checking for a lift: " + String(fingerStatusText(finger.getLastStatus()));
        return -1;
      }
      Serial.println("Sensor reply missed while checking for a lift; retrying");
    }
    delay(150);
  }
  enrollDetail = "finger was not lifted in time";
  return 0;
}

/* ── One session: two R307 captures from genuinely fresh placements ───── */
EnrollResult runCaptureSession(int id, const String &who, uint32_t deadlineMs) {
  for (uint8_t step = 1; step <= ENROLL_STEPS; step++) {
    if (step > 1 && !enrollKeepFingerDown) {
      // On an R307 GETIMAGE only tests contact; it does not change buffer 1.
      // Do not guess that the finger was lifted just because 2.5 s elapsed.
      const int lifted = waitGlassEmpty(who, id, ENROLL_LIFT_BUDGET_MS, step - 1);
      if (lifted < 0) return ENROLL_SENSOR_ERROR;
      if (lifted == 0) return ENROLL_LIFT_TIMEOUT;
    }
    if (step > 1 && enrollKeepFingerDown) {
      // Fallback flow: the finger stays where it is and the reader takes the
      // second view from the same steady press.
      showEnrollScreen(who, id, step - 1, "KEEP IT DOWN", "Taking 2nd picture");
      keepReaderLampOn(READER_LAMP_BURST_MS);
      delay(ENROLL_LIFT_PAUSE_MS);
    }

    bool captureDone = false;
    uint8_t unclear = 0;
    for (uint8_t attempt = 1; attempt <= ENROLL_MAX_ATTEMPTS; attempt++) {
      if ((int32_t)(deadlineMs - millis()) <= 0) {
        enrollDetail = "took too long at step " + String(step) + "/" + String(ENROLL_STEPS);
        return ENROLL_FAILED;
      }
      showEnrollScreen(who, id, step - 1, "PLACE FINGER",
                       enrollKeepFingerDown ? String("Keep it down, flat, still")
                                            : "Step " + String(step) + "/" + String(ENROLL_STEPS) + " flat, still");
      // The prompt is up: light the glass and start asking the reader for an
      // image immediately. (This used to wait 2.5 s first, which made the
      // reader look dead while it was simply not being asked.)
      keepReaderLampOn(READER_LAMP_BURST_MS);
      delay(ENROLL_PLACE_SETTLE_MS);
      const int32_t remaining = (int32_t)(deadlineMs - millis());
      if (remaining <= 0) {
        enrollDetail = "enrollment took too long";
        return ENROLL_FAILED;
      }
      const uint32_t waitMs = (uint32_t)remaining < ENROLL_ADD_TIMEOUT_MS ? (uint32_t)remaining : ENROLL_ADD_TIMEOUT_MS;
      Serial.print("Capture ");
      Serial.print(step);
      Serial.print("/2, attempt ");
      Serial.println(attempt);
      // A transient early no-finger reply must not end the job before the
      // promised placement window. Keep the same prompt and remaining budget.
      // The R307 adapter classifies unexpected responses after conversion or
      // STORE as image/sensor errors, so an ambiguous write is never retried.
      const uint32_t waitStarted = millis();
      uint32_t emptyReplies = 0;
      uint32_t unclearReplies = 0;
      const uint32_t lastSightMs = waitStarted;
      bool reSynced = false;
      bool saidBlind = false;
      bool accepted = false;
      for (;;) {
        const uint32_t elapsed = (uint32_t)(millis() - waitStarted);
        if (elapsed >= waitMs) break;
        /* Ask for the placement in slices, not one long block: between slices
         * the reader's illumination is re-asserted. A variant that switched it
         * off (or never acknowledged the command at boot) then still gets a
         * chance to see the finger instead of answering "no finger" for a full
         * minute - the "sensor does not light up" report. */
        const uint32_t left = waitMs - elapsed;
        const uint32_t slice = left < (uint32_t)ENROLL_LAMP_NUDGE_MS ? left : (uint32_t)ENROLL_LAMP_NUDGE_MS;
        accepted = finger.enroll((uint16_t)id, step, slice);
        emptyReplies += finger.emptyGlassInLastWait();
        unclearReplies += finger.unclearInLastWait();
        if (accepted) break;
        const uint8_t code = finger.getLastStatus();
        if (code != BIOVO_ACK_TIMEOUT) break;   // a real answer ends the wait
        /* That slice saw nothing at all. Two repairs, both local to the reader:
         * once, a protocol re-sync (a confused module answers nothing), and then
         * an honest LCD line instead of a prompt that promises a glass the
         * reader cannot see. The job itself keeps its full budget. */
        const uint32_t blindFor = (uint32_t)(millis() - lastSightMs);
        if (!reSynced && step == 1 && blindFor >= (uint32_t)ENROLL_RESYNC_MS) {
          /* Only before the FIRST capture of a session. Between the two captures
           * the reader is holding the first image in its own buffer, and a
           * handshake is not worth the risk of disturbing it: a blind second
           * capture gets the light request below and nothing more. */
          reSynced = true;
          Serial.println("The reader has seen nothing yet: re-syncing it and asking for its light");
          nudgeReaderLamp();
          finger.handshake(1200);
        }
        if (!saidBlind && blindFor >= (uint32_t)ENROLL_NO_SIGHT_MS) {
          saidBlind = true;
          enrollReaderBlind = true;
          Serial.println("The reader still sees nothing on the glass: check its light, its power and the glass itself");
          showEnrollScreen(who, id, step - 1, "PLACE FINGER", "Reader sees nothing");
        }
        nudgeReaderLamp();
        const uint32_t used = (uint32_t)(millis() - waitStarted);
        if (used >= waitMs) break;
        Serial.println("No image yet; still waiting for this placement");
        const uint32_t pause = waitMs - used < 100U ? waitMs - used : 100U;
        delay(pause);
      }
      if (accepted) {
        Serial.println("Capture accepted");
        beepSuccess();
        captureDone = true;
        break;
      }

      const uint8_t st = finger.getLastStatus();
      Serial.print("Capture not accepted: ");
      Serial.print(fingerStatusText(st));
      Serial.print(" (status ");
      Serial.print(st);
      Serial.print(", R307 status ");
      Serial.print(finger.getLastRawStatus());
      Serial.println(")");
      enrollDetail = "step " + String(step) + "/" + String(ENROLL_STEPS) + ": " +
                     String(fingerStatusText(st)) + " (status " + String(st) + ")";

      if (st == BIOVO_ACK_USER_EXIST) return ENROLL_ID_IN_USE;
      if (st == BIOVO_ACK_FULL) return ENROLL_SENSOR_FULL;
      if (st == BIOVO_ACK_FLASH_ERROR || st == BIOVO_ACK_NO_RESPONSE || st == BIOVO_ACK_COMM_ERROR) {
        // A lost STORE reply is ambiguous. Never blindly announce success or
        // repeat a potentially completed write as if it definitely failed.
        return ENROLL_SENSOR_ERROR;
      }
      if (st == BIOVO_ACK_MISMATCH) {
        enrollDetail = "the two captures did not match; use the same finger for both";
        showEnrollScreen(who, id, 0, "SAME FINGER", "Start again");
        return ENROLL_FAILED; // new session, with two new captures
      }
      if (st == BIOVO_ACK_TIMEOUT) {
        /* Say WHICH no-finger this was. "The reader answered 'no finger' 850
         * times and never once saw an image" is a reader that cannot see
         * (light, glass, power, wiring). It is not someone forgetting to press.
         * The admin page and the Serial log now carry that difference. */
        Serial.print("  reader answers during the wait: no-finger ");
        Serial.print(emptyReplies);
        Serial.print(", unclear ");
        Serial.println(unclearReplies);
        enrollDetail = "no finger within " + String(waitMs / 1000) +
                       " s: the reader answered 'no finger' " + String(emptyReplies) +
                       " times and 'unclear' " + String(unclearReplies) +
                       " times - check its light, power and the glass";
        if (enrollReaderBlind)
          enrollDetail = enrollDetail + " (it saw nothing at all for over ten seconds)";
        return ENROLL_NO_FINGER;
      }
      if (st == BIOVO_ACK_IMAGEMESS) {
        if (++unclear >= ENROLL_MAX_UNCLEAR) return ENROLL_UNCLEAR;
        if (unclear % ENROLL_HOLD_STILL_AT == 0) {
          showEnrollScreen(who, id, step - 1, "LIFT, PLACE AGAIN", "Flat and still");
          beepError();
          const int lifted = waitGlassEmpty(who, id, ENROLL_LIFT_BUDGET_MS, step - 1);
          if (lifted < 0) return ENROLL_SENSOR_ERROR;
          if (lifted == 0) return ENROLL_LIFT_TIMEOUT;
        } else {
          showEnrollScreen(who, id, step - 1, "HOLD STILL", "Press flat, gently");
          delay(800);
        }
        continue;
      }
      return ENROLL_FAILED;
    }
    if (!captureDone) return ENROLL_UNCLEAR;
  }
  enrollDetail = "";
  return ENROLL_OK;
}

/* ── Confirm the stored template on one genuinely fresh placement ──────────
 * The previous working flow used two captures and one confirmation. A match
 * must return this exact ID; an unclear, wrong or unmatched finger is never
 * rounded up to success. The matcher security level is left unchanged.
 */
EnrollResult confirmEnrolledFinger(int id, const String &who, uint32_t deadlineMs) {
  const int32_t remaining = (int32_t)(deadlineMs - millis());
  const uint32_t verifyBudget = remaining <= 0 ? 0 :
    ((uint32_t)remaining < ENROLL_VERIFY_BUDGET_MS ? (uint32_t)remaining : ENROLL_VERIFY_BUDGET_MS);
  const uint32_t lastMoment = millis() + verifyBudget;

  int found = 0;      // confirmations the module has granted
  int missed = 0;     // placements the module could not match
  int lastMiss = 0;   // distinguish an unclear image from a real no-match
  uint16_t wrongId = 0;   // a match that came back under another ID

  while (found < ENROLL_VERIFY_PLACEMENTS) {
    // A fresh press every time, like every real scan of the day - not the
    // finger that has been lying on the glass since the last capture.
    const int lifted = waitGlassEmpty(who, id, ENROLL_LIFT_BUDGET_MS, ENROLL_STEPS + found);
    if (lifted < 0) return ENROLL_SENSOR_ERROR;
    if (lifted == 0) return ENROLL_LIFT_TIMEOUT;
    if ((int32_t)(lastMoment - millis()) <= 0) {
      enrollDetail = "the finger does not scan successfully: no time left for the confirm scans";
      return ENROLL_NOT_CONFIRMED;
    }

    // Row 2 stays the one instruction the person knows from every step.
    showEnrollScreen(who, id, ENROLL_STEPS + found, "PLACE FINGER",
                     "Confirm " + String(found + 1) + "/" + String(ENROLL_VERIFY_PLACEMENTS));
    keepReaderLampOn(READER_LAMP_BURST_MS);
    delay(ENROLL_PLACE_SETTLE_MS);

    uint16_t matchedId = 0;
    const uint32_t scanStart = millis();
    const int32_t scanRemaining = (int32_t)(lastMoment - millis());
    if (scanRemaining <= 0) {
      enrollDetail = "no time left for the confirm scan";
      return ENROLL_NOT_CONFIRMED;
    }
    const uint32_t scanWait = (uint32_t)scanRemaining < ENROLL_ADD_TIMEOUT_MS ? (uint32_t)scanRemaining : ENROLL_ADD_TIMEOUT_MS;
    int state = 0;
    for (;;) {
      const uint32_t elapsed = (uint32_t)(millis() - scanStart);
      if (elapsed >= scanWait) break;
      // Slices, so the reader's light is re-asserted while this placement
      // waits - the same reason as in runCaptureSession().
      const uint32_t left = scanWait - elapsed;
      const uint32_t slice = left < (uint32_t)ENROLL_LAMP_NUDGE_MS ? left : (uint32_t)ENROLL_LAMP_NUDGE_MS;
      state = searchGlass(matchedId, slice);
      if (state != 0) break;
      nudgeReaderLamp();
      const uint32_t used = (uint32_t)(millis() - scanStart);
      if (used >= scanWait) break;
      const uint32_t pause = scanWait - used < 100U ? scanWait - used : 100U;
      delay(pause);
    }
    Serial.print("Confirm scan ");
    Serial.print(found + 1);
    Serial.print("/");
    Serial.print(ENROLL_VERIFY_PLACEMENTS);
    Serial.print(" for ID ");
    Serial.print(id);
    if (state == 2) {
      Serial.print(" -> the sensor answered ID ");
      Serial.print(matchedId);
    } else if (state == 1) {
      Serial.print(" -> NOT REGISTERED on the sensor (status 5)");
    } else if (state == 0) {
      Serial.print(" -> no finger");
    } else if (state == -1) {
      Serial.print(" -> image unclear");
    } else {
      Serial.print(" -> sensor not answering");
    }
    Serial.print(" after ");
    Serial.print(millis() - scanStart);
    Serial.println(" ms");

    if (state == 2) {
      if (matchedId == (uint16_t)id) {
        found++;
        beepSuccess();
        continue;
      }
      // The finger IS on the sensor, just under somebody else's number. That
      // can never become this person's finger, so stop and say so.
      wrongId = matchedId;
      break;
    }
    if (state == -2) {
      enrollDetail = "sensor did not answer the confirm scan: " + String(fingerStatusText(finger.getLastStatus()));
      return ENROLL_SENSOR_ERROR;
    }
    if (state == 0) {
      enrollDetail = "nobody placed the finger for the confirm scan";
      return ENROLL_NO_FINGER;
    }

    // 1 = the module sees the finger but holds no template for it (status 5,
    // the answer the owner heard on the scanner). -1 = image unclear.
    lastMiss = state;
    missed++;
    if (missed > ENROLL_VERIFY_RETRIES) break;
    showEnrollScreen(who, id, ENROLL_STEPS + found, "DOES NOT SCAN",
                     "LIFT, PLACE AGAIN");
    beepError();
    delay(ENROLL_LIFT_PAUSE_MS);
  }

  // Every confirmation was granted: this finger is on the sensor and finds
  // its own ID, which is the only thing that may be called "added".
  if (found >= ENROLL_VERIFY_PLACEMENTS) {
    Serial.println("The sensor found this finger on every confirm scan: enrolled.");
    enrollDetail = "";
    return ENROLL_OK;
  }

  if (wrongId) {
    enrollDetail = "the sensor found this finger under ID " + String(wrongId) +
                   ", not " + String(id);
    return ENROLL_ID_IN_USE; // do not erase/retry a finger belonging to someone else
  } else if (lastMiss == -1) {
    enrollDetail = "the confirm image stayed unclear; clean the sensor and place the finger flat";
  } else {
    enrollDetail = "the sensor did not find the stored finger on " + String(missed) +
                   " fresh scan(s) (NOT REGISTERED)";
  }
  return ENROLL_NOT_CONFIRMED;
}

/* ── Is the name list fresh enough to clear a sensor slot? ──────────────────
 *
 * Before Add Fingerprint can use a slot it must be sure nobody owns it, so it
 * reads the fingerprint names. That request used to be allowed to fail the job
 * outright ("cannot check current fingerprint mappings; reconnect to the
 * website and retry"), which turned one slow or dropped HTTP GET on a weak
 * link into "the admin pressed Add Fingerprint and the scanner said no".
 *
 * The list in flash is a complete copy of the last successful download, and the
 * website hands out only IDs it believes are free. So a cached list is exactly
 * as safe for this decision as a fresh one, and the door keeps working when the
 * link is weak - which is what the owner asked for: the connection is needed to
 * START an enrollment, not to babysit every second of it.
 *
 * Only a device that has never received the list (fresh flash, never online)
 * refuses, because then it truly cannot tell whose slot an ID is.
 */
bool enrollMappingsAreCurrent() {
  // With a saved list in flash the fresh request is a bonus, not a necessity,
  // so it gets a short budget: the person at the door must not stand in front
  // of a PREPARING screen while a weak link times out twice. A cafe link that
  // answers at all answers this small GET in well under a second; one that
  // does not is treated exactly like no link.
  const uint32_t budget = mappingListKnown ? 1500UL : (uint32_t)SERVER_TIMEOUT_MS;
  if (loadMappingsFromServer(budget)) return true;   // sets mappingListKnown itself
  if (!mappingListKnown) {
    enrollDetail = "the scanner has no employee list yet: connect it to the website once, then retry";
    Serial.println("Enrollment refused: no fingerprint name list has ever been loaded");
    return false;
  }
  Serial.println("Website names are not reachable: using the list saved in flash for this enrollment");
  return true;
}

// Stores one finger under id. who is the name shown on the LCD ("" = manual).
// The website job and the Serial `enroll <id>` command both land here and are
// walked through exactly the same pre-flight, so they cannot drift apart.
// Success means ONE thing only: the module stored the finger and finds it again.
EnrollResult enrollFingerprint(int id, const String &who) {
  // Keeps checkLcdHealth() away for the whole job (every return path clears it
  // again): the captures must not be interrupted by anything.
  EnrollmentGuard enrollmentGuard;
  // Every job starts with the preferred two-placement flow.
  enrollKeepFingerDown = false;
  enrollReaderBlind = false;

  Serial.print("Enrolling ID ");
  Serial.println(id);
  Serial.println("Two captures: place the same finger flat and still for each one, and lift it in between.");

  enrollDetail = "";
  showEnrollScreen(who, id, 0, "PREPARING...", "Please wait");

  /* Wake the glass before anybody is asked for a finger. This is the one place
   * that always tries the light, even when the reader refused the command at
   * boot: a module that has since started answering it is picked up here, and
   * an enrollment is exactly when a dark reader wastes a minute of a person's
   * time. */
  nudgeReaderLamp();

  // An offline or stale name list must never authorize deleting another
  // employee's sensor slot, so the check below has to be honest about what it
  // knows. It no longer insists on a live request: see
  // enrollMappingsAreCurrent() for why the copy in flash is safe here.
  if (!enrollMappingsAreCurrent()) return ENROLL_FAILED;
  String mappedName;
  if (mappedNameForId(id, mappedName)) {
    enrollDetail = "ID " + String(id) + " already belongs to " + mappedName;
    return ENROLL_ID_IN_USE;
  }

  // Drop stale replies from the idle scan loop and wait for a quiet line,
  // so the first reply we read really belongs to our first ADD command.
  finger.drain(150);

  // A finger still on the sensor when enrollment ends must not be clocked by
  // the very next idle search; the lift that ends enrollment resets this.
  awaitingFingerLift = true;

  /* ── Pre-flight 1: free the sensor slot (before anybody is asked for a
   *    finger, because a DELETE mid-placement breaks the session). ── */
  if (!freeLeftoverTemplate(id)) return ENROLL_SENSOR_ERROR;

  /* Start from an EMPTY glass for both the website and Serial flows. */
  const int preflightLift = waitGlassEmpty(who, id, ENROLL_LIFT_BUDGET_MS, 0);
  if (preflightLift < 0) return ENROLL_SENSOR_ERROR;
  if (preflightLift == 0) return ENROLL_LIFT_TIMEOUT;

  const uint32_t deadlineMs = millis() + ENROLL_TOTAL_BUDGET_MS;
  EnrollResult outcome = ENROLL_FAILED;
  uint8_t blindWindows = 0;

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
      // A mapping may have changed while the employee was placing a finger.
      // Recheck before a retry can delete the unconfirmed slot again.
      if (!enrollMappingsAreCurrent()) return ENROLL_FAILED;
      String mappedName;
      if (mappedNameForId(id, mappedName)) {
        enrollDetail = "ID " + String(id) + " already belongs to " + mappedName;
        return ENROLL_ID_IN_USE;
      }
      // An unconfirmed session can still have written a template under this
      // ID. Free it again BEFORE the new placement.
      if (!freeLeftoverTemplate(id)) return ENROLL_SENSOR_ERROR;
      const int retryLift = waitGlassEmpty(who, id, ENROLL_LIFT_BUDGET_MS, 0);
      if (retryLift < 0) return ENROLL_SENSOR_ERROR;
      if (retryLift == 0) return ENROLL_LIFT_TIMEOUT;
    }

    /* The last attempt switches flows: both captures from one steady press.
     * Everything before it is the preferred two-placement flow. */
    enrollKeepFingerDown = (session == ENROLL_MAX_SESSIONS);
    if (enrollKeepFingerDown) {
      Serial.println("Last attempt: taking both pictures from one steady press");
    }
    outcome = runCaptureSession(id, who, deadlineMs);

    /* Nothing was seen on the glass for a whole window. Before that becomes a
     * failed job, ask once more: a reader whose light came back late, or a
     * person who pressed a moment after the prompt, then still enrolls instead
     * of sending the admin back to the website for nothing. */
    while (outcome == ENROLL_NO_FINGER && ++blindWindows < ENROLL_NO_FINGER_WINDOWS &&
           (int32_t)(deadlineMs - millis()) > 0) {
      Serial.println("No finger was seen in that window: asking for it once more");
      nudgeReaderLamp();
      showEnrollScreen(who, id, 0, "TRY AGAIN", "Same finger, flat");
      beepError();
      delay(ENROLL_LIFT_PAUSE_MS);
      const int blindLift = waitGlassEmpty(who, id, ENROLL_LIFT_BUDGET_MS, 0);
      if (blindLift < 0) return ENROLL_SENSOR_ERROR;
      outcome = runCaptureSession(id, who, deadlineMs);
    }

    if (outcome == ENROLL_OK) {
      const int16_t newCount = finger.getCount(3000);
      if (newCount >= 0) templateCount = newCount;
      // Restore the previous sketch's flash-settle and UART quiet period before
      // the fresh confirmation. Count is diagnostic, never proof of a match.
      delay(500);
      finger.drain(100);
      delay(250);
      outcome = confirmEnrolledFinger(id, who, deadlineMs);
      if (outcome == ENROLL_OK) {
        Serial.println("Fingerprint enrolled and confirmed by a fresh scan.");
        enrollDetail = "";
        return ENROLL_OK;
      }
      // The captures were accepted but the scan does not find the finger: the
      // whole sequence is the only repair, so fall through to a new session.
      Serial.print("The sensor did not confirm the finger (");
      Serial.print(enrollDetail);
      Serial.println(")");
    }

    // Nobody came to the scanner, the sensor is dead or the slot is taken:
    // retrying cannot help, so tell the website at once.
    if (outcome == ENROLL_NO_FINGER || outcome == ENROLL_SENSOR_FULL ||
        outcome == ENROLL_ID_IN_USE || outcome == ENROLL_UNCLEAR ||
        outcome == ENROLL_SENSOR_ERROR) {
      return outcome;
    }
    if ((int32_t)(deadlineMs - millis()) <= 0) {
      if (enrollDetail.length() == 0) enrollDetail = "enrollment took too long";
      return ENROLL_FAILED;
    }
  }

  if (enrollDetail.length() == 0) enrollDetail = enrollReason(outcome);
  return outcome;
}

// Serial "enroll <id>": store a finger on the sensor, map it in admin afterwards.
void manualEnroll(int id) {
  if (!sensorReady && !detectSensor(1)) {
    Serial.println("Fingerprint sensor not responding; cannot enroll.");
    showLines("Sensor offline", "Check wiring", "", "");
    beepError();
    delay(WARNING_SHOW_MS);
    showIdleScreen();
    return;
  }
  if (id < 1 || id >= (int)finger.capacity()) {
    Serial.print("Invalid ID. Usable R307 slots: 1-");
    Serial.println((int)finger.capacity() - 1);
    return;
  }
  // enrollFingerprint checks the fingerprint names before it can clear a slot
  // (a live download when the link answers, the copy in flash otherwise).
  const EnrollResult result = enrollFingerprint(id, "");
  if (result == ENROLL_OK) {
    // The sensor stores only the template. The admin must map this ID to a staff member.
    // enrollFingerprint() only returns ENROLL_OK after a fresh scan found this
    // finger again, so "Stored" here really means "stored AND readable".
    Serial.print("Stored as ID ");
    Serial.print(id);
    Serial.println(" (a scan finds it) - map it: admin → Attendance → Staff Fingerprints");
    showLines("Stored as ID " + String(id), "Scan confirmed it", "Map it in admin:", "Attendance > Staff");
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
// job is queued or a mapping changes. A periodic poll is also kept as a
// safety net when the stream is down or appears connected but misses an event.
void keepServerLinkAlive() {
  static bool wifiWasConnected = false;
  const bool wifiConnected = WiFi.status() == WL_CONNECTED;
  if (wifiConnected && !wifiWasConnected) {
    // The WiFi is back: the old sockets are dead, and NTP has to be asked
    // again or the clock on the LCD would stay where the drop found it.
    if (eventStreamActive) stopEventStream();
    startTimeSync();
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

  /* The pending-job poll is a SAFETY NET, not only a fallback. A weak link can
   * leave the event stream socket open and silent, and a door that hears about
   * a new fingerprint only when that socket recovers is the "I must stand near
   * the router to add a finger" the owner reported. Poll every five seconds
   * even with a connected stream so a lost event cannot hide an enrollment. */
  if (!enrollingFromServer && millis() - lastPendingCheck > PENDING_POLL_FALLBACK_MS) {
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
  beginServerRequest(eventHttp, "/api/attendance/events?channel=device");
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
    Serial.println("Real-time event: checking enrollment, then names and open hours");
    // An enrollment should not wait behind two unrelated HTTP requests, which
    // may each take seconds on a weak link. Enrollment itself still validates
    // the latest mappings before it can prepare any sensor slot.
    checkPendingEnroll();
    loadMappingsFromServer();
    loadRestScheduleFromServer();
  }
}

/* ── Names: fingerprintId -> staff, cached in LittleFS for offline use ────── */
bool mappedPersonForId(int id, String &name, int &memberId) {
  if (mappingMutex) xSemaphoreTake(mappingMutex, portMAX_DELAY);
  const auto it = fingerprintToStaff.find(id);
  const auto member = fingerprintToMember.find(id);
  const bool found = it != fingerprintToStaff.end();
  if (found) name = it->second;
  memberId = member == fingerprintToMember.end() ? 0 : member->second;
  if (mappingMutex) xSemaphoreGive(mappingMutex);
  return found;
}

bool mappedNameForId(int id, String &name) {
  int memberId = 0;
  return mappedPersonForId(id, name, memberId);
}

void rememberMapping(int id, const String &name, int memberId) {
  if (mappingMutex) xSemaphoreTake(mappingMutex, portMAX_DELAY);
  fingerprintToStaff[id] = name;
  if (memberId > 0) fingerprintToMember[id] = memberId;
  if (mappingMutex) xSemaphoreGive(mappingMutex);
}

bool applyMappingPayload(const String &payload) {
  // Ignore unrelated enrollment metadata so a normal staff list fits without
  // building the entire website response twice in RAM.
  StaticJsonDocument<256> filter;
  filter["count"] = true;
  filter["simpleMap"] = true;
  filter["mappings"][0]["fingerprintId"] = true;
  filter["mappings"][0]["memberId"] = true;
  DynamicJsonDocument doc(32768);
  if (deserializeJson(doc, payload, DeserializationOption::Filter(filter)) ||
      doc.overflowed() || !doc["simpleMap"].is<JsonObject>()) return false;
  std::map<int, String> next;
  std::map<int, int> nextMembers;
  for (JsonPair kv : doc["simpleMap"].as<JsonObject>()) {
    const int fid = String(kv.key().c_str()).toInt();
    if (fid <= 0 || !kv.value().is<const char *>()) return false;
    next[fid] = kv.value().as<String>();
  }
  if (!doc["mappings"].is<JsonArray>() || !doc["count"].is<int>()) return false;
  for (JsonObject row : doc["mappings"].as<JsonArray>()) {
    const int fid = row["fingerprintId"] | 0;
    const int memberId = row["memberId"] | 0;
    if (fid <= 0 || memberId <= 0 || !next.count(fid)) return false;
    nextMembers[fid] = memberId;
  }
  if (next.size() != nextMembers.size() || next.size() != (size_t)doc["count"].as<int>()) return false;
  if (mappingMutex) xSemaphoreTake(mappingMutex, portMAX_DELAY);
  fingerprintToStaff.swap(next);
  fingerprintToMember.swap(nextMembers);
  if (mappingMutex) xSemaphoreGive(mappingMutex);
  mappingListKnown = true;
  Serial.println("Fingerprint names loaded");
  return true;
}

/* Writes the names currently in RAM back to flash. Called after a mapping the
 * website has just confirmed, so a scan taken offline a minute later already
 * shows the employee's name on the LCD instead of "ID 7", even if the full list
 * has not been downloaded again yet. Best effort: the next download replaces
 * the file anyway. */
bool saveMappingCache() {
  DynamicJsonDocument doc(32768);
  JsonObject simple = doc.createNestedObject("simpleMap");
  JsonArray rows = doc.createNestedArray("mappings");
  if (mappingMutex) xSemaphoreTake(mappingMutex, portMAX_DELAY);
  int complete = 0;
  for (const auto &row : fingerprintToStaff) {
    // Only pairs the reader can act on: a name without an employee number would
    // make the whole file unreadable at the next boot (applyMappingPayload
    // requires a complete list), and it could not be uploaded anyway.
    const auto member = fingerprintToMember.find(row.first);
    if (member == fingerprintToMember.end() || member->second <= 0) continue;
    simple[String(row.first)] = row.second;
    JsonObject entry = rows.createNestedObject();
    entry["fingerprintId"] = row.first;
    entry["memberId"] = member->second;
    entry["memberName"] = row.second;
    complete++;
  }
  if (mappingMutex) xSemaphoreGive(mappingMutex);
  doc["count"] = complete;
  if (doc.overflowed()) return false;
  String payload;
  serializeJson(doc, payload);
  File f = LittleFS.open("/mappings.tmp", "w");
  if (!f) return false;
  const size_t written = f.print(payload);
  f.flush();
  f.close();
  const bool ok = written == payload.length() && LittleFS.rename("/mappings.tmp", "/mappings.json");
  if (!ok) LittleFS.remove("/mappings.tmp");
  return ok;
}

void loadCachedMappings() {
  File f = LittleFS.open("/mappings.json", "r");
  if (!f) return;
  const String payload = f.readString();
  f.close();
  if (applyMappingPayload(payload)) Serial.println("Loaded mappings from offline cache");
}

bool loadMappingsFromServer(uint32_t timeoutMs) {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http;
  http.setTimeout(timeoutMs);
  beginServerRequest(http, "/api/attendance/mappings");
  if (deviceToken.length() > 0) http.addHeader("x-attendance-device", deviceToken);
  const int code = http.GET();
  String payload = "";
  if (code == 200) payload = http.getString();
  http.end();
  if (code != 200 || !applyMappingPayload(payload)) return false;
  // Save a complete replacement; a power cut must not truncate the last cache.
  // The network request was finished before taking this short flash lock.
  if (mappingMutex) xSemaphoreTake(mappingMutex, portMAX_DELAY);
  File f = LittleFS.open("/mappings.tmp", "w");
  bool cached = false;
  if (f) {
    const size_t written = f.print(payload);
    f.flush();
    f.close();
    cached = written == payload.length() && LittleFS.rename("/mappings.tmp", "/mappings.json");
    if (!cached) LittleFS.remove("/mappings.tmp");
  }
  if (mappingMutex) xSemaphoreGive(mappingMutex);
  if (!cached) Serial.println("Could not update offline name cache; previous cache kept");
  return true;
}

/* ── Offline queue: one durable record per matched placement ─────────────── */
bool saveToQueue(int fingerprintId, const String &staffName, int memberId, unsigned long scannedAt, uint64_t uptimeMs, String &eventId) {
  if (!offlineQueue) return false;
  char id[33];
  snprintf(id, sizeof(id), "%08lx%08lx%08lx%08lx",
           (unsigned long)esp_random(), (unsigned long)esp_random(),
           (unsigned long)esp_random(), (unsigned long)esp_random());
  eventId = String(id);
  DynamicJsonDocument doc(1024);
  doc["eventId"] = eventId;
  doc["fingerprintId"] = fingerprintId;
  if (memberId > 0) doc["memberId"] = memberId;
  doc["staffName"] = staffName;
  doc["deviceId"] = deviceId;
  doc["bootId"] = bootId;
  // Seconds since this boot (not wall time). If NTP answers later in the SAME
  // uninterrupted boot, this lets us reconstruct when an earlier scan happened.
  doc["uptimeSeconds"] = (uint32_t)(uptimeMs / 1000ULL);
  if (scannedAt > 0) doc["scannedAt"] = scannedAt;
  if (doc.overflowed()) {
    Serial.println("Scan is too large to save safely");
    return false;
  }
  String json;
  serializeJson(doc, json);
  if (!offlineQueue->append(json)) {
    Serial.println("Offline queue write failed or queue is damaged/full; scan was not saved");
    return false;
  }
  Serial.println(scannedAt ? "Saved to offline queue with scan time" : "Saved to offline queue; clock not set yet");
  return true;
}

// BEGIN RECEIPT VALIDATION (also compiled by the host regression tests)
bool receiptMatches(const char *expectedId, uint32_t expectedTime, int expectedFinger,
                    int expectedMember, const char *receivedId, uint32_t receivedTime,
                    int receivedFinger, int receivedMember, const char *action, bool success) {
  if (!expectedId || !receivedId || !action || !expectedId[0] || strcmp(expectedId, receivedId) != 0 ||
      expectedTime != receivedTime || expectedFinger != receivedFinger || receivedMember <= 0 ||
      (expectedMember > 0 && expectedMember != receivedMember)) return false;
  if (strcmp(action, "already_registered") == 0) return true;
  return success && (strcmp(action, "clock_in") == 0 || strcmp(action, "clock_out") == 0);
}
// END RECEIPT VALIDATION

void publishDeliveryNotice(const char *eventId, const char *name, uint32_t scannedAt, DeliveryKind kind) {
  DeliveryNotice notice{};
  snprintf(notice.eventId, sizeof(notice.eventId), "%s", eventId ? eventId : "");
  snprintf(notice.name, sizeof(notice.name), "%s", name && name[0] ? name : "Employee");
  notice.scannedAt = scannedAt;
  notice.kind = kind;
  Serial.print(kind == DELIVERY_REVIEW ? "NEEDS REVIEW: " : kind == DELIVERY_ALREADY ? "ALREADY REGISTERED: " : "SENT TO WEBSITE: ");
  Serial.print(notice.name);
  Serial.print(" - ");
  Serial.println(capturedTimeText(scannedAt));
  if (deliveryNotices && xQueueSend(deliveryNotices, &notice, 0) != pdTRUE)
    Serial.println("LCD confirmation list is full; website result is still recorded above");
}

// Process ONE head. A network request never holds the flash queue lock and
// a scan is removed only after an exact, recognizable website receipt.
QueueSyncResult syncOfflineQueue() {
  if (!offlineQueue) { queueStatus = QUEUE_STORAGE_ERROR; return QUEUE_WAIT; }
  if (WiFi.status() != WL_CONNECTED) { queueStatus = QUEUE_OFFLINE; return QUEUE_WAIT; }
  OfflineQueue::Head head;
  const OfflineQueue::Peek state = offlineQueue->peek(head);
  if (state == OfflineQueue::EMPTY) { queueStatus = QUEUE_IDLE; return QUEUE_EMPTY; }
  if (state != OfflineQueue::READY) {
    queueStatus = QUEUE_STORAGE_ERROR;
    Serial.println("Offline queue paused: damaged storage or a partial record; ask the admin to inspect it");
    return QUEUE_WAIT;
  }
  DynamicJsonDocument doc(1024);
  if (deserializeJson(doc, head.line)) {
    queueStatus = QUEUE_STORAGE_ERROR;
    Serial.println("Offline queue paused: invalid entry retained for inspection");
    return QUEUE_WAIT;
  }
  const int fid = doc["fingerprintId"] | 0;
  unsigned long scannedAt = doc["scannedAt"] | 0UL;
  const char *eventId = doc["eventId"] | "";
  const char *savedName = doc["staffName"] | "";
  if (fid <= 0) {
    queueStatus = QUEUE_STORAGE_ERROR;
    Serial.println("Offline queue paused: invalid fingerprint ID");
    return QUEUE_WAIT;
  }
  if (!scannedAt && doc["bootId"].is<const char *>() && doc["uptimeSeconds"].is<uint32_t>()) {
    const String originalBoot = doc["bootId"].as<String>();
    const uint32_t scanUptime = doc["uptimeSeconds"].as<uint32_t>();
    unsigned long anchorEpoch = 0;
    uint32_t anchorUptime = 0;
    if (offlineQueue->readClockAnchor(originalBoot, anchorEpoch, anchorUptime) &&
        anchorUptime >= scanUptime && anchorEpoch > anchorUptime - scanUptime)
      scannedAt = anchorEpoch - (anchorUptime - scanUptime);
  }
  if (!scannedAt) {
    const String originalBoot = doc["bootId"] | "";
    if (originalBoot == bootId) {
      queueStatus = QUEUE_CLOCK_WAIT;
      Serial.println("Offline queue waiting for the first clock anchor (NTP or website time)");
      return QUEUE_WAIT;
    }
    // A previous boot with no time anchor cannot be dated safely. Preserve it
    // for review before letting later timestamped scans continue.
    if (!offlineQueue->copyToReview(head, "unknown_time")) {
      queueStatus = QUEUE_STORAGE_ERROR;
      Serial.println("Offline queue paused: could not preserve unknown-time scan for review");
      return QUEUE_WAIT;
    }
    queueNeedsReview = true;
    if (!offlineQueue->acknowledge(head)) { queueStatus = QUEUE_STORAGE_ERROR; return QUEUE_WAIT; }
    publishDeliveryNotice(eventId, savedName, 0, DELIVERY_REVIEW);
    Serial.println("Scan without a recoverable time saved for manual review; type queue review on Serial");
    return QUEUE_PROGRESS;
  }

  HTTPClient http;
  http.setTimeout(SERVER_TIMEOUT_MS);
  beginServerRequest(http, "/api/attendance/clock");
  addDeviceHeaders(http);
  DynamicJsonDocument postDoc(512);
  postDoc["fingerprintId"] = fid;
  const int capturedMember = doc["memberId"] | 0;
  if (capturedMember > 0) postDoc["capturedMemberId"] = capturedMember;
  postDoc["deviceId"] = deviceId + "_offline";
  postDoc["method"] = "fingerprint";
  postDoc["scannedAt"] = scannedAt;
  // Legacy records have no ID. Keep the derived ID stable for safe retries.
  char legacyId[33] = {0};
  if (!eventId[0]) {
    const uint64_t chip = ESP.getEfuseMac();
    const String key = String((unsigned long)(chip >> 32)) + ":" + String((unsigned long)chip) + ":" +
                       String((unsigned long)head.start) + ":" + head.line;
    unsigned char digest[32];
    const mbedtls_md_info_t *sha = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    if (!sha || mbedtls_md(sha, (const unsigned char *)key.c_str(), key.length(), digest) != 0) {
      queueStatus = QUEUE_STORAGE_ERROR;
      Serial.println("Cannot identify legacy scan safely; kept on device");
      http.end();
      return QUEUE_WAIT;
    }
    for (int i = 0; i < 16; i++) snprintf(legacyId + 2 * i, 3, "%02x", digest[i]);
    eventId = legacyId;
  }
  postDoc["eventId"] = eventId;
  postDoc["requireRecordedTime"] = true;
  if (postDoc.overflowed()) {
    queueStatus = QUEUE_STORAGE_ERROR;
    Serial.println("Scan request too large; kept on device");
    http.end();
    return QUEUE_WAIT;
  }
  String json;
  serializeJson(postDoc, json);
  queueStatus = QUEUE_SENDING;
  const int httpCode = http.POST(json);
  const String body = httpCode > 0 ? http.getString() : String("");
  http.end();
  queueLastHttpCode = httpCode;
  if (httpCode == 409) {
    if (!offlineQueue->copyToReview(head, "server_conflict")) { queueStatus = QUEUE_STORAGE_ERROR; return QUEUE_WAIT; }
    queueNeedsReview = true;
    if (!offlineQueue->acknowledge(head)) { queueStatus = QUEUE_STORAGE_ERROR; return QUEUE_WAIT; }
    publishDeliveryNotice(eventId, savedName, (uint32_t)scannedAt, DELIVERY_REVIEW);
    Serial.println("Conflicting scan saved for manual review; type queue review on Serial");
    return QUEUE_PROGRESS;
  }
  if (httpCode != 200) {
    queueStatus = QUEUE_ERROR;
    Serial.print("Offline queue paused, HTTP ");
    Serial.println(httpCode);
    return QUEUE_WAIT;
  }
  // A captive portal, old website or proxy can answer HTTP 200 without saving
  // attendance. Do not lose the scan or say SENT unless the response names
  // this exact event, finger, member and recorded scan time.
  DynamicJsonDocument answer(2048);
  const DeserializationError parseError = deserializeJson(answer, body);
  const char *responseId = answer["eventId"] | "";
  const char *action = answer["action"] | "";
  const bool valid = !parseError && receiptMatches(eventId, (uint32_t)scannedAt, fid, capturedMember,
      responseId, answer["recordedAtEpoch"] | 0UL, answer["fingerprintId"] | 0,
      answer["memberId"] | 0, action, answer["success"] | false);
  if (!valid) {
    queueStatus = QUEUE_ERROR;
    Serial.println("Website reply did not confirm this scan; kept on device. Check website deployment or captive portal.");
    return QUEUE_WAIT;
  }
  if (!offlineQueue->acknowledge(head)) {
    queueStatus = QUEUE_STORAGE_ERROR;
    Serial.println("Server accepted scan, but cursor write failed; safe retry required");
    return QUEUE_WAIT;
  }
  const char *serverName = answer["memberName"] | "";
  const DeliveryKind kind = strcmp(action, "clock_in") == 0 ? DELIVERY_IN :
                            strcmp(action, "clock_out") == 0 ? DELIVERY_OUT : DELIVERY_ALREADY;
  publishDeliveryNotice(eventId, serverName[0] ? serverName : savedName, (uint32_t)scannedAt, kind);
  return QUEUE_PROGRESS;
}

void wakeDeliveryTask() {
  if (deliveryTaskHandle) xTaskNotifyGive(deliveryTaskHandle);
}

// NTP is preferred. Some routers block UDP 123 even when the website works:
// use its no-cache clock as a same-boot fallback, with a round-trip estimate.
// This cannot reconstruct a scan from a previous unanchored boot.
bool syncTimeFromWebsite() {
  if (wallClockEpoch() || WiFi.status() != WL_CONNECTED) return false;
  const uint64_t started = (uint64_t)esp_timer_get_time() / 1000ULL;
  HTTPClient http;
  http.setTimeout(SERVER_TIMEOUT_MS);
  beginServerRequest(http, "/api/attendance/device-time");
  http.addHeader("Cache-Control", "no-cache");
  if (deviceToken.length() > 0) http.addHeader("x-attendance-device", deviceToken);
  const int code = http.GET();
  const String body = code == 200 ? http.getString() : String("");
  http.end();
  const uint64_t ended = (uint64_t)esp_timer_get_time() / 1000ULL;
  if (code != 200 || ended < started || ended - started > 10000ULL || wallClockEpoch()) return false;
  DynamicJsonDocument answer(256);
  if (deserializeJson(answer, body) || strcmp(answer["service"] | "", "fana-attendance-time-v1") != 0) return false;
  const uint32_t epoch = answer["epochSeconds"] | 0UL;
  const uint32_t subsecond = answer["millisecond"] | 1000U;
  if (epoch < 1577836800UL || epoch >= 4102444800UL || subsecond > 999) return false;
  const uint64_t estimatedMs = (uint64_t)epoch * 1000ULL + subsecond + (ended - started) / 2ULL;
  struct timeval tv;
  tv.tv_sec = (time_t)(estimatedMs / 1000ULL);
  tv.tv_usec = (suseconds_t)((estimatedMs % 1000ULL) * 1000ULL);
  if (settimeofday(&tv, nullptr) != 0) return false;
  websiteClockUsed = true;
  Serial.println("Clock set from website (estimated; NTP is preferred)");
  return true;
}

// A separate task means enrollment, SSE, name refresh and a slow website status
// request cannot keep a queued attendance scan waiting behind them.
void deliveryTask(void *) {
  uint32_t lastTimeTry = 0;
  bool triedTime = false;
  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      queueStatus = QUEUE_OFFLINE;
      ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(QUEUE_OFFLINE_POLL_MS));
      continue;
    }
    const uint32_t now = millis();
    if (!wallClockEpoch() && (!triedTime || (uint32_t)(now - lastTimeTry) >= WEBSITE_TIME_RETRY_MS)) {
      triedTime = true;
      lastTimeTry = now;
      syncTimeFromWebsite();
    }
    const QueueSyncResult result = syncOfflineQueue();
    if (result == QUEUE_PROGRESS) {
      vTaskDelay(pdMS_TO_TICKS(25));
      continue;
    }
    // New scans and clock anchors wake this immediately; 1-second offline/idle
    // polling also notices reconnection even while the other task is busy.
    const uint32_t wait = result == QUEUE_EMPTY ? QUEUE_OFFLINE_POLL_MS : QUEUE_RETRY_MS;
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(wait));
  }
}

void periodicSync() {
  static unsigned long lastNames = 0;
  static bool mappingsLoaded = false;
  if (WiFi.status() != WL_CONNECTED) return;
  const unsigned long now = millis();
  const uint32_t namesDelay = mappingsLoaded ? 900000UL : 10000UL;
  if ((uint32_t)(now - lastNames) >= namesDelay) {
    lastNames = now;
    mappingsLoaded = loadMappingsFromServer();
  }
}

// Supply the site's root CA to authenticate HTTPS when configured. On ESP32
// core 2.x the legacy URL-only API otherwise uses setInsecure().
void beginServerRequest(HTTPClient &http, const String &path) {
  const String url = serverURL + path;
  if (serverRootCA && serverRootCA[0] && url.startsWith("https://")) http.begin(url, serverRootCA);
  else http.begin(url);
}

// Each device call carries the device token when one is set.
void addDeviceHeaders(HTTPClient &http) {
  http.addHeader("Content-Type", "application/json");
  if (deviceToken.length() > 0) http.addHeader("x-attendance-device", deviceToken);
}

/* ── Serial monitor commands (115200 baud) ────────────────────────────────── */
/* `wifi` on the Serial monitor: everything that decides whether a scan reaches
 * the website. The status page shows the same numbers over the network. */
void printWifiReport() {
  Serial.println("--- WiFi ---");
  Serial.print("Status:        ");
  Serial.println(WiFi.status() == WL_CONNECTED ? "connected" : "not connected");
  Serial.print("SSID:          ");
  Serial.println(WiFi.SSID());
  Serial.print("IP:            ");
  Serial.println(WiFi.localIP().toString());
  Serial.print("Signal:        ");
  Serial.print(WiFi.RSSI());
  Serial.println(" dBm (about -50 next to the router, -70 is usable, below -80 is weak)");
  Serial.print("Channel:       ");
  Serial.println(WiFi.channel());
  Serial.print("Access point:  ");
  Serial.println(WiFi.BSSIDstr());
  Serial.print("Modem sleep:   off (the board is on mains)   TX power: 19.5 dBm");
  Serial.println();
  Serial.print("Reconnects:    ");
  Serial.print((unsigned)wifiReconnects);
  Serial.print(" automatic, ");
  Serial.print((unsigned)wifiRadioResets);
  Serial.println(" radio resets");
  const unsigned long downSince = wifiDownSince.load();
  if (downSince != 0) {
    Serial.print("Down for:      ");
    Serial.print((millis() - downSince) / 1000);
    Serial.println(" s (retrying by itself)");
  }
}

/* `wifi scan` on the Serial monitor: every network the board can hear, with
 * its strength. Use it to see whether the cafe's 2.4 GHz name is strong at the
 * door, and which channel the neighbours are crowding. */
void printWifiScan() {
  Serial.println("--- WiFi scan (2.4 GHz only, this is what the board can hear) ---");
  const int found = WiFi.scanNetworks();
  for (int i = 0; i < found; i++) {
    Serial.print(i + 1);
    Serial.print(": ");
    Serial.print(WiFi.SSID(i));
    Serial.print("  ");
    Serial.print(WiFi.RSSI(i));
    Serial.print(" dBm  channel ");
    Serial.println(WiFi.channel(i));
  }
  if (found == 0) Serial.println("Nothing found. Is the 2.4 GHz radio of the router on?");
  WiFi.scanDelete();
}

void printQueueStatus() {
  Serial.println("--- Attendance sync status ---");
  Serial.print("WiFi: ");
  Serial.println(WiFi.status() == WL_CONNECTED ? "connected (website may still be unreachable)" : "disconnected");
  Serial.print("Sync state: ");
  switch (queueStatus.load()) {
    case QUEUE_OFFLINE: Serial.println("waiting for WiFi"); break;
    case QUEUE_IDLE: Serial.println("no queued scans"); break;
    case QUEUE_SENDING: Serial.println("sending"); break;
    case QUEUE_CLOCK_WAIT: Serial.println("waiting for a valid clock anchor"); break;
    case QUEUE_STORAGE_ERROR: Serial.println("queue storage needs inspection"); break;
    default: Serial.println("website/connection error; retrying"); break;
  }
  Serial.print("Last attendance HTTP code: ");
  Serial.println(queueLastHttpCode.load());
  Serial.print("Clock: ");
  Serial.println(wallClockEpoch() ? (websiteClockUsed ? "set (website fallback was used)" : "set") : "not set yet");
  Serial.print("Manual review records: ");
  Serial.println(queueNeedsReview ? "YES - type queue review" : "none known");
  if (!offlineQueue) { Serial.println("Queue unavailable"); return; }
  OfflineQueue::Head head;
  const OfflineQueue::Peek state = offlineQueue->peek(head);
  if (state == OfflineQueue::EMPTY) Serial.println("Queue: empty");
  else if (state == OfflineQueue::BLOCKED) Serial.println("Queue: blocked; do not erase it");
  else {
    DynamicJsonDocument doc(1024);
    if (deserializeJson(doc, head.line)) Serial.println("Queue: invalid head; do not erase it");
    else {
      Serial.print("First waiting event ID: "); Serial.println(doc["eventId"] | "legacy (no event ID)");
      Serial.print("First waiting finger ID: "); Serial.println(doc["fingerprintId"] | 0);
      Serial.print("First waiting name: "); Serial.println(doc["staffName"] | "unknown");
      Serial.print("First waiting time: "); Serial.println(capturedTimeText(doc["scannedAt"] | 0UL));
      Serial.println("Other scans, if any, remain queued behind this one.");
    }
  }
}

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
  } else if (cmd == "lamp") {
    // Is the reader's glass lit? This asks the module directly, whatever the
    // sketch believed before, and reports which of the three layouts worked -
    // the one thing nobody can see from the code when a glass stays dark.
    lastLightRequestMs = 0;
    lampMisses = 0;   // probe all three layouts again, right now
    const bool lit = finger.requestLightOn(800);
    if (lit) {
      readerLightSupported = true;
      lampMisses = 0;
    }
    Serial.print("Reader light: ");
    if (!lit) {
      Serial.println("refused all 3 layouts (plain LED-ON, breathing blue, blue ON).");
      Serial.println("  This variant controls its own illumination - a dark glass during a");
      Serial.println("  placement is then power, GND or the glass, not a lost command.");
    } else {
      const uint8_t layout = finger.lightLayout();
      Serial.println(layout == 0 ? "layout 1/3 accepted: plain LED-ON" :
                       layout == 1 ? "layout 2/3 accepted: breathing blue (blinks by itself)" :
                                     "layout 3/3 accepted: steady blue");
      Serial.println("  the door re-sends this every moment, so the glass stays lit");
    }
  } else if (cmd == "test") {
    testSensor();
  } else if (cmd.startsWith("watch")) {
    // `watch` or `watch 30`: prove whether the reader sees a finger.
    watchSensor(cmd.length() > 5 ? cmd.substring(5).toInt() : 10);
  } else if (cmd == "sensor hard") {
    testSensorLink(150, 50, "hard, about 8 s of continuous asking");
  } else if (cmd.startsWith("sensor")) {
    testSensorLink(20, 200, "20 checks");
  } else if (cmd.startsWith("rest")) {
    restCommand(cmd.substring(4));
  } else if (cmd == "wifi") {
    printWifiReport();
  } else if (cmd == "queue status") {
    printQueueStatus();
  } else if (cmd == "queue review") {
    // Maintenance command: dump retained records, never delete them implicitly.
    if (!queueMutex || xSemaphoreTake(queueMutex, pdMS_TO_TICKS(1000)) != pdTRUE) {
      Serial.println("Queue busy; try again");
    } else {
      File review = LittleFS.open("/queue.review.jsonl", "r");
      if (!review) Serial.println("No scans awaiting manual review");
      else {
        Serial.println("Review records (do not infer missing timestamps):");
        while (review.available()) Serial.write(review.read());
        review.close();
      }
      xSemaphoreGive(queueMutex);
    }
  } else if (cmd == "queue review clear CONFIRM") {
    if (queueMutex && xSemaphoreTake(queueMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
      if (!LittleFS.exists("/queue.review.jsonl") || LittleFS.remove("/queue.review.jsonl")) {
        queueNeedsReview = false;
        Serial.println("Review records cleared; only do this after reconciliation");
      } else Serial.println("Could not clear review records");
      xSemaphoreGive(queueMutex);
    }
  } else if (cmd == "wifi scan") {
    networkScanRequested = true;
    Serial.println("WiFi scan requested in the background");
  } else if (cmd == "wifi join") {
    networkJoinRequested = true;
    Serial.println("WiFi reconnect requested in the background");
  } else if (cmd.length() > 0) {
    Serial.println("Commands: enroll <id> | list | test | sensor | sensor hard | wifi | wifi scan | wifi join | queue status | queue review | empty confirm | rest show");
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

/* Is it the code, the wiring or the power? Ask the module the same question
 * over and over and count the answers, instead of guessing from one try.
 *
 *   `sensor`       20 COUNT commands, 200 ms apart. The link as it is now.
 *   `sensor hard`  150 commands 50 ms apart: about 8 s of the reader being
 *                  asked continuously. Run it after the module has been on for
 *                  ten minutes and it doubles as the heat test, because a
 *                  module that answers while cold and stops while warm is being
 *                  fed badly (or is already damaged), not mis-programmed.
 *
 * Reading it: every round answered = the wire, the baud and the module are
 * fine, so look above this layer. Silence = power or wiring. Garbled = a level
 * or baud problem, or the supply drooping while the reader draws its current. */
/* The setup hotspot must never be the reason a door ignores people. While
 * WiFiManager's autoConnect() is waiting for somebody to join the hotspot, THIS
 * LOOP DOES NOT RUN AT ALL: no scan is read, no kept scan is sent, and the
 * fingerprint module is never asked - which is the exact shape of "the LCD
 * works but the sensor does not scan". So the wait has a hard end. */
void configureWifiManager(WiFiManager &wm) {
  wm.setConnectTimeout(20);        // seconds per WiFi attempt (a weak link is slow)
  wm.setConfigPortalTimeout(180);  // seconds in the hotspot, then resume background retries
}

void testSensorLink(uint16_t rounds, uint32_t gapMs, const char *label) {
  Serial.println(String("--- sensor link test (") + label + ") ---");
  while (mySerial.available()) mySerial.read();
  uint16_t ok = 0;
  uint16_t silent = 0;
  uint16_t garbled = 0;
  uint16_t other = 0;
  uint32_t fastest = 0xFFFFFFFFUL;
  uint32_t slowest = 0;
  uint32_t total = 0;

  for (uint16_t i = 1; i <= rounds; i++) {
    const unsigned long began = millis();
    const int16_t count = finger.getCount(3000);
    const uint32_t took = (uint32_t)(millis() - began);
    if (count >= 0) {
      ok++;
      templateCount = count;
      if (took < fastest) fastest = took;
      if (took > slowest) slowest = took;
      total += took;
    } else {
      const uint8_t st = finger.getLastStatus();
      if (st == BIOVO_ACK_NO_RESPONSE) silent++;
      else if (st == BIOVO_ACK_COMM_ERROR) garbled++;
      else other++;
      Serial.print("  round ");
      Serial.print(i);
      Serial.print(": ");
      Serial.println(R307Compat::statusText(st));
    }
    if (gapMs > 0) delay(gapMs);
  }

  sensorTestRounds = rounds;
  sensorTestAnswered = ok;
  sensorTestSilent = silent;
  sensorTestGarbled = garbled;

  Serial.print("  answered: ");
  Serial.print(ok);
  Serial.print("/");
  Serial.println(rounds);
  Serial.print("  silent (no frame at all): ");
  Serial.println(silent);
  Serial.print("  garbled (a frame, not a valid reply): ");
  Serial.println(garbled);
  Serial.print("  another status: ");
  Serial.println(other);
  if (ok > 0) {
    Serial.print("  reply time ms - fastest ");
    Serial.print(fastest);
    Serial.print(", slowest ");
    Serial.print(slowest);
    Serial.print(", average ");
    Serial.println(total / ok);
  }
  if (silent + garbled > 0) {
    Serial.println("  a module that answers some of the time is a POWER story:");
    Serial.println("  measure VCC at the R307 pins and compare it with its seller pinout");
    Serial.println("  (normally regulated 5 V); verify common GND and crossed TX/RX.");
  } else if (ok == rounds) {
    Serial.println("  the link is clean: wiring, baud and module all answer every");
    Serial.println("  time. If a finger is still ignored, look at the open hours");
    Serial.println("  (Activity), or at what the module does when it images.");
  }
  showLines("Link test", String(ok) + "/" + String((unsigned)rounds) + " answered",
            (silent + garbled) > 0 ? "check the power" : "link is clean", "");
  delay(2500);
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

/* `watch` in Serial: the fastest way to answer "can this reader see a finger at
 * all?". It asks the glass directly, once every quarter second, and prints only
 * when the answer changes. Place a finger and lift it; a reader that never says
 * "finger present" cannot enroll anything, whatever the website does, and that
 * is a light/power/optics problem at the reader - not a software bug. */
void watchSensor(int seconds) {
  if (!sensorReady && !detectSensor(1)) {
    Serial.println("Sensor not answering; check TX->16, RX->17, GND and 5 V.");
    return;
  }
  if (seconds < 2) seconds = 2;
  if (seconds > 60) seconds = 60;
  Serial.println("--- watching the glass: place a finger, hold it, lift it ---");
  keepReaderLampOn(0);   // ask for the light before the watch starts
  const uint32_t end = millis() + (uint32_t)seconds * 1000UL;
  int last = -99;
  uint16_t present = 0, empty = 0, silent = 0;
  while ((int32_t)(end - millis()) > 0) {
    const int state = finger.fingerPresent(400);
    if (state == 1) present++; else if (state == 0) empty++; else silent++;
    if (state != last) {
      Serial.print("[");
      Serial.print(millis());
      Serial.print(" ms] ");
      if (state == 1) Serial.println("FINGER / SOMETHING on the glass");
      else if (state == 0) Serial.println("glass empty (the reader answers)");
      else {
        Serial.print("reader did NOT answer properly: ");
        Serial.println(fingerStatusText(finger.getLastStatus()));
      }
      last = state;
    }
    delay(250);
  }
  Serial.print("--- watch finished: finger seen ");
  Serial.print(present);
  Serial.print(" times, empty ");
  Serial.print(empty);
  Serial.print(" times, no answer ");
  Serial.print(silent);
  Serial.println(" times ---");
  if (present == 0) {
    Serial.println("No finger was ever seen. Check the reader's light (`lamp`), its glass, power and GND,");
    Serial.println("and place the pad flat on the centre of the glass.");
  }
  showIdleScreen();
}

/* ── Local status page (no secrets, no enrolling) ─────────────────────────── */
void handleRoot() {
  if (!sensorMutex || xSemaphoreTake(sensorMutex, pdMS_TO_TICKS(2000)) != pdTRUE) {
    server.send(503, "text/plain", "Scanner busy; retry");
    return;
  }
  /* The two things the LCD no longer shows (the owner moved them off the glass
   * in favour of the WiFi word and the clock) are still here, for whoever is
   * standing at the device with a phone. */
  const String clock = wallClockText();
  String html = "<h1>Fana Cafe Attendance</h1>";
  html += "<p>Time: " + (clock.length() > 0 ? clock : String("not set yet (NTP)")) + "</p>";
  html += "<p>IP: " + WiFi.localIP().toString() + "</p>";
  html += "<p>WiFi: " + String(WiFi.status() == WL_CONNECTED ? "Connected" : "Not Connected") + "</p>";
  if (WiFi.status() == WL_CONNECTED) {
    html += "<p>Signal: " + String(WiFi.RSSI()) + " dBm (" + wifiMeter(WiFi.RSSI()) + ")" +
            (WiFi.RSSI() < WIFI_WEAK_RSSI ? " (weak: move the router closer, or use a 2.4 GHz access point near the door)" : "") +
            ", channel " + String(WiFi.channel()) + ", access point " + WiFi.BSSIDstr() + "</p>";
  }
  html += "<p>Self-healing: " + String((unsigned)wifiReconnects) + " automatic reconnects, " +
          String((unsigned)wifiRadioResets) + " radio resets. Modem sleep is off and the radio transmits at 19.5 dBm.</p>";
  html += "<p>Sensor: " + String(sensorReady ? "online" : "OFFLINE") + "</p>";
  html += "<p>Sensor last answer: " + String(fingerStatusText(sensorLastStatus)) +
          ", silent passes in a row: " + String((unsigned)sensorSilentPasses) + "</p>";
  if (sensorTestRounds > 0) {
    html += "<p>Last link test: " + String(sensorTestAnswered) + "/" + String((unsigned)sensorTestRounds) +
            " answered, " + String((unsigned)sensorTestSilent) + " silent, " +
            String((unsigned)sensorTestGarbled) + " garbled. Type `sensor` on the Serial monitor to run it again.</p>";
  }
  html += "<p><b>Sensor power:</b> verify the exact R307 connector pinout and rated VCC"
          " (normally regulated 5 V), common GND, and crossed UART TX/RX.</p>";
  html += "<p>Templates: " + String(templateCount) + "</p>";
  html += "<p><a href='/status'>Status JSON</a></p>";
  xSemaphoreGive(sensorMutex); // never hold the sensor while writing to a socket
  server.send(200, "text/html", html);
}

void handleStatus() {
  if (!sensorMutex || xSemaphoreTake(sensorMutex, pdMS_TO_TICKS(2000)) != pdTRUE) {
    server.send(503, "text/plain", "Scanner busy; retry");
    return;
  }
  DynamicJsonDocument doc(1024);
  doc["deviceId"] = deviceId;
  // The two things worth knowing when a door "does not scan": whether the
  // module is answering at all, and how long it has been since it last did.
  doc["sensorReady"] = sensorReady;
  doc["sensorSilentPasses"] = sensorSilentPasses;
  doc["sensorPollMs"] = sensorPollMs;
  doc["sensorStatus"] = fingerStatusText(sensorLastStatus);
  doc["readerLightLayout"] = finger.lightLayout() == 0 ? "plain" :
                             finger.lightLayout() == 1 ? "breathing-blue" :
                             finger.lightLayout() == 2 ? "steady-blue" : "unconfirmed";
  doc["readerLightMisses"] = lampMisses;
  doc["sensorSilentMs"] = sensorLastReplyMs == 0UL ? 0UL : (unsigned long)(millis() - sensorLastReplyMs);
  if (sensorTestRounds > 0) {
    doc["linkTest"] = String(sensorTestAnswered) + "/" + String((unsigned)sensorTestRounds) +
                      " answered, " + String((unsigned)sensorTestSilent) + " silent, " +
                      String((unsigned)sensorTestGarbled) + " garbled";
  }
  doc["scannerAlwaysOn"] = scannerAlwaysOn.load();
  doc["restAwake"] = scannerAlwaysOn || !restScheduleKnown || scheduleAwaits(restWindows, restWindowCount, minuteOfAddisDay(scanEpochNow()));
  doc["restKnown"] = restScheduleKnown;
  doc["restKeptAwake"] = restKeptAwake;
  doc["restNextOpen"] = minuteLabel(restLastWakeMinute);
  doc["ip"] = WiFi.localIP().toString();
  doc["templates"] = templateCount;
  doc["wifi"] = WiFi.status() == WL_CONNECTED;
  // The WiFi facts the owner asked to be able to check ("how can I strengthen
  // the strength"): how strong the signal really is, which access point and
  // channel it is on, and how often the board had to heal the link by itself.
  doc["wifiRssi"] = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
  doc["wifiWeak"] = WiFi.status() == WL_CONNECTED && WiFi.RSSI() < WIFI_WEAK_RSSI;
  doc["wifiChannel"] = WiFi.status() == WL_CONNECTED ? WiFi.channel() : 0;
  doc["wifiBssid"] = WiFi.status() == WL_CONNECTED ? WiFi.BSSIDstr() : String("");
  doc["wifiReconnects"] = wifiReconnects.load();
  doc["wifiRadioResets"] = wifiRadioResets.load();
  const unsigned long downSince = wifiDownSince.load();
  doc["wifiDownMs"] = downSince == 0 ? 0UL : (unsigned long)(millis() - downSince);
  doc["wifiSleep"] = "off (mains powered)";
  doc["wifiTxPower"] = "19.5 dBm";
  doc["time"] = wallClockText();
  doc["timeReady"] = timeReady;
  doc["queueNeedsReview"] = queueNeedsReview.load();
  doc["queueStatus"] = queueStatus.load();
  doc["queueLastHttpCode"] = queueLastHttpCode.load();
  doc["websiteClockFallbackUsed"] = websiteClockUsed.load();
  if (mappingMutex) xSemaphoreTake(mappingMutex, portMAX_DELAY);
  doc["mappings"] = fingerprintToStaff.size();
  if (mappingMutex) xSemaphoreGive(mappingMutex);
  String json;
  serializeJson(doc, json);
  xSemaphoreGive(sensorMutex); // network transmission is outside the sensor lock
  server.send(200, "application/json", json);
}
