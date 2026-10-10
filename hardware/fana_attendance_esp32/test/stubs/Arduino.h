// Host-side stand-in for the Arduino/ESP32 core, used ONLY by the PC tests in
// hardware/fana_attendance_esp32/test. It is never uploaded to the device.
// Time is virtual: delay() advances a simulated clock and lets the simulated
// fingerprint module and the "network task" run.
#pragma once

#include <algorithm>
#include <cctype>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <functional>
#include <map>
#include <string>
#include <vector>

/* ── virtual clock ─────────────────────────────────────────────────────── */
extern uint64_t g_nowMs;
void simTick();   // provided by the test: advances the simulated module / net task
inline unsigned long millis() { return (unsigned long)g_nowMs; }
inline void delay(unsigned long ms) {
  if (ms == 0) ms = 1;
  for (unsigned long i = 0; i < ms; i++) {
    g_nowMs++;
    simTick();
  }
}
inline void yield() { delay(1); }

#define HIGH 1
#define LOW 0
#define OUTPUT 1
#define INPUT 0
extern int g_pinState[64];
inline void pinMode(int, int) {}
inline void digitalWrite(int pin, int v) { g_pinState[pin & 63] = v; }
inline int digitalRead(int pin) { return g_pinState[pin & 63]; }
#define highByte(w) ((uint8_t)((w) >> 8))
#define lowByte(w) ((uint8_t)((w) & 0xff))
inline uint32_t esp_random() { return 0xC0FFEE42u; }   // > 2^31 on purpose

/* ── String (subset of the Arduino API used by the sketch / ArduinoJson) ── */
class String {
 public:
  std::string s;
  String() {}
  String(const char *c) : s(c ? c : "") {}
  String(const std::string &v) : s(v) {}
  String(char c) : s(1, c) {}
  String(int v) : s(std::to_string(v)) {}
  String(unsigned int v) : s(std::to_string(v)) {}
  String(long v) : s(std::to_string(v)) {}
  String(unsigned long v) : s(std::to_string(v)) {}
  String(long long v) : s(std::to_string(v)) {}
  String(unsigned long long v) : s(std::to_string(v)) {}
  String(short v) : s(std::to_string(v)) {}
  String(unsigned short v) : s(std::to_string(v)) {}
  String(unsigned char v) : s(std::to_string(v)) {}
  String(double v) : s(std::to_string(v)) {}
  size_t length() const { return s.size(); }   // size_t == unsigned int on the ESP32
  const char *c_str() const { return s.c_str(); }
  String substring(unsigned a) const { return a >= s.size() ? String() : String(s.substr(a)); }
  String substring(unsigned a, unsigned b) const {
    if (a >= s.size() || b <= a) return String();
    return String(s.substr(a, b - a));
  }
  long toInt() const { return atol(s.c_str()); }
  void trim() {
    size_t a = s.find_first_not_of(" \t\r\n");
    size_t b = s.find_last_not_of(" \t\r\n");
    s = (a == std::string::npos) ? "" : s.substr(a, b - a + 1);
  }
  bool startsWith(const String &p) const { return s.rfind(p.s, 0) == 0; }
  bool equalsIgnoreCase(const String &o) const {
    if (o.s.size() != s.size()) return false;
    for (size_t i = 0; i < s.size(); i++)
      if (tolower((unsigned char)s[i]) != tolower((unsigned char)o.s[i])) return false;
    return true;
  }
  int indexOf(char c) const { size_t p = s.find(c); return p == std::string::npos ? -1 : (int)p; }
  int indexOf(char c, unsigned from) const { size_t p = s.find(c, from); return p == std::string::npos ? -1 : (int)p; }
  int indexOf(const String &t) const { size_t p = s.find(t.s); return p == std::string::npos ? -1 : (int)p; }
  bool concat(const char *c) { if (c) s += c; return true; }
  bool concat(const char *c, unsigned n) { if (c) s.append(c, n); return true; }
  bool concat(char c) { s += c; return true; }
  bool concat(const String &o) { s += o.s; return true; }
  bool reserve(unsigned n) { s.reserve(n); return true; }
  char operator[](unsigned i) const { return i < s.size() ? s[i] : 0; }
  String &operator+=(const String &o) { s += o.s; return *this; }
  String &operator+=(const char *c) { if (c) s += c; return *this; }
  String &operator+=(char c) { s += c; return *this; }
  bool operator==(const String &o) const { return s == o.s; }
  bool operator==(const char *c) const { return s == (c ? c : ""); }
  bool operator!=(const String &o) const { return s != o.s; }
  bool operator!=(const char *c) const { return s != (c ? c : ""); }
  bool operator<(const String &o) const { return s < o.s; }
};
inline String operator+(const String &a, const String &b) { return String(a.s + b.s); }
inline String operator+(const String &a, const char *b) { return String(a.s + (b ? b : "")); }
inline String operator+(const char *a, const String &b) { return String(std::string(a ? a : "") + b.s); }
inline String operator+(const String &a, char b) { return String(a.s + b); }

