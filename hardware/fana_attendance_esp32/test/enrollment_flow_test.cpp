// run_host_tests.py inserts the actual enrollment functions from the .ino at
// the marker below. The device, clock, LCD and website are test doubles.
#include <cassert>
#include <cstdint>
#include <deque>
#include <iostream>
#include <map>
#include <string>
#include <vector>

class String {
 public:
  std::string text;
  String() = default;
  String(const char *s) : text(s ? s : "") {}
  String(const std::string &s) : text(s) {}
  String(int n) : text(std::to_string(n)) {}
  String(unsigned n) : text(std::to_string(n)) {}
  String(long n) : text(std::to_string(n)) {}
  String(unsigned long n) : text(std::to_string(n)) {}
  size_t length() const { return text.size(); }
};
static String operator+(const String &a, const String &b) { return String(a.text + b.text); }

static uint32_t nowMs = 0;
static uint32_t millis() { return nowMs; }
static void delay(uint32_t n) { nowMs += n; }
struct SerialStub {
  template <class T> void print(const T &) {}
  template <class T> void println(const T &) {}
  void println() {}
} Serial;

// -- CONSTANTS FROM THE REAL SKETCH --

static bool enrollmentActive = false;
// The last session of a job takes both captures from one steady press.
static bool enrollKeepFingerDown = false;
struct EnrollmentGuard {
  EnrollmentGuard() { enrollmentActive = true; }
  ~EnrollmentGuard() { enrollmentActive = false; }
};
static String enrollDetail;
static int templateCount = -1;
static bool awaitingFingerLift = false;
static bool mappingOnline = true;
static int mappingCalls = 0;
static bool mapOnSecondCheck = false;
// Mirrors the sketch: true once a complete name list was ever read.
static bool mappingListKnown = false;
static std::map<int, String> fingerprintToStaff;
static bool mappedNameForId(int id, String &name) {
  const auto it = fingerprintToStaff.find(id);
  if (it == fingerprintToStaff.end()) return false;
  name = it->second;
  return true;
}
static bool loadMappingsFromServer(uint32_t = SERVER_TIMEOUT_MS) {
  if (++mappingCalls == 2 && mapOnSecondCheck) fingerprintToStaff[5] = "Another employee";
  if (!mappingOnline) return false;
  mappingListKnown = true;
  return true;
}
// The reader's lamp. The flow only asks for it; the driver decides.
static int lampRequests = 0;
static void keepReaderLampOn(uint32_t) { lampRequests++; }
static void nudgeReaderLamp() { lampRequests++; }
#define FINGERPRINT_DELETEFAIL 0x10
static const char *fingerStatusText(uint8_t) { return "sensor status"; }
static const char *enrollReason(EnrollResult) { return "enrollment failed"; }
static void beepSuccess() {}
static void beepError() {}
static std::vector<std::pair<unsigned, std::string>> screens;
static void showEnrollScreen(const String &, int, uint8_t done, const String &prompt, const String &) {
  screens.push_back({done, prompt.text});
}

struct Action { char type; int result; uint8_t status; int id; uint32_t durationMs; };
struct FakeFinger {
  std::deque<Action> actions;
  std::vector<Action> seen;
  uint8_t status = 0;
  uint8_t raw = 0;
  void add(char type, int result, uint8_t st = 0, int id = 0, uint32_t durationMs = 25) {
    actions.push_back({type, result, st, id, durationMs});
  }
  Action next(char type) {
    assert(!actions.empty());
    Action a = actions.front(); actions.pop_front();
    assert(a.type == type);
    seen.push_back(a); status = a.status; raw = a.status;
    delay(a.durationMs);
    return a;
  }
  int16_t getCount(uint32_t) { return static_cast<int16_t>(next('C').result); }
  bool deleteUser(uint16_t, uint32_t) { return next('D').result != 0; }
  int fingerPresent(uint32_t = 2500) { return next('P').result; }
  uint32_t emptyGlassInLastWait() const { return emptyReplies; }
  uint32_t unclearInLastWait() const { return unclearReplies; }
  uint32_t emptyReplies = 0;
  uint32_t unclearReplies = 0;
  bool enroll(uint16_t, uint8_t step, uint32_t) {
    const auto a = next('E'); assert(a.id == step); return a.result != 0;
  }
  bool search(uint16_t &id, uint8_t &permission, uint32_t) {
    const auto a = next('S'); id = static_cast<uint16_t>(a.id); permission = 1; return a.result != 0;
  }
  uint8_t getLastStatus() const { return status; }
  uint8_t getLastRawStatus() const { return raw; }
  void drain(uint32_t n) { delay(n); }
} finger;

