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

  // Fast online budget (3.5 s): if no receipt arrives, switch to SAVED ("Stored
  // offline queue") and emit the 2nd confirmation green light + buzzer cue.
  feedback.saved(abebe, true, 100);
  assert(feedback.phase() == ScanFeedback::SENDING && feedback.linkWasUp());
  assert(!feedback.consumeDoneCue());
  assert(!feedback.tick(3599));
  assert(feedback.tick(3600) && feedback.phase() == ScanFeedback::SAVED);
  assert(feedback.consumeDoneCue());          // 2nd green + buzzer fires once
  assert(!feedback.consumeDoneCue());         // ... and never repeats
  assert(std::strcmp(feedback.current().name, "Abebe") == 0);
  assert(feedback.current().scannedAt == abebe.scannedAt);
  // A later background receipt can still update the screen without a 3rd beep.
  assert(feedback.mayShow(abebe, 5100));
  feedback.delivered(abebe, 5100);
  assert(feedback.phase() == ScanFeedback::SENT_IN);
  assert(!feedback.consumeDoneCue());
  assert(!feedback.tick(7599));
  assert(feedback.tick(7600) && feedback.phase() == ScanFeedback::IDLE);

  // Offline scan: brief 450 ms Verifying flash (1st green + buzzer), then right
  // at 450 ms shows "Stored offline queue" + 2nd green light + buzzer cue.
  feedback.saved(mulu, false, 20000);
  assert(feedback.phase() == ScanFeedback::SENDING && !feedback.linkWasUp());
  assert(!feedback.tick(20449));
  assert(feedback.tick(20450) && feedback.phase() == ScanFeedback::SAVED);
  assert(feedback.consumeDoneCue());
  assert(!feedback.mayShow(abebe, 21000));
  assert(feedback.mayShow(abebe, 21950));
  feedback.delivered(abebe, 21950);
  assert(feedback.phase() == ScanFeedback::SENT_IN);
  assert(!feedback.consumeDoneCue()); // background delivery: no surprise beep
  assert(std::strcmp(feedback.current().name, "Abebe") == 0);
  assert(feedback.mayShow(mulu, 23450));
  feedback.delivered(mulu, 23450);
  assert(feedback.phase() == ScanFeedback::SENT_OUT);
  assert(feedback.current().scannedAt == mulu.scannedAt);
  feedback.delivered(review, 24950);
  assert(feedback.phase() == ScanFeedback::REVIEW);
  auto already = notice("d", "Sami", 1790000200U, DELIVERY_ALREADY);
  feedback.delivered(already, 26450);
  assert(feedback.phase() == ScanFeedback::ALREADY);

  // Early HTTP failure while associated to router defers immediately at 450 ms
  // instead of waiting the full 3.5 s timeout.
  feedback.saved(abebe, true, 10000);
  feedback.deferIfCurrent("a");
  assert(!feedback.tick(10449));
  assert(feedback.tick(10450) && feedback.phase() == ScanFeedback::SAVED);
  assert(feedback.consumeDoneCue());

  // Warning notice state remains non-blocking and outranks background receipts.
  feedback.notice("NOT REGISTERED", "Finger not enrolled", "Ask admin to add it", 20000U, 2500U);
  assert(feedback.phase() == ScanFeedback::NOTICE);
  assert(!feedback.consumeDoneCue());
  assert(std::strcmp(feedback.noticeTitle(), "NOT REGISTERED") == 0);
  assert(std::strcmp(feedback.noticeLine2(), "Finger not enrolled") == 0);
  assert(std::strcmp(feedback.noticeLine3(), "Ask admin to add it") == 0);
  assert(!feedback.tick(22499));
  assert(feedback.tick(22500) && feedback.phase() == ScanFeedback::IDLE);
  feedback.notice("NOT REGISTERED", "Finger not enrolled", "Ask admin to add it", 50000U, 2500U);
  assert(!feedback.mayShow(abebe, 52000U));
  assert(feedback.tick(52000U) == false);
  assert(feedback.phase() == ScanFeedback::NOTICE);
  assert(feedback.tick(52500U) && feedback.phase() == ScanFeedback::IDLE);
  feedback.notice("IMAGE UNCLEAR", "Press flat and still", "Clean the sensor", 30000U, 2500U);
  feedback.saved(abebe, true, 30100U);
  assert(feedback.phase() == ScanFeedback::SENDING);
  feedback.notice("A VERY LONG WARNING TITLE INDEED", "x", "y", 40000U, 2500U);
  assert(std::strlen(feedback.noticeTitle()) == 20);
  assert(!feedback.tick(41000U));
  assert(feedback.tick(42500U) && feedback.phase() == ScanFeedback::IDLE);

  // Fast direct-to-site flow: verifying() -> saved() -> receipt arrives; waits
  // only the crisp 450 ms 1st-green window so 2nd green + buzzer is distinct,
  // then shows "Sent to website" / "Already registered" and fires done cue.
  ScanFeedback card;
  DeliveryNotice pending = notice("", "Abebe", 1790000000U, DELIVERY_IN);
  card.verifying(pending, true, 1000);
  card.saved(abebe, true, 1005);
  assert(card.phase() == ScanFeedback::SENDING);
  assert(!card.greenPhaseOver(1449));
  assert(card.greenPhaseOver(1450));
  assert(!card.mayShow(abebe, 1300)); // hold until 1st green flash has turned off
  assert(card.mayShow(abebe, 1450));
  card.delivered(abebe, 1450);
  assert(card.phase() == ScanFeedback::SENT_IN);
  assert(card.consumeDoneCue());
  assert(!card.consumeDoneCue());

  // Already-registered direct scan also triggers the 2nd green + buzzer cue.
  ScanFeedback dupCard;
  dupCard.verifying(pending, true, 2000);
  dupCard.saved(already, true, 2004);
  assert(dupCard.mayShow(already, 2500));
  dupCard.delivered(already, 2500);
  assert(dupCard.phase() == ScanFeedback::ALREADY);
  assert(dupCard.consumeDoneCue());

  // Batch summary from offline queue displays immediately without cycling names.
  ScanFeedback offlineCard;
  offlineCard.saved(mulu, false, 20000);
  assert(offlineCard.tick(20450) && offlineCard.phase() == ScanFeedback::SAVED);
  assert(offlineCard.consumeDoneCue());
  DeliveryNotice batchNotice{};
  std::snprintf(batchNotice.name, sizeof(batchNotice.name), "%s", "20 scans sent");
  batchNotice.kind = DELIVERY_BATCH;
  assert(offlineCard.mayShow(batchNotice, 20600));
  offlineCard.delivered(batchNotice, 20600);
  assert(offlineCard.phase() == ScanFeedback::BATCH_SENT);
  assert(!offlineCard.consumeDoneCue());

  // millis wrap safety across 3.5 s receipt window.
  feedback.saved(abebe, true, UINT32_MAX - 1000U);
  assert(!feedback.tick(2000U));
  assert(feedback.tick(2600U) && feedback.phase() == ScanFeedback::SAVED);
  assert(feedback.consumeDoneCue());

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
  std::cout << "Scan feedback tests passed: instant verifying card, online, offline, delayed receipts, review, non-blocking warnings, wrap and false-200 rejection\n";
}
