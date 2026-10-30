// The runner inserts the real scanForFinger() from the sketch.
#include <cassert>
#include <cstdint>
#include <iostream>
#include <string>
#include <algorithm>
using std::min;
struct String : std::string {
  using std::string::string;
  String(unsigned n) : std::string(std::to_string(n)) {}
};
static uint32_t nowMs = 10000;
unsigned long millis() { return nowMs; }
void delay(unsigned long n) { nowMs += n; }
uint64_t esp_timer_get_time() { return uint64_t(nowMs) * 1000; }
struct Logger {
  template<class T> void print(T) {}
  template<class T> void println(T) {}
  void print(const char *) {}
  void print(int v) { (void)v; }
  void print(unsigned v) { (void)v; }
  void print(unsigned v, int) { (void)v; }        // Serial.print(hex, HEX)
  void println(unsigned long v) { (void)v; }
} Serial;
#define HEX 16
struct R307Compat { static const char *statusText(uint8_t) { return "status"; } };
#define BIOVO_ACK_NOUSER 0x05
#define BIOVO_ACK_IMAGEMESS 0x06
#define BIOVO_ACK_COMM_ERROR 0xFE
#define BIOVO_ACK_TIMEOUT 0x08
#define BIOVO_ACK_GO_OUT 0x0F
#define LIFT_POLL_MS 220UL
#define READER_LAMP_BURST_MS 300UL
#define READER_LAMP_IDLE_MS 700UL
#define WARNING_REPEAT_MS 4000
#define SENSOR_POLL_MAX_MS 4000
struct Reader {
  uint8_t status = BIOVO_ACK_TIMEOUT;
  bool match = false;
  int present = 0;
  int searches = 0;
  // What the real driver counts: an image captured / an unclear press during
  // the last search(). This is the reader's evidence that a finger was there.
  int images = 0, unclear = 0;
  bool search(uint16_t &id, uint8_t &, uint32_t) {
    searches++; id = match ? 42 : 0; return match;
  }
  bool searchSawFinger() const { return images > 0 || unclear > 0; }
  uint32_t searchImagesSeen() const { return images; }
  uint32_t searchUnclear() const { return unclear; }
  uint8_t getLastStatus() { return status; }
  uint32_t capturedImageMillis() { return millis(); }
  int fingerPresent(uint32_t) { return present; }
} finger;
bool awaitingFingerLift = false;
unsigned long lastLightRequestMs = 0;
bool sensorLinkReported = false;
uint8_t warningKind = 0xff, sensorSilentPasses = 0;
uint32_t warningShownAt = 0, sensorLastReplyMs = 0;
uint16_t sensorPollMs = 1500;
std::string title, line2, line3;
int warnings = 0, successes = 0, reasserts = 0;
bool lastForce = false;
void keepReaderLampOn(uint32_t, bool force = false) { lastForce = force; }
void reassertReaderLight() { reasserts++; }
void noteSensorAnswer(uint8_t) {}
bool sensorLinkLooksDead() { return false; }
bool sensorAnswers() { return true; }
void dropSensorLink(const std::string &) {}
void showSensorWarning(const String &a, const String &b, const String &c) { warnings++; title = a; line2 = b; line3 = c; }
void handleVerifiedFinger(int id, uint64_t) { assert(id == 42); successes++; }
// -- INSERT REAL SCAN FLOW --
int main() {
  scanForFinger();
  assert(warnings == 0 && successes == 0); // no touch is not a refusal
  finger.status = BIOVO_ACK_NOUSER;
  scanForFinger();
  assert(warnings == 1 && title == "Not registered" && line2 == "Ask the admin");
  assert(!awaitingFingerLift && reasserts > 0);
  scanForFinger();
  assert(warnings == 1); // same held finger is not repeatedly buzzed
  finger.status = BIOVO_ACK_TIMEOUT;
  scanForFinger();
  finger.status = BIOVO_ACK_NOUSER;
  scanForFinger();
  assert(warnings == 2); // fresh placement, even within throttle interval
  finger.status = BIOVO_ACK_IMAGEMESS;
  scanForFinger();
  assert(warnings == 3 && title == "Image unclear" && line2 == "Press flat and still");
  assert(!awaitingFingerLift);

  /* The fault the owner reported last (Oct 2026): a wrong, unregistered or
   * unclear press produced NO light, NO buzzer and a black glass, because the
   * reader answered a bad press with a garbled frame and the sketch treated
   * every unexpected status as "nobody touched the glass". The reader's own
   * evidence now decides: an image it captured (or an unclear press) is a
   * finger, whatever the status byte says. */
  finger.status = BIOVO_ACK_TIMEOUT;   // far enough in time for a new warning
  nowMs += WARNING_REPEAT_MS;
  finger.images = 1; finger.unclear = 0;
  scanForFinger();
  assert(warnings == 4 && title == "Not registered" && line2 == "Press again, flat");
  assert(!awaitingFingerLift);         // still scanning, no latch
  finger.images = 0;

  // A garbled reply after a capture is a refusal too, and it must be visible.
  finger.status = BIOVO_ACK_COMM_ERROR;
  finger.images = 1;
  nowMs += WARNING_REPEAT_MS;
  scanForFinger();
  assert(warnings == 5);
  finger.status = BIOVO_ACK_TIMEOUT;
  finger.images = 0;
  nowMs += WARNING_REPEAT_MS;

  // A truly empty glass with a pure communication timeout stays silent: a
  // wiring fault must not be reported as a bad finger (the link watchdog and
  // the SENSOR NOT screen own that case).
  finger.status = BIOVO_ACK_TIMEOUT;
  finger.images = 0; finger.unclear = 0;
  scanForFinger();
  assert(warnings == 5);

  // After every refusal the light is re-asserted, and the door is still live.
  const int reassertsBefore = reasserts;
  finger.status = BIOVO_ACK_NOUSER;
  nowMs += WARNING_REPEAT_MS;
  scanForFinger();
  assert(reasserts > reassertsBefore && !awaitingFingerLift);

  finger.match = true;
  finger.status = 0;
  scanForFinger();
  assert(successes == 1 && awaitingFingerLift);
  int searches = finger.searches;
  finger.present = 1;
  scanForFinger();
  assert(finger.searches == searches && successes == 1); // held match not duplicated
  finger.present = 0;
  scanForFinger(); scanForFinger();
  assert(!awaitingFingerLift);
  scanForFinger();
  assert(successes == 2); // next employee is read after the lift
  std::cout << "Scan flow tests passed: no touch, rejection, unclear, garbled and lost-press feedback, retry, match and lift\n";
}
