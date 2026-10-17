/* Host harness: runs the REAL sketch code (fana_attendance_esp32.ino) against a
 * simulated FPC1020A module and a simulated website, so the enrollment state
 * machine can be verified without hardware. */
#include <set>
#include <climits>

#include "fana_attendance_esp32.ino"

/* ── the simulated module ─────────────────────────────────────────────────── */
/* ── the simulated module ───────────────────────────────────────────────────
 * Modelled on the sensor's own protocol as the vendor documents it (the
 * Biovo1020A library and its EnrollUser example): THREE enrollment commands,
 * one capture each, and a fresh placement in front of every one of them
 * ("Step 1 complete. Remove finger." / "Place the SAME finger again").
 *
 * Three consequences are what the cafe actually reported, so all three are
 * modelled here:
 *
 *   strictSteps       the module only takes 1 -> 2 -> 3, one capture per step.
 *                     A second ADD_2 in the same session is out of order and
 *                     answers status 1.
 *   needsFreshPress   commands that are all answered OK but taken from ONE
 *                     unmoving press produce a model the module can never
 *                     match again: the record is stored UNUSABLE, and every
 *                     later SEARCH answers status 5 (NOUSER) - the "NOT
 *                     REGISTERED" the owner heard right after "Fingerprint
 *                     Added ✓".
 *   storeLost         every command answers OK and nothing is written at all.
 *
 * A SEARCH reply carries the matched ID and the permission tier the library
 * reads it from (the library only calls it a match for tiers 1-3).
 */
struct Module {
  std::set<int> ids;          // templates the module can find a finger with
  std::set<int> unusable;     // templates it wrote, but can never match again
  std::map<int,int> ownerOf;  // template id -> the finger identity inside it
  int stage = 0;              // accepted captures in the current enroll session
  bool broken = false;        // a non-ADD command was sent mid-session
  bool deaf = false;          // the module hears its wires but answers nobody
  bool silentSearch = false;  // a SEARCH is ignored, a COUNT is answered: busy, not gone
  bool fingerOn = false;      // a finger rests on the glass right now
  int unclearLeft = 0;        // injected "image unclear" answers
  bool unclearSkipAdd1 = true; // ... but not on the very first ADD_1
  bool injected = false;      // the mid-session SEARCH was already injected
  int searchCallsInSession = 0;
  bool addSent = false;          // an ADD command went out in this session
  int nonAddInsideSession = 0;   // rule-1 violations: a non-ADD command after an ADD
  std::vector<uint8_t> commands;  // every command byte the sketch sent
  // the modelled module behaviour, and what the tests assert on
  bool strictSteps = true;
  bool needsFreshPress = true;
  bool storeLost = false;
  int matchesLeft = -1;            // >0: the module stops finding the finger again
  int addCommands = 0;             // ADD commands received, accepted or not
  int placesUsed[6] = {0,0,0,0,0,0}; // the placement each accepted capture saw
  bool sessionCompleted = false;   // the last step of a session was accepted
  int confirmScans = 0;            // SEARCHes after a completed session
  int httpCallsAtFirstConfirm = -1; // so a test can prove the order
} mod;

/* ── the simulated person standing at the scanner ─────────────────────────── */
struct Person {
  unsigned long liftAt = ULONG_MAX;
  unsigned long placeAt = ULONG_MAX;
  int liftsDone = 0;
  int placesDone = 0;        // how many times this finger was put down
  int fingerId = 1;          // the identity the module's template holds
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

// The person reacts to what the LCD asks for, reactMs later.
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
  if (mod.deaf || (mod.silentSearch && buf[1] == BIOVO_CMD_SEARCH)) {
    mod.commands.push_back(buf[1]);   // the wire carries the command...
    return true;                      // ...nothing ever comes back for it
  }
  personUpdate(millis());

  const uint8_t cmd = buf[1];
  const int id = ((int)buf[2] << 8) | buf[3];
  mod.commands.push_back(cmd);

  // The rule this module enforces (see FINGERPRINT_FIX.md): once an ADD
  // command has gone out, only the remaining ADD steps may follow - the
  // confirm scan is legal only after the session has ended. Count every
  // violation so a test can prove the sketch never commits one.
  const bool isAdd = (cmd >= 0x01 && cmd <= 0x03);
  if (isAdd) mod.addSent = true;
  else if (mod.addSent) mod.nonAddInsideSession++;

