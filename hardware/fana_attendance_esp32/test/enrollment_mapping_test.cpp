// run_host_tests.py inserts the actual website mapping functions.
// HTTP, Wi-Fi, JSON and time are test doubles; no physical device is used.
#include <ArduinoJson.h>
#include <cassert>
#include <cstdint>
#include <iostream>
#include <string>

#define SERVER_TIMEOUT_MS 8000
#define MAPPING_RETRY_MS 5000
#define WL_CONNECTED 3
static uint32_t nowMs = 0;
static uint32_t millis() { return nowMs; }
static bool wifiConnected = true;
struct WifiStub { int status() const { return wifiConnected ? WL_CONNECTED : 0; } } WiFi;
struct SerialStub {
  template <class T> void print(const T &) {}
  template <class T> void println(const T &) {}
} Serial;
static String deviceId("entrance");
static bool mappingPending = false;
static bool enrollingFromServer = false;
static int mapFingerprintId = 0;
static int mapMemberId = 0;
static int mapJobId = 0;
static String mapMemberName;
static uint32_t mapNextTryMs = 0;
static int responseMode = 0; // 0=portal, 1=wrong finger, 2=wrong member, 3=valid, 4=server error, 5=refused, 6=rate-limited
static int calls = 0;
static int remembered = 0;
static int failedJob = 0;
class HTTPClient {
 public:
  void setTimeout(int) {}
  int POST(const String &body) {
    DynamicJsonDocument request(768);
    assert(!deserializeJson(request, body));
    const int finger = request["fingerprintId"] | 0;
    const int member = request["memberId"] | 0;
    ++calls;
    if (responseMode == 4) return 503;
    if (responseMode == 5) return 409;
    if (responseMode == 6) return 429;
    if (responseMode == 0) { reply_ = "<html>WiFi login</html>"; return 200; }
    const int replyFinger = responseMode == 1 ? finger + 1 : finger;
    const int replyMember = responseMode == 2 ? member + 1 : member;
    reply_ = String(std::string("{\"success\":true,\"fingerprintId\":") + std::to_string(replyFinger) +
                    ",\"memberId\":" + std::to_string(replyMember) + "}");
    return 200;
  }
  String getString() const { return reply_; }
  void end() {}
 private:
  String reply_;
};
static void beginServerRequest(HTTPClient &, const String &) {}
static void addDeviceHeaders(HTTPClient &) {}
static void rememberMapping(int finger, const String &, int member) { assert(finger == 42 && member == 9); ++remembered; }
// The sketch writes the confirmed name back to its offline cache here; the
// test only needs to know it was asked for.
static int cacheWrites = 0;
static bool saveMappingCache() { ++cacheWrites; return true; }
static uint16_t mapPendingTries = 0;
// The sketch gives up on a mapping the website never confirms, otherwise that
// one flag would block every later enrollment. Too high to fire in this test.
static const uint16_t MAPPING_MAX_TRIES = 30;
static void reportJobFailed(int job, const String &reason) { assert(reason == String("website refused the mapping")); failedJob = job; }
// -- INSERT REAL ENROLLMENT MAPPING POST --
// -- INSERT REAL ENROLLMENT MAPPING RETRY --

int main() {
  assert(postMappingToServer(42, 9, String("Test")) == -1); // captive portal
  responseMode = 1;
  assert(postMappingToServer(42, 9, String("Test")) == -1); // wrong finger
  responseMode = 2;
  assert(postMappingToServer(42, 9, String("Test")) == -1); // wrong employee
  responseMode = 3;
  assert(postMappingToServer(42, 9, String("Test")) == 200);
  responseMode = 6;
  assert(postMappingToServer(42, 9, String("Test")) == -1); // transient rate limit
  mappingPending = true;
  mapFingerprintId = 42; mapMemberId = 9; mapJobId = 77; mapMemberName = "Test";
  mapNextTryMs = nowMs;
  responseMode = 4;
  retryPendingMapping();
  assert(mappingPending && remembered == 0 && failedJob == 0);
  const int previousCalls = calls;
  nowMs += MAPPING_RETRY_MS - 1;
  retryPendingMapping();
  assert(calls == previousCalls);
  responseMode = 3;
  nowMs++;
  retryPendingMapping();
  assert(!mappingPending && remembered == 1 && failedJob == 0);
  mappingPending = true; mapNextTryMs = nowMs; responseMode = 5;
  retryPendingMapping();
  assert(!mappingPending && failedJob == 77 && remembered == 1);
  std::cout << "Enrollment mapping passed: verified receipt, retry, owner cache and refusal reporting\n";
}
