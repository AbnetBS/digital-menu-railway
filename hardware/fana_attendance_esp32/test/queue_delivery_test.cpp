// run_host_tests.py inserts the real queue sender and task from the .ino.
// Hardware, HTTP and JSON are test doubles; no real ESP32 or Wi-Fi is used.
#include <ArduinoJson.h>
#include "OfflineQueue.h"
#include <atomic>
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <iostream>
#include <map>
#include <mutex>
#include <thread>
#include <vector>

// -- INSERT REAL DELIVERY TYPES AND STATE --
enum QueueSyncResult : uint8_t { QUEUE_EMPTY, QUEUE_PROGRESS, QUEUE_WAIT };
enum QueueStatus : uint8_t { QUEUE_OFFLINE, QUEUE_IDLE, QUEUE_SENDING, QUEUE_CLOCK_WAIT, QUEUE_ERROR, QUEUE_STORAGE_ERROR };
#define SERVER_TIMEOUT_MS 8000
#define LIVE_SCAN_TIMEOUT_MS 3200
#define QUEUE_OFFLINE_POLL_MS 1000
#define QUEUE_RETRY_MS 3000
#define WEBSITE_TIME_RETRY_MS 10000
#define OFFLINE_BATCH_MAX 30
#define WL_CONNECTED 3
#define pdTRUE 1

struct SerialStub {
  template <class T> void print(const T &) {}
  template <class T> void println(const T &) {}
  void println() {}
} Serial;

static std::atomic<bool> wifiUp{false};
struct WifiStub { int status() const { return wifiUp ? WL_CONNECTED : 0; } } WiFi;
static std::atomic<uint32_t> randomValue{1};
static uint32_t esp_random() { return randomValue++; }
struct EspStub { uint64_t getEfuseMac() const { return 0x123456789ULL; } } ESP;
struct mbedtls_md_info_t {};
#define MBEDTLS_MD_SHA256 1
static const mbedtls_md_info_t *mbedtls_md_info_from_type(int) { static mbedtls_md_info_t m; return &m; }
static int mbedtls_md(const mbedtls_md_info_t *, const unsigned char *, size_t, unsigned char *digest) {
  std::memset(digest, 7, 32); return 0;
}

static OfflineQueue *offlineQueue = nullptr;
static String bootId("0123456789abcdef");
static String deviceId("entrance");
static std::atomic<uint8_t> queueStatus{QUEUE_OFFLINE};
static std::atomic<int> queueLastHttpCode{0};
static std::atomic<bool> queueNeedsReview{false};
using TaskHandle_t = void *;
static TaskHandle_t deliveryTaskHandle = reinterpret_cast<void *>(1);
static std::mutex notifyMutex;
static std::condition_variable notifyCondition;
static unsigned notifications = 0;
static bool stopTask = false;
struct StopTask {};
static void xTaskNotifyGive(TaskHandle_t) {
  std::lock_guard<std::mutex> lock(notifyMutex); ++notifications; notifyCondition.notify_all();
}
static int ulTaskNotifyTake(int, uint32_t waitMs) {
  std::unique_lock<std::mutex> lock(notifyMutex);
  notifyCondition.wait_for(lock, std::chrono::milliseconds(waitMs), [] { return stopTask || notifications; });
  if (stopTask) throw StopTask{};
  const int result = static_cast<int>(notifications); notifications = 0; return result;
}
static void vTaskDelay(uint32_t ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }
#define pdMS_TO_TICKS(ms) (ms)
static const auto testStart = std::chrono::steady_clock::now();
static uint32_t millis() {
  return static_cast<uint32_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - testStart).count());
}
static unsigned long wallClockEpoch() { return 1790000000UL; }
static bool syncTimeFromWebsite() { return false; }
static String capturedTimeText(uint32_t time) { return String(static_cast<unsigned long>(time)); }

static std::mutex noticeMutex;
static std::condition_variable noticeCondition;
static std::vector<DeliveryNotice> delivered;
using QueueHandle_t = void *;
static QueueHandle_t deliveryNotices = reinterpret_cast<void *>(1);
static int xQueueSend(QueueHandle_t, const DeliveryNotice *notice, int) {
  std::lock_guard<std::mutex> lock(noticeMutex);
  delivered.push_back(*notice); noticeCondition.notify_all(); return pdTRUE;
}

struct FakeReceipt { std::string id; int finger; int member; uint32_t time; };
enum ResponseMode { GOOD, PORTAL, SERVER_DOWN, LOST_REPLY, CONFLICT };
static std::atomic<int> responseMode{GOOD};
static std::mutex serverMutex;
static std::condition_variable serverCondition;
static std::map<std::string, FakeReceipt> committed;
static std::vector<FakeReceipt> requests;
static size_t httpPosts = 0;

