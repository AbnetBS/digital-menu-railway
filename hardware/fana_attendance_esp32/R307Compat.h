#pragma once
#include <Adafruit_Fingerprint.h>

/* R307 transport and the small status vocabulary used by the Fana sketch.
 * The Adafruit library still builds the command packets. We read the replies
 * here because its high-level methods use a fixed one-second reply timeout,
 * ignore their caller's timeout, and fingerFastSearch() searches only 163
 * slots. A slow but working reader could therefore look dead, or a stored ID
 * above 162 could never be found. No matching/security setting is weakened. */
class R307Compat {
 public:
  explicit R307Compat(Stream &serial) : sensor_(&serial), stream_(serial) {}

  // The reader's default address and password are the same as Adafruit's.
  // Retry this after a reader comes back late, not only at power-up.
  bool begin(uint32_t timeoutMs = 2500) {
    capacity_ = 0;
    uint8_t reply[32];
    const uint8_t verify[] = {FINGERPRINT_VERIFYPASSWORD, 0, 0, 0, 0};
    if (!command(verify, sizeof(verify), 1, timeoutMs, true, reply) || lastStatus_ != 0) return false;
    const uint8_t parameters[] = {FINGERPRINT_READSYSPARAM};
    if (!command(parameters, sizeof(parameters), 17, timeoutMs, true, reply) || lastStatus_ != 0) return false;
    capacity_ = ((uint16_t)reply[5] << 8) | reply[6];
    if (capacity_ < 2) {
      capacity_ = 0;
      lastStatus_ = 0xFE;
      return false;
    }
    return true;
  }

  int16_t getCount(uint32_t timeoutMs = 3000) {
    if (!capacity_ && !begin(timeoutMs)) return -1;
    uint8_t reply[32];
    const uint8_t count[] = {FINGERPRINT_TEMPLATECOUNT};
    if (!command(count, sizeof(count), 3, timeoutMs, true, reply) || lastStatus_ != 0) return -1;
    return (int16_t)(((uint16_t)reply[1] << 8) | reply[2]);
  }

  // Capacity is a count of slots. Their addresses are 0 through capacity-1;
  // the attendance website uses 1 onward and intentionally leaves 0 unused.
  uint16_t capacity() const { return capacity_; }

  // Time of the successful GETIMAGE reply used by the last search. This is
  // earlier than matching/response handling and wraps like Arduino millis().
  uint32_t capturedImageMillis() const { return capturedImageMs_; }

  // Some optical readers support the optional LED-ON command. Not all R307
  // variants do; failure must never disable fingerprint capture.
  bool requestLightOn() {
    uint8_t reply[32];
    const uint8_t light[] = {FINGERPRINT_LEDON};
    return command(light, sizeof(light), 1, 1200, false, reply) && lastStatus_ == 0;
  }

  // A non-destructive lift check. GETIMAGE does not overwrite the character
  // buffers, unlike image2Tz or SEARCH, so it is safe between the two captures.
  // 1 = finger/unclear image, 0 = no finger, -1 = communication/reader error.
  int fingerPresent() {
    uint8_t reply[32];
    const uint8_t image[] = {FINGERPRINT_GETIMAGE};
    if (!command(image, sizeof(image), 1, 2500, true, reply)) return -1;
    if (lastStatus_ == 0x00 || lastStatus_ == 0x06) return 1;
    if (lastStatus_ == 0x08) return 0;
    return -1;
  }

  bool search(uint16_t &matchedId, uint8_t &permission, uint32_t waitMs) {
    matchedId = 0;
    permission = 0;
    if (!capacity_) { lastStatus_ = 0xFE; return false; }
    uint8_t previousQuality = 0;
    // One short retry of a poor/unmatched image reduces false rejections, but
    // success still requires the sensor itself to find a stored template.
    for (uint8_t attempt = 0; attempt < 2; attempt++) {
      if (!waitForImage(attempt == 0 ? waitMs : 300)) {
        if (lastStatus_ == 0x06 && attempt == 0) {
          previousQuality = lastStatus_;
          delay(250);
          continue;
        }
        if (previousQuality && lastStatus_ == 0x08) lastStatus_ = previousQuality;
        return false;
      }
      uint8_t reply[32];
      const uint8_t convert[] = {FINGERPRINT_IMAGE2TZ, 1};
      if (!command(convert, sizeof(convert), 1, 3500, true, reply)) return false;
      if (lastStatus_ != 0) {
        if (lastStatus_ == 0x06 && attempt == 0) {
          previousQuality = lastStatus_;
          delay(250);
          continue;
        }
        return false;
      }
      // Search the full reported capacity, not Adafruit's hard-coded 0x00A3.
      const uint8_t find[] = {FINGERPRINT_HISPEEDSEARCH, 1, 0, 0,
                              (uint8_t)(capacity_ >> 8), (uint8_t)capacity_};
      const uint32_t searchMs = waitMs > 3500 ? waitMs : 3500;
      if (!command(find, sizeof(find), 5, searchMs, true, reply)) return false;
      if (lastStatus_ == 0) {
        matchedId = ((uint16_t)reply[1] << 8) | reply[2];
        permission = 1;
        return true;
      }
      if (lastStatus_ == 0x05 && attempt == 0) {
        previousQuality = lastStatus_;
        delay(250);
        continue;
      }
      return false;
    }
    return false;
  }

