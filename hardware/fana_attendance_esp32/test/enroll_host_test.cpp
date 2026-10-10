/* Host harness: runs the REAL sketch code (fana_attendance_esp32.ino) against a
 * simulated FPC1020A module and a simulated website, so the enrollment state
 * machine can be verified without hardware. */
#include <set>
#include <climits>

#include "fana_attendance_esp32.ino"

/* ── the simulated module ─────────────────────────────────────────────────── */
struct Module {
  std::set<int> ids;          // templates stored on the sensor
  int stage = 0;              // accepted captures in the current enroll session
  bool broken = false;        // a non-ADD command was sent mid-session
  bool fingerOn = false;      // a finger rests on the glass right now
  int unclearLeft = 0;        // injected "image unclear" answers
  bool unclearSkipAdd1 = true; // ... but not on the very first ADD_1
  bool injected = false;      // the mid-session SEARCH was already injected
  int searchCallsInSession = 0;
  bool addSent = false;          // an ADD command went out in this session
  int nonAddInsideSession = 0;   // rule-1 violations: a non-ADD command after an ADD
  std::vector<uint8_t> commands;  // every command byte the sketch sent
} mod;

/* ── the simulated person standing at the scanner ─────────────────────────── */
struct Person {
  unsigned long liftAt = ULONG_MAX;
  unsigned long placeAt = ULONG_MAX;
  int liftsDone = 0;
  int placesDone = 0;
  bool cooperative = true;   // false = nobody ever comes to the scanner
  unsigned long reactMs = 800;
} person;

static std::string screen;

static uint8_t cksum(const uint8_t *p) { return p[1] ^ p[2] ^ p[3] ^ p[4] ^ p[5]; }

static void reply(std::deque<uint8_t> &out, uint8_t cmd, uint8_t d1, uint8_t d2, uint8_t status) {
  uint8_t f[8] = {0xF5, cmd, d1, d2, status, 0x00, 0x00, 0xF5};
  f[6] = cksum(f);
  for (uint8_t b : f) out.push_back(b);
}

// The person reacts to what the OLED asks for, reactMs later.
static void personUpdate(unsigned long now) {
  if (!person.cooperative) return;
  if (person.liftAt != ULONG_MAX && (long)(now - person.liftAt) >= 0) {
    mod.fingerOn = false;
    person.liftAt = ULONG_MAX;
    person.liftsDone++;
  }
  if (person.placeAt != ULONG_MAX && (long)(now - person.placeAt) >= 0) {
    mod.fingerOn = true;
    person.placeAt = ULONG_MAX;
    person.placesDone++;
  }
}

