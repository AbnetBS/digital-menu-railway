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

  /* Keep the glass lit (owner, Oct 2026): "make the blue light continuous and
   * blinking non-stop, the employees must not have to time their finger."
   *
   * Three layouts exist on R307/AS608 clones and they are NOT equally
   * supported:
   *   1. plain LEDON                     - the module's own steady light
   *   2. aura: breathing blue, 0 cycles  - the module blinks blue forever
   *   3. aura: steady blue,  0 cycles    - clones that refuse breathing
   *
   * The layout that worked last time is remembered and tried FIRST, so a normal
   * re-assert is one short frame instead of three. The light must never damage
   * a scan, so:
   *   - if the reader is still sending a reply, this returns false WITHOUT
   *     talking (a second frame on the wire garbles the reply that matters);
   *   - it never drains the line and never marks the link dirty (recover=false
   *     below), so a reader that refuses LED control can never stall the door;
   *   - failure is reported, never fatal: the sketch retries later. */
  bool requestLightOn(uint32_t timeoutMs = 200) {
    if (stream_.available() > 0) return false;   // a reply is still arriving
    /* Once a reader has refused every layout three times it very probably does
     * not take host LED commands at all. From then on ONE layout is probed per
     * call instead of three (rotating, so it still finds a late answer), because
     * three timeouts every second is time the door spends NOT scanning. */
    const uint8_t probes = lightMisses_ >= 3 ? 1 : LIGHT_LAYOUTS;
    const uint8_t first = (uint8_t)((lightLayout_ + lightMisses_) % LIGHT_LAYOUTS);
    for (uint8_t i = 0; i < probes; i++) {
      const uint8_t layout = (uint8_t)((first + i) % LIGHT_LAYOUTS);
      if (sendLight(layout, timeoutMs)) {
        lightLayout_ = layout;
        lightMisses_ = 0;
        return true;
      }
    }
    if (lightMisses_ < 250) lightMisses_++;
    return false;
  }

  // Which layout is known to work (0xFF = none confirmed yet). Serial and the
  // status page report it, so a dark glass can be diagnosed without guessing.
  uint8_t lightLayout() const { return lightMisses_ == 0 ? lightLayout_ : 0xFF; }
  uint8_t lightMisses() const { return lightMisses_; }

  // A cheap protocol handshake: proves the module is listening and re-synchronizes
  // a reader that has been silent or confused for a while. It never changes the
  // capacity used for searching and never touches a stored template, so it is
  // safe to send in the middle of a placement window.
  bool handshake(uint32_t timeoutMs = 2000) {
    uint8_t reply[32];
    const uint8_t verify[] = {FINGERPRINT_VERIFYPASSWORD, 0, 0, 0, 0};
    return command(verify, sizeof(verify), 1, timeoutMs, true, reply) && lastStatus_ == 0;
  }

  // A non-destructive lift check. GETIMAGE does not overwrite the character
  // buffers, unlike image2Tz or SEARCH, so it is safe between the two captures
  // and while the door watches for the next person.
  // 1 = finger/unclear image, 0 = no finger, -1 = communication/reader error.
  //
  // timeoutMs is short (a few hundred ms) when this is used to notice a LIFT:
  // a lost reply must never hold the door for two and a half seconds while the
  // next employee is already pressing the glass.
  int fingerPresent(uint32_t timeoutMs = 2500) {
    uint8_t reply[32];
    const uint8_t image[] = {FINGERPRINT_GETIMAGE};
    if (!command(image, sizeof(image), 1, timeoutMs, true, reply)) return -1;
    if (lastStatus_ == 0x00 || lastStatus_ == 0x06) return 1;
    if (lastStatus_ == 0x08) return 0;
    return -1;
  }

  /* What the reader answered during the LAST waitForImage() window.
   * "Seen 0, empty 812" is the honest description of "the finger was never on
   * the glass (or the reader cannot see it)", which is a very different problem
   * from "the finger was there and the image was unclear". The sketch puts
   * these numbers on the Serial log and in the enrollment failure report. */
  uint32_t imagesSeenInLastWait() const { return imagesSeen_; }
  uint32_t emptyGlassInLastWait() const { return emptyGlass_; }
  uint32_t unclearInLastWait() const { return unclear_; }

  /* Did the reader actually SEE a finger during the last search()?
   *
   * This is the difference between "nobody touched the glass" and "somebody put
   * a finger there and the reader could not verify it". The owner's report -
   * "the sensor goes black and nothing happens" for a wrong / unregistered /
   * unclear finger - was partly this: when a match failed with a garbled or
   * unexpected status, the sketch had no evidence a finger had been present, so
   * it said nothing at all, buzzed nothing and lit nothing. The counters below
   * are that evidence, summed over both capture attempts of the search. */
  bool searchSawFinger() const { return searchImages_ > 0 || searchUnclear_ > 0; }
  uint32_t searchImagesSeen() const { return searchImages_; }
  uint32_t searchUnclear() const { return searchUnclear_; }

  bool search(uint16_t &matchedId, uint8_t &permission, uint32_t waitMs) {
    matchedId = 0;
    permission = 0;
    searchImages_ = 0;
    searchUnclear_ = 0;
    if (!capacity_) { lastStatus_ = 0xFE; return false; }
    uint8_t previousQuality = 0;
    // One short retry of a poor/unmatched image reduces false rejections, but
    // success still requires the sensor itself to find a stored template.
    for (uint8_t attempt = 0; attempt < 2; attempt++) {
      const bool gotImage = waitForImage(attempt == 0 ? waitMs : 300);
      searchImages_ += imagesSeen_;
      searchUnclear_ += unclear_;
      if (!gotImage) {
        if (lastStatus_ == 0x06 && attempt == 0) {
          previousQuality = lastStatus_;
          delay(250);
          continue;
        }
        if (previousQuality && lastStatus_ == 0x08) lastStatus_ = previousQuality;
        return false;
      }
      uint8_t reply[32];
      /* Converting a captured image is a fast operation on a healthy reader.
       * 1500 ms (with the retry) keeps a stalled conversion from holding the
       * result - and therefore the red LED - for seven seconds. */
      const uint8_t convert[] = {FINGERPRINT_IMAGE2TZ, 1};
      if (!command(convert, sizeof(convert), 1, 1500, true, reply)) return false;
      if (lastStatus_ != 0) {
        // A captured image that cannot be converted (including a lost image)
        // is a bad placement, not an empty glass.
        if (lastStatus_ == 0x08) lastStatus_ = 0x06;
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
      /* The match itself: generous enough for a big template database, but
       * bounded so a lost reply cannot hide the result. */
      const uint32_t searchMs = waitMs > 3000 ? waitMs : 3000;
      if (!command(find, sizeof(find), 5, searchMs, true, reply)) return false;
      if (lastStatus_ == 0) {
        matchedId = ((uint16_t)reply[1] << 8) | reply[2];
        permission = 1;
        return true;
      }
      // A no-finger reply after capture is an unusable image, not an empty
      // glass. NOMATCH and NOTFOUND both mean no stored template matched in
      // this command; NOMATCH has a different meaning during enrollment.
      if (lastStatus_ == 0x08) lastStatus_ = 0x06;
      if (lastStatus_ == 0x09) lastStatus_ = 0x05;
      /* A DEFINITE no-match on a good image is a real answer, not a fluke: the
       * finger is not enrolled (or is not the person it looks like). Retrying
       * the whole capture costs another ~0.5-1 s and delays the red light and
       * buzzer the employee is waiting for, so answer immediately. Only an
       * UNCLEAR image is worth a second look. */
      if (lastStatus_ == 0x06 && attempt == 0) {
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
    if (!command(convert, sizeof(convert), 1, 3500, true, reply)) return false;
    if (lastStatus_ != 0) {
      // A no-finger-shaped reply AFTER GETIMAGE succeeded is not a 60-second
      // waiting timeout. The image was lost/unusable; ask for a fresh capture.
      if (lastStatus_ == 0x08) lastStatus_ = 0x06;
      return false;
    }
    if (step == 2) {
      const uint8_t combine[] = {FINGERPRINT_REGMODEL};
      if (!command(combine, sizeof(combine), 1, 5000, true, reply)) return false;
      if (lastStatus_ != 0) {
        // A no-finger response here is unexpected, not a placement timeout.
        if (lastStatus_ == 0x08) lastStatus_ = 0xFE;
        return false;
      }
      const uint8_t store[] = {FINGERPRINT_STORE, 1, (uint8_t)(id >> 8), (uint8_t)id};
      // A lost or unexpected STORE acknowledgement is ambiguous: do not
      // blindly send the write twice or announce success.
      if (!command(store, sizeof(store), 1, 5000, false, reply)) return false;
      if (lastStatus_ != 0) {
        if (lastStatus_ == 0x08) lastStatus_ = 0xFE;
        return false;
      }
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
  /* Clears a lost/garbled frame off the wire before the next command.
   *
   * BOUNDED ON PURPOSE. The quiet window used to be 500 ms with a ~2.1 s cap,
   * and it runs inside command(): a single garbled reply therefore delayed the
   * NEXT command - and with it the red LED and buzzer for an unregistered
   * finger - by up to two seconds. 200 ms of silence is already far longer than
   * a 57600-baud frame takes, and the cap keeps one noisy line from ever
   * costing the door more than ~0.6 s. */
  void drain(uint32_t quietMs) {
    const uint32_t started = millis();
    uint32_t lastByte = started;
    const uint32_t cap = quietMs * 3;
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
  uint32_t imagesSeen_ = 0;   // GETIMAGE replies that carried a usable image
  uint32_t emptyGlass_ = 0;   // GETIMAGE replies that said "no finger"
  uint32_t unclear_ = 0;      // GETIMAGE replies that said "image unclear"
  uint8_t lastStatus_ = 0xFF;
  uint8_t lastRawStatus_ = 0xFF;
  bool needsQuiet_ = false;
  uint32_t searchImages_ = 0;    // images captured during the last search()
  uint32_t searchUnclear_ = 0;   // unclear presses during the last search()
  static const uint8_t LIGHT_LAYOUTS = 3;
  uint8_t lightLayout_ = 0;      // 0 = plain, 1 = breathing aura, 2 = steady aura
  uint8_t lightMisses_ = 0;

  // One LED frame, fire-and-forget: no retry, no drain, no dirty-line flag.
  bool sendLight(uint8_t layout, uint32_t timeoutMs) {
    uint8_t reply[32];
    if (layout == 0) {
      const uint8_t light[] = {FINGERPRINT_LEDON};
      return command(light, sizeof(light), 1, timeoutMs, false, reply, false) && lastStatus_ == 0;
    }
#ifdef FINGERPRINT_AURALEDCONFIG
    // func, start colour, end colour, cycles. 0 cycles = never stop.
    const uint8_t func = layout == 1 ? (uint8_t)FINGERPRINT_LED_BREATHING : (uint8_t)FINGERPRINT_LED_ON;
    const uint8_t aura[] = {FINGERPRINT_AURALEDCONFIG, func,
                            FINGERPRINT_LED_BLUE, FINGERPRINT_LED_BLUE, 0x00};
    return command(aura, sizeof(aura), 1, timeoutMs, false, reply, false) && lastStatus_ == 0;
#else
    return false;
#endif
  }

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

  /* recover = true (normal commands): a lost frame is cleaned off the wire
   * before the next command. recover = false (the optional LED frames): a
   * refusal must never cost the door a drain or mark the link dirty.
   *
   * That distinction matters: the optional light command is re-sent every
   * fraction of a second, and a variant that answers it with a garbled frame
   * used to make the sketch drain the line (up to ~2 s per attempt) after every
   * single light request. The door then did nothing - no scan, no beep, no red
   * LED, glass dark - which is one of the ways "the sensor goes black" was
   * produced. Light frames now never set the dirty flag. */
  bool command(const uint8_t *data, uint8_t length, uint8_t expectedLength,
               uint32_t timeoutMs, bool retrySafe, uint8_t *reply, bool recover = true) {
    const uint8_t attempts = retrySafe ? 2 : 1;
    for (uint8_t attempt = 0; attempt < attempts; attempt++) {
      if (needsQuiet_) drain(200);
      Adafruit_Fingerprint_Packet packet(FINGERPRINT_COMMANDPACKET, length, const_cast<uint8_t *>(data));
      sensor_.writeStructuredPacket(packet);
      if (readReply(expectedLength, timeoutMs, reply)) {
        lastRawStatus_ = reply[0];
        lastStatus_ = mapError(reply[0]);
        if (lastStatus_ != 0xFE || attempt + 1 == attempts) return true;
      }
      if (recover) needsQuiet_ = true;
    }
    return false;
  }

  bool waitForImage(uint32_t waitMs) {
    const uint32_t started = millis();
    imagesSeen_ = 0;
    emptyGlass_ = 0;
    unclear_ = 0;
    do {
      uint8_t reply[32];
      const uint8_t image[] = {FINGERPRINT_GETIMAGE};
      /* 800 ms, not 2500: a healthy reader answers GETIMAGE in tens of
       * milliseconds even with no finger. The old deadline meant one lost frame
       * froze the whole scan loop for five seconds (two attempts), which the
       * owner experienced as the door going quiet. The retry still covers a
       * lost frame. */
      if (!command(image, sizeof(image), 1, 800, true, reply)) return false;
      if (lastStatus_ != 0x08) {
        if (lastStatus_ == 0) {
          capturedImageMs_ = millis();
          imagesSeen_++;
        } else {
          unclear_++;
        }
        return lastStatus_ == 0;
      }
      emptyGlass_++;
      if ((uint32_t)(millis() - started) >= waitMs) return false;
      delay(45);   // poll a little faster: less wait before a press is seen
    } while ((uint32_t)(millis() - started) < waitMs);
    lastStatus_ = 0x08;
    return false;
  }
};
