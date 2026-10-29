#include <cassert>
#include <cstdint>
#include <deque>
#include <iostream>
#include <vector>
#include "../R307Compat.h"

static uint32_t nowMs = 0;
unsigned long millis() { return nowMs; }
void delay(unsigned long ms) { nowMs += static_cast<uint32_t>(ms); }

struct Plan {
  uint8_t command;
  std::vector<uint8_t> payload;
  uint32_t delayMs;
  bool corrupt;
  bool silent;
  bool wrongAddress;
};
struct Scheduled { uint32_t at; std::vector<uint8_t> bytes; };

class FakeSensor : public Stream {
 public:
  std::deque<Plan> plans;
  std::deque<Scheduled> scheduled;
  std::deque<uint8_t> rx;
  std::vector<uint8_t> tx;
  std::vector<std::vector<uint8_t>> commands;

  void plan(uint8_t cmd, std::vector<uint8_t> payload, uint32_t after = 0,
            bool corrupt = false, bool silent = false, bool wrongAddress = false) {
    plans.push_back({cmd, payload, after, corrupt, silent, wrongAddress});
  }
  void ack(uint8_t cmd) { plan(cmd, {0}); }
  void init(uint16_t capacity = 1000) {
    ack(FINGERPRINT_VERIFYPASSWORD);
    std::vector<uint8_t> parameters(17, 0);
    parameters[5] = capacity >> 8;
    parameters[6] = capacity & 0xFF;
    plan(FINGERPRINT_READSYSPARAM, parameters);
  }
  void pump() {
    while (!scheduled.empty() && static_cast<int32_t>(nowMs - scheduled.front().at) >= 0) {
      for (auto b : scheduled.front().bytes) rx.push_back(b);
      scheduled.pop_front();
    }
  }
  int available() override { pump(); return static_cast<int>(rx.size()); }
  int read() override {
    pump();
    if (rx.empty()) return -1;
    const int b = rx.front();
    rx.pop_front();
    ++nowMs; // UART and millis progress even when bytes arrive continuously
    return b;
  }
  size_t write(uint8_t b) override {
    tx.push_back(b);
    if (tx.size() < 9) return 1;
    const size_t total = 9 + (static_cast<size_t>(tx[7]) << 8) + tx[8];
    if (tx.size() != total) return 1;
    assert(tx[0] == 0xEF && tx[1] == 0x01 && tx[6] == 1);
    uint16_t sum = tx[6] + tx[7] + tx[8];
    for (size_t i = 9; i + 2 < tx.size(); ++i) sum += tx[i];
    assert(tx[total - 2] == (sum >> 8) && tx[total - 1] == (sum & 0xFF));
    commands.emplace_back(tx.begin() + 9, tx.end() - 2);
    assert(!plans.empty());
    Plan p = plans.front();
    plans.pop_front();
    assert(p.command == tx[9]);
    tx.clear();
    if (!p.silent) {
      const uint16_t len = static_cast<uint16_t>(p.payload.size() + 2);
      std::vector<uint8_t> response = {0xEF, 0x01, 0xFF, 0xFF, 0xFF,
                                       static_cast<uint8_t>(p.wrongAddress ? 0xFE : 0xFF),
                                       0x07, static_cast<uint8_t>(len >> 8), static_cast<uint8_t>(len)};
      uint16_t checksum = 7 + (len >> 8) + (len & 0xFF);
      for (auto x : p.payload) { response.push_back(x); checksum += x; }
      response.push_back(static_cast<uint8_t>(checksum >> 8));
      response.push_back(static_cast<uint8_t>((checksum & 0xFF) ^ (p.corrupt ? 1 : 0)));
      scheduled.push_back({nowMs + p.delayMs, response});
    }
    return 1;
  }
};

static void prepare(FakeSensor &s, R307Compat &reader) {
  s.init();
  assert(reader.begin(3000));
  assert(reader.capacity() == 1000);
}

static void test_capacity_and_full_range() {
  nowMs = 0;
  FakeSensor s;
  R307Compat reader(s);
  prepare(s, reader);
  s.plan(FINGERPRINT_TEMPLATECOUNT, {0, 0, 7}, 1700); // longer than Adafruit's default 1 second
  assert(reader.getCount(3000) == 7);
  s.ack(FINGERPRINT_GETIMAGE);
  s.ack(FINGERPRINT_IMAGE2TZ);
  s.plan(FINGERPRINT_HISPEEDSEARCH, {0, 1, 0x90, 0, 90}); // ID 400
  uint16_t id = 0;
  uint8_t permission = 0;
  assert(reader.search(id, permission, 1500));
  assert(id == 400 && permission == 1);
  const auto &find = s.commands.back();
  assert(find.size() == 6 && find[0] == FINGERPRINT_HISPEEDSEARCH);
  assert(find[4] == 0x03 && find[5] == 0xE8); // all 1000 slots, not 163
  assert(s.plans.empty());
}

