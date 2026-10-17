/*
 * ESP32 USB/Serial-only check.
 * Leave every peripheral disconnected. Upload this to confirm the board,
 * USB data cable, selected port, and Serial Monitor before wiring anything.
 * Serial Monitor: 115200 baud. This sketch does not touch GPIO pins.
 */

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("ESP32 serial check started");
}

void loop() {
  static unsigned long tick = 0;
  Serial.print("PASS - ESP32 is running; tick ");
  Serial.println(tick++);
  delay(1000);
}
