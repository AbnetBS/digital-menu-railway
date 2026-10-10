// PC simulation of the FANA attendance device. It compiles the REAL sketch
// (fana_attendance_esp32.ino) and the REAL Biovo1020A library against small
// stand-ins for the ESP32 core, then plays the situations from the cafe:
// fast verify, finger left on the sensor, unregistered finger, automatic and
// manual enrollment (including the status 6 / status 7 cases), no finger at
// all, WiFi loss and a module that ignores the capture-window command.
//
// Build & run:  ./run_tests.sh      (needs g++ and git for ArduinoJson)
#include <Arduino.h>
#include "../fana_attendance_esp32.ino"

#include <cassert>
#include <iostream>

/* ── globals required by the stubs ─────────────────────────────────────── */
uint64_t g_nowMs = 0;
int g_pinState[64] = {0};
ConsoleSerial Serial;
EspClass ESP;
TwoWire Wire;
WiFiClass WiFi;
LittleFSClass LittleFS;
TaskFunction_t g_netTaskFn = nullptr;
SimWire *g_sensorWire = nullptr;
bool g_wifiUp = true;
std::deque<char> g_sseFeed;
std::string g_screen;
std::vector<std::pair<uint64_t, std::string>> g_screens;
std::map<std::string, std::string> g_files;
FakeServerFn g_fakeServer;
int g_newConnections = 0;
long long g_epochAtZero = 1791600000LL;   // 2026-10-10, "NTP synced"
time_t sim_time(time_t *out) {
  time_t t = g_epochAtZero ? (time_t)(g_epochAtZero + (long long)(g_nowMs / 1000)) : (time_t)(g_nowMs / 1000);
  if (out) *out = t;
  return t;
}

/* ── simulated FPC1020A (official 0xF5 protocol) ───────────────────────── */
struct SimModule : SimWire {
  std::map<uint16_t, int> db;      // id -> finger identity
  int fingerOn = 0;                // finger currently on the glass (0 = none)
  int landingReads = 0;            // next N captures see a finger still landing
  bool support2E = true;
  uint8_t window = 0;              // factory default: wait forever
  int unitMs = 250;                // one capture-window unit (T0)
  bool rejectDuplicates = true;
  bool busy = false;
  uint8_t cmd = 0, p1 = 0, p2 = 0, p3 = 0;
  uint64_t startedAt = 0, replyAt = 0;
  bool replyPending = false;
  uint8_t reply[8];
  int enrollId = -1, enrollIdentity = 0, enrollCount = 0;
  std::vector<uint8_t> rx;
  int ignoredWhileBusy = 0;
  int captureCommands = 0;

