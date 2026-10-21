/*
  R307 bench test for Arduino UNO

  Install from Arduino IDE Library Manager:
    "Adafruit Fingerprint Sensor Library" by Adafruit

  Typical UART wiring (VERIFY YOUR SELLER'S PINOUT -- wire colours vary):
    R307 VCC -> supply specified for your exact module (often UNO 5V)
    R307 GND -> UNO GND
    R307 TX  -> UNO D2 (SoftwareSerial RX)
    UNO D3   -> R307 RX through a 5V-to-3.3V divider/level shifter

  Simple divider for UNO D3 -> sensor RX:
    UNO D3 -- 1k resistor --+-- R307 RX
                            |
                           2k resistor
                            |
                           GND

  Serial Monitor: 115200 baud, line ending "Newline" or "Both NL & CR".
  Commands:
    e  enroll a finger (asks for template ID)
    s  scan/match continuously
    i  show sensor information
    d  delete one template (asks for ID)
    x  delete ALL templates (asks for YES confirmation)
    h  show help
*/

#include <SoftwareSerial.h>
#include <Adafruit_Fingerprint.h>

static const uint8_t UNO_RX_FROM_SENSOR = 2;
static const uint8_t UNO_TX_TO_SENSOR = 3;

SoftwareSerial sensorSerial(UNO_RX_FROM_SENSOR, UNO_TX_TO_SENSOR);
Adafruit_Fingerprint finger = Adafruit_Fingerprint(&sensorSerial);

bool continuousScan = true;

void printHelp() {
  Serial.println(F("\n=== R307 TEST MENU ==="));
  Serial.println(F("e = enroll a finger"));
  Serial.println(F("s = start continuous matching"));
  Serial.println(F("i = sensor information"));
  Serial.println(F("d = delete one template"));
  Serial.println(F("x = delete ALL templates"));
  Serial.println(F("h = show this menu"));
}

void clearSerialInput() {
  while (Serial.available()) Serial.read();
}

uint16_t readNumber(const __FlashStringHelper *prompt, uint16_t minimumValue, uint16_t maximumValue) {
  Serial.print(prompt);
  Serial.print(F(" ("));
  Serial.print(minimumValue);
  Serial.print(F("-"));
  Serial.print(maximumValue);
  Serial.println(F("):"));

  clearSerialInput();
  String input;
  while (true) {
    while (Serial.available()) {
      char c = (char)Serial.read();
      if (c == '\n' || c == '\r') {
        if (input.length()) {
          long value = input.toInt();
          if (value >= minimumValue && value <= maximumValue) return (uint16_t)value;
          Serial.println(F("Number is outside the allowed range. Try again:"));
          input = "";
        }
      } else if (c >= '0' && c <= '9') {
        input += c;
      }
    }
  }
}

void printSensorError(uint8_t code) {
  Serial.print(F("Sensor response: 0x"));
  Serial.println(code, HEX);
  switch (code) {
    case FINGERPRINT_PACKETRECIEVEERR: Serial.println(F("Communication error")); break;
    case FINGERPRINT_NOFINGER: Serial.println(F("No finger detected")); break;
    case FINGERPRINT_IMAGEFAIL: Serial.println(F("Could not capture image")); break;
    case FINGERPRINT_IMAGEMESS: Serial.println(F("Image too messy -- clean/dry finger and sensor")); break;
    case FINGERPRINT_FEATUREFAIL:
    case FINGERPRINT_INVALIDIMAGE: Serial.println(F("Could not find fingerprint features")); break;
    case FINGERPRINT_ENROLLMISMATCH: Serial.println(F("The two scans did not match")); break;
    case FINGERPRINT_BADLOCATION: Serial.println(F("Template ID/location is invalid")); break;
    case FINGERPRINT_FLASHERR: Serial.println(F("Could not write to sensor memory")); break;
    default: Serial.println(F("Unknown sensor error")); break;
  }
}

bool waitForFingerRemoved(unsigned long timeoutMs = 15000) {
  Serial.println(F("Lift finger..."));
  unsigned long started = millis();
  while (millis() - started < timeoutMs) {
    uint8_t result = finger.getImage();
    if (result == FINGERPRINT_NOFINGER) {
      delay(400);
      return true;
    }
    delay(80);
  }
  Serial.println(F("Timed out waiting for finger to be lifted."));
  return false;
}

bool captureToBuffer(uint8_t slot, const __FlashStringHelper *instruction) {
  Serial.println(instruction);
  Serial.println(F("Place the center pad flat; hold still."));
  unsigned long started = millis();

  while (millis() - started < 30000UL) {
    uint8_t result = finger.getImage();
    if (result == FINGERPRINT_NOFINGER) {
      delay(80);
      continue;
    }
    if (result != FINGERPRINT_OK) {
      printSensorError(result);
      return false;
    }

    Serial.println(F("Image captured."));
    result = finger.image2Tz(slot);
    if (result != FINGERPRINT_OK) {
      printSensorError(result);
      return false;
    }
    Serial.println(F("Features extracted."));
    return true;
  }

  Serial.println(F("Timed out waiting for a finger."));
  return false;
}

