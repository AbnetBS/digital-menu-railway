// Host stubs so the ESP32 sketch can be TYPE-CHECKED with g++ (no hardware).
#ifndef ARDUINO_H_STUB
#define ARDUINO_H_STUB
#include <cstdint>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <string>
#include <deque>
#include <vector>
#include <initializer_list>
#include <iostream>
#include <type_traits>

#define HIGH 1
#define LOW  0
#define OUTPUT 1
#define INPUT 0
#define LED_BUILTIN 2
#define SSD1306_SWITCHCAPVCC 0x2
#define SERIAL_8N1 0
#define min(a,b) ((a)<(b)?(a):(b))
#define max(a,b) ((a)>(b)?(a):(b))
#define highByte(x) ((uint8_t)(((x) >> 8) & 0xFF))
#define lowByte(x)  ((uint8_t)((x) & 0xFF))
#define F(x) (x)

static unsigned long _stub_millis = 0;
static inline unsigned long millis() { return _stub_millis; }
static inline void delay(unsigned long ms) { _stub_millis += ms; }
static inline void pinMode(int, int) {}
static inline void digitalWrite(int, int) {}
static inline int digitalRead(int) { return 0; }
static inline long map(long x, long a, long b, long c, long d) { return (x-a)*(d-c)/(b-a)+c; }

// ── Arduino String ─────────────────────────────────────────────────────────
class String {
public:
  std::string s;
  String() {}
  String(const char *c) : s(c ? c : "") {}
  String(const std::string &c) : s(c) {}
  String(int v) { char b[24]; snprintf(b, sizeof(b), "%d", v); s = b; }
  String(unsigned int v) { char b[24]; snprintf(b, sizeof(b), "%u", v); s = b; }
  String(long v) { char b[24]; snprintf(b, sizeof(b), "%ld", v); s = b; }
  String(unsigned long v) { char b[24]; snprintf(b, sizeof(b), "%lu", v); s = b; }
  String(float v) { char b[24]; snprintf(b, sizeof(b), "%f", v); s = b; }

  unsigned int length() const { return (unsigned int)s.size(); }
  const char *c_str() const { return s.c_str(); }
  String substring(unsigned int from) const { return String(s.substr(from > s.size() ? s.size() : from)); }
  String substring(unsigned int from, unsigned int to) const {
    if (from > s.size()) from = (unsigned int)s.size();
    if (to > s.size()) to = (unsigned int)s.size();
    if (to < from) to = from;
    return String(s.substr(from, to - from));
  }
  bool startsWith(const String &o) const { return s.compare(0, o.s.size(), o.s) == 0; }
  bool endsWith(const String &o) const {
    return s.size() >= o.s.size() && s.compare(s.size() - o.s.size(), o.s.size(), o.s) == 0;
  }
  void trim() {
    size_t a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) { s.clear(); return; }
    size_t b = s.find_last_not_of(" \t\r\n");
    s = s.substr(a, b - a + 1);
  }
  void toLowerCase() { for (auto &c : s) c = (char)tolower(c); }
  long toInt() const { return atol(s.c_str()); }
  float toFloat() const { return (float)atof(s.c_str()); }
  int compareTo(const String &o) const { return s.compare(o.s); }
  bool equals(const String &o) const { return s == o.s; }
  bool equalsIgnoreCase(const String &o) const { return toLowerCopy(s) == toLowerCopy(o.s); }
  void replace(const String &a, const String &b) {
    size_t p = 0;
    while ((p = s.find(a.s, p)) != std::string::npos) { s.replace(p, a.s.size(), b.s); p += b.s.size(); }
  }
  char operator[](unsigned int i) const { return s[i]; }
  char &operator[](unsigned int i) { return s[i]; }
  String &operator+=(const String &o) { s += o.s; return *this; }
  String &operator+=(char c) { s += c; return *this; }
  String &operator=(const String &o) { s = o.s; return *this; }
  bool operator<(const String &o) const { return s < o.s; }

