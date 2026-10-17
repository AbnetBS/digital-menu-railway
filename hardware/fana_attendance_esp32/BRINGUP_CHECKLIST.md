# Hardware bring-up: test one part at a time

This is a physical checklist for restarting after the wires were removed. Mark
**PASS** or **FAIL** for each step; do not add the next part until the current
one passes. Software tests can simulate the device, but they cannot prove that
a real sensor, wire, power supply, LCD, or buzzer works.

## Before any wiring

- Unplug USB and every external power supply before moving wires.
- Do not connect the sensor's VCC until its exact board/input-voltage rating is
  confirmed from its markings or datasheet. `FPC1020A` by itself does not tell
  us whether the board in hand accepts 3.3 V or 5 V. **Do not try both voltages.**
- Never put 5 V on an ESP32 GPIO. Keep the LCD's SDA/SCL behind the level
  shifter. Do not drive a buzzer directly from GPIO23.
- Take a clear photo of the fingerprint module's front and back, including its
  connector labels and any small regulator/part markings. If the voltage still
  cannot be identified, stop before powering the sensor.

## Test order

### 1. ESP32 board and USB/Serial

Leave all peripherals disconnected. Open and upload
`hardware/diagnostics/esp32_serial_check/esp32_serial_check.ino`. Open Serial
Monitor at **115200 baud**.

**PASS:** upload completes and `PASS - ESP32 is running; tick ...` appears
about once per second. This checks the board, USB data cable/port, selected
board/port, and Serial path only.

### 2. Fingerprint sensor and UART — only after its supply rating is known

Do not guess its VCC. First identify the exact board from its labels and
markings (front/back photos help). Once its rated input is confirmed, power off
and connect only these four wires; leave the LCD, buzzer, and LEDs disconnected:

| Sensor | ESP32 |
|---|---|
| VCC | The voltage confirmed for this exact module |
| GND | GND |
| TX | GPIO16 (ESP32 RX2) |
| RX | GPIO17 (ESP32 TX2) |

Use the pin labels, not wire color alone. Upload
`hardware/diagnostics/fpc1020a_count_check/fpc1020a_count_check.ino` and open
Serial Monitor at **115200 baud**. It sends one non-destructive `COUNT` command; it does not enroll or delete
fingerprints. The sensor UART is **19200 baud, 8N1**. Because this sensor was
reported to heat up, stay beside the power switch and unplug USB immediately if
the sensor gets hot, smells, smokes, or the ESP32 resets. Unplug USB after the
result; do not try another voltage at random.

**PASS:** `PASS - COUNT reply OK; stored templates = N`. `N = 0` is valid: it
means the sensor answered but has no saved templates. A failed count means the
link has not passed; do not repeat the test until VCC, common GND, and crossed
TX/RX have been rechecked.

### 3. LCD and level shifter

Disconnect power before rewiring. Test the LCD separately with
`hardware/fana_attendance_esp32/diagnostics/lcd_check/lcd_check.ino` and only the
LCD/backpack plus its level shifter connected. Keep all grounds common; ESP32
GPIO21/22 go through the shifter to LCD SDA/SCL. Never connect the LCD's
5 V-pulled SDA/SCL directly to the ESP32.

**PASS:** Serial reports an I2C address and the LCD shows the four-line test
pattern. If Serial finds no I2C device, check LCD power, common ground, and the
A1/B1 and A2/B2 paths before changing the sketch. Blocks with a lit backlight
usually mean the contrast adjustment needs turning slowly.

### 4. Green and red LEDs

Power off before wiring. Test each LED separately with
`hardware/diagnostics/led_pin_check/led_pin_check.ino`. Each LED needs its own
**220-ohm series resistor**. Green is GPIO18; red is GPIO19. Do not connect an
LED directly between a GPIO and a power rail without a resistor.

**PASS:** Serial says GREEN on / RED off, then GREEN off / RED on, and the
matching LEDs follow those messages.

### 5. Buzzer and transistor driver

Do this last among the individual parts. First identify the exact transistor
and its leg order and check whether the buzzer is active or passive and its
rated voltage. Those details were not verified in the project notes, so do not
guess the transistor legs or connect the buzzer to GPIO23 directly. Use the
transistor driver and diode only as appropriate for the identified parts.

**PASS:** the correct buzzer type sounds on the test signal and the ESP32 does
not reset. If it is silent, stop and inspect the buzzer type, transistor pinout,
resistor values, and supply; do not bypass the transistor.

### 6. Reassemble and verify the complete attendance device

Only after the individual parts pass, reconnect one part at a time and flash
the archived baseline at
`hardware/baselines/pre-pr55-pr56/fana_attendance_esp32/fana_attendance_esp32.ino`.
Keep a short result log: ESP32 / sensor / LCD / green LED / red LED / buzzer,
with each marked PASS or FAIL and the exact Serial message for any failure.

The next safe first step is to identify the sensor board from its front/back
photos and confirm its VCC rating. Do not reconnect its power wire until then.
