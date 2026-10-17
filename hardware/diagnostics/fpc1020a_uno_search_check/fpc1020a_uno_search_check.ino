/*
 * One-shot FPC1020A fingerprint-search test for Arduino Uno.
 * This performs SEARCH only. It does not enroll, delete, or change templates.
 *
 * Uno GPIO is 5 V: keep a logic-level shifter between Uno UART and the sensor.
 * Do not connect Uno D3 directly to sensor RX. Keep sensor VCC at the exact
 * module's confirmed rated supply (3.3 V as selected for this setup).
 *
 * Sensor pins:
 *   pin 1 GND       -> common GND
 *   pin 2 UART_RX   <- Uno D3 through level shifter
 *   pin 3 UART_TX   -> Uno D2 through level shifter
 *   pin 4 VCC       -> confirmed 3.3 V sensor supply
 *   pins 5 and 6    -> not connected
 *
 * Serial Monitor: 115200 baud. Sensor UART: 19200 baud.
 */

#include <SoftwareSerial.h>
#include <Biovo1020A.h>

const uint8_t SENSOR_RX_PIN = 2; // Uno receives sensor TX
const uint8_t SENSOR_TX_PIN = 3; // Uno sends to sensor RX via level shifter

SoftwareSerial sensorUart(SENSOR_RX_PIN, SENSOR_TX_PIN);
Biovo1020A sensor(sensorUart);

void setup() {
  Serial.begin(115200);
  sensorUart.begin(19200);
  delay(1500);
  sensor.begin();

  Serial.println();
  Serial.println("Arduino Uno - one-shot fingerprint SEARCH test");
  Serial.println("Use a finger already stored in the sensor (14 templates reported).");
  Serial.println("Get the finger ready; SEARCH starts in 2 seconds.");
  delay(2000);
  Serial.println("Place the enrolled finger NOW and hold it still for up to 10 seconds.");
  Serial.flush();

  uint16_t matchedId = 0;
  uint8_t permission = 0;
  const bool matched = sensor.search(matchedId, permission, 10000);
  const uint8_t status = sensor.getLastStatus();

  if (matched && matchedId > 0) {
    Serial.print("PASS - fingerprint matched stored ID ");
    Serial.println(matchedId);
  } else {
    Serial.print("Sensor response status 0x");
    Serial.print(status, HEX);
    Serial.print(" - ");
    Serial.println(Biovo1020A::statusText(status));

    if (status == BIOVO_ACK_NOUSER || status == BIOVO_ACK_IMAGEMESS ||
        status == BIOVO_ACK_TIMEOUT || status == BIOVO_ACK_GO_OUT) {
      Serial.println("PASS - sensor replied; check finger placement or template match.");
    } else {
      Serial.println("No valid scan reply; check power, level shifter, and UART wires.");
    }
  }

  Serial.println("Unplug power after reading the result.");
}

void loop() {
  // One search only; unplug power after the result.
  delay(1000);
}
