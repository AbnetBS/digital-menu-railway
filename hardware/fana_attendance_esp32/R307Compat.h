#pragma once
#include <Adafruit_Fingerprint.h>

/* Compatibility wrapper used by the Fana attendance sketch. It keeps the
 * website/LCD/offline machinery independent of the reader while translating
 * the R307/Adafruit packet protocol into the small status vocabulary the
 * device UI already understands. */
class R307Compat {
 public:
  explicit R307Compat(Stream &serial) : sensor_(&serial), stream_(serial) {}

  void begin() {
    lastStatus_ = sensor_.verifyPassword() ? 0x00 : 0xFF;
    if (lastStatus_ == 0x00) sensor_.getParameters();
  }

  int16_t getCount(uint32_t timeoutMs = 3000) {
    (void)timeoutMs;
    uint8_t r = sensor_.getTemplateCount();
    if (r != FINGERPRINT_OK) { lastStatus_ = mapError(r); return -1; }
    lastStatus_ = 0x00;
    return (int16_t)sensor_.templateCount;
  }

  uint16_t capacity() const { return sensor_.capacity ? sensor_.capacity : 1000; }

  bool search(uint16_t &matchedId, uint8_t &permission, uint32_t timeoutMs) {
    matchedId = 0; permission = 0;
    const uint32_t started = millis();
    uint8_t r = FINGERPRINT_NOFINGER;
    do {
      r = sensor_.getImage();
      if (r == FINGERPRINT_NOFINGER) { delay(35); continue; }
      break;
    } while (millis() - started < timeoutMs);
    if (r == FINGERPRINT_NOFINGER) { lastStatus_ = 0x08; return false; }
    if (r != FINGERPRINT_OK) { lastStatus_ = mapError(r); return false; }
    r = sensor_.image2Tz(1);
    if (r != FINGERPRINT_OK) { lastStatus_ = mapError(r); return false; }
    r = sensor_.fingerFastSearch();
    if (r == FINGERPRINT_OK) {
      matchedId = sensor_.fingerID;
      permission = 1;
      lastStatus_ = 0x00;
      return true;
    }
    lastStatus_ = (r == FINGERPRINT_NOTFOUND) ? 0x05 : mapError(r);
    return false;
  }

  /* R307 enrollment is two fresh placements. Step 1 fills character buffer 1;
   * step 2 fills buffer 2, combines both views and stores the template. */
  bool enroll(uint16_t id, uint8_t step, uint32_t timeoutMs) {
    if (step < 1 || step > 2) { lastStatus_ = 0x01; return false; }
    const uint32_t started = millis();
    uint8_t r = FINGERPRINT_NOFINGER;
    do {
      r = sensor_.getImage();
      if (r == FINGERPRINT_NOFINGER) { delay(40); continue; }
      break;
    } while (millis() - started < timeoutMs);
    if (r == FINGERPRINT_NOFINGER) { lastStatus_ = 0x08; return false; }
    if (r != FINGERPRINT_OK) { lastStatus_ = mapError(r); return false; }
    r = sensor_.image2Tz(step);
    if (r != FINGERPRINT_OK) { lastStatus_ = mapError(r); return false; }
    if (step == 2) {
      r = sensor_.createModel();
      if (r != FINGERPRINT_OK) { lastStatus_ = mapError(r); return false; }
      r = sensor_.storeModel(id);
      if (r != FINGERPRINT_OK) { lastStatus_ = mapError(r); return false; }
    }
    lastStatus_ = 0x00;
    return true;
  }

  bool deleteUser(uint16_t id, uint32_t timeoutMs = 5000) {
    (void)timeoutMs;
    uint8_t r = sensor_.deleteModel(id);
    lastStatus_ = (r == FINGERPRINT_OK) ? 0x00 : mapError(r);
    return r == FINGERPRINT_OK;
  }

  bool deleteAll() {
    uint8_t r = sensor_.emptyDatabase();
    lastStatus_ = (r == FINGERPRINT_OK) ? 0x00 : mapError(r);
    return r == FINGERPRINT_OK;
  }

  uint8_t getLastStatus() const { return lastStatus_; }
  void drain(uint32_t quietMs) {
    while (stream_.available()) stream_.read();
    delay(quietMs);
    while (stream_.available()) stream_.read();
  }

  static const char *statusText(uint8_t s) {
    switch (s) {
      case 0x00: return "OK";
      case 0x01: return "Command failed";
      case 0x04: return "Database full / bad location";
      case 0x05: return "Finger not enrolled";
      case 0x06: return "Image unclear / scans do not match";
      case 0x08: return "No finger / timeout";
      case 0x0F: return "Finger lifted";
      case 0xFE: return "Communication error";
      case 0xFF: return "No reply - check wiring/power";
      default: return "Unknown status";
    }
  }

 private:
  Adafruit_Fingerprint sensor_;
  Stream &stream_;
  uint8_t lastStatus_ = 0xFF;

  static uint8_t mapError(uint8_t r) {
    if (r == FINGERPRINT_NOFINGER) return 0x08;
    if (r == FINGERPRINT_IMAGEMESS || r == FINGERPRINT_FEATUREFAIL ||
        r == FINGERPRINT_INVALIDIMAGE || r == FINGERPRINT_ENROLLMISMATCH) return 0x06;
    if (r == FINGERPRINT_BADLOCATION || r == FINGERPRINT_FLASHERR) return 0x04;
    if (r == FINGERPRINT_PACKETRECIEVEERR) return 0xFE;
    if (r == FINGERPRINT_NOTFOUND) return 0x05;
    return 0x01;
  }
};
