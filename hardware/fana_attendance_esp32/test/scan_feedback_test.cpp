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

  // Wi-Fi association is not confirmation: start sending, then say saved if
  // a website receipt has not arrived. The original name/time must survive.
  feedback.saved(abebe, true, 100);
  assert(feedback.phase() == ScanFeedback::SENDING);
  assert(!feedback.tick(1899));
  assert(feedback.tick(1900) && feedback.phase() == ScanFeedback::SAVED);
  assert(std::strcmp(feedback.current().name, "Abebe") == 0);
  assert(feedback.current().scannedAt == abebe.scannedAt);
  // A confirmed reply for the same event can update the current result now.
  assert(feedback.mayShow(abebe, 1901));
  feedback.delivered(abebe, 1901);
  assert(feedback.phase() == ScanFeedback::SENT_IN);
  assert(!feedback.tick(4900));
  assert(feedback.tick(4901) && feedback.phase() == ScanFeedback::IDLE);

  // Offline gives the honest stored message immediately. Later deliveries of
  // several people can be shown in order without overwriting a fresh scan.
  feedback.saved(mulu, false, 6000);
  assert(feedback.phase() == ScanFeedback::SAVED);
  assert(!feedback.mayShow(abebe, 7000));
  assert(feedback.mayShow(abebe, 7500));
  feedback.delivered(abebe, 7500);
  assert(feedback.phase() == ScanFeedback::SENT_IN);
  assert(std::strcmp(feedback.current().name, "Abebe") == 0);
  assert(feedback.mayShow(mulu, 9000));
  feedback.delivered(mulu, 9000);
  assert(feedback.phase() == ScanFeedback::SENT_OUT);
  assert(feedback.current().scannedAt == mulu.scannedAt);
  feedback.delivered(review, 10500);
  assert(feedback.phase() == ScanFeedback::REVIEW);
  auto already = notice("d", "Sami", 1790000200U, DELIVERY_ALREADY);
  feedback.delivered(already, 12000);
  assert(feedback.phase() == ScanFeedback::ALREADY); // not a new IN or OUT

  // millis wrap must not leave the message stuck or lose the next status.
  feedback.saved(abebe, true, UINT32_MAX - 1000U);
  assert(feedback.tick(800U) && feedback.phase() == ScanFeedback::SAVED);

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
  std::cout << "Scan feedback tests passed: online, offline, delayed receipts, review, wrap and false-200 rejection\n";
}