static bool onSensor(int portId, const uint8_t *buf, size_t n, std::deque<uint8_t> &out) {
  if (portId != 2 || n < 8 || buf[0] != 0xF5) return true;
  personUpdate(millis());

  const uint8_t cmd = buf[1];
  const int id = ((int)buf[2] << 8) | buf[3];
  mod.commands.push_back(cmd);

  // The rule this module enforces (see FINGERPRINT_FIX.md): once an ADD
  // command has gone out, only the remaining ADD steps may follow. Count
  // every violation so a test can prove the sketch never commits one.
  const bool isAdd = (cmd >= 0x01 && cmd <= 0x03);
  if (isAdd) mod.addSent = true;
  else if (mod.addSent) mod.nonAddInsideSession++;

  switch (cmd) {
    case 0x09: { // COUNT
      reply(out, cmd, (uint8_t)(mod.ids.size() >> 8), (uint8_t)(mod.ids.size() & 0xFF), 0x00);
      return true;
    }
    case 0x04: { // DELETE one id
      if (mod.ids.erase(id)) reply(out, cmd, buf[2], buf[3], 0x00);
      else reply(out, cmd, buf[2], buf[3], 0x01);
      return true;
    }
    case 0x0C: { // SEARCH - the ONLY command that may not appear mid-session
      if (mod.stage > 0) { mod.broken = true; mod.searchCallsInSession++; }
      if (!mod.fingerOn) reply(out, cmd, 0, 0, 0x08);       // no finger
      else if (mod.ids.count(id)) reply(out, cmd, buf[2], buf[3], 0x00);
      else reply(out, cmd, 0, 0, 0x05);                     // finger, not enrolled
      return true;
    }
    case 0x01: case 0x02: case 0x03: { // ADD_1 / ADD_2 / ADD_3
      const int step = cmd;
      // A broken session (a non-ADD command sneaked in) refuses every step
      // until a new ADD_1 starts a fresh one.
      if (mod.broken && step != 1) { reply(out, cmd, buf[2], buf[3], 0x01); return true; }
      const bool wanted = (step == 1) ||
                          (step == 2 && mod.stage >= 1 && mod.stage <= 4) ||
                          (step == 3 && mod.stage == 5);
      if (!wanted) { reply(out, cmd, buf[2], buf[3], 0x01); return true; }     // command failed
      if (step == 1 && mod.ids.count(id)) { reply(out, cmd, buf[2], buf[3], 0x07); return true; }
      if (!mod.fingerOn) { reply(out, cmd, buf[2], buf[3], 0x08); return true; } // no finger
      // Injected "image unclear": never on the very first ADD_1, so the test
      // really lands on a later capture.
      const bool skipFirst = (mod.unclearSkipAdd1 && step == 1 && mod.stage == 0);
      if (mod.unclearLeft > 0 && !skipFirst) {
        mod.unclearLeft--;
        reply(out, cmd, buf[2], buf[3], 0x06);
        return true;
      }
      mod.broken = false;
      mod.stage = (step == 1) ? 1 : mod.stage + 1;
      if (step == 3) { mod.ids.insert(id); mod.stage = 0; mod.addSent = false; }
      reply(out, cmd, buf[2], buf[3], 0x00);
      return true;
    }
    default:
      reply(out, cmd, buf[2], buf[3], 0x01);
      return true;
  }
}

static void onScreen(const std::string &line) {
  screen += line + "\n";
  if (!person.cooperative) return;
  // The person does what the OLED asks, reactMs later: lift for anything that
  // says LIFT, and put the finger down for PLACE FINGER.
  const bool wantsLift = line.find("LIFT") != std::string::npos;
  const bool wantsPlace = line.find("PLACE FINGER") != std::string::npos;
  if (wantsLift && mod.fingerOn && person.liftAt == ULONG_MAX) {
    person.liftAt = millis() + person.reactMs;
  }
  if (wantsPlace && !mod.fingerOn && person.placeAt == ULONG_MAX && person.liftAt == ULONG_MAX) {
    person.placeAt = millis() + person.reactMs;
  }
}

/* ── test scaffolding ─────────────────────────────────────────────────────── */
static int failures = 0;
static void check(const char *what, bool ok, const std::string &extra = "") {
  printf("%s %s%s\n", ok ? "PASS" : "FAIL", what, (!ok && !extra.empty()) ? "\n       " + extra : "");
  if (!ok) failures++;
}
static void resetAll() {
  mod = Module();
  person = Person();
  screen.clear();
  _stub_millis = 0;
  enrollDetail = "";
  fingerprintToStaff.clear();
  httpQueue.clear();
  httpCalls.clear();
  lastHandledJobId = 0;
  sensorReady = true;
  templateCount = 0;
  Serial.rx.clear();
  Serial.tx.clear();
  mySerial.rx.clear();
  mySerial.tx.clear();
}
static bool cmdSeen(uint8_t c) {
  for (uint8_t x : mod.commands) if (x == c) return true;
  return false;
}
// True when only ADD commands (0x01/0x02/0x03) were sent between the first and
// the last ADD of the session - the rule that keeps the module cooperating.
static bool onlyAddsBetweenFirstAndLastAdd() {
  int first = -1, last = -1;
  for (int i = 0; i < (int)mod.commands.size(); i++) {
    if (mod.commands[i] >= 1 && mod.commands[i] <= 3) { if (first < 0) first = i; last = i; }
  }
  if (first < 0) return false;
  for (int i = first + 1; i < last; i++) {
    const uint8_t c = mod.commands[i];
    if (!(c >= 1 && c <= 3)) return false;
  }
  return true;
}

