#pragma once
// Minimal test double for the public Adafruit packet-writer API. Production
// builds use the actual Adafruit Fingerprint Sensor Library, not this file.
#include "Arduino.h"
#define FINGERPRINT_OK 0x00
#define FINGERPRINT_PACKETRECIEVEERR 0x01
#define FINGERPRINT_NOFINGER 0x02
#define FINGERPRINT_IMAGEFAIL 0x03
#define FINGERPRINT_IMAGEMESS 0x06
#define FINGERPRINT_FEATUREFAIL 0x07
#define FINGERPRINT_NOMATCH 0x08
#define FINGERPRINT_NOTFOUND 0x09
#define FINGERPRINT_ENROLLMISMATCH 0x0A
#define FINGERPRINT_BADLOCATION 0x0B
#define FINGERPRINT_DBRANGEFAIL 0x0C
#define FINGERPRINT_INVALIDIMAGE 0x15
#define FINGERPRINT_FLASHERR 0x18
#define FINGERPRINT_COMMANDPACKET 0x01
#define FINGERPRINT_ACKPACKET 0x07
#define FINGERPRINT_GETIMAGE 0x01
#define FINGERPRINT_IMAGE2TZ 0x02
#define FINGERPRINT_REGMODEL 0x05
#define FINGERPRINT_STORE 0x06
#define FINGERPRINT_DELETE 0x0C
#define FINGERPRINT_EMPTY 0x0D
#define FINGERPRINT_READSYSPARAM 0x0F
#define FINGERPRINT_VERIFYPASSWORD 0x13
#define FINGERPRINT_HISPEEDSEARCH 0x1B
#define FINGERPRINT_TEMPLATECOUNT 0x1D
#define FINGERPRINT_LEDON 0x50

struct Adafruit_Fingerprint_Packet {
  uint8_t type;
  uint16_t length;
  uint8_t data[64];
  Adafruit_Fingerprint_Packet(uint8_t t, uint16_t n, uint8_t *p) : type(t), length(n) {
    std::memcpy(data, p, n);
  }
};

class Adafruit_Fingerprint {
 public:
  explicit Adafruit_Fingerprint(Stream *s) : stream_(s) {}
  void writeStructuredPacket(const Adafruit_Fingerprint_Packet &p) {
    stream_->write(0xEF); stream_->write(0x01);
    for (int i = 0; i < 4; i++) stream_->write(0xFF);
    const uint16_t length = p.length + 2;
    stream_->write(p.type);
    stream_->write(uint8_t(length >> 8)); stream_->write(uint8_t(length));
    uint16_t sum = p.type + (length >> 8) + (length & 0xFF);
    for (uint16_t i = 0; i < p.length; i++) { stream_->write(p.data[i]); sum += p.data[i]; }
    stream_->write(uint8_t(sum >> 8)); stream_->write(uint8_t(sum));
  }
 private:
  Stream *stream_;
};