  // Two genuinely fresh placements. The second buffer is combined with the
  // first and stored; a separate fresh SEARCH must still confirm the new ID.
  bool enroll(uint16_t id, uint8_t step, uint32_t waitMs) {
    if (!capacity_ || id == 0 || id >= capacity_ || step < 1 || step > 2) {
      lastStatus_ = 0x04;
      return false;
    }
    if (!waitForImage(waitMs)) return false;
    uint8_t reply[32];
    const uint8_t convert[] = {FINGERPRINT_IMAGE2TZ, step};
    if (!command(convert, sizeof(convert), 1, 3500, true, reply) || lastStatus_ != 0) return false;
    if (step == 2) {
      const uint8_t combine[] = {FINGERPRINT_REGMODEL};
      if (!command(combine, sizeof(combine), 1, 5000, true, reply) || lastStatus_ != 0) return false;
      const uint8_t store[] = {FINGERPRINT_STORE, 1, (uint8_t)(id >> 8), (uint8_t)id};
      // A lost STORE acknowledgement is ambiguous: do not blindly send the
      // write twice or announce success. The job fails and can be retried.
      if (!command(store, sizeof(store), 1, 5000, false, reply) || lastStatus_ != 0) return false;
    }
    return true;
  }

  bool deleteUser(uint16_t id, uint32_t timeoutMs = 5000) {
    uint8_t reply[32];
    const uint8_t remove[] = {FINGERPRINT_DELETE, (uint8_t)(id >> 8), (uint8_t)id, 0, 1};
    return command(remove, sizeof(remove), 1, timeoutMs, false, reply) && lastStatus_ == 0;
  }

  bool deleteAll() {
    uint8_t reply[32];
    const uint8_t empty[] = {FINGERPRINT_EMPTY};
    return command(empty, sizeof(empty), 1, 5000, false, reply) && lastStatus_ == 0;
  }

  uint8_t getLastStatus() const { return lastStatus_; }
  uint8_t getLastRawStatus() const { return lastRawStatus_; }

  // Wait for a genuinely quiet UART after a timeout, not just a single flush.
  // The cap prevents a noisy wire from keeping the device here forever.
  void drain(uint32_t quietMs) {
    const uint32_t started = millis();
    uint32_t lastByte = started;
    const uint32_t cap = quietMs * 4 + 100;
    while ((uint32_t)(millis() - started) < cap && (uint32_t)(millis() - lastByte) < quietMs) {
      if (stream_.available()) {
        stream_.read();
        lastByte = millis();
      } else {
        delay(1);
      }
    }
    needsQuiet_ = false;
  }

  static const char *statusText(uint8_t s) {
    switch (s) {
      case 0x00: return "OK";
      case 0x01: return "Command failed";
      case 0x04: return "Invalid slot / memory problem";
      case 0x05: return "Finger not enrolled";
      case 0x06: return "Image unclear";
      case 0x08: return "No finger / timeout";
      case 0x09: return "Captures do not match";
      case 0x0A: return "Sensor flash write failed";
      case 0x0F: return "Finger lifted";
      case 0xFE: return "Communication error / invalid reply";
      case 0xFF: return "No reply - check wiring/power";
      default: return "Unknown status";
    }
  }

 private:
  Adafruit_Fingerprint sensor_;
  Stream &stream_;
  uint16_t capacity_ = 0;
  uint32_t capturedImageMs_ = 0;
  uint8_t lastStatus_ = 0xFF;
  uint8_t lastRawStatus_ = 0xFF;
  bool needsQuiet_ = false;

