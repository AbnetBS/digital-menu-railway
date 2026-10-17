#ifndef WIFIMANAGER_H_STUB
#define WIFIMANAGER_H_STUB
#include <Arduino.h>
/* Enough of WiFiManager to compile and to assert on. The two setters are
 * recorded, because "the setup hotspot may never block the loop for ever" is a
 * behaviour the sketch has to keep: while autoConnect() waits, nothing is
 * scanned at all. Signatures match the real library (v1 and v2 both take an int
 * for the per-attempt timeout and an unsigned long for the portal one). */
extern int stubWmConnectTimeoutSec;
extern unsigned long stubWmConfigPortalTimeoutSec;

class WiFiManager {
public:
  bool autoConnect(const char *, const char *) { return true; }
  void resetSettings() {}
  void setConnectTimeout(int seconds) { stubWmConnectTimeoutSec = seconds; }
  void setConfigPortalTimeout(unsigned long seconds) { stubWmConfigPortalTimeoutSec = seconds; }
};
#endif