static void test_capture_time_precedes_matching_delays() {
  nowMs = 0;
  FakeSensor s;
  R307Compat reader(s);
  prepare(s, reader);
  s.ack(FINGERPRINT_GETIMAGE);
  s.plan(FINGERPRINT_IMAGE2TZ, {0}, 1200);
  s.plan(FINGERPRINT_HISPEEDSEARCH, {0, 0, 7, 0, 50}, 800);
  uint16_t id;
  uint8_t permission;
  assert(reader.search(id, permission, 1500) && id == 7);
  assert(static_cast<uint32_t>(millis() - reader.capturedImageMillis()) >= 2000);
}

static void test_quality_and_no_finger() {
  nowMs = 0;
  FakeSensor s;
  R307Compat reader(s);
  prepare(s, reader);
  // Image capture can fail transiently even with a healthy finger. Retry once.
  s.plan(FINGERPRINT_GETIMAGE, {FINGERPRINT_IMAGEFAIL});
  s.ack(FINGERPRINT_GETIMAGE);
  s.ack(FINGERPRINT_IMAGE2TZ);
  s.plan(FINGERPRINT_HISPEEDSEARCH, {0, 0, 42, 0, 55});
  uint16_t id;
  uint8_t permission;
  assert(reader.search(id, permission, 1500) && id == 42);
  // Unregistered stays unregistered even if the person lifts during the retry.
  s.ack(FINGERPRINT_GETIMAGE);
  s.ack(FINGERPRINT_IMAGE2TZ);
  s.plan(FINGERPRINT_HISPEEDSEARCH, {FINGERPRINT_NOTFOUND});
  for (int i = 0; i < 6; ++i) s.plan(FINGERPRINT_GETIMAGE, {FINGERPRINT_NOFINGER});
  assert(!reader.search(id, permission, 1500));
  assert(reader.getLastStatus() == 0x05);
  s.plans.clear();
  s.plan(FINGERPRINT_GETIMAGE, {FINGERPRINT_NOFINGER});
  assert(reader.fingerPresent() == 0);
  s.plan(FINGERPRINT_GETIMAGE, {FINGERPRINT_IMAGEFAIL});
  assert(reader.fingerPresent() == 1);
}

static void test_fresh_capture_and_confirmation() {
  nowMs = 0;
  FakeSensor s;
  R307Compat reader(s);
  prepare(s, reader);
  s.ack(FINGERPRINT_GETIMAGE); s.ack(FINGERPRINT_IMAGE2TZ);
  assert(reader.enroll(400, 1, 30000));
  assert(s.commands.back()[1] == 1);
  // The lift check must not issue image2Tz or SEARCH between the buffers.
  s.plan(FINGERPRINT_GETIMAGE, {FINGERPRINT_NOFINGER});
  assert(reader.fingerPresent() == 0);
  s.ack(FINGERPRINT_GETIMAGE); s.ack(FINGERPRINT_IMAGE2TZ);
  s.ack(FINGERPRINT_REGMODEL); s.ack(FINGERPRINT_STORE);
  assert(reader.enroll(400, 2, 30000));
  assert(s.commands[s.commands.size() - 3][1] == 2);
  const auto &stored = s.commands.back();
  assert(stored[0] == FINGERPRINT_STORE && stored[2] == 1 && stored[3] == 0x90);
  s.ack(FINGERPRINT_GETIMAGE); s.ack(FINGERPRINT_IMAGE2TZ);
  s.plan(FINGERPRINT_HISPEEDSEARCH, {0, 1, 0x90, 0, 80});
  uint16_t id;
  uint8_t permission;
  assert(reader.search(id, permission, 1500) && id == 400);
  assert(!reader.enroll(1000, 1, 500)); // capacity is a count; last slot is 999
}

