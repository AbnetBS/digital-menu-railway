/*
 * Green/red indicator LED check for Arduino Uno.
 * Disconnect the LCD, fingerprint sensor, and buzzer for this test.
 * Each LED needs its own 220-ohm series resistor.
 *
 * Uno D8 -> 220 ohm -> green LED long leg (+); short leg (-) -> GND
 * Uno D9 -> 220 ohm -> red LED long leg (+); short leg (-) -> GND
 * Serial Monitor: 115200 baud.
 * These are Uno test pins only; the ESP32 product uses GPIO18/GPIO19.
 */

#define GREEN_LED 8
#define RED_LED   9

void setup() {
  Serial.begin(115200);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  digitalWrite(GREEN_LED, LOW);
  digitalWrite(RED_LED, LOW);
  Serial.println("Arduino Uno LED check started");
}

void loop() {
  digitalWrite(GREEN_LED, HIGH);
  digitalWrite(RED_LED, LOW);
  Serial.println("GREEN on; RED off");
  delay(1000);

  digitalWrite(GREEN_LED, LOW);
  digitalWrite(RED_LED, HIGH);
  Serial.println("GREEN off; RED on");
  delay(1000);

  digitalWrite(RED_LED, LOW);
  Serial.println("Both off");
  delay(1000);
}