void enrollFinger() {
  continuousScan = false;
  uint16_t maximumId = finger.capacity > 0 ? finger.capacity : 1000;
  uint16_t id = readNumber(F("Enter template ID"), 1, maximumId);

  Serial.print(F("\nEnrolling template ID "));
  Serial.println(id);
  Serial.println(F("Use the SAME finger twice, with a small angle/position change."));

  if (!waitForFingerRemoved(5000)) return;
  if (!captureToBuffer(1, F("SCAN 1 OF 2"))) return;
  if (!waitForFingerRemoved()) return;
  if (!captureToBuffer(2, F("SCAN 2 OF 2 -- move slightly, do not use another finger"))) return;

  uint8_t result = finger.createModel();
  if (result != FINGERPRINT_OK) {
    printSensorError(result);
    waitForFingerRemoved();
    return;
  }
  Serial.println(F("The two scans matched; template created."));

  result = finger.storeModel(id);
  if (result != FINGERPRINT_OK) {
    printSensorError(result);
    waitForFingerRemoved();
    return;
  }

  Serial.print(F("SUCCESS: fingerprint stored as ID "));
  Serial.println(id);
  waitForFingerRemoved();
  continuousScan = true;
}

void matchOnce() {
  uint8_t result = finger.getImage();
  if (result == FINGERPRINT_NOFINGER) return;
  if (result != FINGERPRINT_OK) {
    printSensorError(result);
    delay(500);
    return;
  }

  result = finger.image2Tz(1);
  if (result != FINGERPRINT_OK) {
    printSensorError(result);
    waitForFingerRemoved(5000);
    return;
  }

  result = finger.fingerFastSearch();
  if (result == FINGERPRINT_OK) {
    Serial.print(F("MATCH: ID "));
    Serial.print(finger.fingerID);
    Serial.print(F(" | confidence "));
    Serial.println(finger.confidence);
  } else if (result == FINGERPRINT_NOTFOUND) {
    Serial.println(F("NO MATCH"));
  } else {
    printSensorError(result);
  }

  waitForFingerRemoved(5000);
}

void showInfo() {
  finger.getParameters();
  finger.getTemplateCount();
  Serial.println(F("\n=== SENSOR INFORMATION ==="));
  Serial.print(F("Status register: 0x")); Serial.println(finger.status_reg, HEX);
  Serial.print(F("System ID: 0x")); Serial.println(finger.system_id, HEX);
  Serial.print(F("Capacity reported by sensor: ")); Serial.println(finger.capacity);
  Serial.print(F("Security level: ")); Serial.println(finger.security_level);
  Serial.print(F("Device address: 0x")); Serial.println(finger.device_addr, HEX);
  Serial.print(F("Packet length: ")); Serial.println(finger.packet_len);
  Serial.print(F("Baud rate setting: ")); Serial.println(finger.baud_rate);
  Serial.print(F("Stored templates: ")); Serial.println(finger.templateCount);
}

void deleteOne() {
  continuousScan = false;
  uint16_t maximumId = finger.capacity > 0 ? finger.capacity : 1000;
  uint16_t id = readNumber(F("Template ID to delete"), 1, maximumId);
  uint8_t result = finger.deleteModel(id);
  if (result == FINGERPRINT_OK) Serial.println(F("Template deleted."));
  else printSensorError(result);
  continuousScan = true;
}

void deleteAll() {
  continuousScan = false;
  Serial.println(F("DANGER: type YES and press Enter to erase every fingerprint:"));
  clearSerialInput();
  String input;
  while (true) {
    if (Serial.available()) {
      char c = (char)Serial.read();
      if (c == '\n' || c == '\r') {
        if (!input.length()) continue;
        break;
      }
      input += c;
    }
  }
  input.trim();
  if (input != "YES") {
    Serial.println(F("Cancelled."));
  } else {
    uint8_t result = finger.emptyDatabase();
    if (result == FINGERPRINT_OK) Serial.println(F("All templates erased."));
    else printSensorError(result);
  }
  continuousScan = true;
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println(F("\nR307 + Arduino UNO fingerprint test"));

  // 57600 is the common R307 factory default. If verification fails, confirm
  // the seller's baud rate and try 9600/115200 only after checking wiring.
  finger.begin(57600);
  delay(100);

  if (!finger.verifyPassword()) {
    Serial.println(F("ERROR: sensor not found or password is different."));
    Serial.println(F("Check VCC, common GND, crossed TX/RX, voltage levels and 57600 baud."));
    while (true) delay(1000);
  }

  Serial.println(F("Sensor connected successfully."));
  showInfo();
  printHelp();
  Serial.println(F("Continuous matching is ON. Place an enrolled finger, or type e to enroll."));
}

void loop() {
  if (Serial.available()) {
    char command = (char)Serial.read();
    if (command == '\n' || command == '\r' || command == ' ') return;
    switch (command) {
      case 'e': case 'E': enrollFinger(); break;
      case 's': case 'S': continuousScan = true; Serial.println(F("Continuous matching ON.")); break;
      case 'i': case 'I': showInfo(); break;
      case 'd': case 'D': deleteOne(); break;
      case 'x': case 'X': deleteAll(); break;
      case 'h': case 'H': printHelp(); break;
      default: Serial.println(F("Unknown command. Type h for help.")); break;
    }
  }

  if (continuousScan) matchOnce();
  delay(40);
}