static void test_no_finger_after_capture_is_not_a_wait_timeout() {
  nowMs = 0;
  FakeSensor s;
  R307Compat reader(s);
  prepare(s, reader);
  // If the sensor loses the image during conversion, do not report that the
  // person failed to appear for the entire waiting period.
  s.ack(FINGERPRINT_GETIMAGE);
  s.plan(FINGERPRINT_IMAGE2TZ, {FINGERPRINT_NOFINGER});
  assert(!reader.enroll(5, 1, 30000));
  assert(reader.getLastStatus() == 0x06); // unclear image; prompt/retry
  // A no-finger-shaped STORE error must never lead to a blind second write.
  s.ack(FINGERPRINT_GETIMAGE); s.ack(FINGERPRINT_IMAGE2TZ); s.ack(FINGERPRINT_REGMODEL);
  s.plan(FINGERPRINT_STORE, {FINGERPRINT_NOFINGER});
  assert(!reader.enroll(5, 2, 30000));
  assert(reader.getLastStatus() == 0xFE); // sensor error, not no-finger timeout
  assert(s.plans.empty());
}

static void test_mismatch_and_ambiguous_store() {
  nowMs = 0;
  FakeSensor s;
  R307Compat reader(s);
  prepare(s, reader);
  s.ack(FINGERPRINT_GETIMAGE); s.ack(FINGERPRINT_IMAGE2TZ);
  s.plan(FINGERPRINT_REGMODEL, {FINGERPRINT_ENROLLMISMATCH});
  assert(!reader.enroll(5, 2, 1000));
  assert(reader.getLastStatus() == 0x09);
  assert(s.commands.back()[0] == FINGERPRINT_REGMODEL); // no STORE after mismatch
  s.ack(FINGERPRINT_GETIMAGE); s.ack(FINGERPRINT_IMAGE2TZ); s.ack(FINGERPRINT_REGMODEL);
  s.plan(FINGERPRINT_STORE, {}, 0, false, true);
  assert(!reader.enroll(5, 2, 1000));
  assert(reader.getLastStatus() == 0xFF);
  size_t writes = 0;
  for (const auto &c : s.commands) if (c[0] == FINGERPRINT_STORE) writes++;
  assert(writes == 1); // no blind retry of an ambiguous write
}

static void test_bad_and_late_packets() {
  nowMs = 0;
  FakeSensor s;
  R307Compat reader(s);
  prepare(s, reader);
  // First valid-looking ACK has a bad checksum. A safe GETIMAGE is retried.
  s.plan(FINGERPRINT_GETIMAGE, {0}, 0, true);
  s.plan(FINGERPRINT_GETIMAGE, {FINGERPRINT_NOFINGER});
  assert(reader.fingerPresent() == 0);
  // Both attempts receive nothing; this can never be interpreted as a lift.
  s.plan(FINGERPRINT_GETIMAGE, {}, 0, false, true);
  s.plan(FINGERPRINT_GETIMAGE, {}, 0, false, true);
  assert(reader.fingerPresent() == -1 && reader.getLastStatus() == 0xFF);
  // A late first ACK arrives during quiet-line recovery and is discarded.
  s.plan(FINGERPRINT_GETIMAGE, {0}, 2600);
  s.plan(FINGERPRINT_GETIMAGE, {FINGERPRINT_NOFINGER});
  assert(reader.fingerPresent() == 0);
  // Wrong-address replies are never accepted as a real count.
  s.plan(FINGERPRINT_TEMPLATECOUNT, {0, 0, 9}, 0, false, false, true);
  s.plan(FINGERPRINT_TEMPLATECOUNT, {0, 0, 3});
  assert(reader.getCount(1500) == 3);
}

static void test_late_boot() {
  nowMs = 0;
  FakeSensor s;
  R307Compat reader(s);
  s.plan(FINGERPRINT_VERIFYPASSWORD, {}, 0, false, true);
  s.plan(FINGERPRINT_VERIFYPASSWORD, {}, 0, false, true);
  assert(!reader.begin(400) && reader.capacity() == 0);
  s.init(512);
  assert(reader.begin(1500) && reader.capacity() == 512);
}

