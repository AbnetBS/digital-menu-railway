#ifndef HTTPCLIENT_H_STUB
#define HTTPCLIENT_H_STUB
#include <Arduino.h>
// Scripted transport: the harness queues replies per URL.
class WiFiClient : public Stream {
public:
  std::deque<uint8_t> rx;
  bool isConnected = false;
  int available() override { return (int)rx.size(); }
  int read() override { if (rx.empty()) return -1; uint8_t b = rx.front(); rx.pop_front(); return b; }
  size_t write(const uint8_t *, size_t n) override { return n; }
  bool connected() { return isConnected; }
};
struct HttpReply { int code; std::string body; };
extern std::deque<HttpReply> httpQueue;
extern std::deque<std::string> httpCalls;   // "METHOD url payload"
class HTTPClient {
public:
  std::string url, method, payload;
  void setTimeout(int) {}
  void begin(const String &u) { url = u.c_str(); }
  void addHeader(const String &, const String &) {}
  int GET() { method = "GET"; return send(""); }
  int POST(const String &p) { method = "POST"; return send(p.c_str()); }
  String getString() { return String(lastBody); }
  WiFiClient *getStreamPtr() { return &stream; }
  void end() {}
  static String errorToString(int c) { return String(c); }
  WiFiClient stream;
  std::string lastBody;
private:
  int send(const std::string &p) {
    payload = p;
    httpCalls.push_back(method + " " + url + " " + p);
    if (httpQueue.empty()) return -1;
    HttpReply r = httpQueue.front();
    httpQueue.pop_front();
    lastBody = r.body;
    stream.isConnected = (r.code == 200);
    return r.code;
  }
};
#endif