class HTTPClient {
 public:
  void setTimeout(int) {}
  int POST(const String &request) {
    DynamicJsonDocument doc(16384);
    assert(!deserializeJson(doc, request));
    const int mode = responseMode.load();
    if (doc["events"].is<JsonArray>()) {
      JsonArray events = doc["events"].as<JsonArray>();
      std::vector<FakeReceipt> batchEntries;
      for (JsonObject ev : events) {
        batchEntries.push_back(FakeReceipt{
            ev["eventId"] | "", ev["fingerprintId"] | 0, ev["capturedMemberId"] | 0,
            static_cast<uint32_t>(ev["scannedAt"] | 0UL)});
      }
      {
        std::lock_guard<std::mutex> lock(serverMutex);
        ++httpPosts;
        for (const auto &entry : batchEntries) {
          requests.push_back(entry);
          if ((mode == GOOD || mode == LOST_REPLY) && entry.finger != 999) {
            committed.emplace(entry.id, entry);
          }
        }
        serverCondition.notify_all();
      }
      if (mode == PORTAL) { body_ = "<html>Sign in to WiFi</html>"; return 200; }
      if (mode == SERVER_DOWN || mode == LOST_REPLY) return -1;
      std::string json = "{\"batch\":true,\"count\":" + std::to_string(batchEntries.size()) + ",\"results\":[";
      for (size_t i = 0; i < batchEntries.size(); ++i) {
        if (i) json += ",";
        const auto &entry = batchEntries[i];
        if (entry.finger == 999) {
          json += "{\"httpStatus\":404,\"status\":\"not_found\",\"eventId\":\"" + entry.id + "\"}";
        } else {
          const int memberId = entry.member > 0 ? entry.member : entry.finger;
          json += "{\"httpStatus\":200,\"eventId\":\"" + entry.id + "\",\"recordedAtEpoch\":" + std::to_string(entry.time) +
            ",\"fingerprintId\":" + std::to_string(entry.finger) + ",\"memberId\":" + std::to_string(memberId) +
            ",\"memberName\":\"Employee " + std::to_string(memberId) + "\",\"action\":\"clock_in\",\"success\":true}";
        }
      }
      json += "]}";
      body_ = String(json);
      return 200;
    }

    FakeReceipt entry{doc["eventId"] | "", doc["fingerprintId"] | 0, doc["capturedMemberId"] | 0,
                      static_cast<uint32_t>(doc["scannedAt"] | 0UL)};
    {
      std::lock_guard<std::mutex> lock(serverMutex);
      ++httpPosts;
      requests.push_back(entry);
      if ((mode == GOOD || mode == LOST_REPLY) && entry.finger != 999) committed.emplace(entry.id, entry);
      serverCondition.notify_all();
    }
    if (mode == PORTAL) { body_ = "<html>Sign in to WiFi</html>"; return 200; }
    if (mode == SERVER_DOWN || mode == LOST_REPLY) return -1;
    if (mode == CONFLICT) { body_ = "{}"; return 409; }
    if (entry.finger == 999) { body_ = "{\"status\":\"not_found\"}"; return 404; }
    const int memberId = entry.member > 0 ? entry.member : entry.finger;
    std::string json = "{\"eventId\":\"" + entry.id + "\",\"recordedAtEpoch\":" + std::to_string(entry.time) +
      ",\"fingerprintId\":" + std::to_string(entry.finger) + ",\"memberId\":" + std::to_string(memberId) +
      ",\"memberName\":\"Employee " + std::to_string(memberId) + "\",\"action\":\"clock_in\",\"success\":true}";
    body_ = String(json);
    return 200;
  }
  String getString() const { return body_; }
  void end() {}
 private:
  String body_;
};
static void beginServerRequest(HTTPClient &, const String &) {}
static void addDeviceHeaders(HTTPClient &) {}
static void acquireDeliveryNetwork() {}
static void releaseDeliveryNetwork(bool purge) {
  if (purge && offlineQueue) offlineQueue->purgeDeliveredStorage(bootId);
}
static void notifyLiveSendDeferred(const char *) {}
static bool forceSyncTimeFromWebsite() { return false; }
static void ensureClockAnchorSaved() {}
static void flushEnrollProgress() {}

// -- INSERT REAL QUEUE SENDER AND TASK --

