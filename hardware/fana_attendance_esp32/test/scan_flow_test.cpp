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
struct Logger { template<class T> void println(T) {} } Serial;
#define BIOVO_ACK_NOUSER 0x05
#define BIOVO_ACK_IMAGEMESS 0x06
#define BIOVO_ACK_TIMEOUT 0x08
#define BIOVO_ACK_GO_OUT 0x0F
#define LIFT_POLL_MS 220UL
#define READER_LAMP_BURST_MS 300UL
#define WARNING_REPEAT_MS 4000
#define SENSOR_POLL_MAX_MS 4000
struct Reader {
  uint8_t status = BIOVO_ACK_TIMEOUT;
  bool match = false;
  int present = 0;
  int searches = 0;
  bool search(uint16_t &id, uint8_t &, uint32_t) { searches++; id = match ? 42 : 0; return match; }
  uint8_t getLastStatus() { return status; }
  uint32_t capturedImageMillis() { return millis(); }
  int fingerPresent(uint32_t) { return present; }
} finger;
bool awaitingFingerLift = false, readerLightNeedsRefresh = false;
bool sensorLinkReported = false;
uint8_t warningKind = 0xff, sensorSilentPasses = 0;
uint32_t warningShownAt = 0, sensorLastReplyMs = 0;
uint16_t sensorPollMs = 1500;
std::string title, line2, line3;
int warnings = 0, successes = 0, reasserts = 0;
void keepReaderLampOn(uint32_t) {}
void reassertReaderLight() { reasserts++; readerLightNeedsRefresh = false; }
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
  assert(warnings == 1 && title == "NOT RECOGNIZED" && line3 == "Ask admin to enroll");
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
  assert(warnings == 3 && title == "IMAGE UNCLEAR" && line2 == "Press flat and still");
  assert(!awaitingFingerLift);
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
  std::cout << "Scan flow tests passed: no touch, rejection, retry, match and lift\n";
}
