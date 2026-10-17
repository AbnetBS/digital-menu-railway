/*
 * Standalone buzzer check for the listed 5 V ACTIVE PIEZO buzzer.
 *
 * Do not use this with a different/unknown buzzer until its voltage/type is
 * confirmed. The transistor keeps the 5 V buzzer current off the ESP32 GPIO.
 *
 * Temporary bench test: the 10 kOhm base-to-GND pull-down is omitted. The
 * 1 kOhm GPIO-to-base resistor is REQUIRED. Without the 10 kOhm, the buzzer
 * may chirp briefly while the ESP32 resets/boots; add the pull-down for the
 * final installation.
 *
 * 2N2222 pin orientation from the user's reference: hold the marked flat face
 * toward you, legs down: left = emitter, middle = base, right = collector.
 * Verify the exact part pinout if its manufacturer/datasheet differs.
 *
 * WIRING (power disconnected while wiring):
 *   ESP32 GPIO23 -- 1 kOhm resistor -- transistor base (middle leg)
 *   transistor emitter (left leg)  -- common GND
 *   transistor collector (right)   -- buzzer short/negative lead
 *   buzzer long/positive lead      -- regulated +5 V
 *   ESP32 GND                      -- same common GND as the 5 V source
 *
 * The listed buzzer is piezoelectric, so no flyback diode is needed. Do not
 * connect the buzzer directly to GPIO23 and do not connect +5 V to ESP32 3V3.
 * Disconnect the fingerprint sensor, LCD, and other loads during this test.
 * The level shifter may remain attached to the LCD backpack; no need to
 * desolder/remove it.
 *
 * Serial Monitor: 115200 baud. The test makes a short beep every 2 seconds.
 */

#define BUZZER_CONTROL_PIN 23

void setup() {
  // Start in the OFF state; the physical 10 kOhm pull-down is still recommended.
  digitalWrite(BUZZER_CONTROL_PIN, LOW);
  pinMode(BUZZER_CONTROL_PIN, OUTPUT);
  digitalWrite(BUZZER_CONTROL_PIN, LOW);

  Serial.begin(115200);
  Serial.println("Buzzer check: GPIO23, active piezo, short pulse every 2 seconds");
}

void loop() {
  Serial.println("Buzzer ON (250 ms)");
  digitalWrite(BUZZER_CONTROL_PIN, HIGH);
  delay(250);

  digitalWrite(BUZZER_CONTROL_PIN, LOW);
  Serial.println("Buzzer OFF");
  delay(1750);
}
