#pragma once
#include <Arduino.h>
#include <Wire.h>
#define SSD1306_SWITCHCAPVCC 0x02
#define SSD1306_WHITE 1
// Records the text of every frame pushed with display().
extern std::string g_screen;                       // last frame shown
extern std::vector<std::pair<uint64_t, std::string>> g_screens;
class Adafruit_SSD1306 : public Print {
 public:
  std::string frame;
  Adafruit_SSD1306(int, int, TwoWire *, int) {}
  bool begin(int, int) { return true; }
  void clearDisplay() { frame.clear(); }
  void setTextSize(int) {}
  void setTextColor(int) {}
  void setCursor(int, int) { if (!frame.empty() && frame.back() != '|') frame += '|'; }
  size_t write(uint8_t b) override { frame += (char)b; return 1; }
  void drawFastHLine(int, int, int, int) {}
  void fillRect(int, int, int, int, int) { frame += '#'; }
  void drawRect(int, int, int, int, int) { frame += '.'; }
  void display() {
    if (g_screens.empty() || g_screens.back().second != frame) g_screens.push_back({g_nowMs, frame});
    g_screen = frame;
  }
};