/* ── Stream / Print ────────────────────────────────────────────────────── */
class Print {
 public:
  virtual ~Print() {}
  virtual size_t write(uint8_t b) = 0;
  virtual size_t write(const uint8_t *buf, size_t n) {
    for (size_t i = 0; i < n; i++) write(buf[i]);
    return n;
  }
  size_t print(const String &v) { return write((const uint8_t *)v.c_str(), v.length()); }
  size_t print(const char *v) { return print(String(v)); }
  size_t print(int v) { return print(String(v)); }
  size_t print(unsigned v) { return print(String(v)); }
  size_t print(long v) { return print(String(v)); }
  size_t print(unsigned long v) { return print(String(v)); }
  template <typename T, typename = decltype(&T::toString)> size_t print(const T &v) { return print(v.toString()); }   // Printable (IPAddress)
  size_t println() { return print("\n"); }
  template <typename T> size_t println(const T &v) { size_t n = print(v); return n + print("\n"); }
  size_t printf(const char *fmt, ...) {
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    return print((const char *)buf);
  }
};

class Stream : public Print {
 public:
  virtual int available() = 0;
  virtual int read() = 0;
  virtual void flush() {}
  using Print::write;
  String readString() {
    String r;
    while (available() > 0) r += (char)read();
    return r;
  }
  String readStringUntil(char t) {
    String r;
    while (available() > 0) {
      int c = read();
      if (c == t) break;
      r += (char)c;
    }
    return r;
  }
};

/* ── Serial (console) ──────────────────────────────────────────────────── */
class ConsoleSerial : public Stream {
 public:
  std::string input;
  std::string log;
  bool echo = false;
  void begin(unsigned long) {}
  size_t write(uint8_t b) override {
    log += (char)b;
    if (echo) fputc(b, stdout);
    return 1;
  }
  int available() override { return (int)input.size(); }
  int read() override {
    if (input.empty()) return -1;
    int c = (unsigned char)input[0];
    input.erase(0, 1);
    return c;
  }
};
extern ConsoleSerial Serial;

/* ── HardwareSerial wired to the simulated FPC1020A ────────────────────── */
#define SERIAL_8N1 0x800001c
struct SimWire {   // implemented by the test
  virtual void hostWrote(const uint8_t *buf, size_t n) = 0;
  std::deque<uint8_t> toHost;
  virtual ~SimWire() {}
};
extern SimWire *g_sensorWire;
class HardwareSerial : public Stream {
 public:
  explicit HardwareSerial(int) {}
  void begin(unsigned long, uint32_t = SERIAL_8N1, int = -1, int = -1) {}
  int available() override { return g_sensorWire ? (int)g_sensorWire->toHost.size() : 0; }
  int read() override {
    if (!g_sensorWire || g_sensorWire->toHost.empty()) return -1;
    uint8_t b = g_sensorWire->toHost.front();
    g_sensorWire->toHost.pop_front();
    return b;
  }
  size_t write(uint8_t b) override { return write(&b, 1); }
  size_t write(const uint8_t *buf, size_t n) override {
    if (g_sensorWire) g_sensorWire->hostWrote(buf, n);
    return n;
  }
};

/* ── ESP object ────────────────────────────────────────────────────────── */
struct EspClass {
  uint32_t getFreeHeap() { return 150000; }
  void restart() {}
};
extern EspClass ESP;

/* ── FreeRTOS (single-threaded stand-ins) ──────────────────────────────── */
typedef int BaseType_t;
typedef uint32_t TickType_t;
#define pdTRUE 1
#define pdFALSE 0
#define portMAX_DELAY 0xffffffffu
#define pdMS_TO_TICKS(x) ((TickType_t)(x))
struct SimQueue {
  size_t itemSize;
  size_t capacity;
  std::deque<std::vector<uint8_t>> items;
};
typedef SimQueue *QueueHandle_t;
typedef int *SemaphoreHandle_t;
typedef void *TaskHandle_t;
inline QueueHandle_t xQueueCreate(size_t len, size_t size) { return new SimQueue{size, len, {}}; }
inline BaseType_t xQueueSend(QueueHandle_t q, const void *item, TickType_t) {
  if (q->items.size() >= q->capacity) return pdFALSE;
  const uint8_t *p = (const uint8_t *)item;
  q->items.push_back(std::vector<uint8_t>(p, p + q->itemSize));
  return pdTRUE;
}
inline BaseType_t xQueueReceive(QueueHandle_t q, void *out, TickType_t) {
  if (q->items.empty()) return pdFALSE;
  memcpy(out, q->items.front().data(), q->itemSize);
  q->items.pop_front();
  return pdTRUE;
}
inline unsigned uxQueueMessagesWaiting(QueueHandle_t q) { return (unsigned)q->items.size(); }
inline SemaphoreHandle_t xSemaphoreCreateMutex() { return new int(0); }
inline BaseType_t xSemaphoreTake(SemaphoreHandle_t m, TickType_t) {
  if (*m) { fprintf(stderr, "DEADLOCK: mutex taken twice\n"); abort(); }
  *m = 1;
  return pdTRUE;
}
inline BaseType_t xSemaphoreGive(SemaphoreHandle_t m) { *m = 0; return pdTRUE; }
typedef void (*TaskFunction_t)(void *);
extern TaskFunction_t g_netTaskFn;
inline BaseType_t xTaskCreatePinnedToCore(TaskFunction_t fn, const char *, uint32_t, void *, int, TaskHandle_t *, int) {
  g_netTaskFn = fn;   // not started: the test drives netStep() from simTick()
  return pdTRUE;
}