// -- INSERT REAL FIRMWARE HERE --

static void reset() {
  nowMs = 0; finger = FakeFinger(); screens.clear(); enrollDetail = "";
  fingerprintToStaff.clear(); mappingOnline = true; mappingCalls = 0; mapOnSecondCheck = false;
  awaitingFingerLift = false; mappingListKnown = false; lampRequests = 0;
  enrollKeepFingerDown = false;
}
static void emptyGlass() { finger.add('P', 0, BIOVO_ACK_TIMEOUT); finger.add('P', 0, BIOVO_ACK_TIMEOUT); }
static void slotCleanup() { finger.add('C', 4); finger.add('D', 1); finger.add('C', 4); }

static void test_actual_enrollment() {
  reset();
  slotCleanup(); emptyGlass();
  finger.add('E', 1, 0, 1);
  finger.add('P', 1); emptyGlass(); // second capture really waits for lift
  finger.add('E', 1, 0, 2);
  finger.add('C', 5);
  finger.add('P', 1); emptyGlass(); // confirmation is a fresh placement
  finger.add('S', 1, 0, 400);
  assert(enrollFingerprint(400, "Abebe") == ENROLL_OK);
  assert(finger.actions.empty());
  assert(awaitingFingerLift && !enrollmentActive);
  assert(!screens.empty() && screens.front().second == "PREPARING...");
  bool showedProgressOne = false, showedProgressTwo = false;
  for (const auto &s : screens) {
    if (s.first == 1 && s.second == "LIFT YOUR FINGER") showedProgressOne = true;
    if (s.first == 2 && s.second == "PLACE FINGER") showedProgressTwo = true;
  }
  assert(showedProgressOne && showedProgressTwo);
}
static void test_early_no_finger_does_not_end_the_prompt() {
  reset();
  // A premature no-finger result is not proof that the whole wait elapsed.
  // Keep PLACE FINGER visible and accept a finger that arrives afterwards.
  finger.add('E', 0, BIOVO_ACK_TIMEOUT, 1);
  finger.add('E', 1, 0, 1);
  emptyGlass();
  finger.add('E', 1, 0, 2);
  assert(runCaptureSession(5, "Abebe", 300000) == ENROLL_OK);
  assert(!screens.empty() && screens.front().second == "PLACE FINGER");
  assert(finger.actions.empty());

  reset();
  finger.add('E', 0, BIOVO_ACK_TIMEOUT, 1, ENROLL_ADD_TIMEOUT_MS);
  const uint32_t began = millis();
  assert(runCaptureSession(5, "Abebe", 300000) == ENROLL_NO_FINGER);
  assert(millis() - began >= ENROLL_ADD_TIMEOUT_MS);
  assert(finger.actions.empty());

  reset();
  emptyGlass();
  finger.add('S', 0, BIOVO_ACK_TIMEOUT);
  finger.add('S', 1, 0, 5);
  assert(confirmEnrolledFinger(5, "Abebe", 300000) == ENROLL_OK);
  assert(finger.actions.empty());
}
static void test_silence_is_not_lift() {
  reset();
  finger.add('P', -1, BIOVO_ACK_NO_RESPONSE);
  finger.add('P', -1, BIOVO_ACK_NO_RESPONSE);
  assert(waitGlassEmpty("Abebe", 10, 20000, 1) == -1);
  assert(enrollDetail.text.find("sensor did not respond") != std::string::npos);
}
static void test_retry_quality_but_not_mismatch() {
  reset();
  finger.add('E', 0, BIOVO_ACK_IMAGEMESS, 1);
  finger.add('E', 1, 0, 1);
  emptyGlass();
  finger.add('E', 1, 0, 2);
  assert(runCaptureSession(5, "Abebe", 300000) == ENROLL_OK);
  assert(finger.actions.empty());
  reset();
  finger.add('E', 1, 0, 1); emptyGlass();
  finger.add('E', 0, BIOVO_ACK_MISMATCH, 2);
  assert(runCaptureSession(5, "Abebe", 300000) == ENROLL_FAILED);
  assert(enrollDetail.text.find("same finger") != std::string::npos);
  assert(finger.actions.empty());
}
static void test_unconfirmed_and_uncertain_write() {
  reset();
  emptyGlass();
  finger.add('S', 1, 0, 6); // sensor matched somebody else's ID
  assert(confirmEnrolledFinger(5, "Abebe", 300000) == ENROLL_ID_IN_USE);
  assert(enrollDetail.text.find("ID 6") != std::string::npos);
  reset();
  slotCleanup(); emptyGlass(); finger.add('E', 1, 0, 1); emptyGlass();
  finger.add('E', 0, BIOVO_ACK_NO_RESPONSE, 2);
  assert(enrollFingerprint(5, "Abebe") == ENROLL_SENSOR_ERROR);
  assert(finger.actions.empty()); // never retry an ambiguous STORE as success
}
static void test_mappings_before_deletion() {
  // A device that has NEVER received the name list cannot tell whose slot an ID
  // is, so it still refuses to enroll.
  reset(); mappingOnline = false;
  assert(enrollFingerprint(5, "Abebe") == ENROLL_FAILED);
  assert(finger.seen.empty());
  // ...but a device that already has the list saved keeps working when the
  // website does not answer: the connection is needed to START a job, not to
  // babysit every second of it.
  reset(); mappingListKnown = true;
  slotCleanup(); emptyGlass();
  finger.add('E', 1, 0, 1); emptyGlass();
  finger.add('E', 1, 0, 2);
  finger.add('C', 5); emptyGlass();
  finger.add('S', 1, 0, 5);
  assert(enrollFingerprint(5, "Abebe") == ENROLL_OK);
  assert(finger.actions.empty());
  reset(); mappingListKnown = true; fingerprintToStaff[5] = "Another employee";
  assert(enrollFingerprint(5, "Abebe") == ENROLL_ID_IN_USE);
  assert(finger.seen.empty());
  reset(); mapOnSecondCheck = true;
  slotCleanup(); emptyGlass();
  finger.add('E', 1, 0, 1); emptyGlass();
  finger.add('E', 0, BIOVO_ACK_MISMATCH, 2);
  assert(enrollFingerprint(5, "Abebe") == ENROLL_ID_IN_USE);
  assert(mappingCalls == 2 && finger.actions.empty()); // no second delete after a mapping change
}
/* The last attempt of a job takes both captures from ONE steady press. This is
 * the flow that works on a reader whose optics lose the finger between two
 * placements; it must not ask for a lift in the middle. */