  void sendLater(uint8_t c, uint8_t q1, uint8_t q2, uint8_t q3, uint32_t afterMs) {
    reply[0] = 0xF5; reply[1] = c; reply[2] = q1; reply[3] = q2; reply[4] = q3; reply[5] = 0;
    reply[6] = reply[1] ^ reply[2] ^ reply[3] ^ reply[4] ^ reply[5];
    reply[7] = 0xF5;
    replyAt = g_nowMs + afterMs;
    replyPending = true;
  }
  void hostWrote(const uint8_t *buf, size_t n) override {
    rx.insert(rx.end(), buf, buf + n);
    while (rx.size() >= 8) {
      if (rx[0] != 0xF5) { rx.erase(rx.begin()); continue; }
      uint8_t f[8];
      std::copy(rx.begin(), rx.begin() + 8, f);
      rx.erase(rx.begin(), rx.begin() + 8);
      if (f[7] != 0xF5 || f[6] != (uint8_t)(f[1] ^ f[2] ^ f[3] ^ f[4] ^ f[5])) continue;
      if (busy || replyPending) { ignoredWhileBusy++; continue; }   // a busy module drops commands
      start(f[1], f[2], f[3], f[4]);
    }
  }
  void start(uint8_t c, uint8_t a, uint8_t b, uint8_t d) {
    cmd = c; p1 = a; p2 = b; p3 = d;
    uint16_t id = ((uint16_t)a << 8) | b;
    switch (c) {
      case 0x01: case 0x02: case 0x03: case 0x0C:
        busy = true; startedAt = g_nowMs; captureCommands++;
        break;
      case 0x09: sendLater(c, db.size() >> 8, db.size() & 0xff, 0x00, 5); busy = true; break;
      case 0x04: { bool had = db.erase(id) > 0; sendLater(c, 0, 0, had ? 0x00 : 0x05, 5); busy = true; break; }
      case 0x05: db.clear(); sendLater(c, 0, 0, 0x00, 5); busy = true; break;
      case 0x2E:
        if (!support2E) break;                            // old firmware: silence
        if (d == 1) sendLater(c, 0, window, 0x00, 5);
        else { window = b; sendLater(c, 0, window, 0x00, 5); }
        busy = true;
        break;
      default: sendLater(c, 0, 0, 0x01, 5); busy = true;
    }
  }
  void capture() {   // finger is on the glass: answer the capture command after 300 ms
    uint16_t id = ((uint16_t)p1 << 8) | p2;
    bool landing = landingReads > 0;
    if (landing) landingReads--;
    if (cmd == 0x0C) {
      if (landing) { sendLater(cmd, 0, 0, 0x05, 300); return; }
      for (auto &kv : db)
        if (kv.second == fingerOn) { sendLater(cmd, kv.first >> 8, kv.first & 0xff, 1, 300); return; }
      sendLater(cmd, 0, 0, 0x05, 300);
      return;
    }
    if (cmd == 0x01) {
      if (db.count(id)) { sendLater(cmd, 0, 0, 0x06, 50); return; }   // ID occupied
      if (landing) { sendLater(cmd, 0, 0, 0x01, 300); return; }
      enrollId = id; enrollIdentity = fingerOn; enrollCount = 1;
      sendLater(cmd, 0, 0, 0x00, 300);
      return;
    }
    if (landing || enrollId != id || fingerOn != enrollIdentity) { sendLater(cmd, 0, 0, 0x01, 300); return; }
    if (cmd == 0x02) { enrollCount++; sendLater(cmd, 0, 0, 0x00, 300); return; }
    // 0x03
    if (rejectDuplicates)
      for (auto &kv : db)
        if (kv.second == enrollIdentity) { sendLater(cmd, kv.first >> 8, kv.first & 0xff, 0x07, 300); enrollId = -1; return; }
    db[id] = enrollIdentity;
    enrollId = -1;
    sendLater(cmd, 0, 0, 0x00, 300);
  }
  void tick() {
    if (replyPending) {
      if (g_nowMs >= replyAt) {
        for (int i = 0; i < 8; i++) toHost.push_back(reply[i]);
        replyPending = false;
        busy = false;
      }
      return;
    }
    if (!busy) return;
    if (fingerOn) { capture(); return; }
    if (window > 0 && g_nowMs - startedAt >= (uint64_t)window * unitMs) sendLater(cmd, 0, 0, 0x08, 0);
  }
};
SimModule sim;

