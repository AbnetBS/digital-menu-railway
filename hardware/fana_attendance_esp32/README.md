# FANA CAFE - Attendance Hardware

## Materials (Final List - 8,720 Br without optional)
- ESP32 WROOM Wifi Board 1,750 Br (Micro USB, use data cable)
- FPC1020A Fingerprint 4,500 Br (1000 capacity, capacitive, 360°, wet optimized)
- 0.96" OLED Module 950 Br
- Jumper Wires 40pcs 600 Br (need 2 packs: Male-Female + Female-Female = 1,200 Br)
- BreadBoard 750 Br
- Buzzer 5V 150 Br
- LED 5mm x2 20 Br
- Total core: 8,720 Br (1 pack wires) or 9,320 Br (2 packs wires)

Optional (you said not needed now):
- Power Bank 10,000mAh pass-through 1,800 Br for backup battery (30 hours)
- Plastic Box 300 Br
- Micro USB Female to Type-C Male converter DATA 150 Br
- Data cable Micro USB DATA 200 Br
- Resistor 220ohm 20 Br
- 5V 2A Adapter 300 Br

Total with optional: ~11,920 Br

## Wiring for ESP32 WROOM + FPC1020A
```
FPC1020A VCC (Red)    -> ESP32 3.3V (or 5V if needed)
FPC1020A GND (Black)  -> ESP32 GND
FPC1020A TX (Yellow)  -> ESP32 GPIO16 (RX2)
FPC1020A RX (White)   -> ESP32 GPIO17 (TX2)
Buzzer +              -> ESP32 GPIO23
Buzzer -              -> GND
Green LED +           -> GPIO18 -> 220ohm -> GND
Red LED +             -> GPIO19 -> 220ohm -> GND
OLED VCC              -> 3.3V
OLED GND              -> GND
OLED SDA              -> GPIO21
OLED SCL              -> GPIO22
```

Need 16 jumper wires total.

## Setup Steps

1. Install Arduino IDE 2.3.10
2. Add ESP32 boards: File -> Preferences -> Additional URL: https://dl.espressif.com/dl/package_esp32_index.json
3. Boards Manager -> esp32 -> Install
4. Library Manager -> Install:
   - Adafruit Fingerprint Sensor Library
   - Adafruit SSD1306
   - Adafruit GFX Library
   - WiFiManager by tzapu
   - ArduinoJson
5. Select Board: ESP32 Dev Module, Port: COMx, Upload Speed: 921600
6. Edit `serverURL` in .ino to your VPSDime domain: `https://yourdomain.com`
7. Upload sketch
8. First boot: Phone WiFi -> Connect to "Fana-Attendance-Setup" password "fana12345" -> Set restaurant WiFi
9. Device will show IP on OLED, e.g., 192.168.1.50
10. Test: Place finger, should beep green, OLED shows name, POSTs to server

## Enroll Fingerprints

**Method 1 - Via Serial Monitor (easy):**
- Open Serial Monitor 115200
- Type `enroll 1` and press Enter
- Place finger, remove, place again -> Stored ID 1
- Then in admin panel /admin -> Attendance -> Staff Fingerprints -> Select staff Mulu -> Enter ID 1 -> Enroll

**Method 2 - Via Web:**
- Go to http://192.168.1.50/enroll?id=1 in browser
- Place finger

## Workflow

1. Idle: OLED shows "Place finger", tablet /attendance shows live clock
2. Scan: FPC1020A finds ID in <0.45 sec, OLED shows name, green LED + beep, POST to /api/attendance/clock
3. Tablet /attendance auto refresh every 8 sec, shows new row IN/OUT with total hours
4. Admin /admin -> Attendance tab shows paper sheet view like your photo: Employee Name | Date | IN Time & Finger | OUT Time & Finger | Total Hours | Late
5. Offline: Saves to LittleFS queue, syncs when internet back, OLED still works from local cache

## API Endpoints (on your VPSDime VPS)

- POST /api/attendance/clock {fingerprintId, deviceId} -> clock IN/OUT, returns OLED message
- GET /api/attendance/today -> today's live logs for kiosk
- GET /api/attendance/logs?from=2026-10-01&to=2026-10-07 -> paper sheet data
- GET /api/attendance/mappings -> fingerprintId -> staffName for ESP32 cache
- POST /api/attendance/biometrics {staffId, fingerprintId, fingerName} -> link fingerprint to staff
- GET /api/attendance/biometrics -> list all enrollments
- GET/POST /api/attendance/shifts -> Morning/Afternoon shifts

## Paper Sheet Design (like your photo)

Digital version:
```
FANA CAFÉ & RESTAURANT - Attendance Sheet - 04/01/2019 to 05/01/2019
Employee Name | 04/01/2019 Mon Day | 05/01/2019 Tues Day
              | IN (TIME & SGN) | OUT (TIME & SGN) | IN | OUT
Ayelech ...   | 12:00 ID1 Late5 | 14:00 ID1 2h | ...
```
SGN = Fingerprint ID verified (digital signature)

## Backup Battery

- Power bank 10,000mAh with pass-through: Charger -> Power bank -> ESP32
- When power lost, power bank continues 30 hours
- ESP32 still logs offline, syncs later

## Troubleshooting

- If OLED black: try address 0x3D instead of 0x3C
- If fingerprint not found: check wiring TX->16 RX->17 cross, baud 57600, VCC 3.3V or 5V
- If WiFi fails: reset WiFiManager by uncommenting wm.resetSettings() and re-upload
- If POST fails: check serverURL https, check VPSDime firewall allows ESP32 IP

## Next Steps After Hardware Buy

1. Flash ESP32 with this code, set serverURL to your domain
2. Enroll 1-2 test fingerprints via Serial
3. Test POST to /api/attendance/clock via Serial Monitor
4. Open /attendance on tablet, should show live
5. Open /admin -> Attendance tab, should show paper sheet