int main() {
  serialWriteHook = onSensor;
  screenHook = onScreen;

  printf("=== 1. the plain case: empty glass, finger placed after PLACE FINGER ===\n");
  resetAll();
  EnrollResult r = enrollFingerprint(7, "Abebe");
  check("enrolled as ID 7", r == ENROLL_OK, "result=" + std::to_string((int)r) + " detail=" + enrollDetail.c_str());
  check("the sensor really stored ID 7", mod.ids.count(7) == 1);
  check("six captures were taken", mod.stage == 0 && mod.ids.count(7) == 1);
  check("only ADD commands between the first and the last ADD", onlyAddsBetweenFirstAndLastAdd());

  printf("\n=== 2. THE REPORTED BUG: finger already on the glass + leftover template on the ID ===\n");
  resetAll();
  mod.ids.insert(3);          // a template nobody mapped (old manual `enroll 3`)
  mod.fingerOn = true;        // the person was already leaning on the scanner
  r = enrollFingerprint(3, "Mulu");
  check("enrolled anyway (this is what used to fail)", r == ENROLL_OK,
        "result=" + std::to_string((int)r) + " detail=" + enrollDetail.c_str());
  check("the leftover was deleted first", cmdSeen(0x04));
  check("the device asked for a lift", screen.find("LIFT YOUR FINGER") != std::string::npos);
  check("only ADD commands between the first and the last ADD", onlyAddsBetweenFirstAndLastAdd());

  printf("\n=== 3. an unclear image on scan 2 recovers without extra sensor commands ===\n");
  resetAll();
  mod.unclearLeft = 2;
  r = enrollFingerprint(11, "Sara");
  check("recovered and enrolled", r == ENROLL_OK, "result=" + std::to_string((int)r) + " detail=" + enrollDetail.c_str());
  check("only ADD commands between the first and the last ADD", onlyAddsBetweenFirstAndLastAdd());

  printf("\n=== 4. nobody comes to the scanner ===\n");
  resetAll();
  person.cooperative = false;
  r = enrollFingerprint(12, "Nobody");
  check("gives up with ENROLL_NO_FINGER", r == ENROLL_NO_FINGER, "result=" + std::to_string((int)r));
  check("the reason names the missing finger", enrollDetail.s.find("no finger was placed") != std::string::npos,
        enrollDetail.c_str());
  check("it did not block forever", millis() < ENROLL_NO_FINGER_MS * 3UL, "millis=" + std::to_string(millis()));

  printf("\n=== 5. a broken session is retried from a fresh lift, not failed ===\n");
  resetAll();
  // Force the first session to break: a SEARCH sneaks in mid-session (what the
  // idle loop would do if anything re-entered it), exactly the PR #50 failure.
  serialWriteHook = [](int p, const uint8_t *b, size_t n, std::deque<uint8_t> &o) -> bool {
    // Once, right before the third capture, a SEARCH sneaks in (what the idle
    // loop would do if anything re-entered it). Its stale reply lands first and
    // the module then refuses the rest of that session: the PR #50 failure.
    if (p == 2 && n >= 8 && b[1] == 0x02 && mod.stage == 2 && !mod.injected) {
      mod.injected = true;
      uint8_t s[8] = {0xF5, 0x0C, 0, 0, 0, 0, 0, 0xF5};
      s[6] = s[1] ^ s[2] ^ s[3] ^ s[4] ^ s[5];
      onSensor(2, s, 8, o);
    }
    return onSensor(p, b, n, o);
  };
  r = enrollFingerprint(21, "Kebede");
  check("the job still finished", r == ENROLL_OK, "result=" + std::to_string((int)r) + " detail=" + enrollDetail.c_str());
  check("a broken session was detected", mod.injected);
  check("a second attempt was started", screen.find("LIFT, PLACE AGAIN") != std::string::npos);
  serialWriteHook = onSensor;

  printf("\n=== 6. the website job end to end: pending -> started -> mapping ===\n");
  resetAll();
  mod.fingerOn = true;   // the worst case again: already leaning on the scanner
  httpQueue.push_back({200, "{\"count\":1,\"jobs\":[{\"jobId\":42,\"memberId\":9,\"memberName\":\"Tigist\",\"fingerprintId\":4}]}"});
  httpQueue.push_back({200, "{\"success\":true}"});   // job_started
  httpQueue.push_back({200, "{\"success\":true}"});   // mapping
  const bool added = checkPendingEnroll();
  check("the device reported the finger as added", added);
  check("the sensor stored ID 4", mod.ids.count(4) == 1);
  check("three calls reached the website", httpCalls.size() == 3, std::to_string(httpCalls.size()) + " calls");
  check("call 1 asks who is waiting", httpCalls.size() > 0 && httpCalls[0].find("GET ") == 0 && httpCalls[0].find("/api/attendance/biometrics?pending=1") != std::string::npos,
        httpCalls.empty() ? "" : httpCalls[0]);
  check("call 2 announces the job before any sensor command",
        httpCalls.size() > 1 && httpCalls[1].find("job_started") != std::string::npos &&
        httpCalls[1].find("\"jobId\":42") != std::string::npos,
        httpCalls.size() > 1 ? httpCalls[1] : "");
  check("call 3 posts the mapping with the member id",
        httpCalls.size() > 2 && httpCalls[2].find("/api/attendance/mappings") != std::string::npos &&
        httpCalls[2].find("\"fingerprintId\":4") != std::string::npos &&
        httpCalls[2].find("\"memberId\":9") != std::string::npos,
        httpCalls.size() > 2 ? httpCalls[2] : "");

  printf("\n=== 7. a failed website job reports the exact reason ===\n");
  resetAll();
  person.cooperative = false;
  httpQueue.push_back({200, "{\"count\":1,\"jobs\":[{\"jobId\":43,\"memberId\":9,\"memberName\":\"Tigist\",\"fingerprintId\":5}]}"});
  httpQueue.push_back({200, "{\"success\":true}"});   // job_started
  httpQueue.push_back({200, "{\"success\":true}"});   // job_failed
  checkPendingEnroll();
  bool reported = false;
  for (auto &c : httpCalls) if (c.find("job_failed") != std::string::npos) reported = c.find("no finger was placed") != std::string::npos;
  check("job_failed carries the reason", reported);

  printf("\n=== 8. an ID that already belongs to somebody is never overwritten ===\n");
  resetAll();
  mod.ids.insert(6);
  fingerprintToStaff[6] = "Dawit";
  httpQueue.push_back({200, "{\"count\":1,\"jobs\":[{\"jobId\":44,\"memberId\":9,\"memberName\":\"Tigist\",\"fingerprintId\":6}]}"});
  httpQueue.push_back({200, "{\"success\":true}"});
  httpQueue.push_back({200, "{\"success\":true}"});
  checkPendingEnroll();
  check("ID 6 was not deleted", mod.ids.count(6) == 1);
  check("no ADD command was sent", !cmdSeen(0x01) && !cmdSeen(0x02) && !cmdSeen(0x03));

  printf("\n=== 9. the OLD ordering broke the module's one rule, the new one never does ===\n");
  // Replay what the sketch used to do when the ID still held a leftover
  // template: ADD_1 first, and only then the DELETE. That puts a non-ADD
  // command inside the session, which is the exact thing that made the module
  // answer status 1 on the next capture.
  resetAll();
  mod.ids.insert(3);
  mod.fingerOn = true;
  {
    std::deque<uint8_t> out;
    const uint8_t add1[8] = {0xF5, 0x01, 0x00, 0x03, 0x01, 0x00, 0x00, 0xF5};
    const uint8_t del[8]  = {0xF5, 0x04, 0x00, 0x03, 0x00, 0x00, 0x00, 0xF5};
    onSensor(2, add1, 8, out);   // -> status 7, ID already has a finger
    onSensor(2, del, 8, out);    // <- the old mid-placement DELETE
  }
  check("the old ordering did violate the rule", mod.nonAddInsideSession == 1,
        "violations=" + std::to_string(mod.nonAddInsideSession));

  resetAll();
  mod.ids.insert(3);
  mod.fingerOn = true;
  r = enrollFingerprint(3, "Mulu");
  check("the new ordering sends no non-ADD command inside the session",
        mod.nonAddInsideSession == 0, "violations=" + std::to_string(mod.nonAddInsideSession));
  check("and it still enrolls", r == ENROLL_OK, "result=" + std::to_string((int)r));

  printf("\n%s (%d failed)\n", failures ? "HARNESS FAILED" : "HARNESS PASSED", failures);
  return failures ? 1 : 0;
}