/* ── fake website ──────────────────────────────────────────────────────── */
struct Job { int jobId, memberId; std::string name; int fid; std::string status; };
struct FakeSite {
  std::map<int, std::string> mapping;     // fid -> name
  std::map<std::string, int> members = {{"Abebe", 4}, {"Kebede", 5}, {"Mulu", 6}};
  std::vector<Job> jobs;
  std::vector<std::string> clockBodies, mappingBodies, failBodies;
  std::map<int, int> scans;               // fid -> count (IN then already)
  bool down = false;
  int handle(const std::string &method, const std::string &url, const std::string &body,
             const std::map<std::string, std::string> &, std::string &out) {
    if (down) return -1;
    DynamicJsonDocument in(1024);
    if (!body.empty()) deserializeJson(in, body);
    if (url.find("/api/attendance/events") != std::string::npos) return 200;
    if (url.find("/api/attendance/clock") != std::string::npos) {
      clockBodies.push_back(body);
      int fid = in["fingerprintId"] | 0;
      if (!mapping.count(fid)) { out = "{\"error\":\"Fingerprint not enrolled\",\"status\":\"not_found\"}"; return 404; }
      bool first = scans[fid]++ == 0;
      out = std::string("{\"success\":true,\"memberName\":\"") + mapping[fid] + "\",\"action\":\"" +
            (first ? "clock_in" : "already_registered") + "\",\"oled\":{\"line2\":\"" +
            (first ? "IN 08:05" : "Already IN 08:05") + "\",\"line3\":\"On Time\"}}";
      return 200;
    }
    if (url.find("/api/attendance/mappings") != std::string::npos && method == "GET") {
      out = "{\"count\":" + std::to_string(mapping.size()) + ",\"mappings\":[";
      bool firstItem = true;
      for (auto &kv : mapping) {   // the big array the device must ignore
        out += std::string(firstItem ? "" : ",") + "{\"fingerprintId\":" + std::to_string(kv.first) +
               ",\"memberName\":\"" + kv.second + "\",\"staffName\":\"" + kv.second + "\",\"fingerName\":\"Right Index\"}";
        firstItem = false;
      }
      out += "],\"simpleMap\":{";
      firstItem = true;
      for (auto &kv : mapping) {
        out += std::string(firstItem ? "" : ",") + "\"" + std::to_string(kv.first) + "\":\"" + kv.second + "\"";
        firstItem = false;
      }
      out += "}}";
      return 200;
    }
    if (url.find("/api/attendance/mappings") != std::string::npos) {
      mappingBodies.push_back(body);
      int fid = in["fingerprintId"] | 0;
      int jobId = in["jobId"] | 0;
      std::string name = in["memberName"] | "";
      mapping[fid] = name;
      for (auto &j : jobs) if (j.jobId == jobId) j.status = "done";
      out = "{\"success\":true,\"message\":\"Fingerprint Added\"}";
      return 200;
    }
    if (url.find("/api/attendance/biometrics?pending=1") != std::string::npos) {
      out = "{\"count\":0,\"jobs\":[";
      bool firstItem = true;
      int n = 0;
      for (auto &j : jobs) {
        if (j.status != "pending") continue;
        out += std::string(firstItem ? "" : ",") + "{\"jobId\":" + std::to_string(j.jobId) + ",\"memberId\":" +
               std::to_string(j.memberId) + ",\"memberName\":\"" + j.name + "\",\"fingerprintId\":" + std::to_string(j.fid) + "}";
        firstItem = false;
        n++;
      }
      out += "]}";
      out.replace(9, 1, std::to_string(n));
      return 200;
    }
    if (url.find("/api/attendance/biometrics") != std::string::npos && method == "POST") {
      failBodies.push_back(body);
      int jobId = in["jobId"] | 0;
      for (auto &j : jobs) if (j.jobId == jobId) j.status = "failed";
      out = "{\"success\":true}";
      return 200;
    }
    out = "{\"error\":\"not found\"}";
    return 404;
  }
  void addJob(int jobId, const std::string &name, int fid) {
    jobs.push_back({jobId, members[name], name, fid, "pending"});
    for (char c : std::string("data: refresh\n\n")) g_sseFeed.push_back(c);   // real-time push
  }
};
FakeSite site;

/* ── a person standing at the device ───────────────────────────────────── */
struct Person {
  int finger = 0;            // identity of the finger they use
  bool followsScreen = false;
  uint64_t activeFrom = 0;   // ignores the screen before this time
  int desired = 0;
  uint64_t changeAt = 0;
  int lingerMs = 350;        // how long the finger stays on after the last step
  void tick() {
    if (!followsScreen || g_nowMs < activeFrom) return;
    int want = 0;                       // only the enrollment screens ("Step x of 6") ask for the finger
    bool enrolling = g_screen.find("Step ") != std::string::npos;
    if (!enrolling) want = 0;
    else if (g_screen.find("LIFT") != std::string::npos || g_screen.find("AGAIN|") != std::string::npos) want = 0;
    else if (g_screen.find("PLACE") != std::string::npos || g_screen.find("HOLD") != std::string::npos ||
             g_screen.find("FLAT") != std::string::npos) want = finger;
    else want = sim.fingerOn;
    if (want != desired) {       // human reaction time; slow to lift once it is all done
      desired = want;
      changeAt = g_nowMs + (want == 0 && !enrolling ? lingerMs : 350);
    }
    if (sim.fingerOn != desired && g_nowMs >= changeAt) sim.fingerOn = desired;
  }
};
Person person;

