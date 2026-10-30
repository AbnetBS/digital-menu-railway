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
  // Other readers return NOMATCH from search; it is also a refusal, not an
  // enrollment mismatch. A lift during retry must not erase the warning.
  s.ack(FINGERPRINT_GETIMAGE); s.ack(FINGERPRINT_IMAGE2TZ);
  s.plan(FINGERPRINT_HISPEEDSEARCH, {FINGERPRINT_NOMATCH});
  for (int i = 0; i < 6; ++i) s.plan(FINGERPRINT_GETIMAGE, {FINGERPRINT_NOFINGER});
  assert(!reader.search(id, permission, 1500) && reader.getLastStatus() == 0x05);
  s.plans.clear();
  // Image was captured but disappeared before conversion: tell the employee
  // to retry, rather than treating it as untouched glass.
  s.ack(FINGERPRINT_GETIMAGE);
  s.plan(FINGERPRINT_IMAGE2TZ, {FINGERPRINT_NOFINGER});
  for (int i = 0; i < 6; ++i) s.plan(FINGERPRINT_GETIMAGE, {FINGERPRINT_NOFINGER});
  assert(!reader.search(id, permission, 1500) && reader.getLastStatus() == 0x06);
  s.plans.clear();
  s.ack(FINGERPRINT_GETIMAGE); s.ack(FINGERPRINT_IMAGE2TZ);
  s.plan(FINGERPRINT_HISPEEDSEARCH, {FINGERPRINT_NOFINGER});
  for (int i = 0; i < 6; ++i) s.plan(FINGERPRINT_GETIMAGE, {FINGERPRINT_NOFINGER});
  assert(!reader.search(id, permission, 1500) && reader.getLastStatus() == 0x06);
  s.plans.clear();
  // Nobody touched the reader: do not invent a rejection.
  for (int i = 0; i < 30; ++i) s.plan(FINGERPRINT_GETIMAGE, {FINGERPRINT_NOFINGER});
  assert(!reader.search(id, permission, 200) && reader.getLastStatus() == 0x08);
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

/* The glass must stay lit (owner, Oct 2026: "the blue light must be continuous
 * and blinking non-stop"). Three layouts exist and are remembered, so a normal
 * re-assert costs ONE frame - and a light request can never damage a scan. */
static void test_optional_led() {
  // 1. Plain LEDON is tried first and remembered; a re-assert is one frame.
  nowMs = 0;
  {
    FakeSensor s;
    R307Compat reader(s);
    prepare(s, reader);
    s.ack(FINGERPRINT_LEDON);
    assert(reader.requestLightOn());
    assert(s.commands.back()[0] == FINGERPRINT_LEDON && reader.lightLayout() == 0);
    const size_t before = s.commands.size();
    s.ack(FINGERPRINT_LEDON);
    assert(reader.requestLightOn());
    assert(s.commands.size() == before + 1);           // no wasted probes
    // A light request must not disturb an ordinary match afterwards.
    s.ack(FINGERPRINT_GETIMAGE); s.ack(FINGERPRINT_IMAGE2TZ);
    s.plan(FINGERPRINT_HISPEEDSEARCH, {0, 0, 42, 0, 55});
    uint16_t id = 0; uint8_t permission = 0;
    assert(reader.search(id, permission, 1500) && id == 42);
  }
  // 2. A clone that refuses plain LEDON is lit by breathing blue, and that
  //    layout is then used first on every later re-assert.
  nowMs = 0;
  {
    FakeSensor s;
    R307Compat reader(s);
    prepare(s, reader);
    s.plan(FINGERPRINT_LEDON, {1});
    s.ack(FINGERPRINT_AURALEDCONFIG);
    assert(reader.requestLightOn());
    assert(s.commands.back()[0] == FINGERPRINT_AURALEDCONFIG);
    assert(s.commands.back()[1] == FINGERPRINT_LED_BREATHING);
    assert(s.commands.back()[2] == FINGERPRINT_LED_BLUE);
    assert(reader.lightLayout() == 1);
    s.ack(FINGERPRINT_AURALEDCONFIG);
    assert(reader.requestLightOn());
    assert(s.commands.back()[1] == FINGERPRINT_LED_BREATHING);
  }
  // 3. A clone that refuses breathing but accepts steady blue is still lit.
  nowMs = 0;
  {
    FakeSensor s;
    R307Compat reader(s);
    prepare(s, reader);
    s.plan(FINGERPRINT_LEDON, {1});
    s.plan(FINGERPRINT_AURALEDCONFIG, {1});
    s.ack(FINGERPRINT_AURALEDCONFIG);
    assert(reader.requestLightOn());
    assert(s.commands.back()[1] == FINGERPRINT_LED_ON);
    assert(reader.lightLayout() == 2);
  }
  // 4. A reader that refuses all three is reported, never fatal: capture and
  //    matching still work, and the failure leaves no dirty line behind.
  nowMs = 0;
  {
    FakeSensor s;
    R307Compat reader(s);
    prepare(s, reader);
    s.plan(FINGERPRINT_LEDON, {1});
    s.plan(FINGERPRINT_AURALEDCONFIG, {1});
    s.plan(FINGERPRINT_AURALEDCONFIG, {1});
    assert(!reader.requestLightOn());
    assert(reader.lightMisses() == 1);
    s.ack(FINGERPRINT_GETIMAGE);
    s.ack(FINGERPRINT_IMAGE2TZ);
    s.plan(FINGERPRINT_HISPEEDSEARCH, {0, 0, 7, 0, 90});
    uint16_t id = 0; uint8_t permission = 0;
    assert(reader.search(id, permission, 1500) && id == 7);
    // The three refused light frames left no dirty line: the next command went
    // out immediately and was answered (no multi-second drain).
    assert(nowMs < 3000);
  }
  // 5. A reader that keeps refusing costs the door ONE short probe per call
  //    (not three), so light handling can never be what makes scanning slow.
  nowMs = 0;
  {
    FakeSensor s;
    R307Compat reader(s);
    prepare(s, reader);
    // Three full rounds. The probe order rotates, so the plans follow it.
    const uint8_t rounds[3][3] = {
      {FINGERPRINT_LEDON, FINGERPRINT_AURALEDCONFIG, FINGERPRINT_AURALEDCONFIG},
      {FINGERPRINT_AURALEDCONFIG, FINGERPRINT_AURALEDCONFIG, FINGERPRINT_LEDON},
      {FINGERPRINT_AURALEDCONFIG, FINGERPRINT_LEDON, FINGERPRINT_AURALEDCONFIG},
    };
    for (int round = 0; round < 3; ++round) {
      for (int probe = 0; probe < 3; ++probe) s.plan(rounds[round][probe], {1});
      assert(!reader.requestLightOn());
    }
    assert(reader.lightMisses() == 3);
    const size_t before = s.commands.size();
    s.plan(FINGERPRINT_LEDON, {1});              // one rotating probe only
    assert(!reader.requestLightOn());
    assert(s.commands.size() == before + 1);
    // It still recovers the moment the reader answers, and goes back to the
    // fast cadence with that layout.
    s.ack(FINGERPRINT_AURALEDCONFIG);
    assert(reader.requestLightOn());
    assert(reader.lightMisses() == 0 && reader.lightLayout() == 1);
  }
}

