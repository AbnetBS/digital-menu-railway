// Minimal host-side Arduino stub so the Biovo1020A library can be compiled
// and unit-tested on a PC with g++ (no Arduino hardware needed).
#ifndef ARDUINO_H_STUB
#define ARDUINO_H_STUB

#include <cstdint>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <deque>
#include <vector>
#include <initializer_list>

#define highByte(x) ((uint8_t)(((x) >> 8) & 0xFF))
#define lowByte(x)  ((uint8_t)((x) & 0xFF))

static unsigned long _stub_millis = 0;
static inline unsigned long millis() { return _stub_millis; }
static inline void delay(unsigned long ms) { _stub_millis += ms; }

class Stream {
public:
  virtual ~Stream() {}
  virtual int available() = 0;
  virtual int read() = 0;
  virtual size_t write(const uint8_t *buf, size_t n) = 0;
  virtual void flush() {}
  size_t write(uint8_t b) { return write(&b, 1); }
};

// Scripted serial port. Bytes queued with feed() are what the "sensor" sends;
// replyOnWrite is queued automatically when the library writes a command
// (models a sensor that answers after receiving a command).
class FakeSerial : public Stream {
public:
  std::deque<uint8_t> rx;
  std::vector<uint8_t> tx;
  std::vector<uint8_t> replyOnWrite;

  int available() override { return (int)rx.size(); }
  int read() override {
    if (rx.empty()) return -1;
    uint8_t b = rx.front();
    rx.pop_front();
    return b;
  }
  size_t write(const uint8_t *buf, size_t n) override {
    tx.insert(tx.end(), buf, buf + n);
    for (uint8_t b : replyOnWrite) rx.push_back(b);
    return n;
  }
  void feed(std::initializer_list<uint8_t> bytes) {
    for (uint8_t b : bytes) rx.push_back(b);
  }
};

#endif
