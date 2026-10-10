#pragma once
#include <Arduino.h>
#define WL_CONNECTED 3
#define WL_DISCONNECTED 6
#define WIFI_STA 1
extern bool g_wifiUp;
extern std::deque<char> g_sseFeed;
class IPAddress {
 public:
  String toString() const { return String("192.168.1.50"); }
};
class WiFiClient {
 public:
  bool isOpen = false;
  std::deque<char> *feed = nullptr;
  virtual ~WiFiClient() {}
  bool connected() { return isOpen && g_wifiUp; }
  int available() { return (feed && connected()) ? (int)feed->size() : 0; }
  int read() {
    if (!feed || feed->empty()) return -1;
    char c = feed->front();
    feed->pop_front();
    return (unsigned char)c;
  }
  void stop() { isOpen = false; feed = nullptr; }
};
class WiFiClass {
 public:
  int status() { return g_wifiUp ? WL_CONNECTED : WL_DISCONNECTED; }
  void mode(int) {}
  void setAutoReconnect(bool) {}
  int begin() { return status(); }
  bool reconnect() { return true; }
  IPAddress localIP() { return IPAddress(); }
};
extern WiFiClass WiFi;
