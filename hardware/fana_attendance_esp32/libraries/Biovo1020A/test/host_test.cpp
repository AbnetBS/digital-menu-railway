// Host-side unit tests for the patched Biovo1020A library.
// Build & run:  g++ -std=c++11 -I. -I../src host_test.cpp ../src/Biovo1020A.cpp -o host_test && ./host_test
#include "Arduino.h"
#include "Biovo1020A.h"

static int failures = 0;
#define CHECK(cond)                                                        \
  do {                                                                     \
    if (!(cond)) {                                                         \
      printf("FAIL line %d: %s\n", __LINE__, #cond);                       \
      failures++;                                                          \
    }                                                                      \
  } while (0)

static uint8_t cksum(uint8_t cmd, uint8_t d1, uint8_t d2, uint8_t d3, uint8_t d4) {
  return cmd ^ d1 ^ d2 ^ d3 ^ d4;
}

int main() {
  // 1. Normal COUNT reply -> count 3, status 0, correct command frame sent
  {
    FakeSerial ser;
    Biovo1020A f(ser);
    ser.replyOnWrite = {0xF5, 0x09, 0x00, 0x03, 0x00, 0x00, cksum(0x09, 0, 3, 0, 0), 0xF5};
    CHECK(f.getCount(1000) == 3);
    CHECK(f.getLastStatus() == 0x00);
    CHECK(ser.tx.size() == 8);
    CHECK(ser.tx[0] == 0xF5 && ser.tx[1] == 0x09 && ser.tx[7] == 0xF5);
    CHECK(ser.tx[6] == (0x09 ^ 0x00 ^ 0x00 ^ 0x00 ^ 0x00));
  }

  // 2. THE BUG THIS PATCH FIXES: a stale reply to an earlier SEARCH (cmd 0x0C,
  //    status 0x06) arrives together with the real ENROLL reply. The old
  //    library read the stale frame, failed validation and reported the stale
  //    status 6 ("enroll failed, status = 6"). The patched library must
  //    discard the stale frame and accept the real enroll reply.
  {
    FakeSerial ser;
    Biovo1020A f(ser);
    ser.replyOnWrite = {
      0xF5, 0x0C, 0x00, 0x00, 0x06, 0x00, cksum(0x0C, 0, 0, 0x06, 0), 0xF5, // stale SEARCH reply
      0xF5, 0x01, 0x00, 0x01, 0x00, 0x00, cksum(0x01, 0, 1, 0x00, 0), 0xF5  // real ENROLL_1 reply
    };
    CHECK(f.enroll(1, 1, 1000) == true);
    CHECK(f.getLastStatus() == 0x00);
  }

  // 3. Garbage bytes before the frame (line noise) -> resync on 0xF5 head
  {
    FakeSerial ser;
    Biovo1020A f(ser);
    ser.replyOnWrite = {0x00, 0xFF, 0x13,
                        0xF5, 0x09, 0x00, 0x07, 0x00, 0x00, cksum(0x09, 0, 7, 0, 0), 0xF5};
    CHECK(f.getCount(1000) == 7);
  }

  // 4. No reply at all -> false, status 0xFF (NO_RESPONSE)
  {
    FakeSerial ser;
    Biovo1020A f(ser);
    CHECK(f.getCount(500) == -1);
    CHECK(f.getLastStatus() == BIOVO_ACK_NO_RESPONSE);
  }

  // 5. Only a reply to a DIFFERENT command -> false, status 0xFE (COMM_ERROR)
  {
    FakeSerial ser;
    Biovo1020A f(ser);
    ser.replyOnWrite = {0xF5, 0x0C, 0x00, 0x00, 0x08, 0x00, cksum(0x0C, 0, 0, 0x08, 0), 0xF5};
    CHECK(f.getCount(500) == -1);
    CHECK(f.getLastStatus() == BIOVO_ACK_COMM_ERROR);
  }

  // 6. Frame with a bad checksum is discarded, the next good frame accepted
  {
    FakeSerial ser;
    Biovo1020A f(ser);
    ser.replyOnWrite = {
      0xF5, 0x09, 0x00, 0x02, 0x00, 0x00, 0x00, 0xF5, // wrong checksum on purpose
      0xF5, 0x09, 0x00, 0x02, 0x00, 0x00, cksum(0x09, 0, 2, 0, 0), 0xF5
    };
    CHECK(f.getCount(1000) == 2);
  }

  // 7. search(): match with ID 5, permission 1
  {
    FakeSerial ser;
    Biovo1020A f(ser);
    ser.replyOnWrite = {0xF5, 0x0C, 0x00, 0x05, 0x01, 0x00, cksum(0x0C, 0, 5, 1, 0), 0xF5};
    uint16_t id = 0;
    uint8_t perm = 0;
    CHECK(f.search(id, perm, 1000) == true);
    CHECK(id == 5 && perm == 1);
  }

  // 8. search(): no match -> status 0x05 (NOUSER), returns false
  {
    FakeSerial ser;
    Biovo1020A f(ser);
    ser.replyOnWrite = {0xF5, 0x0C, 0x00, 0x00, 0x05, 0x00, cksum(0x0C, 0, 0, 0x05, 0), 0xF5};
    uint16_t id = 0;
    uint8_t perm = 0;
    CHECK(f.search(id, perm, 1000) == false);
    CHECK(f.getLastStatus() == BIOVO_ACK_NOUSER);
  }

  // 9. enroll(): module reports image-messy (0x06) -> false, status 0x06
  {
    FakeSerial ser;
    Biovo1020A f(ser);
    ser.replyOnWrite = {0xF5, 0x01, 0x00, 0x09, 0x06, 0x00, cksum(0x01, 0, 9, 0x06, 0), 0xF5};
    CHECK(f.enroll(9, 1, 1000) == false);
    CHECK(f.getLastStatus() == BIOVO_ACK_IMAGEMESS);
  }

  // 10. enroll(): ID already exists (0x07) -> false, status 0x07
  {
    FakeSerial ser;
    Biovo1020A f(ser);
    ser.replyOnWrite = {0xF5, 0x01, 0x00, 0x09, 0x07, 0x00, cksum(0x01, 0, 9, 0x07, 0), 0xF5};
    CHECK(f.enroll(9, 1, 1000) == false);
    CHECK(f.getLastStatus() == BIOVO_ACK_USER_EXIST);
  }

  // 11. deleteAll OK
  {
    FakeSerial ser;
    Biovo1020A f(ser);
    ser.replyOnWrite = {0xF5, 0x05, 0x00, 0x00, 0x00, 0x00, cksum(0x05, 0, 0, 0, 0), 0xF5};
    CHECK(f.deleteAll(1000) == true);
  }

  // 12. drain(): flushes pending bytes and waits for a quiet line
  {
    FakeSerial ser;
    Biovo1020A f(ser);
    ser.feed({0xF5, 0x0C, 0x00, 0x00, 0x08, 0x00, cksum(0x0C, 0, 0, 0x08, 0), 0xF5});
    f.drain(50);
    CHECK(ser.rx.empty());
  }

  // 13. Mid-frame start: we begin listening in the middle of a stale frame,
  //     then the real reply arrives. The window must still lock onto it.
  {
    FakeSerial ser;
    Biovo1020A f(ser);
    // tail of a stale frame, then a full COUNT reply
    ser.replyOnWrite = {0x00, 0x00, 0x04, 0xF5,
                        0xF5, 0x09, 0x00, 0x08, 0x00, 0x00, cksum(0x09, 0, 8, 0, 0), 0xF5};
    CHECK(f.getCount(1000) == 8);
  }

  // 14. Two valid frames back-to-back for the SAME command (e.g. two SEARCH
  //     replies). A stale reply to the same command is indistinguishable from
  //     the real one, so the FIRST valid frame wins. That is fine for the
  //     sketch: consecutive searches are semantically identical, and the
  //     loop simply searches again.
  {
    FakeSerial ser;
    Biovo1020A f(ser);
    ser.replyOnWrite = {
      0xF5, 0x0C, 0x00, 0x00, 0x08, 0x00, cksum(0x0C, 0, 0, 0x08, 0), 0xF5,
      0xF5, 0x0C, 0x00, 0x03, 0x02, 0x00, cksum(0x0C, 0, 3, 2, 0), 0xF5
    };
    uint16_t id = 0;
    uint8_t perm = 0;
    CHECK(f.search(id, perm, 1000) == false); // first reply: no finger (0x08)
    CHECK(f.getLastStatus() == BIOVO_ACK_TIMEOUT);
  }

  // 15. statusText covers every documented code
  CHECK(strcmp(Biovo1020A::statusText(0x00), "OK") == 0);
  CHECK(strstr(Biovo1020A::statusText(0x06), "Image unclear") != nullptr);
  CHECK(strstr(Biovo1020A::statusText(0xFF), "No reply") != nullptr);

  if (failures == 0) {
    printf("ALL TESTS PASSED\n");
    return 0;
  }
  printf("%d TEST(S) FAILED\n", failures);
  return 1;
}
