// run_host_tests.py inserts the actual feedback and receipt code from the .ino.
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>

// -- INSERT REAL DELIVERY TYPES AND STATE --
// -- INSERT REAL RECEIPT VALIDATION --

static DeliveryNotice notice(const char *id, const char *name, uint32_t when, DeliveryKind kind) {
  DeliveryNotice n{};
  std::snprintf(n.eventId, sizeof(n.eventId), "%s", id);
  std::snprintf(n.name, sizeof(n.name), "%s", name);
  n.scannedAt = when;
  n.kind = kind;
  return n;
}

int main() {
  ScanFeedback feedback;
  const auto abebe = notice("a", "Abebe", 1790000000U, DELIVERY_IN);
  const auto mulu = notice("b", "Mulu", 1790000100U, DELIVERY_OUT);
  const auto review = notice("c", "Sara", 0, DELIVERY_REVIEW);

  // Wi-Fi association is not confirmation: the door says SENDING and keeps
  // saying it for a full round-trip budget. A slow-but-working website must
  // never be called "saved offline" after 1.8 s (owner, Oct 2026: "even though
  // there is Wi-Fi the system says saved on device"). The original name/time
  // must survive either way.
  feedback.saved(abebe, true, 100);
  assert(feedback.phase() == ScanFeedback::SENDING && feedback.linkWasUp());
  assert(!feedback.tick(1899));
  assert(!feedback.tick(8000));
  assert(feedback.tick(8101) && feedback.phase() == ScanFeedback::SAVED);
  assert(std::strcmp(feedback.current().name, "Abebe") == 0);
  assert(feedback.current().scannedAt == abebe.scannedAt);
  // A confirmed reply for the same event can update the current result now.
  assert(feedback.mayShow(abebe, 8102));
  feedback.delivered(abebe, 8102);
  assert(feedback.phase() == ScanFeedback::SENT_IN);
  assert(!feedback.tick(11101));
  assert(feedback.tick(11102) && feedback.phase() == ScanFeedback::IDLE);

  // Offline gives the honest stored message immediately. Later deliveries of
  // several people can be shown in order without overwriting a fresh scan.
  feedback.saved(mulu, false, 20000);
  assert(feedback.phase() == ScanFeedback::SAVED && !feedback.linkWasUp());
  assert(!feedback.mayShow(abebe, 21000));
  assert(feedback.mayShow(abebe, 21500));
  feedback.delivered(abebe, 21500);
  assert(feedback.phase() == ScanFeedback::SENT_IN);
  assert(std::strcmp(feedback.current().name, "Abebe") == 0);
  assert(feedback.mayShow(mulu, 23000));
  feedback.delivered(mulu, 23000);
  assert(feedback.phase() == ScanFeedback::SENT_OUT);
  assert(feedback.current().scannedAt == mulu.scannedAt);
  feedback.delivered(review, 24500);
  assert(feedback.phase() == ScanFeedback::REVIEW);
  auto already = notice("d", "Sami", 1790000200U, DELIVERY_ALREADY);
  feedback.delivered(already, 26000);
  assert(feedback.phase() == ScanFeedback::ALREADY); // not a new IN or OUT

  /* A warning about a placement is a STATE, not a pause: it expires on its own
   * so the door keeps scanning and a finger placed at any moment is read. */
  feedback.notice("NOT REGISTERED", "Finger not enrolled", "Ask admin to add it", 20000U, 2500U);
  assert(feedback.phase() == ScanFeedback::NOTICE);
  assert(std::strcmp(feedback.noticeTitle(), "NOT REGISTERED") == 0);
  assert(std::strcmp(feedback.noticeLine2(), "Finger not enrolled") == 0);
  assert(std::strcmp(feedback.noticeLine3(), "Ask admin to add it") == 0);
  assert(!feedback.tick(22499));
  assert(feedback.tick(22500) && feedback.phase() == ScanFeedback::IDLE);
  // An older scan's receipt never cuts a warning short.
  feedback.notice("NOT REGISTERED", "Finger not enrolled", "Ask admin to add it", 50000U, 2500U);
  assert(!feedback.mayShow(abebe, 52000U));
  assert(feedback.tick(52000U) == false);
  assert(feedback.phase() == ScanFeedback::NOTICE);
  assert(feedback.tick(52500U) && feedback.phase() == ScanFeedback::IDLE);
  // A real scan takes the screen over from a warning at once.
  feedback.notice("IMAGE UNCLEAR", "Press flat and still", "Clean the sensor", 30000U, 2500U);
  feedback.saved(abebe, true, 30100U);
  assert(feedback.phase() == ScanFeedback::SENDING);
  // Over-long warning text is cut, never overruns the 20-character LCD line.
  feedback.notice("A VERY LONG WARNING TITLE INDEED", "x", "y", 40000U, 2500U);
  assert(std::strlen(feedback.noticeTitle()) == 20);
  assert(!feedback.tick(41000U));
  assert(feedback.tick(42500U) && feedback.phase() == ScanFeedback::IDLE);

  // millis wrap must not leave the message stuck or lose the next status.
  feedback.saved(abebe, true, UINT32_MAX - 1000U);
  assert(!feedback.tick(4100U));
  assert(feedback.tick(7100U) && feedback.phase() == ScanFeedback::SAVED);

  const char *id = "0123456789abcdef0123456789abcdef";
  assert(receiptMatches(id, 1790000000U, 55, 7, id, 1790000000U, 55, 7, "clock_in", true));
  assert(receiptMatches(id, 1790000000U, 55, 7, id, 1790000000U, 55, 7, "already_registered", false));
  assert(!receiptMatches(id, 1790000000U, 55, 7, "", 1790000000U, 55, 7, "clock_in", true));
  assert(!receiptMatches(id, 1790000000U, 55, 7, id, 1790000001U, 55, 7, "clock_in", true));
  assert(!receiptMatches(id, 1790000000U, 55, 7, id, 1790000000U, 56, 7, "clock_in", true));
  assert(!receiptMatches(id, 1790000000U, 55, 7, id, 1790000000U, 55, 8, "clock_in", true));
  assert(!receiptMatches(id, 1790000000U, 55, 7, id, 1790000000U, 55, 7, "clock_in", false));
  assert(!receiptMatches(id, 1790000000U, 55, 7, id, 1790000000U, 55, 7, "unexpected", true));
  assert(!receiptMatches(id, 1790000000U, 55, 0, id, 1790000000U, 55, 0, "clock_in", true));
  std::cout << "Scan feedback tests passed: online, offline, delayed receipts, review, non-blocking warnings, wrap and false-200 rejection\n";
}
