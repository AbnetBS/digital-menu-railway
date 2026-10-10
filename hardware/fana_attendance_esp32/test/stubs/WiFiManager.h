#pragma once
#include <WiFi.h>
class WiFiManager {
 public:
  bool getWiFiIsSaved() { return true; }
  void setConfigPortalTimeout(int) {}
  bool autoConnect(const char *, const char *) { return g_wifiUp; }
  void resetSettings() {}
};
