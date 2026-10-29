#pragma once
#include <cstdint>
#include <cstddef>
#include <cstring>

using boolean = bool;
unsigned long millis();
void delay(unsigned long ms);

class Stream {
 public:
  virtual ~Stream() = default;
  virtual int available() = 0;
  virtual int read() = 0;
  virtual size_t write(uint8_t byte) = 0;
};

class HardwareSerial : public Stream {
 public:
  void begin(uint32_t) {}
};