/* SPEED (owner, Oct 2026): "when an unregistered finger is placed the system took
 * long before the red LED and buzzer - it must be as soon as it can."
 *
 * The reader's answer is the floor: nothing can be faster than the module. What
 * the sketch must not do is ADD to it. These bounds are the fixed costs that used
 * to sit in front of the red LED: an over-long GETIMAGE deadline, a retry of the
 * whole conversion, and a quiet-line drain with a two-second cap. */
static void test_refusal_latency_is_bounded() {
  // Typical reader, unregistered finger: one capture, one conversion, one search.
  nowMs = 0;
  FakeSensor s;
  R307Compat reader(s);
  prepare(s, reader);
  s.ack(FINGERPRINT_GETIMAGE);        // image arrives at once
  s.ack(FINGERPRINT_IMAGE2TZ);
  s.plan(FINGERPRINT_HISPEEDSEARCH, {FINGERPRINT_NOTFOUND});
  uint16_t id = 0; uint8_t permission = 0;
  const uint32_t before = nowMs;
  assert(!reader.search(id, permission, 1500));
  const uint32_t spent = nowMs - before;
  assert(reader.getLastStatus() == 0x05);
  // No artificial wait belongs in this path at all (the old code spent 250 ms
  // re-capturing before it would admit the finger was not enrolled).
  assert(spent < 250);

  // Worst case: the reader says nothing at all on every frame of one search.
  // That must still be measured in about a second, not in tens of seconds.
  nowMs = 0;
  FakeSensor silent;
  R307Compat reader2(silent);
  prepare(silent, reader2);
  for (int i = 0; i < 12; ++i) silent.plan(FINGERPRINT_GETIMAGE, {}, 0, false, true);
  const uint32_t worstStart = nowMs;
  assert(!reader2.search(id, permission, 400));
  const uint32_t worst = nowMs - worstStart;
  assert(worst < 4000);   // bounded by the short GETIMAGE deadline + one drain
}

/* A definitively unregistered finger must be reported at once, not after a
 * second full capture, and the driver must be able to say that it SAW a finger
 * (that is what makes the red LED and buzzer fire for a bad press). */
static void test_refusal_is_fast_and_visible() {
  nowMs = 0;
  FakeSensor s;
  R307Compat reader(s);
  prepare(s, reader);
  s.ack(FINGERPRINT_GETIMAGE);
  s.ack(FINGERPRINT_IMAGE2TZ);
  s.plan(FINGERPRINT_HISPEEDSEARCH, {FINGERPRINT_NOTFOUND});
  uint16_t id = 0; uint8_t permission = 0;
  assert(!reader.search(id, permission, 1500));
  assert(reader.getLastStatus() == 0x05);
  assert(reader.searchSawFinger() && reader.searchImagesSeen() == 1);
  size_t imageCommands = 0;
  for (const auto &c : s.commands) if (c[0] == FINGERPRINT_GETIMAGE) imageCommands++;
  assert(imageCommands == 1);   // no second capture for a definite no-match

  // An unclear press is retried once (a second look is worth it) and still
  // counts as a finger for the warning.
  nowMs = 0;
  FakeSensor s2;
  R307Compat reader2(s2);
  prepare(s2, reader2);
  s2.plan(FINGERPRINT_GETIMAGE, {FINGERPRINT_IMAGEFAIL});
  s2.plan(FINGERPRINT_GETIMAGE, {FINGERPRINT_IMAGEFAIL});
  for (int i = 0; i < 4; ++i) s2.plan(FINGERPRINT_GETIMAGE, {FINGERPRINT_NOFINGER});
  assert(!reader2.search(id, permission, 300));
  assert(reader2.searchSawFinger() && reader2.searchUnclear() >= 1);

  // Nobody touched the glass: no image, so no warning is invented.
  nowMs = 0;
  FakeSensor s3;
  R307Compat reader3(s3);
  prepare(s3, reader3);
  for (int i = 0; i < 30; ++i) s3.plan(FINGERPRINT_GETIMAGE, {FINGERPRINT_NOFINGER});
  assert(!reader3.search(id, permission, 200));
  assert(!reader3.searchSawFinger());
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
  test_refusal_is_fast_and_visible();
  test_refusal_latency_is_bounded();
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