static bool waitForNotices(size_t count, int timeoutMs = 2200) {
  std::unique_lock<std::mutex> lock(noticeMutex);
  return noticeCondition.wait_for(lock, std::chrono::milliseconds(timeoutMs), [&] { return delivered.size() >= count; });
}
static bool waitForRequests(size_t count, int timeoutMs = 2200) {
  std::unique_lock<std::mutex> lock(serverMutex);
  return serverCondition.wait_for(lock, std::chrono::milliseconds(timeoutMs), [&] { return requests.size() >= count; });
}
static String save(int fid, const char *name, int member, unsigned long time) {
  String id;
  assert(saveToQueue(fid, String(name), member, time, 100000, id));
  wakeDeliveryTask();
  return id;
}

int main() {
  fs::FS fs;
  std::timed_mutex mutex;
  OfflineQueue queue(fs, &mutex);
  offlineQueue = &queue;
  std::thread worker([] { try { deliveryTask(nullptr); } catch (const StopTask &) {} });

  const String first = save(51, "Abebe", 1, 1790000000UL);
  const String second = save(52, "Mulu", 2, 1790000060UL);
  const String third = save(53, "Sara", 3, 1790000120UL);
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  { std::lock_guard<std::mutex> lock(serverMutex); assert(requests.empty()); }
  // No explicit wake: the separate sender notices Wi-Fi coming back within its
  // one-second poll and delivers all three queued scans TOGETHER in one batch
  // HTTP POST, showing a single batch confirmation instead of cycling names.
  wifiUp = true;
  assert(waitForNotices(1));
  {
    std::lock_guard<std::mutex> lock(serverMutex);
    assert(httpPosts == 1);
    assert(committed.size() == 3 && requests.size() == 3);
    assert(requests[0].id == first.c_str() && requests[0].time == 1790000000U && requests[0].member == 1);
    assert(requests[1].id == second.c_str() && requests[1].time == 1790000060U && requests[1].member == 2);
    assert(requests[2].id == third.c_str() && requests[2].time == 1790000120U && requests[2].member == 3);
  }
  {
    std::lock_guard<std::mutex> lock(noticeMutex);
    assert(delivered.size() == 1);
    assert(delivered[0].kind == DELIVERY_BATCH && std::strcmp(delivered[0].name, "3 scans sent") == 0);
  }

  // Wi-Fi connected to a captive portal returns HTTP 200, but that is not an
  // attendance receipt: retain the scan and never say SENT.
  responseMode = PORTAL;
  const String fourth = save(54, "Aster", 4, 1790000180UL);
  assert(waitForRequests(4));
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  OfflineQueue::Head head;
  assert(queue.peek(head) == OfflineQueue::READY);
  { std::lock_guard<std::mutex> lock(noticeMutex); assert(delivered.size() == 1); }
  // The next wake immediately retries a retained head, without another 10 s wait.
  responseMode = GOOD;
  wakeDeliveryTask();
  assert(waitForNotices(2));
  { std::lock_guard<std::mutex> lock(serverMutex); assert(committed.count(fourth.c_str()) == 1); }

  // Lost response: the server committed, but the local cursor must not advance
  // until the duplicate receipt arrives. Exactly one server event is credited.
  size_t requestsBeforeLostReply;
  { std::lock_guard<std::mutex> lock(serverMutex); requestsBeforeLostReply = requests.size(); }
  responseMode = LOST_REPLY;
  const String fifth = save(55, "Liya", 5, 1790000240UL);
  assert(waitForRequests(requestsBeforeLostReply + 1));
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  assert(queue.peek(head) == OfflineQueue::READY);
  responseMode = GOOD;
  wakeDeliveryTask();
  assert(waitForNotices(3));
  { std::lock_guard<std::mutex> lock(serverMutex); assert(committed.count(fifth.c_str()) == 1 && committed.size() == 5); }

  // An online scan wakes the waiting task immediately, not after its idle poll.
  const auto began = std::chrono::steady_clock::now();
  save(56, "Beti", 6, 1790000300UL);
  assert(waitForNotices(4, 900));
  assert(std::chrono::steady_clock::now() - began < std::chrono::milliseconds(900));

  // Earlier same-boot scans wait for their real anchor, then sync on wake.
  save(57, "Tigist", 7, 0);
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  assert(queueStatus == QUEUE_CLOCK_WAIT);
  assert(queue.saveClockAnchor(bootId, 1790000400UL, 400));
  wakeDeliveryTask();
  assert(waitForNotices(5));
  { std::lock_guard<std::mutex> lock(noticeMutex); assert(delivered[4].scannedAt == 1790000100U); }

  // Associated Wi-Fi can outlive an unreachable website. Recovery must happen
  // on the retry timer even when no one performs another scan or manual wake.
  size_t beforeDown;
  { std::lock_guard<std::mutex> lock(serverMutex); beforeDown = requests.size(); }
  responseMode = SERVER_DOWN;
  const String eighth = save(58, "Selam", 8, 1790000500UL);
  assert(waitForRequests(beforeDown + 1));
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  assert(queue.peek(head) == OfflineQueue::READY);
  responseMode = GOOD;
  assert(waitForNotices(6, 4500)); // no wake
  { std::lock_guard<std::mutex> lock(serverMutex); assert(committed.count(eighth.c_str()) == 1); }

  // 10 registered employees scan while offline (plus 1 unmapped sensor slot in
  // the middle): when Wi-Fi returns, ONE single batch HTTP POST commits all 10
  // employees together without head-of-line blocking or 1-by-1 LCD cycling.
  wifiUp = false;
  std::this_thread::sleep_for(std::chrono::milliseconds(60));
  size_t postsBeforeTen = 0;
  size_t noticesBeforeTen = 0;
  { std::lock_guard<std::mutex> lock(serverMutex); postsBeforeTen = httpPosts; }
  { std::lock_guard<std::mutex> lock(noticeMutex); noticesBeforeTen = delivered.size(); }
  std::vector<String> tenIds;
  for (int i = 0; i < 10; ++i) {
    if (i == 4) save(999, "ID 999", 0, 1790001000UL + static_cast<unsigned long>(i) * 30UL);
    tenIds.push_back(save(101 + i, "Staff", 101 + i, 1790001010UL + static_cast<unsigned long>(i) * 30UL));
  }
  wifiUp = true;
  wakeDeliveryTask();
  assert(waitForNotices(noticesBeforeTen + 1, 2200));
  std::this_thread::sleep_for(std::chrono::milliseconds(80));
  assert(queue.peek(head) == OfflineQueue::EMPTY);
  assert(queueNeedsReview.load());
  {
    std::lock_guard<std::mutex> lock(serverMutex);
    assert(httpPosts == postsBeforeTen + 1);
    for (const auto &eid : tenIds) assert(committed.count(eid.c_str()) == 1);
  }
  {
    std::lock_guard<std::mutex> lock(noticeMutex);
    assert(delivered.size() == noticesBeforeTen + 1);
    assert(delivered.back().kind == DELIVERY_BATCH);
    assert(std::strcmp(delivered.back().name, "10 scans sent") == 0);
  }
  assert(!fs.exists("/queue.json") && !fs.exists("/queue.cursor"));

  // 20 stored offline fingerprints: all 20 upload together in ONE batch POST
  // when Wi-Fi returns, and the device queue files are deleted immediately so
  // flash stays empty and fast for the next offline outage.
  wifiUp = false;
  std::this_thread::sleep_for(std::chrono::milliseconds(60));
  size_t postsBeforeTwenty = 0;
  size_t noticesBeforeTwenty = 0;
  { std::lock_guard<std::mutex> lock(serverMutex); postsBeforeTwenty = httpPosts; }
  { std::lock_guard<std::mutex> lock(noticeMutex); noticesBeforeTwenty = delivered.size(); }
  std::vector<String> twentyIds;
  for (int i = 0; i < 20; ++i) {
    twentyIds.push_back(save(201 + i, "Employee", 201 + i, 1790002000UL + static_cast<unsigned long>(i) * 15UL));
  }
  assert(fs.exists("/queue.json"));
  wifiUp = true;
  wakeDeliveryTask();
  assert(waitForNotices(noticesBeforeTwenty + 1, 2200));
  std::this_thread::sleep_for(std::chrono::milliseconds(80));
  assert(queue.peek(head) == OfflineQueue::EMPTY);
  assert(!fs.exists("/queue.json") && !fs.exists("/queue.cursor"));
  {
    std::lock_guard<std::mutex> lock(serverMutex);
    assert(httpPosts == postsBeforeTwenty + 1);
    for (const auto &eid : twentyIds) assert(committed.count(eid.c_str()) == 1);
  }
  {
    std::lock_guard<std::mutex> lock(noticeMutex);
    assert(delivered.size() == noticesBeforeTwenty + 1);
    assert(delivered.back().kind == DELIVERY_BATCH);
    assert(std::strcmp(delivered.back().name, "20 scans sent") == 0);
  }

  { std::lock_guard<std::mutex> lock(notifyMutex); stopTask = true; notifyCondition.notify_all(); }
  worker.join();
  std::cout << "Queue delivery tests passed: offline scans, reconnect, online wake, bad 200, lost reply, automatic retry and clock anchor\n";
}
