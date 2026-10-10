#pragma once
#include <WiFi.h>
// Routes every request to the fake server of the test. Counts new
// connections so the test can prove the keep-alive connection is reused.
typedef std::function<int(const std::string &method, const std::string &url, const std::string &body,
                          const std::map<std::string, std::string> &headers, std::string &response)> FakeServerFn;
extern FakeServerFn g_fakeServer;
extern int g_newConnections;
class HTTPClient {
 public:
  WiFiClient *client = nullptr;
  std::string url, response;
  std::map<std::string, std::string> headers;
  bool reuse = true;
  bool begin(WiFiClient &c, const String &u) {
    client = &c;
    url = u.s;
    headers.clear();
    return true;
  }
  void setReuse(bool r) { reuse = r; }
  void setConnectTimeout(int) {}
  void setTimeout(uint16_t) {}
  void addHeader(const String &k, const String &v) { headers[k.s] = v.s; }
  int GET() { return send("GET", ""); }
  int POST(const String &b) { return send("POST", b.s); }
  int send(const char *method, const std::string &body) {
    if (!g_wifiUp || !client) return -1;
    if (!client->isOpen) {
      client->isOpen = true;
      g_newConnections++;
    }
    response.clear();
    int code = g_fakeServer(method, url, body, headers, response);
    if (code < 0) client->stop();
    if (code == 200 && url.find("/events") != std::string::npos) client->feed = &g_sseFeed;
    return code;
  }
  String getString() { return String(response); }
  WiFiClient *getStreamPtr() { return client; }
  void end() { if (!reuse && client) client->stop(); }
  static String errorToString(int code) { return String("error ") + String(code); }
};