  switch (cmd) {
    case 0x09: { // COUNT - every record the module holds, usable or not
      const int n = (int)(mod.ids.size() + mod.unusable.size());
      reply(out, cmd, (uint8_t)(n >> 8), (uint8_t)(n & 0xFF), 0x00);
      return true;
    }
    case 0x04: { // DELETE one id
      bool erased = false;
      if (mod.ids.erase(id)) erased = true;
      if (mod.unusable.erase(id)) erased = true;
      mod.ownerOf.erase(id);
      if (erased) reply(out, cmd, buf[2], buf[3], 0x00);
      else reply(out, cmd, buf[2], buf[3], 0x01);
      return true;
    }
    case 0x0C: { // SEARCH - the ONLY command that may not appear mid-session
      if (mod.stage > 0) { mod.broken = true; mod.searchCallsInSession++; }
      if (mod.sessionCompleted) {
        mod.confirmScans++;
        if (mod.httpCallsAtFirstConfirm < 0) mod.httpCallsAtFirstConfirm = (int)httpCalls.size();
      }
      if (!mod.fingerOn) { reply(out, cmd, 0, 0, 0x08); return true; } // no finger
      int matchId = 0;
      for (const auto &kv : mod.ownerOf) {
        if (kv.second == person.fingerId && mod.ids.count(kv.first)) { matchId = kv.first; break; }
      }
      // A match answers the ID plus a permission tier (1-3), which is the only
      // thing the library calls a match; anything else is status 5 NOUSER.
      if (matchId && mod.matchesLeft != 0) {
        if (mod.matchesLeft > 0 && mod.sessionCompleted) mod.matchesLeft--;
        reply(out, cmd, (uint8_t)(matchId >> 8), (uint8_t)(matchId & 0xFF), 0x02);
      } else {
        reply(out, cmd, 0, 0, 0x05);                      // finger seen, not enrolled
      }
      return true;
    }
    case 0x01: case 0x02: case 0x03: { // ADD_1 / ADD_2 / ADD_3
      const int step = cmd;
      mod.addCommands++;
      // A broken session (a non-ADD command sneaked in) refuses every step
      // until a new ADD_1 starts a fresh one.
      if (mod.broken && step != 1) { reply(out, cmd, buf[2], buf[3], 0x01); return true; }
      bool wanted;
      if (step == 1) wanted = true;                        // ADD_1 opens a session
      else if (mod.strictSteps) wanted = (mod.stage == step - 1);   // vendor: 1 -> 2 -> 3
      else wanted = (step == 2) ? (mod.stage >= 1 && mod.stage <= 4)  // the old six-scan
                                : (mod.stage == 5);                    // recipe, for replay
      if (!wanted) { reply(out, cmd, buf[2], buf[3], 0x01); return true; }     // command failed
      if (step == 1 && (mod.ids.count(id) || mod.unusable.count(id))) {
        reply(out, cmd, buf[2], buf[3], 0x07); return true;                     // ID in use
      }
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
      if (step == 1) {
        mod.stage = 0;
        for (int i = 0; i < 6; i++) mod.placesUsed[i] = 0;
      }
      mod.placesUsed[mod.stage] = person.placesDone;  // which press this came from
      mod.stage++;
      if (step == 3) {
        // The model is written on the last step. Pictures of one unmoving
        // press are accepted and merged, but that model matches nothing.
        bool onePress = true;
        for (int i = 1; i < mod.stage; i++)
          if (mod.placesUsed[i] != mod.placesUsed[0]) onePress = false;
        if (mod.storeLost) {
          // the module said OK to everything and wrote nothing
        } else if (mod.needsFreshPress && onePress) {
          mod.unusable.insert(id);
        } else {
          mod.ids.insert(id);
          mod.ownerOf[id] = person.fingerId;
        }
        mod.stage = 0;
        mod.addSent = false;   // the session is over: other commands are legal
        mod.sessionCompleted = true;
      }
      reply(out, cmd, buf[2], buf[3], 0x00);
      return true;
    }
    default:
      reply(out, cmd, buf[2], buf[3], 0x01);
      return true;
  }
}

static std::vector<std::string> screensSeen;   // the whole glass after each row

static void onScreen(const std::string &line) {
  personUpdate(millis());   // what the LCD asked for earlier has happened by now
  screen += line + "\n";
  std::string snap;
  for (int r = 0; r < LCD_STUB_ROWS; r++) {
    for (int c = 0; c < LCD_STUB_COLS; c++) snap += lcdGrid[r][c];
    snap += '\n';
  }
  screensSeen.push_back(snap);
  if (!person.cooperative) return;
  // The person does what the LCD asks, reactMs later: lift for anything that
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
  const std::string tail = (!ok && !extra.empty()) ? "\n       " + extra : std::string();
  printf("%s %s%s\n", ok ? "PASS" : "FAIL", what, tail.c_str());
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
  // The link watchdog, so every case starts from a module that has been talking.
  sensorSilentPasses = 0;
  sensorLastStatus = BIOVO_ACK_SUCCESS;
  sensorLastReplyMs = 0;
  sensorLinkReported = false;
  sensorTestRounds = sensorTestAnswered = sensorTestSilent = sensorTestGarbled = 0;
  Serial.rx.clear();
  Serial.tx.clear();
  mySerial.rx.clear();
  mySerial.tx.clear();
  // The LCD: present, switched on, blank, and its address cache forgotten.
  lcdBeginStatus = 0;
  lcdReady = false;
  lcdClearCalls = 0;
  lcdWrapHits = 0;
  lcdBacklightOn = false;
  stubWifiStatus = WL_CONNECTED;
  stubTimeValid = true;      // NTP answered: 14:05:30 on the glass
  stubHour = 14;
  stubMinute = 5;
  stubSecond = 30;
  screensSeen.clear();
  // Flash: nothing stored, and the "last known real time" pair forgotten, so
  // every case starts from a device that has not seen NTP since this boot.
  littleFsFiles.clear();
  epochAtSync = 0;
  millisAtSync = 0;
  lastWallClockNote = 0;   // the once-a-second throttle must not skip a test
  timeReady = false;
  startLcd();
  lcdClearCalls = 0;   // the one clear of startLcd() is the allowed one
  lcdWriteCalls = 0;
}

// True when the glass showed this text at any point (a message that the next
// screen has already replaced).
static bool screenShowed(const std::string &needle) {
  for (const std::string &snap : screensSeen)
    if (snap.find(needle) != std::string::npos) return true;
  return false;
}

// The "scannedAt" number inside a queued line or a posted payload, 0 if absent.
static unsigned long scannedAtIn(const std::string &text) {
  const std::string key = "\"scannedAt\":";
  const size_t at = text.find(key);
  if (at == std::string::npos) return 0;
  return strtoul(text.c_str() + at + key.size(), nullptr, 10);
}

/* ── reading the simulated glass ──────────────────────────────────────────── */
static std::string rowText(int row) {
  std::string out;
  for (int c = 0; c < LCD_STUB_COLS; c++) out += lcdGrid[row][c];
  return out;
}
static bool rowEquals(int row, const char *expected) { return rowText(row) == std::string(expected); }
// The row is cut to 20 characters and then padded: a leftover character from
// an older, longer line is impossible on a row this test accepts.
static bool rowShows(int row, const std::string &needle) {
  return rowText(row).find(needle) != std::string::npos;
}
// Every line this sketch draws is a full 20-character row, so nothing from a
// longer, older line can be left behind. The stub counts any row write that
// stopped before column 19, and any character that ran past the row.
static bool noLeftovers() { return lcdShortRowWrites == 0; }
static bool nothingOverflows() { return lcdWrapHits == 0; }

// The enrollment progress bar is one cell per step plus the confirm scan,
// each of them '#' or '.'.
static bool progressBarOverflows() {
  for (const std::string &snap : screensSeen) {
    const size_t br = snap.find('[');
    if (br == std::string::npos) continue;
    const size_t end = snap.find(']', br);
    if (end == std::string::npos || end - br - 1 != ENROLL_SCANS) return true;
    for (size_t i = br + 1; i < end; i++)
      if (snap[i] != '#' && snap[i] != '.') return true;
  }
  return false;
}

