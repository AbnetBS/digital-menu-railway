#include "Biovo1020A.h"

Biovo1020A::Biovo1020A(Stream &serialPort)
    : _serial(serialPort), _lastStatus(BIOVO_ACK_NO_RESPONSE) {
  memset(_rxPacket, 0, sizeof(_rxPacket));
}

void Biovo1020A::begin() {
  clearBuffer();
}

void Biovo1020A::clearBuffer() {
  while (_serial.available() > 0) {
    _serial.read();
  }
}

void Biovo1020A::drain(uint32_t quietMs) {
  clearBuffer();
  uint32_t lastByte = millis();
  while ((int32_t)(millis() - lastByte) < (int32_t)quietMs) {
    if (_serial.available() > 0) {
      _serial.read();
      lastByte = millis();
    } else {
      delay(1);
    }
  }
}

uint8_t Biovo1020A::calculateChecksum(const uint8_t *p) {
  return p[1] ^ p[2] ^ p[3] ^ p[4] ^ p[5];
}

bool Biovo1020A::sendCommand(uint8_t cmd, uint8_t d1, uint8_t d2, uint8_t d3, uint32_t timeout) {
  uint8_t tx[8];
  tx[0] = 0xF5;
  tx[1] = cmd;
  tx[2] = d1;
  tx[3] = d2;
  tx[4] = d3;
  tx[5] = 0x00;
  tx[6] = calculateChecksum(tx);
  tx[7] = 0xF5;

  clearBuffer();
  _serial.write(tx, 8);
  _serial.flush();

  uint32_t deadline = millis() + timeout;
  bool garbageSeen = false;

  // Sliding 8-byte receive window: it always holds the last 8 bytes seen.
  // A valid reply is a window that starts with 0xF5, ends with 0xF5, echoes
  // OUR command byte and carries a correct checksum. Stale replies to
  // earlier commands (e.g. a SEARCH reply that arrives after we sent
  // ENROLL) and line noise simply slide through the window until the reply
  // that belongs to this command shows up.
  while ((int32_t)(deadline - millis()) > 0) {
    if (_serial.available() == 0) {
      delay(1); // yield so a dead sensor cannot busy-spin the task
      continue;
    }

    uint8_t b = _serial.read();
    memmove(_rxPacket, _rxPacket + 1, 7);
    _rxPacket[7] = b;

    if (_rxPacket[0] != 0xF5) continue; // hunt for a frame head

    if (_rxPacket[7] == 0xF5 && _rxPacket[1] == cmd &&
        _rxPacket[6] == calculateChecksum(_rxPacket)) {
      _lastStatus = _rxPacket[4];
      return true;
    }

    // Head byte but not our reply (stale/garbled frame): remember the noise
    // and slide past this false head.
    garbageSeen = true;
  }

  _lastStatus = garbageSeen ? BIOVO_ACK_COMM_ERROR : BIOVO_ACK_NO_RESPONSE;
  return false;
}

int16_t Biovo1020A::getCount(uint32_t timeout) {
  if (!sendCommand(BIOVO_CMD_COUNT, 0, 0, 0, timeout)) {
    return -1;
  }
  if (_lastStatus != BIOVO_ACK_SUCCESS) {
    return -1;
  }
  return ((uint16_t)_rxPacket[2] << 8) | _rxPacket[3];
}

bool Biovo1020A::enroll(uint16_t id, uint8_t step, uint32_t timeout) {
  uint8_t cmd;
  switch (step) {
    case 1: cmd = BIOVO_CMD_ENROLL_1; break;
    case 2: cmd = BIOVO_CMD_ENROLL_2; break;
    case 3: cmd = BIOVO_CMD_ENROLL_3; break;
    default: return false;
  }

  if (!sendCommand(cmd, highByte(id), lowByte(id), 1, timeout)) {
    return false;
  }
  return (_lastStatus == BIOVO_ACK_SUCCESS);
}

bool Biovo1020A::search(uint16_t &matchedID, uint8_t &permission, uint32_t timeout) {
  if (!sendCommand(BIOVO_CMD_SEARCH, 0, 0, 0, timeout)) {
    return false;
  }

  matchedID = ((uint16_t)_rxPacket[2] << 8) | _rxPacket[3];
  permission = _rxPacket[4];

  // Valid permission tiers are 1, 2, or 3
  return (permission >= 1 && permission <= 3);
}

bool Biovo1020A::deleteUser(uint16_t id, uint32_t timeout) {
  if (!sendCommand(BIOVO_CMD_DELETE, highByte(id), lowByte(id), 0, timeout)) {
    return false;
  }
  return (_lastStatus == BIOVO_ACK_SUCCESS);
}

bool Biovo1020A::deleteAll(uint32_t timeout) {
  if (!sendCommand(BIOVO_CMD_DELETE_ALL, 0, 0, 0, timeout)) {
    return false;
  }
  return (_lastStatus == BIOVO_ACK_SUCCESS);
}

const char* Biovo1020A::statusText(uint8_t status) {
  switch (status) {
    case BIOVO_ACK_SUCCESS:    return "OK";
    case BIOVO_ACK_FAIL:       return "Command failed";
    case BIOVO_ACK_FULL:       return "Database full";
    case BIOVO_ACK_NOUSER:     return "No matching finger enrolled";
    case BIOVO_ACK_IMAGEMESS:  return "Image unclear - press flat, clean sensor";
    case BIOVO_ACK_USER_EXIST: return "ID already has a finger";
    case BIOVO_ACK_TIMEOUT:    return "No finger / scan timeout";
    case BIOVO_ACK_GO_OUT:     return "Finger lifted";
    case BIOVO_ACK_COMM_ERROR: return "Garbled reply from sensor";
    case BIOVO_ACK_NO_RESPONSE:return "No reply - check wiring/power";
    default:                   return "Unknown status";
  }
}
