#ifndef WEBSERVER_H_STUB
#define WEBSERVER_H_STUB
#include <Arduino.h>
class WebServer {
public:
  WebServer(int = 80) {}
  void on(const char *, void (*)()) {}
  void begin() {}
  void handleClient() {}
  void send(int, const char *, const String &) {}
};
#endif
