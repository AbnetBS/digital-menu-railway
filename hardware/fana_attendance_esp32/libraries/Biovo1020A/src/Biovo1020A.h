#ifndef BIOVO1020A_H
#define BIOVO1020A_H

#include <Arduino.h>

/*
 * Biovo1020A / FPC1020A capacitive fingerprint sensor library - PATCHED COPY
 * for the FANA CAFE attendance device (hardware/fana_attendance_esp32).
 *
 * Base: https://github.com/nahomyirga787-spec/Biovo1020A (v1.0.1)
 *
 * Fixes in this patched copy:
 *  1. sendCommand() now uses a sliding 8-byte receive window and DISCARDS
 *     stale replies to earlier commands (e.g. a late SEARCH reply that
 *     arrives after an ENROLL command was sent). The original library read
 *     the first 8 bytes blindly, so a stale frame failed validation and the
 *     caller saw a stale status byte - the "enroll failed, status = 6"
 *     confusion.
 *  2. Full status-code table (0x05 NOUSER, 0x06 IMAGEMESS, 0x07 USER_EXIST,
 *     0x08 TIMEOUT, 0x0F GO_OUT) plus library-internal codes 0xFE (garbled /
 *     wrong-command reply) and 0xFF (no reply).
 *  3. New helpers: drain() (flush + wait for a quiet line) and
 *     statusText() (human-readable status for Serial/OLED).
 *  4. Timeout is now an absolute frame deadline and the receive loop yields,
 *     so a dead sensor cannot busy-spin for the whole timeout.
 *
 * The public API is 100% compatible with the original library.
 */

// Commands (0xF5-framed 8-byte protocol)
#define BIOVO_CMD_ENROLL_1   0x01
#define BIOVO_CMD_ENROLL_2   0x02
#define BIOVO_CMD_ENROLL_3   0x03
#define BIOVO_CMD_DELETE     0x04
#define BIOVO_CMD_DELETE_ALL 0x05
#define BIOVO_CMD_COUNT      0x09
#define BIOVO_CMD_SEARCH     0x0C

// Status byte returned by the module (response frame byte 4)
#define BIOVO_ACK_SUCCESS    0x00  // command successful
#define BIOVO_ACK_FAIL       0x01  // command failed
#define BIOVO_ACK_FULL       0x04  // fingerprint database full
#define BIOVO_ACK_NOUSER     0x05  // search: no matching finger enrolled
#define BIOVO_ACK_IMAGEMESS  0x06  // fingerprint image too messy/unclear to process
#define BIOVO_ACK_USER_EXIST 0x07  // enroll: this ID already has a fingerprint
#define BIOVO_ACK_TIMEOUT    0x08  // search: no finger / search window expired
#define BIOVO_ACK_GO_OUT     0x0F  // finger lifted off the sensor

// Library-internal codes (never sent by the module)
#define BIOVO_ACK_COMM_ERROR 0xFE  // garbled frame or reply to a different command
#define BIOVO_ACK_NO_RESPONSE 0xFF // no reply within the timeout

class Biovo1020A {
  public:
    Biovo1020A(Stream &serialPort);

    void begin();
    int16_t getCount(uint32_t timeout = 5000);
    bool enroll(uint16_t id, uint8_t step, uint32_t timeout = 30000);
    bool search(uint16_t &matchedID, uint8_t &permission, uint32_t timeout = 30000);
    bool deleteUser(uint16_t id, uint32_t timeout = 5000);
    bool deleteAll(uint32_t timeout = 5000);

    uint8_t getLastStatus() const { return _lastStatus; }
    const uint8_t* getLastRxPacket() const { return _rxPacket; }

    // Flush pending bytes, then wait until the UART has been quiet for quietMs.
    // Call before enrollment so a late reply to an earlier scan cannot be
    // mistaken for the enrollment reply.
    void drain(uint32_t quietMs = 100);

    // Human-readable text for a status byte (Serial monitor / OLED messages).
    static const char* statusText(uint8_t status);

  private:
    Stream &_serial;
    uint8_t _rxPacket[8];
    uint8_t _lastStatus;

    void clearBuffer();
    uint8_t calculateChecksum(const uint8_t *packet);
    bool sendCommand(uint8_t cmd, uint8_t d1, uint8_t d2, uint8_t d3, uint32_t timeout);
};

#endif