// The instruction is centered on row 2, never glued to the left edge.
static bool progressPromptIsCentered() {
  for (const std::string &snap : screensSeen) {
    const std::string row = snap.substr(2 * (LCD_STUB_COLS + 1), LCD_STUB_COLS);
    const size_t first = row.find_first_not_of(' ');
    if (first == std::string::npos || first == 0) continue;
    if (row.find("PLACE FINGER") != std::string::npos) return true;
  }
  return false;
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

  printf("=== 1. the plain case: the module's three steps, each from its own press ===\n");
  resetAll();
  EnrollResult r = enrollFingerprint(7, "Abebe");
  check("enrolled as ID 7", r == ENROLL_OK, "result=" + std::to_string((int)r) + " detail=" + enrollDetail.c_str());
  check("the sensor really stored ID 7", mod.ids.count(7) == 1);
  check("and stored it WHERE IT CAN BE FOUND (not an unusable record)",
        mod.unusable.empty(), "unusable=" + std::to_string(mod.unusable.size()));
  check("three ADD commands were sent: step 1, 2, 3 - not six",
        mod.addCommands == ENROLL_STEPS, std::to_string(mod.addCommands) + " ADD commands");
  check("every step came from a fresh placement of the same finger",
        person.placesDone >= ENROLL_STEPS, std::to_string(person.placesDone) + " placements");
  check("only ADD commands between the first and the last ADD", onlyAddsBetweenFirstAndLastAdd());
  check("the device CONFIRMED the finger three times before calling it enrolled",
        mod.confirmScans >= ENROLL_VERIFY_PLACEMENTS,
        "confirm scans=" + std::to_string(mod.confirmScans));
  check("the 20x4 LCD guided the enrollment by name", screen.find("Enroll Abebe") != std::string::npos);
  check("every row write filled all 20 columns (no leftovers)", noLeftovers());
  check("no row ran past column 19", nothingOverflows(), "wrap hits=" + std::to_string(lcdWrapHits));
  check("the screen was never cleared during enrollment (no flicker)", lcdClearCalls == 0,
        "clears=" + std::to_string(lcdClearCalls));

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

  printf("\n=== 3. an unclear image on step 2 recovers without extra sensor commands ===\n");
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
    if (p == 2 && n >= 8 && b[1] == 0x02 && mod.stage == 1 && !mod.injected) {
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
  check("the finger was scanned again before the website heard about it",
        mod.confirmScans > 0 && mod.httpCallsAtFirstConfirm == 2,
        "confirm scans=" + std::to_string(mod.confirmScans) +
        " http calls when it ran=" + std::to_string(mod.httpCallsAtFirstConfirm));
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

  printf("\n=== 9b. THE OWNER'S REPORT: six accepted scans, and the finger is still NOT REGISTERED ===\n");
  // Replay the recipe this sketch used to run - 1, 2, 2, 2, 2, 3 with the
  // finger held on the glass the whole time - against a module that is as
  // easy-going about it as the old firmware assumed. Every command answers
  // OK, so the old code reported success ... and the finger is unusable.
  resetAll();
  mod.strictSteps = false;
  {
    std::deque<uint8_t> out;
    const uint8_t press = 0;   // the finger is never lifted: one placement only
    person.placesDone = 1;
    mod.fingerOn = true;
    for (int i = 0; i < 6; i++) {
      const uint8_t step = (i == 0) ? 0x01 : (i == 5 ? 0x03 : 0x02);
      const uint8_t frame[8] = {0xF5, step, 0x00, 0x05, 0x01, 0x00, 0x00, 0xF5};
      uint8_t f[8];
      memcpy(f, frame, 8);
      f[6] = cksum(f);
      onSensor(2, f, 8, out);
      (void)press;
    }
    check("all six commands were accepted, so the old code said ADDED",
          mod.addCommands == 6 && mod.sessionCompleted,
          "adds=" + std::to_string(mod.addCommands));
    // ... and this is what the very next scan of that finger gets:
    std::deque<uint8_t> srch;
    const uint8_t sframe[8] = {0xF5, 0x0C, 0x00, 0x00, 0x00, 0x00, 0x00, 0xF5};
    uint8_t sf[8];
    memcpy(sf, sframe, 8);
    sf[6] = cksum(sf);
    onSensor(2, sf, 8, srch);
    check("the module answers status 5 - the LCD's NOT REGISTERED",
          mod.ids.empty() && mod.unusable.count(5) == 1 && srch.size() == 8 && srch[4] == 0x05,
          "ids=" + std::to_string(mod.ids.size()) + " unusable=" + std::to_string(mod.unusable.size()));
  }
  // The new recipe never lands there: three steps from three presses, and a
  // scan that has to find the finger before anything is called added.
  resetAll();
  r = enrollFingerprint(5, "Hanna");
  check("the new recipe leaves a template the module can find again",
        r == ENROLL_OK && mod.ids.count(5) == 1 && mod.unusable.empty(),
        "result=" + std::to_string((int)r) + " detail=" + enrollDetail.c_str());
  check("and it took a fresh placement per step, not one press held on the glass",
        person.placesDone >= ENROLL_STEPS, std::to_string(person.placesDone) + " placements");

  printf("\n=== 9b2. found twice out of three is NOT an enrollment ===\n");
  // The last three placements are the proof. A finger the module loses half
  // way through them is the "worked at the desk, fails at the door" finger, so
  // it must be reported as a failure and never as added.
  resetAll();
  mod.matchesLeft = 2;
  r = enrollFingerprint(14, "Yonas");
  check("the enrollment is refused", r == ENROLL_NOT_CONFIRMED,
        "result=" + std::to_string((int)r) + " detail=" + enrollDetail.c_str());
  check("and the reason says the finger does not scan successfully",
        enrollDetail.s.find("does not scan successfully") != std::string::npos, enrollDetail.c_str());

  printf("\n=== 9c. a module that answers OK and stores nothing is never called ADDED ===\n");
  // The other half of the owner's report: the website must never see a mapping
  // for a finger the sensor cannot produce on the next scan.
  resetAll();
  mod.storeLost = true;              // every command says OK, nothing is written
  r = enrollFingerprint(9, "Bruno");
  check("the enrollment fails instead of reporting a saved finger",
        r == ENROLL_NOT_CONFIRMED, "result=" + std::to_string((int)r) + " detail=" + enrollDetail.c_str());
  check("the reason says the finger does not scan successfully",
        enrollDetail.s.find("does not scan successfully") != std::string::npos, enrollDetail.c_str());
  check("every step was still accepted, so the old code would have said ADDED",
        mod.addCommands >= ENROLL_STEPS, std::to_string(mod.addCommands) + " ADD commands");
  check("the finger is not claimed as stored", mod.ids.empty());

  resetAll();
  mod.storeLost = true;
  httpQueue.push_back({200, "{\"count\":1,\"jobs\":[{\"jobId\":45,\"memberId\":9,\"memberName\":\"Bruno\",\"fingerprintId\":8}]}"});
  httpQueue.push_back({200, "{\"success\":true}"});   // job_started
  httpQueue.push_back({200, "{\"success\":true}"});   // job_failed
  const bool claimed = checkPendingEnroll();
  check("no mapping is posted for an unconfirmed finger",
        !claimed && httpQueue.empty() && httpCalls.size() == 3 &&
        httpCalls[2].find("job_failed") != std::string::npos,
        std::to_string(httpCalls.size()) + " calls");
  check("and the admin page gets the reason it will print",
        httpCalls.size() == 3 && httpCalls[2].find("does not scan successfully") != std::string::npos,
        httpCalls.size() == 3 ? httpCalls[2] : std::string());

  printf("\n=== 10. the 20x4 LCD: every screen, and the characters that must not be left over ===\n");
  resetAll();
  showIdleScreen();
  check("idle row 0 is the cafe name", rowEquals(0, "Fana Cafe Attendance"), rowText(0));
  check("idle row 1 asks for the finger", rowEquals(1, "Place finger        "), rowText(1));
  check("idle row 2 says the WiFi is connected", rowEquals(2, "Wifi Connected      "), rowText(2));
  check("idle row 3 shows the wall clock", rowEquals(3, "Time 14:05:30       "), rowText(3));
  check("the IP address and the template count left the glass",
        !rowShows(2, "192.168") && !rowShows(3, "Templates:"), rowText(2) + " | " + rowText(3));

  stubWifiStatus = WL_DISCONNECTED;   // the internet dropped
  sensorReady = false;                // ... and so did the sensor
  showIdleScreen();
  check("offline is still reported on the LCD", rowEquals(2, "Wifi Not Connected  "), rowText(2));
  check("a dead sensor is still reported on the LCD", rowEquals(1, "SENSOR OFFLINE!     "), rowText(1));

  // A router that blocks NTP: the row says the time is not set instead of
  // showing a wrong one, and the rest of the screen keeps working.
  stubWifiStatus = WL_CONNECTED;
  sensorReady = true;
  stubTimeValid = false;
  showIdleScreen();
  check("a clock that never synced says so instead of guessing",
        rowEquals(3, "Time not set yet    "), rowText(3));

  // The clock moves: once a second, one row only, and never over a message.
  stubTimeValid = true;
  showIdleScreen();
  const int writesBeforeClock = lcdWriteCalls;
  refreshIdleClock();                 // inside the same second: nothing to do
  check("the clock row is not redrawn more often than once a second",
        lcdWriteCalls == writesBeforeClock,
        std::to_string(lcdWriteCalls - writesBeforeClock) + " characters rewritten");
  delay(IDLE_CLOCK_REFRESH_MS + 1);
  stubSecond = 31;
  refreshIdleClock();
  check("the clock row follows the seconds", rowEquals(3, "Time 14:05:31       "), rowText(3));
  check("and only that one row was rewritten (no flicker on the other three)",
        lcdWriteCalls - writesBeforeClock == LCD_STUB_COLS,
        std::to_string(lcdWriteCalls - writesBeforeClock) + " characters rewritten");

  showBig("Abebe", "VERIFIED", "Sending...");   // a result covers the idle screen
  const int writesAfterResult = lcdWriteCalls;
  delay(IDLE_CLOCK_REFRESH_MS + 1);
  stubSecond = 45;
  refreshIdleClock();
  check("the clock never overwrites a result message",
        lcdWriteCalls == writesAfterResult && rowEquals(1, "      VERIFIED      "), rowText(1));
  showIdleScreen();                   // back to idle, and the clock with it
  check("the clock comes back with the idle screen", rowEquals(3, "Time 14:05:45       "), rowText(3));

  // A long line, then a short one: the short one must wipe the leftovers.
  stubSecond = 30;
  showLines("A very long name that gets cut", "second", "third", "fourth");
  showIdleScreen();
  check("a shorter line leaves no leftovers from a longer one",
        rowEquals(0, "Fana Cafe Attendance"), rowText(0));
  check("the shorter line filled its row completely (no leftovers)", noLeftovers());

  // Same screen twice: the second draw must not touch the glass (= no flicker).
  const int writesBefore = lcdWriteCalls;
  showIdleScreen();
  check("an unchanged screen is not redrawn (no flicker)", lcdWriteCalls == writesBefore,
        std::to_string(lcdWriteCalls - writesBefore) + " characters rewritten");

  // The result screen: name, big word centered, note at the bottom.
  resetAll();
  showBig("Abebe", "VERIFIED", "Sending...");
  check("result row 0 is the name", rowEquals(0, "Abebe               "), rowText(0));
  check("the big word is centered", rowEquals(1, "      VERIFIED      "), rowText(1));
  check("the note is at the bottom", rowEquals(3, "Sending...          "), rowText(3));

  // Enrollment progress is TEXT now (the old 128x64 drawing is gone).
  resetAll();
  person.cooperative = false;         // nobody touches the scanner
  EnrollResult slow = enrollFingerprint(8, "Sara");
  check("the enrollment screen shows the ID and the text bar",
        screen.find("ID 8 [") != std::string::npos, "no ID/bar row was drawn");
  check("the bar is followed by the accepted-scan count",
        screen.find("] 0/" + std::to_string(ENROLL_SCANS)) != std::string::npos,
        "no k/N count on the bar row");
  check("the bar counts the three steps and the confirm scans: six cells again",
        ENROLL_SCANS == ENROLL_STEPS + ENROLL_VERIFY_PLACEMENTS);
  check("the progress bar never shows more than its own cells",
        !progressBarOverflows());
  check("the prompt is centered on its own row", progressPromptIsCentered());
  check("nobody comes, so the job still ends", slow == ENROLL_NO_FINGER,
        std::to_string((int)slow));
  check("no row ever ran past column 19 in any screen", nothingOverflows(),
        "wrap hits=" + std::to_string(lcdWrapHits));
  check("and no row was ever left half-written", noLeftovers(),
        "short rows=" + std::to_string(lcdShortRowWrites));

  // A device with no LCD at all still runs: the display simply stays silent.
  resetAll();
  lcdReady = false;
  lcdBeginStatus = -1;               // hd44780 says "no backpack"
  const int writesWithoutLcd = lcdWriteCalls;
  showIdleScreen();
  check("without an LCD nothing is written and nothing crashes",
        lcdWriteCalls == writesWithoutLcd && !lcdReady);
  lcdBeginStatus = 0;
  delay(11000);                      // wait out checkLcdHealth()'s 10 s retry
  checkLcdHealth();
  check("a later retry finds the LCD again", lcdReady, "startLcd() still fails");
  check("the found LCD shows the idle screen", rowEquals(1, "Place finger        "), rowText(1));

  printf("\n=== 11. an offline scan keeps the moment of the finger ===\n");

  /* ── the internet goes down, a finger comes, the internet comes back ──── */
  resetAll();
  fingerprintToStaff[4] = "Tigist";
  stubHour = 12; stubMinute = 30; stubSecond = 0;   // the finger at 12:30:00
  delay(1000);
  noteWallClock();                                  // the device knows the time
  const unsigned long atFinger = scanEpochNow();
  check("the device knows the real time before the outage",
        atFinger > 0, std::to_string(atFinger));

  stubWifiStatus = WL_DISCONNECTED;
  handleVerifiedFinger(4);
  check("a scan nobody could deliver is kept in flash, not dropped",
        littleFsFiles.count("/queue.json") == 1 && !littleFsFiles["/queue.json"].empty(),
        littleFsFiles.count("/queue.json") ? littleFsFiles["/queue.json"] : "no queue file");
  check("the glass says it was saved and will sync",
        screenShowed("Saved offline") && screenShowed("Will sync when"));
  check("the kept scan carries the moment of the finger",
        scannedAtIn(littleFsFiles["/queue.json"]) == atFinger,
        littleFsFiles["/queue.json"]);

  stubHour = 13; stubMinute = 10; stubSecond = 5;   // 40 minutes of outage
  delay(40 * 60 * 1000);
  stubWifiStatus = WL_CONNECTED;
  httpCalls.clear();
  httpQueue.clear();
  httpQueue.push_back({200, "{\"success\":true,\"action\":\"clock_in\"}"});
  syncOfflineQueue();
  check("the kept scan is delivered once the internet is back",
        httpCalls.size() == 1, std::to_string(httpCalls.size()) + " calls");
  check("it goes to the clock route and says it came late",
        httpCalls.size() == 1 &&
          httpCalls[0].find("/api/attendance/clock") != std::string::npos &&
          httpCalls[0].find("_offline") != std::string::npos,
        httpCalls.empty() ? "" : httpCalls[0]);
  check("and it still says WHEN THE FINGER WAS PLACED, not when the internet came back",
        httpCalls.size() == 1 && scannedAtIn(httpCalls[0]) == atFinger,
        httpCalls.empty() ? "" : httpCalls[0]);
  check("a delivered scan leaves the queue empty",
        littleFsFiles.count("/queue.json") == 0);

  /* ── NTP itself is unreachable: the last good clock plus millis ───────── */
  resetAll();
  fingerprintToStaff[4] = "Tigist";
  stubHour = 9; stubMinute = 0; stubSecond = 0;
  delay(1000);
  noteWallClock();
  const unsigned long atNine = scanEpochNow();
  stubTimeValid = false;              // NTP stops answering
  stubWifiStatus = WL_DISCONNECTED;
  delay(90 * 1000);                   // 90 seconds later somebody scans
  const unsigned long carried = scanEpochNow();
  check("a scan made while NTP is silent still gets a real time",
        carried >= atNine + 90 && carried <= atNine + 120,
        "carried=" + std::to_string(carried) + " expected about " + std::to_string(atNine + 90));
  handleVerifiedFinger(4);
  check("and that time is what is written into the queue",
        scannedAtIn(littleFsFiles["/queue.json"]) == carried,
        littleFsFiles["/queue.json"]);

  /* ── a device that has NEVER seen NTP must not invent a time ──────────── */
  resetAll();
  fingerprintToStaff[4] = "Tigist";
  stubTimeValid = false;
  stubWifiStatus = WL_DISCONNECTED;
  handleVerifiedFinger(4);
  check("a device that never got a time keeps the scan but claims no time",
        scanEpochNow() == 0 &&
          littleFsFiles.count("/queue.json") == 1 &&
          littleFsFiles["/queue.json"].find("scannedAt") == std::string::npos,
        littleFsFiles.count("/queue.json") ? littleFsFiles["/queue.json"] : "no queue file");
  stubWifiStatus = WL_CONNECTED;
  httpCalls.clear();
  httpQueue.clear();
  httpQueue.push_back({200, "{}"});
  syncOfflineQueue();
  check("so it sends no time, and the website stamps the arrival as it always did",
        httpCalls.size() == 1 && httpCalls[0].find("scannedAt") == std::string::npos,
        httpCalls.empty() ? "" : httpCalls[0]);

  /* ── a line queued by older firmware has no time and gets none ────────── */
  resetAll();
  littleFsFiles["/queue.json"] =
      "{\"deviceId\":\"door\",\"fingerprintId\":4,\"staffName\":\"Tigist\",\"timestamp\":\"81234\"}\n";
  stubWifiStatus = WL_CONNECTED;
  httpCalls.clear();
  httpQueue.clear();
  httpQueue.push_back({200, "{}"});
  syncOfflineQueue();
  check("an older queued line is still delivered, without a made-up time",
        httpCalls.size() == 1 &&
          httpCalls[0].find("\"fingerprintId\":4") != std::string::npos &&
          httpCalls[0].find("scannedAt") == std::string::npos,
        httpCalls.empty() ? "" : httpCalls[0]);

  /* ── two kept scans go oldest first, so the IN arrives before the OUT ─── */
  resetAll();
  littleFsFiles["/queue.json"] =
      "{\"deviceId\":\"door\",\"fingerprintId\":4,\"scannedAt\":1760000000}\n"
      "{\"deviceId\":\"door\",\"fingerprintId\":4,\"scannedAt\":1760014400}\n";
  stubWifiStatus = WL_CONNECTED;
  httpCalls.clear();
  httpQueue.clear();
  httpQueue.push_back({200, "{}"});
  httpQueue.push_back({200, "{}"});
  syncOfflineQueue();
  check("both kept scans are delivered, oldest first",
        httpCalls.size() == 2 &&
          scannedAtIn(httpCalls[0]) == 1760000000UL &&
          scannedAtIn(httpCalls[1]) == 1760014400UL,
        httpCalls.size() == 2 ? httpCalls[0] + " || " + httpCalls[1] : std::to_string(httpCalls.size()) + " calls");

  /* ── refused is dropped, unreachable is kept ──────────────────────────── */
  resetAll();
  littleFsFiles["/queue.json"] =
      "{\"deviceId\":\"door\",\"fingerprintId\":7,\"scannedAt\":1760000000}\n";
  stubWifiStatus = WL_CONNECTED;
  httpCalls.clear();
  httpQueue.clear();
  httpQueue.push_back({404, "{\"error\":\"Fingerprint not enrolled\"}"});
  syncOfflineQueue();
  check("a scan the website refuses is dropped, not retried for ever",
        littleFsFiles.count("/queue.json") == 0);

  resetAll();
  littleFsFiles["/queue.json"] =
      "{\"deviceId\":\"door\",\"fingerprintId\":7,\"scannedAt\":1760000000}\n";
  stubWifiStatus = WL_CONNECTED;
  httpCalls.clear();
  httpQueue.clear();                 // nothing answers: the post cannot go out
  syncOfflineQueue();
  check("a scan that still cannot reach the website stays queued, with its time",
        littleFsFiles.count("/queue.json") == 1 &&
          scannedAtIn(littleFsFiles["/queue.json"]) == 1760000000UL,
        littleFsFiles.count("/queue.json") ? littleFsFiles["/queue.json"] : "queue was dropped");

  // ── 12. the rest windows ──────────────────────────────────────────────────
  // What the scanner does with the hours the owner lists in
  // Attendance -> Activity: awake inside them, deep asleep outside them. This is
  // the arithmetic the ESP32 runs on its own, offline, and it has to agree with
  // the website minute for minute - so the same cases are asserted here that
  // scripts/verify-attendance-activity.ts asserts there.
  printf("\n=== the rest windows: awake inside the hours, resting outside ===\n");
  {
    resetAll();
    stubWifiStatus = WL_CONNECTED;
    const RestWindow one[] = {{720, 900, true}};   // open 12:00 - 15:00
    check("with no hours listed at all the scanner is ALWAYS awake", scheduleAwaits(nullptr, 0, 185));
    check("12:00 is inside its own window", scheduleAwaits(one, 1, 720));
    check("14:59 is the last awake minute", scheduleAwaits(one, 1, 899));
    check("15:05 is resting (the owner's 3:05 example)", scheduleAwaits(one, 1, 905) == false);
    check("and the middle of the night is resting", scheduleAwaits(one, 1, 185) == false);

    const RestWindow wrap[] = {{1320, 360, true}};  // open 22:00 - 06:00, over midnight
    check("a window across midnight is awake at 23:00", scheduleAwaits(wrap, 1, 1380));
    check("...and awake at 05:00", scheduleAwaits(wrap, 1, 300));
    check("...and resting at 12:00", scheduleAwaits(wrap, 1, 720) == false);

    const RestWindow off[] = {{720, 900, false}};   // the row's own on/off switch
    check("the escape hatch: switching his only interval off wakes the board", scheduleAwaits(off, 1, 800));
    const RestWindow mixed[] = {{720, 900, false}, {0, 60, true}};
    check("a switched-off interval no longer opens the door", scheduleAwaits(mixed, 2, 800) == false);
    check("while its enabled neighbour runs, the board is awake", scheduleAwaits(mixed, 2, 30));
    const RestWindow wholeDay[] = {{600, 600, true}};
    check("from == to means the whole day, never nothing",
          scheduleAwaits(wholeDay, 1, 3) && scheduleAwaits(wholeDay, 1, 1439));

    check("the flip is measured, not guessed: 11:50 -> 12:00 is 10 minutes",
          minutesUntilScheduleChange(one, 1, 710) == 10);
    check("at 15:00 it is the long walk back to tomorrow's 12:00",
          minutesUntilScheduleChange(one, 1, 900) == 1260);
    check("with nothing listed the answer never changes",
          minutesUntilScheduleChange(nullptr, 0, 500) == 1440);

    uint32_t sleepMs = 0;
    uint16_t wake = 0;
    check("at 03:05 the board sleeps", restShouldSleep(one, 1, 185, REST_SLICE_MAX_MS, &sleepMs, &wake));
    check("and it is told the REAL boundary: open again at 12:00", wake == 720);
    check("a five-hour night is slept in one capped slice", sleepMs == REST_SLICE_MAX_MS);
    check("9 minutes before opening: sleep those 9 minutes",
          restShouldSleep(one, 1, 711, REST_SLICE_MAX_MS, &sleepMs, &wake) && sleepMs == 9UL * 60000UL && wake == 720);
    check("one minute before opening is not worth a restart: it stays up",
          restShouldSleep(one, 1, 719, REST_SLICE_MAX_MS, &sleepMs, &wake) == false);
    check("while the door is open it does not sleep",
          restShouldSleep(one, 1, 800, REST_SLICE_MAX_MS, &sleepMs, &wake) == false);

    // The hurry-up: the website can shorten the sleep so a change it just made
    // is obeyed in about a minute, and it can only shorten the WAIT, never move
    // the hour the door opens.
    check("a five-hour night is one short slice when a change is expected",
          restShouldSleep(one, 1, 185, 45000UL, &sleepMs, &wake) && sleepMs == 45000UL);
    check("and the real opening hour is still what the board promises", wake == 720);
    check("a short wait is still not worth a reboot, hurry or not",
          restShouldSleep(one, 1, 719, 45000UL, &sleepMs, &wake) == false);
    check("a cap under the wait is obeyed, not rounded up to the whole night",
          restShouldSleep(one, 1, 700, 45000UL, &sleepMs, &wake) && sleepMs == 45000UL);

    check("a time from the website parses", hhmmToMinutes("06:00") == 360 && hhmmToMinutes("23:59") == 1439);
    check("anything else is refused, not guessed",
          hhmmToMinutes("6:00") == 0xFFFF && hhmmToMinutes("") == 0xFFFF && hhmmToMinutes("24:00") == 0xFFFF);
    check("the Addis minute of an epoch is UTC+3, no daylight saving", minuteOfAddisDay(0UL) == 180);
    check("a minute prints as HH:MM", minuteLabel(725) == "12:05");

    // What the server's number becomes, after the clamp that keeps a silly
    // value from turning the door into a reboot every few seconds.
    restSliceSeconds = 0;
    check("no number from the website means the long 10 minute slice", restSliceMs() == REST_SLICE_MAX_MS);
    restSliceSeconds = 45;
    check("45 s is obeyed as 45 s", restSliceMs() == 45000UL);
    restSliceSeconds = 2;
    check("2 s is refused: never under the floor", restSliceMs() == REST_SLICE_FLOOR_MS);
    restSliceSeconds = 99999;
    check("and a huge number never sleeps longer than the slice cap", restSliceMs() == REST_SLICE_MAX_MS);
    restSliceSeconds = 0;

    // The whole decision path, from the JSON the device caches in flash.
    const String payload =
        "{\"device\":{\"windows\":[{\"from\":\"06:00\",\"to\":\"10:00\",\"enabled\":true},"
        "{\"from\":\"12:00\",\"to\":\"15:00\",\"enabled\":true}],\"keptAwake\":false,\"wakeUntilEpoch\":0,"
        "\"sliceSeconds\":45}}";
    check("the cached answer becomes rows", parseRestPayload(payload) && restWindowCount == 2);
    check("and the short-sleep request it carries is obeyed", restSliceSeconds == 45);
    restSliceSeconds = 0;
    check("03:00 rests with those two intervals open",
          scheduleAwaits(restWindows, restWindowCount, 180) == false);
    check("13:00 is awake", scheduleAwaits(restWindows, restWindowCount, 780));
    check("and the summary the Serial monitor prints lists both intervals",
          restScheduleSummary().s.find("06:00-10:00") != std::string::npos &&
            restScheduleSummary().s.find("12:00-15:00") != std::string::npos);

    // What goRest() actually does to the board: an LCD that goes dark, a wake
    // alarm for the time it decided on, and no return.
    const int sleepsBefore = stubDeepSleepCalls;
    lcdReady = true;
    lcdBacklightOn = true;
    goRest(REST_SLICE_MAX_MS, 720);
    check("goRest asks the chip to wake after the slice it decided on",
          stubSleepUs == (uint64_t)REST_SLICE_MAX_MS * 1000ULL);
    check("goRest deep sleeps", stubDeepSleepCalls == sleepsBefore + 1);
    check("goRest turns the backlight off, not just the text", lcdBacklightOn == false);

    // maybeRest() is the gate in loop(): the closed hours obeyed, the two admin
    // overrides honoured, and no sleep while the clock is a guess or a schedule
    // has never been read. Each case counts the board's own decisions, so one
    // assertion cannot disturb the next.
    stubTimeValid = true;
    noteWallClock();
    restScheduleKnown = true;
    restKeptAwake = false;
    restWakeUntilEpoch = 0UL;
    // Two rows that are guaranteed NOT to cover this minute, whatever it is.
    const uint16_t nowMin = minuteOfAddisDay(scanEpochNow());
    restWindowCount = 1;
    restWindows[0] = {(uint16_t)((nowMin + 600) % 1440), (uint16_t)((nowMin + 1200) % 1440), true};
    delay(REST_AFTER_MESSAGE_MS + 50);
    int before = stubDeepSleepCalls;
    maybeRest();
    check("loop() puts the board to sleep in the closed hours", stubDeepSleepCalls == before + 1);

    delay(REST_AFTER_MESSAGE_MS + 50);
    restKeptAwake = true;
    before = stubDeepSleepCalls;
    maybeRest();
    check("but not while the admin has switched the rest off", stubDeepSleepCalls == before);
    restKeptAwake = false;

    delay(REST_AFTER_MESSAGE_MS + 50);
    restWakeUntilEpoch = scanEpochNow() + 3600UL;
    before = stubDeepSleepCalls;
    maybeRest();
    check("nor during the N minutes of \"stay awake for a while\"", stubDeepSleepCalls == before);

    delay(REST_AFTER_MESSAGE_MS + 50);
    restWakeUntilEpoch = scanEpochNow() - 1UL;   // expired on its own
    before = stubDeepSleepCalls;
    maybeRest();
    check("an expired \"for N minutes\" starts resting again by itself", stubDeepSleepCalls == before + 1);
    restWakeUntilEpoch = 0UL;

    // A board that has never had NTP answer since it booted does not know what
    // hour it is. Guessing an hour is how a door ends up shut all night.
    resetAll();
    stubTimeValid = false;
    stubWifiStatus = WL_DISCONNECTED;
    restScheduleKnown = true;
    delay(REST_AFTER_MESSAGE_MS + 50);
    before = stubDeepSleepCalls;
    check("its clock really is unknown", scanEpochNow() == 0UL);
    maybeRest();
    check("and with no clock it stays awake", stubDeepSleepCalls == before);
    stubTimeValid = true;
    noteWallClock();

    delay(REST_AFTER_MESSAGE_MS + 50);
    restWindowCount = 0;                       // the empty panel: open all day
    before = stubDeepSleepCalls;
    maybeRest();
    check("an owner who lists no hours cannot lock his own door", stubDeepSleepCalls == before);

    delay(REST_AFTER_MESSAGE_MS + 50);
    restWindowCount = 1;                       // closed right now again...
    restWindows[0] = {(uint16_t)((nowMin + 600) % 1440), (uint16_t)((nowMin + 1200) % 1440), true};
    restScheduleKnown = false;                 // ...but this board has read nothing yet
    before = stubDeepSleepCalls;
    maybeRest();
    check("a board that has read no schedule yet sleeps for nobody", stubDeepSleepCalls == before);
  }

  /* ── 13. a sensor that goes quiet is noticed, not silently ignored ───────
   * The owner's report: "sometimes when I plug it the LCD all work but the
   * sensor doesnt scan, I put a finger, nothing happens". A module that answers
   * "no finger" is alive; a module that answers NOTHING is a dead link, and
   * until this existed the two looked identical from the outside: the idle
   * screen stayed up and every scan attempt timed out in silence.
   */
  printf("\n=== a sensor that stops answering is noticed and looked for again ===\n");
  {
    resetAll();
    check("silence and a garbled frame are the two signs of a dead link",
          sensorReplyIsSilence(BIOVO_ACK_NO_RESPONSE) && sensorReplyIsSilence(BIOVO_ACK_COMM_ERROR));
    check("a module that says \"no finger\" is ALIVE, so that is never a failure",
          !sensorReplyIsSilence(BIOVO_ACK_TIMEOUT) && !sensorReplyIsSilence(BIOVO_ACK_NOUSER) &&
            !sensorReplyIsSilence(BIOVO_ACK_GO_OUT) && !sensorReplyIsSilence(BIOVO_ACK_IMAGEMESS) &&
            !sensorReplyIsSilence(BIOVO_ACK_SUCCESS));

    for (int i = 0; i < SENSOR_FAIL_LIMIT - 1; i++) noteSensorAnswer(BIOVO_ACK_NO_RESPONSE);
    check("a short run of silence is not yet a dead sensor", sensorLinkLooksDead() == false);
    noteSensorAnswer(BIOVO_ACK_TIMEOUT);
    check("and one honest reply clears the whole run",
          sensorSilentPasses == 0 && sensorLinkLooksDead() == false && sensorLinkReported == false);

    for (int i = 0; i < SENSOR_FAIL_LIMIT; i++) noteSensorAnswer(BIOVO_ACK_NO_RESPONSE);
    check("SENSOR_FAIL_LIMIT passes with nothing back is a dead link", sensorLinkLooksDead());

    // A module that is only BUSY must not be called dead: a SEARCH over a few
    // hundred templates can outlast the poll budget, and the cheap COUNT is how
    // the two are told apart.
    resetAll();
    sensorReady = true;
    mod.silentSearch = true;
    for (int i = 0; i < SENSOR_FAIL_LIMIT * 2; i++) scanForFinger();
    check("a module that ignores scans but answers COUNT is not dropped", sensorReady);
    check("it is not announced as a broken link", screenShowed("SENSOR NOT") == false);
    check("instead the scan starts waiting longer for it", sensorPollMs > SENSOR_POLL_MS);
    for (int i = 0; i < SENSOR_FAIL_LIMIT * 4; i++) scanForFinger();
    check("and that patience is capped, so one slow scan cannot stall the door",
          sensorPollMs == SENSOR_POLL_MAX_MS);
    mod.silentSearch = false;
    scanForFinger();
    check("a normal answer puts the old polling speed back", sensorPollMs == SENSOR_POLL_MS);

    // The real path: a module wired to the wires but answering nobody.
    resetAll();
    sensorReady = true;
    mod.deaf = true;
    for (int i = 0; i < SENSOR_FAIL_LIMIT - 1; i++) scanForFinger();
    awaitingFingerLift = true;   // somebody is mid-placement when the link dies
    scanForFinger();             // the sixth silence, which is the drop
    check("the idle scan notices it and gives the sensor up", sensorReady == false);
    check("the person at the door is told what happened, not asked to place a finger again",
          screenShowed("SENSOR NOT"), screen);
    check("and the idle screen keeps saying the sensor is offline",
          rowShows(1, "SENSOR OFFLINE"), rowText(1));
    check("the message names what to measure, not just that something failed",
          screenShowed("power 3.3V") && screenShowed("wiring TX/RX"));
    check("a scan that never finished does not block the next one", awaitingFingerLift == false);
    check("and the loss is announced once, not every second", sensorLinkReported);

    delay(6000);                 // the health check looks for it again every 5 s
    mod.deaf = false;
    checkSensorHealth();
    check("the module is found again by itself, no reboot and no reflash", sensorReady);
    check("and the glass says what came back", screenShowed("Sensor back"));
    check("a found sensor starts from a clean run",
          sensorSilentPasses == 0 && sensorLinkReported == false);

    // The link test the owner can run himself, and what it reports.
    resetAll();
    mod.deaf = true;
    testSensorLink(5, 0, "host test");
    check("a deaf module is reported as silent, not as a working sensor",
          sensorTestRounds == 5 && sensorTestAnswered == 0 && sensorTestSilent == 5);
    resetAll();
    testSensorLink(5, 0, "host test");
    check("and a healthy one is five answers out of five, so the wiring is cleared",
          sensorTestRounds == 5 && sensorTestAnswered == 5 && sensorTestSilent == 0 && sensorTestGarbled == 0);

    // The other way a perfectly wired scanner ignores everybody: the board is
    // sitting in its setup hotspot, where the loop does not run at all.
    resetAll();
    WiFiManager wm;
    configureWifiManager(wm);
    check("the setup hotspot has a hard end, so the loop gets to run again",
          stubWmConfigPortalTimeoutSec > 0 && stubWmConfigPortalTimeoutSec <= 300);
    check("and each WiFi attempt is bounded too",
          stubWmConnectTimeoutSec > 0 && stubWmConnectTimeoutSec <= 30);
  }

  printf("\n%s (%d failed)\n", failures ? "HARNESS FAILED" : "HARNESS PASSED", failures);
  return failures ? 1 : 0;
}