static void test_optional_led() {
  nowMs = 0;
  FakeSensor s;
  R307Compat reader(s);
  s.init();
  assert(reader.begin(1500));
  s.ack(FINGERPRINT_LEDON);
  assert(reader.requestLightOn());
  // A clone that refuses the plain LED-ON but accepts the aura LED layout is
  // lit by the second command - the "sensor does not light up" reader.
  s.plan(FINGERPRINT_LEDON, {1});
  s.ack(FINGERPRINT_AURALEDCONFIG);
  assert(reader.requestLightOn());
  // A reader that rejects every light layout (plain, breathing blue, steady
  // blue) still processes ordinary capture commands.
  s.plan(FINGERPRINT_LEDON, {1});
  s.plan(FINGERPRINT_AURALEDCONFIG, {1});
  s.plan(FINGERPRINT_AURALEDCONFIG, {1});
  assert(!reader.requestLightOn());
  // The light commands are always blue and either breathing forever or steady:
  // the glass must stay visibly alive, never go dark between two scans.
  assert(s.commands[s.commands.size() - 2][2] == FINGERPRINT_LED_BLUE);
  assert(s.commands[s.commands.size() - 2][1] == FINGERPRINT_LED_BREATHING);
  assert(s.commands.back()[1] == FINGERPRINT_LED_ON);
  s.plan(FINGERPRINT_GETIMAGE, {FINGERPRINT_NOFINGER});
  assert(reader.fingerPresent() == 0);
  // The handshake is a password verify: it proves the module is listening
  // without touching its memory.
  s.ack(FINGERPRINT_VERIFYPASSWORD);
  assert(reader.handshake(1200));
}

/* The door is between two employees of the same group. While the first finger
 * is still resting on the glass, the sketch must not spend a match - it asks
 * the short question instead, and a missing reply costs the short timeout, not
 * two and a half seconds. */
static void test_short_lift_poll() {
  nowMs = 0;
  FakeSensor s;
  R307Compat reader(s);
  prepare(s, reader);
  s.plan(FINGERPRINT_GETIMAGE, {FINGERPRINT_NOFINGER});
  assert(reader.fingerPresent(220) == 0);
  // A finger (or an unclear press) on the glass reports as "something there".
  s.ack(FINGERPRINT_GETIMAGE);
  assert(reader.fingerPresent(220) == 1);
  s.plan(FINGERPRINT_GETIMAGE, {FINGERPRINT_IMAGEMESS});
  assert(reader.fingerPresent(220) == 1);
  // A silent reader cannot hold the next employee for 2.5 s either: the short
  // poll gives up in roughly the short timeout, and the only extra cost is one
  // quiet-line drain after the lost frame.
  nowMs = 0;
  s.plan(FINGERPRINT_GETIMAGE, {}, 0, false, true);
  s.plan(FINGERPRINT_GETIMAGE, {}, 0, false, true);
  assert(reader.fingerPresent(220) == -1);
  assert(nowMs < 1500);
}

/* The plain LED-ON is not the only way to light an R307 clone: the aura layout
 * is tried second, and a reader that answers either one is treated as lit. */
static void test_light_has_two_commands() {
  nowMs = 0;
  FakeSensor s;
  R307Compat reader(s);
  prepare(s, reader);
  s.plan(FINGERPRINT_LEDON, {1});          // plain command refused
  s.ack(FINGERPRINT_AURALEDCONFIG);        // clone answers the aura layout
  assert(reader.requestLightOn(300));
  assert(s.commands.back()[0] == FINGERPRINT_AURALEDCONFIG);
  s.ack(FINGERPRINT_VERIFYPASSWORD);
  assert(reader.handshake(300));
}

/* An enrollment placement must be able to say WHY it saw nothing: the counters
 * separate "nobody touched the glass" from "the image was unclear". */
static void test_placement_answer_counters() {
  nowMs = 0;
  FakeSensor s;
  R307Compat reader(s);
  prepare(s, reader);
  for (int i = 0; i < 20; ++i) s.plan(FINGERPRINT_GETIMAGE, {FINGERPRINT_NOFINGER});
  assert(!reader.enroll(7, 1, 200));
  assert(reader.emptyGlassInLastWait() >= 2);
  assert(reader.imagesSeenInLastWait() == 0);
  assert(reader.unclearInLastWait() == 0);
  nowMs = 0;
  s.plans.clear();   // drop the empty-glass replies the first wait did not use
  s.plan(FINGERPRINT_GETIMAGE, {FINGERPRINT_IMAGEFAIL});
  assert(!reader.enroll(7, 1, 200));
  assert(reader.unclearInLastWait() == 1);
  assert(reader.emptyGlassInLastWait() == 0);
}

int main() {
  test_optional_led();
  test_light_has_two_commands();
  test_short_lift_poll();
  test_placement_answer_counters();
  test_capacity_and_full_range();
  test_capture_time_precedes_matching_delays();
  test_quality_and_no_finger();
  test_fresh_capture_and_confirmation();
  test_no_finger_after_capture_is_not_a_wait_timeout();
  test_mismatch_and_ambiguous_store();
  test_bad_and_late_packets();
  test_late_boot();
  std::cout << "R307 transport tests passed: timeouts, full search range, quality, lift, short lift poll, two light commands, wait counters, capture, mismatch, late/bad packets and recovery\n";
}
