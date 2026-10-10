#ifndef WIFI_H_STUB
#define WIFI_H_STUB
#include <Arduino.h>
#define WL_CONNECTED 3
#define WL_DISCONNECTED 6
class WiFiClass {
public:
  int status() { return WL_CONNECTED; }
  IPAddress localIP() { return IPAddress(); }
};
extern WiFiClass WiFi;
#endif
