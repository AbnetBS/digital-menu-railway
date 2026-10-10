#pragma once
#include <Arduino.h>
class WebServer {
 public:
  explicit WebServer(int) {}
  void on(const char *, void (*)()) {}
  void begin() {}
  void handleClient() {}
  void send(int, const char *, const String &) {}
  bool hasArg(const char *) { return false; }
  String arg(const char *) { return String(); }
};
