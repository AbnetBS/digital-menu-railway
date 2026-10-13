#include <Arduino.h>
#include <WiFi.h>
#include <hd44780.h>
#include <HTTPClient.h>
#include <LittleFS.h>
HardwareSerial Serial(0);
TwoWire Wire;
WiFiClass WiFi;
LittleFSClass LittleFS;
std::deque<HttpReply> httpQueue;
std::deque<std::string> httpCalls;
std::map<std::string, std::string> littleFsFiles;
EspClass ESP;
bool (*serialWriteHook)(int, const uint8_t *, size_t, std::deque<uint8_t> &) = nullptr;

/* ── the simulated 20x4 LCD (test/stub/hd44780.h) ─────────────────────────── */
char lcdGrid[LCD_STUB_ROWS][LCD_STUB_COLS + 1] = {};
int  lcdClearCalls = 0;
int  lcdWriteCalls = 0;
int  lcdShortRowWrites = 0;
int  lcdWrapHits = 0;
int  lcdCursorRow = 0;
bool lcdBacklightOn = false;
int  lcdBeginStatus = 0;    // 0 = backpack found; set nonzero to simulate none
int  lcdAddress = 0x27;     // what getProp(Prop_addr) reports
int  stubWifiStatus = WL_CONNECTED;
void (*screenHook)(const std::string &) = nullptr;