/* ── simulation driver ─────────────────────────────────────────────────── */
static bool inNet = false;
static std::vector<std::pair<uint64_t, int>> fingerPlan;   // (time, identity) changes
void simTick() {
  for (auto &p : fingerPlan) if (p.first == g_nowMs) sim.fingerOn = p.second;
  sim.tick();
  person.tick();
  if (!inNet && g_netTaskFn && g_nowMs % 20 == 0) {   // the second core
    inNet = true;
    netStep();
    inNet = false;
  }
}
void runUntil(uint64_t t) {
  while (g_nowMs < t) {
    loop();
    if (g_nowMs < t) delay(1);
  }
}
void runFor(uint64_t ms) { runUntil(g_nowMs + ms); }
void fingerAt(uint64_t at, int identity, uint64_t holdMs) {
  fingerPlan.push_back({at, identity});
  fingerPlan.push_back({at + holdMs, 0});
}
uint64_t firstScreenAfter(uint64_t t, const std::string &text) {
  for (auto &s : g_screens) if (s.first >= t && s.second.find(text) != std::string::npos) return s.first;
  return 0;
}
int countScreens(uint64_t from, uint64_t to, const std::string &text) {
  int n = 0;
  for (auto &s : g_screens) if (s.first >= from && s.first <= to && s.second.find(text) != std::string::npos) n++;
  return n;
}
int clockPostsFor(int fid) {
  int n = 0;
  for (auto &b : site.clockBodies) if (b.find("\"fingerprintId\":" + std::to_string(fid) + ",") != std::string::npos) n++;
  return n;
}

static int failures = 0;
#define CHECK(cond, msg)                                                       \
  do {                                                                         \
    if (cond) printf("  ok   %s\n", msg);                                      \
    else { printf("  FAIL %s  (line %d)\n", msg, __LINE__); failures++; }      \
  } while (0)

const int FINGER_ABEBE = 101, FINGER_KEBEDE = 102, FINGER_STRANGER = 103;

void boot() {
  g_sensorWire = &sim;
  g_fakeServer = [](const std::string &m, const std::string &u, const std::string &b,
                    const std::map<std::string, std::string> &h, std::string &o) { return site.handle(m, u, b, h, o); };
  setup();
  runFor(1500);   // let the net task connect the stream and load names
}

void dumpScreens(uint64_t from) {
  for (auto &s : g_screens) if (s.first >= from) printf("     %8llu  %s\n", (unsigned long long)s.first, s.second.c_str());
}

/* ── scenarios ─────────────────────────────────────────────────────────── */

void scenario_verify_fast() {
  site.mapping = {{7, "Abebe"}, {8, "Kebede"}};
  sim.db = {{7, FINGER_ABEBE}, {8, FINGER_KEBEDE}};
  boot();
  CHECK(sim.window == CAPTURE_WINDOW_UNITS, "boot sets the sensor capture window (fast mode)");
  CHECK(captureWindowKnown, "sketch knows the window, so it never sends while the sensor is busy");
  runFor(5000);
  CHECK(sim.ignoredWhileBusy == 0, "idle scanning never sends a command to a busy sensor");
  uint64_t t0 = g_nowMs + 337;   // a random moment inside a capture window
  fingerAt(t0, FINGER_ABEBE, 1200);
  runFor(6000);
  uint64_t shown = firstScreenAfter(t0, "VERIFIED");
  printf("     VERIFIED shown %llu ms after the finger touched\n", (unsigned long long)(shown - t0));
  CHECK(shown && shown - t0 <= 1000, "VERIFIED + name on the OLED within 1 s of touching");
  CHECK(firstScreenAfter(t0, "Abebe") == shown, "the name is on the first screen (from the local cache)");
  uint64_t result = firstScreenAfter(t0, "IN 08:05");
  CHECK(result && result - t0 <= 2500, "server result (IN 08:05) on the OLED within 2.5 s");
  CHECK(clockPostsFor(7) == 1, "exactly one clock-in posted");
  CHECK(site.clockBodies.size() && site.clockBodies[0].find("\"scannedAt\":") != std::string::npos, "the post carries the real scan time");
  int connectionsBefore = g_newConnections;
  uint64_t t1 = g_nowMs + 100;
  fingerAt(t1, FINGER_KEBEDE, 1000);
  runFor(5000);
  CHECK(clockPostsFor(8) == 1, "next person (Kebede) recorded too");
  CHECK(g_newConnections == connectionsBefore, "second scan reused the open HTTPS connection (no new TLS handshake)");
}

