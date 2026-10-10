#ifndef GFX_H_STUB
#define GFX_H_STUB
#include <Arduino.h>
extern void (*screenHook)(const std::string &line);
#define SSD1306_WHITE 1
#define SSD1306_BLACK 0
class Adafruit_GFX {
public:
  std::string screen;
  void setTextSize(int) {}
  void setTextColor(int) {}
  void setCursor(int, int) {}
  void clearDisplay() { screen.clear(); }
  void display() {}
  void drawRect(int, int, int, int, int) {}
  void fillRect(int, int, int, int, int) {}
  size_t print(const String &s) { screen += s.c_str(); screen += "\n"; if (screenHook) screenHook(s.c_str()); return s.length(); }
  size_t println(const String &s) { return print(s); }
  size_t print(const char *s) { screen += s; screen += "\n"; return strlen(s); }
  size_t println(const char *s) { return print(s); }
};
#endif
