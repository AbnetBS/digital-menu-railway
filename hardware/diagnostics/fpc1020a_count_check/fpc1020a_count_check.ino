/*
 * One-shot, non-destructive FPC1020A/Biovo1020A UART link check.
 *
 * CAUTION: only power the exact sensor board at its confirmed rated VCC.
 * If it becomes hot, smells, smokes, or resets the ESP32, unplug USB at once
 * and do not try again. This sketch sends exactly one COUNT command; it does
 * not enroll, delete, or change fingerprints.
 *
 * Connect only the sensor and ESP32:
 *   sensor pin 1 GND       -> ESP32 GND
 *   sensor pin 2 UART_RX   -> ESP32 GPIO17 (TX2)
 *   sensor pin 3 UART_TX   -> ESP32 GPIO16 (RX2)
 *   sensor pin 4 VCC       -> confirmed rated supply only
 *   sensor pins 5 and 6    -> not connected
 *
 * Serial Monitor: 115200 baud. Sensor UART: 19200 baud, 8N1.
 * Install the repository's patched Biovo1020A library first.
 */

#include <Biovo1020A.h>

#define SENSOR_RX_PIN 16
#define SENSOR_TX_PIN 17

HardwareSerial sensorSerial(2);
Biovo1020A sensor(sensorSerial);

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println();
  Serial.println("FPC1020A one-shot COUNT check");
  Serial.println("One read only; no enrollment/deletion commands.");

  sensorSerial.begin(19200, SERIAL_8N1, SENSOR_RX_PIN, SENSOR_TX_PIN);
  delay(500);
  sensor.begin();

  Serial.println("Requesting template count once...");
  const int16_t count = sensor.getCount(2000);
  if (count >= 0) {
    Serial.print("PASS - COUNT reply OK; stored templates = ");
    Serial.println(count);
  } else {
    const uint8_t status = sensor.getLastStatus();
    Serial.print("FAIL - no valid COUNT reply; status 0x");
    Serial.print(status, HEX);
    Serial.print(" (");
    Serial.print(Biovo1020A::statusText(status));
    Serial.println(")");
  }

  Serial.println("Unplug USB to end this test.");
}

void loop() {
  // Deliberately send no more commands. Unplug USB after reading the result.
  delay(1000);
}