void scenario_finger_stays() {
  site.mapping = {{7, "Abebe"}};
  sim.db = {{7, FINGER_ABEBE}};
  boot();
  uint64_t t0 = g_nowMs + 200;
  fingerAt(t0, FINGER_ABEBE, 7000);   // leaves the finger for 7 s
  runFor(9000);
  CHECK(clockPostsFor(7) == 1, "finger left on the sensor for 7 s = ONE clock event");
}

void scenario_landing_then_match() {
  site.mapping = {{7, "Abebe"}};
  sim.db = {{7, FINGER_ABEBE}};
  boot();
  uint64_t t0 = g_nowMs + 150;
  fingerPlan.push_back({t0 - 1, 0});
  sim.landingReads = 1;   // first image catches the finger while it lands
  fingerAt(t0, FINGER_ABEBE, 1500);
  runFor(4000);
  CHECK(countScreens(t0, g_nowMs, "NOT REGISTERED") == 0, "a finger that is still landing is NOT called 'not registered'");
  uint64_t shown = firstScreenAfter(t0, "VERIFIED");
  CHECK(shown && shown - t0 <= 1600, "it is verified on the silent re-read (within 1.6 s)");
  CHECK(clockPostsFor(7) == 1, "and recorded once");
}

void scenario_unregistered() {
  site.mapping = {{7, "Abebe"}};
  sim.db = {{7, FINGER_ABEBE}};
  boot();
  uint64_t t0 = g_nowMs + 100;
  fingerAt(t0, FINGER_STRANGER, 6000);
  runFor(8000);
  uint64_t shown = firstScreenAfter(t0, "NOT REGISTERED");
  CHECK(shown && shown - t0 <= 2000, "unknown finger: NOT REGISTERED within 2 s");
  CHECK(countScreens(t0, g_nowMs, "NOT REGISTERED") == 1, "said once, not repeated while the finger stays");
  CHECK(site.clockBodies.empty(), "nothing is posted for an unknown finger");
}

void scenario_auto_enroll_waits_for_finger() {
  site.mapping = {{7, "Abebe"}};
  sim.db = {{7, FINGER_ABEBE}};
  boot();
  uint64_t t0 = g_nowMs;
  site.addJob(11, "Kebede", 12);
  person.finger = FINGER_KEBEDE;
  person.followsScreen = true;
  person.activeFrom = t0 + 10000;   // walks up 10 s later
  person.lingerMs = 3000;           // and leaves the finger there 3 s after it is done
  runFor(60000);
  CHECK(sim.db.count(12) && sim.db[12] == FINGER_KEBEDE, "finger stored on the sensor under ID 12");
  CHECK(site.mappingBodies.size() == 1, "mapping sent to the website once");
  CHECK(site.mappingBodies.size() && site.mappingBodies[0].find("\"memberId\":5") != std::string::npos &&
            site.mappingBodies[0].find("\"jobId\":11") != std::string::npos,
        "mapping carries memberId + jobId (no name guessing)");
  CHECK(firstScreenAfter(t0, "FINGERPRINT ADDED") > 0, "OLED says FINGERPRINT ADDED");
  CHECK(countScreens(t0, g_nowMs, "FAILED") == 0, "10 s without a finger did not fail anything");
  CHECK(countScreens(t0, g_nowMs, "FLAT") == 0, "no 'bad image' tries were counted while waiting");
  CHECK(firstScreenAfter(t0, "Step 5 of 6") > 0, "OLED shows the step progress (Step x of 6)");
  uint64_t done = firstScreenAfter(t0, "FINGERPRINT ADDED");
  printf("     enrollment finished %llu s after the person started\n", (unsigned long long)((done - person.activeFrom) / 1000));
  CHECK(clockPostsFor(12) == 0, "the finger still on the sensor after enrolling is NOT clocked in");
  CHECK(countScreens(done, done + 4000, "VERIFIED") == 0, "FINGERPRINT ADDED stays readable (not overwritten)");
  // the new finger works right away
  person.followsScreen = false;
  sim.fingerOn = 0;
  runFor(7000);
  uint64_t t1 = g_nowMs + 50;
  fingerAt(t1, FINGER_KEBEDE, 1000);
  runFor(4000);
  CHECK(clockPostsFor(12) == 1, "Kebede can clock in immediately after enrolling");
}

