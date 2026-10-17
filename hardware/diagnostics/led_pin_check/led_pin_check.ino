/*
 * Attendance indicator LED check.
 * Disconnect the sensor, LCD, and buzzer. Use one 220-ohm series resistor per
 * LED. Wire each LED's anode (+) toward its GPIO and cathode (-) toward GND,
 * with the resistor anywhere in series. Do not omit the resistors.
 *
 * Green LED: GPIO18. Red LED: GPIO19.
 * Serial Monitor: 115200 baud.
 */

#define GREEN_LED 18
#define RED_LED   19

void setup() {
  Serial.begin(115200);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  digitalWrite(GREEN_LED, LOW);
  digitalWrite(RED_LED, LOW);
  Serial.println("LED check started: green GPIO18, red GPIO19");
}

void loop() {
  digitalWrite(GREEN_LED, HIGH);
  digitalWrite(RED_LED, LOW);
  Serial.println("GREEN should be on; RED should be off");
  delay(1000);

  digitalWrite(GREEN_LED, LOW);
  digitalWrite(RED_LED, HIGH);
  Serial.println("GREEN should be off; RED should be on");
  delay(1000);

  digitalWrite(RED_LED, LOW);
  Serial.println("Both LEDs should be off");
  delay(1000);
}
