# Arduino firmware baseline before PRs #55 and #56

This folder contains the exact attendance sketch from merge commit
`66620ea98487604d4836a5780c10ee9525b41583` (PR #54). It is the version that
was on `main` immediately before PR #55 and PR #56. The sketch is copied
byte-for-byte; the current firmware at
`hardware/fana_attendance_esp32/fana_attendance_esp32.ino` has not been changed.

## Open and upload

Open this file in Arduino IDE:

`hardware/baselines/pre-pr55-pr56/fana_attendance_esp32/fana_attendance_esp32.ino`

The folder and `.ino` names match, as Arduino IDE expects. Use an ESP32 Dev
Module board and open Serial Monitor at **115200 baud**.

Required libraries:

- `WiFiManager` by tzapu
- `ArduinoJson` v6
- `hd44780` by Bill Perry
- The repository's patched `Biovo1020A` library at
  `hardware/fana_attendance_esp32/libraries/Biovo1020A`

The sensor UART in this baseline is **19200 baud, 8N1**: sensor TX goes to
ESP32 GPIO16 (RX2), and sensor RX goes to ESP32 GPIO17 (TX2). The sensor's
correct supply voltage depends on the exact module board; identify its rating
before reconnecting VCC. Do not guess or try 5 V as a test.

## Safe sensor check in this baseline

At startup, the sketch asks the sensor for its template count. The Serial
Monitor should show `Found FPC1020A fingerprint sensor, templates: N` if it
gets a valid reply. `N` may be zero; zero templates does **not** mean the sensor
is broken. After setup finishes, the Serial Monitor command `test` repeats the
non-destructive count check and prints `COUNT reply OK` or the failure status.

Do **not** type `empty confirm`; that command erases fingerprints stored in the
sensor. The host-side simulation for this archived firmware was run here and
passed. That checks the program logic only, not the physical sensor, wiring, or
power supply.