void scenario_auto_enroll_id_occupied() {
  site.mapping = {{7, "Abebe"}};
  sim.db = {{7, FINGER_ABEBE}, {12, 999}};   // leftover template at ID 12 -> status 6 before
  boot();
  uint64_t t0 = g_nowMs;
  site.addJob(11, "Kebede", 12);
  person.finger = FINGER_KEBEDE;
  person.followsScreen = true;
  person.activeFrom = t0 + 2000;
  runFor(45000);
  CHECK(sim.db.count(12) && sim.db[12] == FINGER_KEBEDE, "leftover at ID 12 (status 6) replaced by the new finger");
  CHECK(firstScreenAfter(t0, "FINGERPRINT ADDED") > 0, "enrollment succeeded");
}

void scenario_auto_enroll_duplicate_orphan() {
  site.mapping = {{7, "Abebe"}};
  sim.db = {{7, FINGER_ABEBE}, {30, FINGER_KEBEDE}};   // Kebede's finger saved earlier as ID 30, never mapped
  boot();
  uint64_t t0 = g_nowMs;
  site.addJob(11, "Kebede", 12);
  person.finger = FINGER_KEBEDE;
  person.followsScreen = true;
  person.activeFrom = t0 + 2000;
  runFor(45000);
  CHECK(!sim.db.count(30), "unmapped old copy (ID 30) removed - no duplicate finger on the sensor");
  CHECK(sim.db.count(12) && sim.db[12] == FINGER_KEBEDE, "finger stored under the job's ID 12");
  CHECK(firstScreenAfter(t0, "FINGERPRINT ADDED") > 0, "enrollment succeeded");
}

void scenario_auto_enroll_finger_of_someone_else() {
  site.mapping = {{7, "Abebe"}};
  sim.db = {{7, FINGER_ABEBE}};
  boot();
  uint64_t t0 = g_nowMs;
  site.addJob(11, "Kebede", 12);
  person.finger = FINGER_ABEBE;     // Abebe tries to register his own finger as Kebede
  person.followsScreen = true;
  person.activeFrom = t0 + 2000;
  runFor(20000);
  CHECK(!sim.db.count(12), "nothing stored under Kebede's ID");
  CHECK(firstScreenAfter(t0, "by Abebe") > 0, "OLED: Finger already used by Abebe");
  CHECK(site.failBodies.size() == 1 && site.failBodies[0].find("device_failed") != std::string::npos,
        "the website is told the job failed (admin sees it at once)");
  CHECK(site.mappingBodies.empty(), "no wrong mapping was sent");
}

void scenario_auto_enroll_nobody_comes() {
  site.mapping = {{7, "Abebe"}};
  sim.db = {{7, FINGER_ABEBE}};
  boot();
  uint64_t t0 = g_nowMs;
  site.addJob(11, "Kebede", 12);
  runFor(40000);
  uint64_t failed = firstScreenAfter(t0, "No finger - timed out");
  CHECK(failed > 0 && failed - t0 < 32000, "no finger at all: clear 'timed out' message, never stuck");
  CHECK(site.failBodies.size() == 1, "website told the job failed");
  runFor(8000);
  CHECK(site.jobs[0].status == "failed", "the job is not picked up again in a loop");
  uint64_t t1 = g_nowMs + 50;
  fingerAt(t1, FINGER_ABEBE, 1000);
  runFor(4000);
  CHECK(clockPostsFor(7) == 1, "normal scanning works again afterwards");
}

