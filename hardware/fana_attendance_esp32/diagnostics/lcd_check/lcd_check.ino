/*
 * lcd_check.ino - find the 20x4 LCD backpack and prove the display works.
 * NOT part of the attendance product. Flash it INSTEAD of the product sketch
 * while the LCD is being wired or is not showing anything.
 *
 * It answers the two questions the product sketch must not guess:
 *   1. Which I2C address does the backpack answer on?  (it scans 0x03-0x77)
 *   2. Does the 20x4 screen work, and is it wired through the level shifter?
 *
 * WHAT IT DOES
 *   1. Scans the I2C bus GPIO21 (SDA) / GPIO22 (SCL) and prints EVERY address
 *      that answers - before any library is involved.
 *   2. Asks hd44780 to locate and configure the backpack by itself
 *      (hd44780_I2Cexp lcd;), so no address has to be typed anywhere, and
 *      prints the address it found plus the begin() status code.
 *   3. Writes a test pattern across all four rows and a live counter, so a
 *      working screen is impossible to miss.
 *   4. Blinks the backlight once, which proves the backpack is powered.
 *
 * WIRING (the product wiring - power OFF while you change it)
 *   ESP32 3V3      -> level shifter LV
 *   5 V (regulated)-> level shifter HV  AND  LCD backpack VCC
 *   ESP32 GPIO21   -> level shifter A1  ->  B1 -> backpack SDA
 *   ESP32 GPIO22   -> level shifter A2  ->  B2 -> backpack SCL
 *   ESP32 GND      -> common GND (level shifter LV GND, HV GND, backpack GND)
 *   Channels 3 and 4 stay unused.
 *
 *   NEVER connect the backpack's SDA/SCL to the ESP32 directly: the backpack
 *   is a 5 V part and its pull-ups would put 5 V on a 3.3 V pin. The level
 *   shifter (LV = 3.3 V side, HV = 5 V side) is what protects the ESP32.
 *
 * IF THE SCREEN STAYS BLANK / SHOWS BLOCKS
 *   - Blocks with the backlight on = the CONTRAST pot (the blue one on the
 *     backpack). That is normal on a fresh module; turn it slowly.
 *   - No scan hits at all = wiring: check 5 V on the backpack VCC, every GND,
 *     and that SDA/SCL really go through A1/B1 and A2/B2, not straight to the
 *     ESP32. On a level shifter the LOW side is the 3.3 V side.
 *   - A scan hit but begin() fails = the backpack answered but the library
 *     could not configure it; note the status and the address and send both.
 *   - Verify the transistor/buzzer wiring separately; this sketch never
 *     touches GPIO23.
 *
 * LIBRARY: "hd44780" by Bill Perry, installed from the Arduino Library Manager.
 *   The include below is the only one needed here; the product sketch also
 *   includes hd44780ioClass/hd44780_I2Cexp.h (this sketch includes it first
 *   and hd44780.h comes with it).
 */

#include <Wire.h>
#include <hd44780.h>
#include <hd44780ioClass/hd44780_I2Cexp.h>

#define LCD_COLS      20
#define LCD_ROWS      4
#define LCD_SDA_PIN   21
#define LCD_SCL_PIN   22

hd44780_I2Cexp lcd;   // auto-locate + auto-configure: no address is assumed

static void scanI2cBus() {
  Serial.println("Scanning the I2C bus (SDA=GPIO21, SCL=GPIO22)...");
  uint8_t found = 0;
  for (uint8_t addr = 0x03; addr <= 0x77; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.print("  device answers at 0x");
      Serial.println(addr, HEX);
      found++;
    }
  }
  if (found == 0) {
    Serial.println("  NOTHING answered. Check: backpack VCC on 5 V, all GNDs,");
    Serial.println("  SDA on B1 and SCL on B2 (through the shifter, never direct).");
  } else {
    Serial.print("  ");
    Serial.print(found);
    Serial.println(" device(s) on the bus. The backpack is normally the only one.");
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n\nFANA CAFE - 20x4 LCD check (hd44780, auto-locate)\n");

  Wire.begin(LCD_SDA_PIN, LCD_SCL_PIN);
  Wire.setClock(100000);
  scanI2cBus();

  Serial.println("\nAsking hd44780 to find and configure the backpack...");
  const int status = lcd.begin(LCD_COLS, LCD_ROWS);   // 20 columns, 4 rows
  if (status) {
    Serial.print("begin() FAILED, status code ");
    Serial.print(status);
    Serial.println(" (negative = error; the library's rv codes are in hd44780.h).");
    Serial.println("The display stays untouched; fix the wiring/contrast and reset the board.");
    return;
  }

  Serial.print("begin() OK. The backpack was found at I2C address 0x");
  Serial.println(lcd.getProp(hd44780_I2Cexp::Prop_addr), HEX);
  Serial.println("The address above is what the product sketch will use on its own.");
  Serial.println("You can pin it in the sketch with: hd44780_I2Cexp lcd(0x??);");
  Serial.println("Normally leave the sketch on auto-locate - it needs no address.\n");

  // Every print below is EXACTLY 20 characters: a 21st character would wrap
  // to the start of the next row and make the test pattern unreadable.
  lcd.backlight();
  lcd.setCursor(0, 0); lcd.print("FANA CAFE LCD CHECK ");
  lcd.setCursor(0, 1); lcd.print("2004 / 20x4 / I2C   ");
  lcd.setCursor(0, 2); lcd.print("If all four rows    ");
  lcd.setCursor(0, 3); lcd.print("show text: wiring ok");
  Serial.println("Four rows written. If a row is missing, check SDA/SCL seating.");
  delay(2500);

  // The backlight blink: proves the backpack is powered and controlled.
  Serial.println("Blinking the backlight (once off, once on)...");
  lcd.noBacklight();
  delay(1000);
  lcd.backlight();
  delay(1000);

  // Wipe everything, then show a live counter so a stale screen is obvious.
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print("Column ruler:       ");
  lcd.setCursor(0, 1); lcd.print("12345678901234567890");
  lcd.setCursor(0, 2); lcd.print("Contrast: blue pot  ");
  lcd.setCursor(0, 3); lcd.print("Live counters below ");
  delay(2500);
  lcd.clear();
}

void loop() {
  static unsigned long last = 0;
  if (millis() - last < 1000) return;
  last = millis();

  // Each line is 20 characters (or fewer, then padded by the snprintf width).
  char line[21];
  lcd.setCursor(0, 0);
  lcd.print("20x4 LCD is alive   ");
  snprintf(line, sizeof(line), "Uptime %10lu s", millis() / 1000);
  lcd.setCursor(0, 1);
  lcd.print(line);
  snprintf(line, sizeof(line), "Millis %10lu  ", millis());
  lcd.setCursor(0, 2);
  lcd.print(line);
  snprintf(line, sizeof(line), "I2C 0x%02X hd44780    ", lcd.getProp(hd44780_I2Cexp::Prop_addr));
  lcd.setCursor(0, 3);
  lcd.print(line);

  Serial.print("tick ");
  Serial.println(millis() / 1000);
}
