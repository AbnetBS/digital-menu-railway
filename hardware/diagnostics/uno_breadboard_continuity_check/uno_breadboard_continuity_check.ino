/*
 * No-external-resistor breadboard continuity check for Arduino Uno.
 *
 * Disconnect all power supplies, modules, and components from the breadboard.
 * Connect only:
 *   Uno GND -> one breadboard hole being tested
 *   Uno D2  -> another hole expected to share that electrical group
 *
 * The Uno's internal INPUT_PULLUP limits the test current. The Uno's built-in
 * LED on D13 (which already has a resistor) lights when the two holes connect.
 * Serial Monitor: 115200 baud. No external LED or resistor is needed.
 *
 * Test one pair of holes at a time. Do not leave any 5 V or 3.3 V supply wires
 * on the breadboard during this test.
 */

const uint8_t SENSE_PIN = 2;
const uint8_t STATUS_LED = LED_BUILTIN;

void setup() {
  Serial.begin(115200);
  pinMode(SENSE_PIN, INPUT_PULLUP);
  pinMode(STATUS_LED, OUTPUT);
  digitalWrite(STATUS_LED, LOW);

  Serial.println("Uno breadboard continuity check");
  Serial.println("CONNECTED = D2 and GND are on connected holes");
  Serial.println("OPEN = those holes are not connected");
}

void loop() {
  const bool connected = digitalRead(SENSE_PIN) == LOW;
  digitalWrite(STATUS_LED, connected ? HIGH : LOW);
  Serial.println(connected ? "CONNECTED - built-in LED ON" : "OPEN - built-in LED OFF");
  delay(500);
}