void scenario_offline_then_sync() {
  site.mapping = {{7, "Abebe"}};
  sim.db = {{7, FINGER_ABEBE}};
  boot();
  g_wifiUp = false;
  runFor(500);
  uint64_t t0 = g_nowMs + 100;
  uint32_t scanEpoch = (uint32_t)(g_epochAtZero + (long long)(t0 / 1000));
  fingerAt(t0, FINGER_ABEBE, 800);
  runFor(3000);
  CHECK(firstScreenAfter(t0, "VERIFIED") > 0, "offline: still VERIFIED instantly");
  CHECK(firstScreenAfter(t0, "SAVED") > 0, "offline: OLED says saved");
  CHECK(g_files.count("/queue.json") && offlineCount == 1, "scan saved to the offline file");
  runFor(60000);   // a minute later the WiFi returns
  g_wifiUp = true;
  runFor(3000);
  CHECK(clockPostsFor(7) == 1, "saved scan sent when WiFi is back");
  bool exact = false;
  if (!site.clockBodies.empty()) {
    DynamicJsonDocument d(256);
    deserializeJson(d, site.clockBodies.back());
    uint32_t sent = d["scannedAt"].as<uint32_t>();
    exact = sent >= scanEpoch && sent <= scanEpoch + 1;
    printf("     scanned at %u, sent with scannedAt %u\n", scanEpoch, sent);
  }
  CHECK(exact, "it carries the time of the scan, not the time of the sync");
  CHECK(offlineCount == 0 && !g_files.count("/queue.json"), "offline file emptied");
}

void scenario_offline_before_clock_sync() {
  g_epochAtZero = 0;   // booted without internet: no NTP time yet
  site.mapping = {{7, "Abebe"}};
  sim.db = {{7, FINGER_ABEBE}};
  g_wifiUp = false;
  boot();
  uint64_t t0 = g_nowMs + 100;
  fingerAt(t0, FINGER_ABEBE, 800);
  runFor(3000);
  runFor(120000);
  g_epochAtZero = 1791600000LL;    // NTP arrives with the WiFi
  g_wifiUp = true;
  runFor(3000);
  bool exact = false;
  if (!site.clockBodies.empty()) {
    DynamicJsonDocument d(256);
    deserializeJson(d, site.clockBodies.back());
    uint32_t sent = d["scannedAt"].as<uint32_t>();
    uint32_t truth = (uint32_t)(g_epochAtZero + (long long)(t0 / 1000));
    exact = sent + 2 >= truth && sent <= truth + 2;
    printf("     true scan time %u, sent %u\n", truth, sent);
  }
  CHECK(exact, "scan saved before NTP sync still gets its real time back");
}

void scenario_server_404_not_queued() {
  site.mapping = {};                 // finger on the sensor, but not mapped on the website
  sim.db = {{7, FINGER_ABEBE}};
  boot();
  uint64_t t0 = g_nowMs + 100;
  fingerAt(t0, FINGER_ABEBE, 800);
  runFor(4000);
  CHECK(firstScreenAfter(t0, "NOT ADDED") > 0, "OLED explains the ID is not mapped on the website");
  CHECK(!g_files.count("/queue.json"), "a 404 is NOT put in the offline queue (no endless retries)");
  runFor(40000);
  CHECK(clockPostsFor(7) == 1, "and never re-sent");
}

void scenario_legacy_module() {
  sim.support2E = false;             // module ignores 0x2E and waits forever
  site.mapping = {{7, "Abebe"}};
  sim.db = {{7, FINGER_ABEBE}};
  boot();
  CHECK(!captureWindowKnown, "sketch notices the module has no capture-window command");
  uint64_t t0 = g_nowMs + 700;
  fingerAt(t0, FINGER_ABEBE, 1200);
  runFor(5000);
  CHECK(clockPostsFor(7) == 1, "legacy module: scan still verified and recorded");
  uint64_t shown = firstScreenAfter(t0, "VERIFIED");
  CHECK(shown && shown - t0 <= 1000, "legacy module: VERIFIED within 1 s");
  uint64_t t1 = g_nowMs;
  site.addJob(11, "Kebede", 12);
  person.finger = FINGER_KEBEDE;
  person.followsScreen = true;
  person.activeFrom = t1 + 3000;
  runFor(60000);
  CHECK(sim.db.count(12) && sim.db[12] == FINGER_KEBEDE, "legacy module: automatic enrollment works");
  CHECK(firstScreenAfter(t1, "FINGERPRINT ADDED") > 0, "legacy module: FINGERPRINT ADDED");
}

