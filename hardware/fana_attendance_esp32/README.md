# Fana attendance device — ESP32 + R307

The production sketch is `fana_attendance_esp32.ino`. It now targets the **R307 optical fingerprint reader** and keeps the existing Fana website workflow: remote enrollment jobs, fingerprint-to-member mapping, IN/OUT clocking, offline queue, 20×4 LCD, LEDs, buzzer, Wi-Fi setup and scheduled deep sleep.

## Required libraries

Install with Arduino IDE Library Manager:

- **Adafruit Fingerprint Sensor Library** by Adafruit
- **hd44780** by Bill Perry
- **WiFiManager** by tzapu
- **ArduinoJson 6**

The old `Biovo1020A` library and FPC diagnostics remain in the repository only as historical/legacy material. The production R307 sketch does not use them.

## R307 wiring

**Verify the connector pinout supplied with your exact unit. Wire colours are not standardized.**

| R307 | ESP32 WROOM |
|---|---|
| VCC | Regulated supply specified by the seller (normally 5 V for R307) |
| GND | GND |
| TX | GPIO16 / RX2 |
| RX | GPIO17 / TX2 |

The ESP32 UART is 3.3 V logic. All grounds must be common. Do not connect an unknown wire by colour alone.

The sketch opens UART2 at **57600 baud, 8N1**, matching the tested R307 shown by the device information output.

## Other hardware

### 20×4 LCD with I²C backpack, through a bidirectional level shifter

| Connection | Destination |
|---|---|
| ESP32 3V3 | level-shifter LV |
| regulated 5 V | level-shifter HV and LCD VCC |
| GPIO21 | A1 → B1 → LCD SDA |
| GPIO22 | A2 → B2 → LCD SCL |
| all grounds | common GND |

### Indicators

- Green LED: GPIO18 through 220 Ω
- Red LED: GPIO19 through 220 Ω
- Active buzzer driver: GPIO23 through a transistor as documented in the sketch header

## R307 enrollment flow

1. Admin presses **Add Fingerprint** on the website.
2. The device receives the pending job.
3. The employee places the finger for capture 1.
4. The employee lifts it.
5. The same finger is placed again with a small position/angle change for capture 2.
6. The R307 combines the two captures and stores one template.
7. Fresh confirmation placements must find the same template ID.
8. Only then is the ID mapped to the employee on the website.

The R307’s internal matcher supports rotated placements. Employees should still place the finger pad flat enough to capture useful ridge detail.

## Normal scan

- One placement produces one attendance event.
- The sensor returns a template ID.
- The ESP32 posts that ID to `/api/attendance/clock`.
- The LCD shows IN, OUT, late, already registered, or the server’s refusal.
- A finger left on the glass does not repeatedly clock.
- If internet is unavailable, the event is queued in LittleFS and synchronized later.

## First upload

1. Select **ESP32 Dev Module**.
2. Install the required libraries.
3. Confirm the R307 pinout and wiring.
4. Upload `fana_attendance_esp32.ino`.
5. Open Serial Monitor at **115200 baud**.
6. On first boot, join `Fana-Attendance-Setup` with password `fana12345`, then configure restaurant Wi-Fi.
7. Confirm Serial shows `Found R307 fingerprint sensor` and the template count.

## Offline attendance time

**A kept scan carries its own time.** When the network is unavailable, the ESP32 stores the scan in LittleFS with the moment the finger was placed. Kept scans are delivered oldest first after connectivity returns. If the device has not reached NTP since it was powered on it claims no time at all; the server then uses arrival time rather than accepting an invented timestamp.

## Serial commands

At 115200 baud:

- `enroll <id>` — enroll and confirm one R307 template manually
- `list` — report the number of stored templates
- `test` — one sensor communication test
- `sensor` — repeated link test
- `sensor hard` — longer repeated link test
- `empty` — explain the destructive command
- `empty confirm` — erase all templates
- `rest show` — show scanner awake/rest schedule
- `rest off` — keep the scanner awake
- `rest on` — allow the configured schedule to control sleep
- `rest reload` — reload the schedule

## Capacity

The tested R307 reports a capacity of **1000 templates**. The sketch validates IDs against the capacity reported by the actual module rather than trusting only a product listing.

Existing FPC1020A templates cannot be transferred. Every employee must be enrolled again on the R307. Existing website employees, attendance history, payroll records and role settings remain unchanged.

## Activity schedule and battery operation

The admin **Activity** schedule comes automatically from Role & Time shifts. An
awake scanner refreshes immediately after edits. A sleeping scanner receives the
change at its next timer wake (up to 10 minutes), then uses 45-second rest slices
while a fingerprint job waits. Only the scanner and LCD sleep; website/PIN paths
remain available.

For battery operation, use watt-hours for planning: a nominal 10,000 mAh,
3.7 V bank is about 37 Wh, not 10,000 mAh at 5 V. A 6000 mAh label must likewise
be converted using its cell voltage. Avoid banks with Auto-shutoff at low load.