static void test_single_press_fallback() {
  reset();
  enrollKeepFingerDown = true;
  finger.add('E', 1, 0, 1);
  finger.add('E', 1, 0, 2);   // no 'P' action at all: no lift is requested
  assert(runCaptureSession(5, "Abebe", 300000) == ENROLL_OK);
  assert(finger.actions.empty());
  bool keepDown = false;
  for (const auto &s : screens) if (s.second == "KEEP IT DOWN") keepDown = true;
  assert(keepDown);
  // The preferred flow still asks for the lift when the flag is clear.
  reset();
  finger.add('E', 1, 0, 1); emptyGlass();
  finger.add('E', 1, 0, 2);
  assert(runCaptureSession(5, "Abebe", 300000) == ENROLL_OK);
  assert(finger.actions.empty());
  keepDown = false;
  for (const auto &s : screens) if (s.second == "KEEP IT DOWN") keepDown = true;
  assert(!keepDown);
}

static void test_slot_delete_errors() {
  reset(); finger.add('C', 4); finger.add('D', 0, FINGERPRINT_DELETEFAIL);
  assert(freeLeftoverTemplate(5)); // reader may say DELETEFAIL for an empty slot
  reset(); finger.add('C', 4); finger.add('D', 0, 0x01);
  assert(!freeLeftoverTemplate(5)); // unexpected failures are not treated as empty
}
int main() {
  test_actual_enrollment();
  test_early_no_finger_does_not_end_the_prompt();
  test_silence_is_not_lift();
  test_retry_quality_but_not_mismatch();
  test_unconfirmed_and_uncertain_write();
  test_mappings_before_deletion();
  test_slot_delete_errors();
  test_single_press_fallback();
  std::cout << "Enrollment flow tests passed: fresh lifts, confirmation, quality retries, mismatches, silence, one-press fallback and safe slot cleanup\n";
}