void scenario_manual_enroll() {
  site.mapping = {{7, "Abebe"}};
  sim.db = {{7, FINGER_ABEBE}};
  boot();
  uint64_t t0 = g_nowMs;
  person.finger = FINGER_KEBEDE;
  person.followsScreen = true;
  person.activeFrom = t0 + 3000;
  Serial.input = "enroll 40\n";
  runFor(50000);
  CHECK(sim.db.count(40) && sim.db[40] == FINGER_KEBEDE, "Serial 'enroll 40' stores the finger as ID 40");
  CHECK(Serial.log.find("Stored as ID 40") != std::string::npos, "Serial tells the owner to map ID 40 in admin");
  CHECK(firstScreenAfter(t0, "STORED") > 0, "OLED shows STORED / ID 40");
  CHECK(site.mappingBodies.empty() && site.failBodies.empty(), "manual enrollment sends nothing by itself");
}

void scenario_manual_enroll_refuses_mapped_id() {
  site.mapping = {{7, "Abebe"}};
  sim.db = {{7, FINGER_ABEBE}};
  boot();
  int before = sim.captureCommands;
  Serial.input = "enroll 7\n";
  runFor(3000);
  CHECK(Serial.log.find("already belongs to Abebe") != std::string::npos, "'enroll 7' refused: ID 7 belongs to Abebe");
  CHECK(sim.db[7] == FINGER_ABEBE, "Abebe's finger untouched");
  (void)before;
}

void scenario_many_names() {
  site.mapping.clear();
  for (int i = 1; i <= 150; i++) site.mapping[i] = "Staff Member " + std::to_string(i);
  sim.db = {{150, FINGER_ABEBE}};
  boot();
  CHECK(mappingCount() == 150, "150 fingerprint names load (old 4 KB buffer overflowed)");
  uint64_t t0 = g_nowMs + 100;
  fingerAt(t0, FINGER_ABEBE, 800);
  runFor(3000);
  CHECK(firstScreenAfter(t0, "Staff Member 150") > 0, "the right name appears instantly");
}

int main(int argc, char **argv) {
  std::string which = argc > 1 ? argv[1] : "";
  struct { const char *name; void (*fn)(); } all[] = {
    {"verify_fast", scenario_verify_fast},
    {"finger_stays", scenario_finger_stays},
    {"landing_then_match", scenario_landing_then_match},
    {"unregistered", scenario_unregistered},
    {"auto_enroll_waits_for_finger", scenario_auto_enroll_waits_for_finger},
    {"auto_enroll_id_occupied", scenario_auto_enroll_id_occupied},
    {"auto_enroll_duplicate_orphan", scenario_auto_enroll_duplicate_orphan},
    {"auto_enroll_finger_of_someone_else", scenario_auto_enroll_finger_of_someone_else},
    {"auto_enroll_nobody_comes", scenario_auto_enroll_nobody_comes},
    {"offline_then_sync", scenario_offline_then_sync},
    {"offline_before_clock_sync", scenario_offline_before_clock_sync},
    {"server_404_not_queued", scenario_server_404_not_queued},
    {"legacy_module", scenario_legacy_module},
    {"manual_enroll", scenario_manual_enroll},
    {"manual_enroll_refuses_mapped_id", scenario_manual_enroll_refuses_mapped_id},
    {"many_names", scenario_many_names},
  };
  if (which == "--list") {
    for (auto &s : all) printf("%s\n", s.name);
    return 0;
  }
  for (auto &s : all) {
    if (which != s.name) continue;
    printf("[%s]\n", s.name);
    s.fn();
    if (failures && getenv("SHOW_SCREENS")) dumpScreens(0);
    if (failures && getenv("SHOW_SERIAL")) printf("%s\n", Serial.log.c_str());
    return failures ? 1 : 0;
  }
  fprintf(stderr, "unknown scenario %s\n", which.c_str());
  return 2;
}
