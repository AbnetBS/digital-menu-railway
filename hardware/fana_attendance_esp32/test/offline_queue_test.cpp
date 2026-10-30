#include <cassert>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <thread>
#include "../OfflineQueue.h"

int main() {
  fs::FS fs;
  std::timed_mutex mutex;
  OfflineQueue q(fs, &mutex);
  OfflineQueue::Head head;
  assert(q.peek(head) == OfflineQueue::EMPTY);

  // Previously flashed firmware used CRLF. Preserve it and deliver in order.
  fs.put("/queue.json", "{\"old\":1}\r\n{\"old\":2}\r\n");
  assert(q.peek(head) == OfflineQueue::READY && head.line == String("{\"old\":1}"));
  const size_t afterFirst = head.end;
  assert(q.acknowledge(head));
  OfflineQueue afterReboot(fs, &mutex);
  assert(afterReboot.peek(head) == OfflineQueue::READY && head.start == afterFirst);
  assert(head.line == String("{\"old\":2}"));
  assert(afterReboot.acknowledge(head));
  assert(afterReboot.peek(head) == OfflineQueue::EMPTY);
  assert(!fs.exists("/queue.json"));

  // A paused/slow network sender has no queue lock: a new person can be saved
  // before the HTTP reply. Acknowledging the old head must retain the new tail.
  assert(q.append("first"));
  std::mutex signalMutex;
  std::condition_variable signal;
  bool sending = false, finish = false;
  std::thread sender([&] {
    OfflineQueue::Head inFlight;
    assert(q.peek(inFlight) == OfflineQueue::READY && inFlight.line == String("first"));
    {
      std::unique_lock<std::mutex> lock(signalMutex);
      sending = true; signal.notify_all();
      signal.wait(lock, [&] { return finish; });
    }
    assert(q.acknowledge(inFlight));
  });
  {
    std::unique_lock<std::mutex> lock(signalMutex);
    signal.wait(lock, [&] { return sending; });
  }
  const auto began = std::chrono::steady_clock::now();
  assert(q.append("second"));
  assert(std::chrono::steady_clock::now() - began < std::chrono::seconds(1));
  { std::lock_guard<std::mutex> lock(signalMutex); finish = true; }
  signal.notify_all(); sender.join();
  assert(q.peek(head) == OfflineQueue::READY && head.line == String("second"));

  // Losing the cursor write after a server success must replay, not skip.
  fs.failRename = true;
  assert(!q.acknowledge(head));
  fs.failRename = false;
  OfflineQueue retry(fs, &mutex);
  OfflineQueue::Head replay;
  assert(retry.peek(replay) == OfflineQueue::READY && replay.line == head.line);
  assert(retry.acknowledge(replay));
  assert(retry.peek(replay) == OfflineQueue::EMPTY);

  // A stale cursor after a completed log was removed cannot skip a new log.
  fs.put("/queue.cursor", "99");
  assert(q.append("new generation"));
  assert(q.peek(head) == OfflineQueue::READY && head.start == 0 && head.line == String("new generation"));
  assert(q.acknowledge(head));

  // A torn record/corrupt cursor stops the queue rather than losing a scan.
  fs.writeLimit = 3;
  assert(!q.append("a long event"));
  fs.writeLimit = static_cast<size_t>(-1);
  assert(!q.append("must not attach"));
  assert(q.peek(head) == OfflineQueue::BLOCKED);
  fs.put("/queue.json", "good\n"); fs.put("/queue.cursor", "not-a-number");
  assert(q.peek(head) == OfflineQueue::BLOCKED);
  fs.put("/queue.cursor", "999");
  assert(q.peek(head) == OfflineQueue::BLOCKED);
  fs.remove("/queue.cursor");
  assert(q.peek(head) == OfflineQueue::READY);
  assert(q.acknowledge(head));

  // A first NTP anchor is durable and fixed across later retries/reboots.
  const String boot("0123456789abcdef");
  assert(q.saveClockAnchor(boot, 1790000000UL, 500));
  assert(q.saveClockAnchor(boot, 1790000100UL, 600));
  unsigned long epoch = 0; uint32_t uptime = 0;
  OfflineQueue anotherBoot(fs, &mutex);
  assert(anotherBoot.readClockAnchor(boot, epoch, uptime));
  assert(epoch == 1790000000UL && uptime == 500);
  assert(epoch - (uptime - 100) == 1789999600UL);
  assert(!q.saveClockAnchor("../bad", 1, 1));
  assert(!q.readClockAnchor("ffffffffffffffff", epoch, uptime));
  fs.put("/anchor-ffffffffffffffff", "1790000000,4"); // incomplete
  assert(!q.readClockAnchor("ffffffffffffffff", epoch, uptime));
  assert(!q.saveClockAnchor("ffffffffffffffff", 1790000000UL, 4));

  // Unknown-time/conflicting entries are copied for review BEFORE removal.
  assert(q.append("{\"eventId\":\"unknown-event\"}"));
  assert(q.peek(head) == OfflineQueue::READY);
  fs.failWriteOpen = true;
  assert(!q.copyToReview(head, "unknown_time"));
  fs.failWriteOpen = false;
  assert(q.peek(replay) == OfflineQueue::READY && replay.line == head.line);
  assert(q.copyToReview(head, "unknown_time"));
  assert(q.acknowledge(head));
  assert(fs.get("/queue.review.jsonl") == "{\"reason\":\"unknown_time\",\"record\":{\"eventId\":\"unknown-event\"}}\n");
  assert(q.append("later-valid-event"));
  assert(q.peek(head) == OfflineQueue::READY && head.line == String("later-valid-event"));
  assert(q.acknowledge(head));

  // Batch peek + batch acknowledge advance the durable cursor across N records
  // atomically and clean up /queue.json once the final record is acknowledged.
  assert(!q.hasPending());
  for (int i = 0; i < 10; ++i) {
    assert(q.append(String("{\"n\":") + String(i) + String("}")));
  }
  assert(q.hasPending());
  std::vector<OfflineQueue::Head> batch;
  assert(q.peekBatch(batch, 6) == OfflineQueue::READY && batch.size() == 6);
  assert(batch[0].line == String("{\"n\":0}") && batch[5].line == String("{\"n\":5}"));
  assert(q.acknowledgeBatch(batch[0], batch[5]));
  assert(q.hasPending());
  assert(q.peekBatch(batch, 10) == OfflineQueue::READY && batch.size() == 4);
  assert(batch[0].line == String("{\"n\":6}") && batch[3].line == String("{\"n\":9}"));
  assert(q.acknowledgeBatch(batch[0], batch[3]));
  assert(!q.hasPending());
  assert(!fs.exists("/queue.json") && !fs.exists("/queue.cursor"));
  std::cout << "Offline queue tests passed: FIFO, stalled send, reboot, torn writes, durable anchors and manual review\n";
}
