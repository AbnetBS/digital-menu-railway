#ifndef WIFI_H_STUB
#define WIFI_H_STUB
#include <Arduino.h>
#define WL_CONNECTED 3
#define WL_DISCONNECTED 6
// Set by the harness (test/globals.cpp): WL_CONNECTED unless a test asks
// for the offline screen.
extern int stubWifiStatus;
class WiFiClass {
public:
  int status() { return stubWifiStatus; }
  IPAddress localIP() { return IPAddress(); }
};
extern WiFiClass WiFi;
#endif
