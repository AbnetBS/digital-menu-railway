#include <Arduino.h>
#include <esp_sleep.h>
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
/* The wall clock of the idle screen: a fixed 14:05:30 unless a test moves it,
 * so "the screen is not redrawn while it is unchanged" stays deterministic. */
bool stubTimeValid = true;
int  stubHour = 14;
int  stubMinute = 5;
int  stubSecond = 30;
void (*screenHook)(const std::string &) = nullptr;

// ── the rest windows' deep sleep, recorded not performed (stub/esp_sleep.h) ─
uint64_t stubSleepUs = 0;
int stubDeepSleepCalls = 0;

// ── WiFiManager's timeouts, as the sketch set them ─────────────────────────
int stubWmConnectTimeoutSec = -1;
unsigned long stubWmConfigPortalTimeoutSec = 0;