private:
  static std::string toLowerCopy(std::string v) { for (auto &c : v) c = (char)tolower(c); return v; }
};
static inline bool operator==(const String &a, const String &b) { return a.s == b.s; }
static inline bool operator!=(const String &a, const String &b) { return a.s != b.s; }
static inline bool operator==(const String &a, const char *b) { return a.s == (b ? b : ""); }
static inline bool operator==(const char *a, const String &b) { return b == a; }
static inline bool operator!=(const String &a, const char *b) { return !(a == b); }
static inline bool operator!=(const char *a, const String &b) { return !(b == a); }
static inline String operator+(const String &a, const String &b) { return String(a.s + b.s); }
static inline String operator+(const char *a, const String &b) { return String(std::string(a) + b.s); }
static inline String operator+(const String &a, const char *b) { return String(a.s + std::string(b)); }
static inline String operator+(const String &a, int v) { return a + String(v); }
static inline String operator+(int v, const String &a) { return String(v) + a; }
static inline String operator+(const String &a, unsigned long v) { return a + String(v); }
static inline String operator+(const String &a, long v) { return a + String(v); }
static inline String operator+(const String &a, char c) { return a + String(std::string(1, c)); }

class IPAddress {
public:
  std::string toString() const { return "192.168.1.50"; }
  operator String() const { return String(toString()); }
};
class EspClass {
public:
  void restart() {}
  void delay(int) {}
};
extern EspClass ESP;

// ── Stream / Serial ────────────────────────────────────────────────────────
class Stream {
public:
  virtual ~Stream() {}
  virtual int available() = 0;
  virtual int read() = 0;
  virtual size_t write(const uint8_t *buf, size_t n) = 0;
  virtual void flush() {}
  size_t write(uint8_t b) { return write(&b, 1); }
  size_t write(const char *s) { return write((const uint8_t *)s, strlen(s)); }
  void begin(unsigned long) {}
  void begin(unsigned long, uint32_t, int, int) {}
  void end() {}
  template <typename T> typename std::enable_if<std::is_arithmetic<T>::value, void>::type
  print(T v) { std::cout << +v; }
  void print(int v, int base) { printf(base == 16 ? "%X" : "%o", v); }
  void print(const String &s) { fputs(s.c_str(), stdout); }
  void print(const char *s) { fputs(s ? s : "", stdout); }
  void print(char c) { fputc(c, stdout); }
  void print(const IPAddress &ip) { fputs(ip.toString().c_str(), stdout); }
  void println() { fputc('\n', stdout); }
  template <typename T> typename std::enable_if<std::is_arithmetic<T>::value, void>::type
  println(T v) { print(v); println(); }
  void println(int v, int base) { print(v, base); println(); }
  void println(const String &s) { print(s); println(); }
  void println(const char *s) { print(s); println(); }
  void println(char c) { print(c); println(); }
  void println(const IPAddress &ip) { print(ip); println(); }
  String readStringUntil(char) { return String(""); }
  bool operator!() const { return false; }
};

// Set by the test harness: called for every command written to a UART, and it
// appends whatever the simulated device answers.
extern bool (*serialWriteHook)(int portId, const uint8_t *buf, size_t n, std::deque<uint8_t> &rxOut);
// Set by the test harness: called with the text drawn on the OLED.
extern void (*screenHook)(const std::string &line);

class HardwareSerial : public Stream {
public:
  std::deque<uint8_t> rx;
  std::vector<uint8_t> tx;
  std::vector<uint8_t> replyOnWrite;
  int portId;
  explicit HardwareSerial(int id = 0) : portId(id) {}
  int available() override { return (int)rx.size(); }
  int read() override { if (rx.empty()) return -1; uint8_t b = rx.front(); rx.pop_front(); return b; }
  size_t write(const uint8_t *buf, size_t n) override {
    tx.insert(tx.end(), buf, buf + n);
    if (serialWriteHook) serialWriteHook(portId, buf, n, rx);
    for (uint8_t b : replyOnWrite) rx.push_back(b);
    return n;
  }
  void feed(std::initializer_list<uint8_t> bytes) { for (uint8_t b : bytes) rx.push_back(b); }
};
extern HardwareSerial Serial;

// ── Wire / IPAddress ───────────────────────────────────────────────────────
class TwoWire : public Stream {
public:
  void begin(int = -1, int = -1) {}
  int available() override { return 0; }
  int read() override { return -1; }
  size_t write(const uint8_t *, size_t n) override { return n; }
};
extern TwoWire Wire;

#endif
