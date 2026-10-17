/*
 * 20x4 I2C LCD check for Arduino Uno, with the BSS138 shifter left attached.
 * Isolate the LCD: disconnect the fingerprint sensor, ESP32, LEDs, and buzzer.
 *
 * Uno SDA is A4 and SCL is A5 (or the dedicated SDA/SCL header pins).
 * Keep the LCD on the level shifter's 5 V / HV side (B1/B2); connect Uno SDA
 * and SCL to those same B-side lines. Power shifter LV from 3.3 V and HV from
 * 5 V, with common GND. Leave A1/A2 unconnected during this Uno test; those
 * are the 3.3 V ESP32-side lines used later. This test checks the LCD and its
 * I2C path on the B side, not the ESP32-side shifting itself.
 *
 * Install hd44780 by Bill Perry. The I2C backpack address is auto-detected.
 * Serial Monitor: 115200 baud.
 */

#include <Wire.h>
#include <hd44780.h>
#include <hd44780ioClass/hd44780_I2Cexp.h>

#define LCD_COLS 20
#define LCD_ROWS 4

hd44780_I2Cexp lcd;

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println();
  Serial.println("Arduino Uno - 20x4 LCD check");

  Wire.begin(); // Uno I2C: SDA=A4, SCL=A5
  const int status = lcd.begin(LCD_COLS, LCD_ROWS);
  if (status != 0) {
    Serial.print("FAIL - LCD begin status ");
    Serial.println(status);
    Serial.println("Check LCD 5V, GND, B1/B2, and contrast.");
    return;
  }

  lcd.backlight();
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print("UNO LCD CHECK PASS  ");
  lcd.setCursor(0, 1); lcd.print("20x4 I2C screen     ");
  lcd.setCursor(0, 2); lcd.print("Check all four rows ");
  lcd.setCursor(0, 3); lcd.print("Serial addr below   ");

  Serial.print("PASS - LCD found at I2C address 0x");
  Serial.println(lcd.getProp(hd44780_I2Cexp::Prop_addr), HEX);
  Serial.println("All four rows should show text.");
}

void loop() {
  // Static test pattern; no other parts are used.
}