  static uint8_t mapError(uint8_t r) {
    if (r == FINGERPRINT_OK) return 0x00;
    if (r == FINGERPRINT_NOFINGER) return 0x08;
    if (r == FINGERPRINT_IMAGEFAIL || r == FINGERPRINT_IMAGEMESS ||
        r == FINGERPRINT_FEATUREFAIL || r == FINGERPRINT_INVALIDIMAGE) return 0x06;
    if (r == FINGERPRINT_ENROLLMISMATCH || r == FINGERPRINT_NOMATCH) return 0x09;
    if (r == FINGERPRINT_BADLOCATION || r == FINGERPRINT_DBRANGEFAIL) return 0x04;
    if (r == FINGERPRINT_FLASHERR) return 0x0A;
    if (r == FINGERPRINT_PACKETRECIEVEERR) return 0xFE;
    if (r == FINGERPRINT_NOTFOUND) return 0x05;
    return 0x01;
  }

  bool readByte(uint8_t &byte, uint32_t started, uint32_t timeoutMs) {
    while ((uint32_t)(millis() - started) < timeoutMs) {
      if (stream_.available()) {
        const int value = stream_.read();
        if (value >= 0) { byte = (uint8_t)value; return true; }
      }
      delay(1);
    }
    return false;
  }

  // Validate address, length and checksum. R307 replies do not echo the
  // command, so a late same-shaped reply can never be identified perfectly;
  // generous deadlines and a quiet-line recovery reduce that risk.
  bool readReply(uint8_t expectedSuccessLength, uint32_t timeoutMs, uint8_t *reply) {
    const uint32_t started = millis();
    bool sawBytes = false;
    while ((uint32_t)(millis() - started) < timeoutMs) {
      uint8_t b;
      if (!readByte(b, started, timeoutMs)) break;
      sawBytes = true;
      if (b != 0xEF) { delay(1); continue; }
      if (!readByte(b, started, timeoutMs)) break;
      if (b != 0x01) continue;
      uint8_t header[7]; // four address bytes, type, and two length bytes
      bool complete = true;
      for (uint8_t i = 0; i < sizeof(header); i++) {
        if (!readByte(header[i], started, timeoutMs)) { complete = false; break; }
      }
      if (!complete) break;
      const uint16_t length = ((uint16_t)header[5] << 8) | header[6];
      if (length < 3 || length > 34) continue;
      uint8_t wire[34];
      for (uint16_t i = 0; i < length; i++) {
        if (!readByte(wire[i], started, timeoutMs)) { complete = false; break; }
      }
      if (!complete) break;
      uint16_t checksum = (uint16_t)header[4] + header[5] + header[6];
      for (uint16_t i = 0; i < length - 2; i++) checksum += wire[i];
      const uint16_t received = ((uint16_t)wire[length - 2] << 8) | wire[length - 1];
      if (header[0] != 0xFF || header[1] != 0xFF || header[2] != 0xFF || header[3] != 0xFF ||
          header[4] != FINGERPRINT_ACKPACKET || checksum != received) continue;
      const uint16_t payloadLength = length - 2;
      if ((wire[0] == FINGERPRINT_OK && payloadLength != expectedSuccessLength) ||
          (wire[0] != FINGERPRINT_OK && payloadLength != 1)) continue;
      for (uint16_t i = 0; i < payloadLength; i++) reply[i] = wire[i];
      return true;
    }
    lastStatus_ = sawBytes ? 0xFE : 0xFF;
    lastRawStatus_ = 0xFF;
    return false;
  }

  bool command(const uint8_t *data, uint8_t length, uint8_t expectedLength,
               uint32_t timeoutMs, bool retrySafe, uint8_t *reply) {
    const uint8_t attempts = retrySafe ? 2 : 1;
    for (uint8_t attempt = 0; attempt < attempts; attempt++) {
      if (needsQuiet_) drain(500);
      Adafruit_Fingerprint_Packet packet(FINGERPRINT_COMMANDPACKET, length, const_cast<uint8_t *>(data));
      sensor_.writeStructuredPacket(packet);
      if (readReply(expectedLength, timeoutMs, reply)) {
        lastRawStatus_ = reply[0];
        lastStatus_ = mapError(reply[0]);
        if (lastStatus_ != 0xFE || attempt + 1 == attempts) return true;
      }
      needsQuiet_ = true;
    }
    return false;
  }

  bool waitForImage(uint32_t waitMs) {
    const uint32_t started = millis();
    do {
      uint8_t reply[32];
      const uint8_t image[] = {FINGERPRINT_GETIMAGE};
      if (!command(image, sizeof(image), 1, 2500, true, reply)) return false;
      if (lastStatus_ != 0x08) {
        if (lastStatus_ == 0) capturedImageMs_ = millis();
        return lastStatus_ == 0;
      }
      if ((uint32_t)(millis() - started) >= waitMs) return false;
      delay(70);
    } while ((uint32_t)(millis() - started) < waitMs);
    lastStatus_ = 0x08;
    return false;
  }
};
