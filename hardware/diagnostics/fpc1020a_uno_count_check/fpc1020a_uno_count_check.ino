/*
 * One-shot FPC1020A COUNT test for Arduino Uno.
 * Reads the template count only; it does not enroll or delete fingerprints.
 *
 * Important: Uno GPIO is 5 V. Do NOT connect Uno D3 directly to sensor RX.
 * Use a logic-level shifter (recommended) or a divider to reduce D3's 5 V TX
 * signal to 3.3 V. The sensor TX output is 3.3 V; use a level shifter to Uno
 * D2 for a reliable 5 V logic-level input.
 *
 * Sensor pinout used here:
 *   pin 1 GND       -> common GND
 *   pin 2 UART_RX   <- Uno D3 through level shifter
 *   pin 3 UART_TX   -> Uno D2 through level shifter
 *   pin 4 VCC       -> the exact module's confirmed rated supply
 *   pins 5 and 6    -> not connected
 *
 * Use the Biovo1020A library from the repository. Serial Monitor: 115200.
 */

#include <SoftwareSerial.h>
#include <Biovo1020A.h>

const uint8_t SENSOR_RX_PIN = 2; // Uno receives the sensor's TX
const uint8_t SENSOR_TX_PIN = 3; // Uno sends to sensor RX through level shifter

SoftwareSerial sensorUart(SENSOR_RX_PIN, SENSOR_TX_PIN);
Biovo1020A sensor(sensorUart);

void setup() {
  Serial.begin(115200);
  sensorUart.begin(19200);
  delay(1500); // allow the sensor to start before the one COUNT request
  sensor.begin();

  Serial.println();
  Serial.println("Arduino Uno - one-shot fingerprint sensor COUNT test");
  Serial.println("No fingerprint data will be changed.");

  const int16_t count = sensor.getCount(2000);
  if (count >= 0) {
    Serial.print("PASS - sensor replied; templates = ");
    Serial.println(count);
  } else {
    const uint8_t status = sensor.getLastStatus();
    Serial.print("FAIL - no valid sensor reply; status 0x");
    Serial.println(status, HEX);
    Serial.println(Biovo1020A::statusText(status));
  }

  Serial.println("Unplug power after reading the result.");
}

void loop() {
  // One request only. Unplug power after reading Serial Monitor.
  delay(1000);
}
