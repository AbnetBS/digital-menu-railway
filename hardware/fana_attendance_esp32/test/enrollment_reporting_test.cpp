// run_host_tests.py inserts the actual failure-report/retry functions.
// HTTP, Wi-Fi, JSON and time are test doubles; no physical device is used.
#include <ArduinoJson.h>
#include <cassert>
#include <cstdint>
#include <iostream>
#include <string>

#define SERVER_TIMEOUT_MS 8000
#define WL_CONNECTED 3
static uint32_t nowMs = 0;
static uint32_t millis() { return nowMs; }
static bool wifiConnected = false;
struct WifiStub { int status() const { return wifiConnected ? WL_CONNECTED : 0; } } WiFi;
struct SerialStub {
  template <class T> void print(const T &) {}
  template <class T> void println(const T &) {}
} Serial;
static int pendingFailureJobId = 0;
static String pendingFailureReason;
static uint32_t pendingFailureRetryAt = 0;
static int calls = 0;
static int responseMode = 0; // 0=connection error, 1=portal 200, 2=wrong ID, 3=valid receipt
static int lastJob = 0;
static String lastReason;
class HTTPClient {
 public:
  void setTimeout(int) {}
  int POST(const String &body) {
    DynamicJsonDocument request(512);
    assert(!deserializeJson(request, body));
    assert(std::string(request["action"] | "") == "job_failed");
    lastJob = request["jobId"] | 0;
    lastReason = String(request["reason"] | "");
    ++calls;
    if (responseMode == 0) return -1;
    if (responseMode == 1) { reply_ = "<html>WiFi login</html>"; return 200; }
    const int replyId = responseMode == 2 ? lastJob + 1 : lastJob;
    reply_ = String(std::string("{\"success\":true,\"jobId\":") + std::to_string(replyId) + "}");
    return 200;
  }
  String getString() const { return reply_; }
  void end() {}
 private:
  String reply_;
};
static void beginServerRequest(HTTPClient &, const String &) {}
static void addDeviceHeaders(HTTPClient &) {}
void retryPendingEnrollmentFailure();
// -- INSERT REAL ENROLLMENT FAILURE REPORTING --

int main() {
  // Recording an error while offline must not lose the reason or call HTTP.
  reportJobFailed(17, String("sensor did not answer"));
  assert(pendingFailureJobId == 17 && calls == 0);
  wifiConnected = true;
  retryPendingEnrollmentFailure(); // connection fails
  assert(calls == 1 && pendingFailureJobId == 17 && lastJob == 17);
  nowMs += 4999;
  retryPendingEnrollmentFailure();
  assert(calls == 1); // no busy retry loop
  responseMode = 1;
  nowMs++;
  retryPendingEnrollmentFailure(); // unrelated HTTP 200 is not confirmation
  assert(calls == 2 && pendingFailureJobId == 17);
  responseMode = 2;
  nowMs += 5000;
  retryPendingEnrollmentFailure(); // wrong job receipt is not confirmation
  assert(calls == 3 && pendingFailureJobId == 17);
  responseMode = 3;
  nowMs += 5000;
  retryPendingEnrollmentFailure();
  assert(calls == 4 && pendingFailureJobId == 0);
  assert(lastReason == String("sensor did not answer"));
  retryPendingEnrollmentFailure();
  assert(calls == 4);
  std::cout << "Enrollment reporting passed: offline retry, captive portal, wrong job and verified acknowledgement\n";
}
