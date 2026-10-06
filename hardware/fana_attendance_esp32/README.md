# FANA CAFE - Attendance Hardware

> **GitHub Repo File**: This .ino file is kept in GitHub at `hardware/fana_attendance_esp32/fana_attendance_esp32.ino` for copy-paste upload. Always update there, commit, and copy from GitHub to Arduino IDE. Latest version is in branch `arena/01a0e384-digital-menu-railway` and `main` after merge.

## Materials (Final List - 8,720 Br without optional)
- ESP32 WROOM Wifi Board 1,750 Br (Micro USB, use existing data cable)
- FPC1020A Fingerprint 4,500 Br (1000 capacity, capacitive, 360°, wet optimized, <0.45s)
- 0.96" OLED Module 950 Br
- Jumper Wires 40pcs 600 Br (need 2 packs: Male-Female + Female-Female = 1,200 Br for 16 wires)
- BreadBoard 750 Br
- Buzzer 5V 150 Br
- LED 5mm x2 20 Br (Green + Red)
- Total core: 8,720 Br (1 pack wires) or 9,320 Br (2 packs wires) = 16 wires exact

Optional (you said not needed now):
- Power Bank 10,000mAh pass-through 1,800 Br for backup battery (30 hours)
- Plastic Box 300 Br
- Micro USB Female to Type-C Male converter DATA 150 Br
- Data cable Micro USB DATA 200 Br (use existing)
- Resistor 220ohm 20 Br
- 5V 2A Adapter 300 Br

Total with optional: ~11,920 Br

**Exact wire count: 16 wires**
- 4 wires Female-Female for FPC1020A (VCC,GND,TX,RX)
- 4 wires Female-Female for OLED (VCC,GND,SDA,SCL)
- 8 wires Male-Male for ESP32 breadboard power + buzzer + 2 LEDs + resistors

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
6. Edit `serverURL` in .ino to your VPSDime Coolify domain: `https://yourdomain.com` (replace with real domain)
7. Upload sketch (copy from GitHub file hardware/fana_attendance_esp32/fana_attendance_esp32.ino)
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
   - Print button: In Paper Sheet View, click "Print Hard Copy" -> prints only the table like normal paper (landscape, black border, FANA CAFÉ header) for hard copy filing
5. Offline: Saves to LittleFS queue, syncs when internet back, OLED still works from local cache
6. Sales: Owner reports now show only last 7 days daily sales sliding window (7th removed when new day starts) — total sales all-time replaced

## New Features Oct 2026

- ESP32 code in GitHub: File lives at hardware/fana_attendance_esp32/fana_attendance_esp32.ino - update in GitHub, copy-paste to Arduino IDE
- Print Attendance Sheet: Admin -> Attendance -> Paper Sheet View -> Print Hard Copy -> hard copy like paper sheet image you sent. Uses @media print landscape.
- Last 7 Days Sales: Reports tab now shows Daily Sales Last 7 Days sliding window. API /api/reports returns last7DaysSales array (date, label, revenue, orders) reversed oldest->newest. When new Ethiopian day starts, oldest drops automatically.
- Ready for hardware connect tomorrow: All APIs tested, typecheck passes, build passes 54 pages, mappings public, clock public, today/logs admin, biometrics admin, shifts admin.

## API Endpoints (on your VPSDime VPS)

- POST /api/attendance/clock {fingerprintId, deviceId} -> clock IN/OUT, returns OLED message
- GET /api/attendance/today -> today's live logs for kiosk
- GET /api/attendance/logs?from=2026-10-01&to=2026-10-07 -> paper sheet data
- GET /api/attendance/mappings -> fingerprintId -> staffName for ESP32 cache (public, no auth for ESP32)
- POST /api/attendance/biometrics {staffId, fingerprintId, fingerName} -> link fingerprint to staff
- GET /api/attendance/biometrics -> list all enrollments
- GET/POST /api/attendance/shifts -> Morning/Afternoon shifts
- GET /api/reports -> now includes last7DaysSales sliding window 7 days

## Paper Sheet Design (like your photo)

Digital version:
```
FANA CAFÉ & RESTAURANT - Attendance Sheet - 04/01/2019 to 05/01/2019
Employee Name | 04/01/2019 Mon Day | 05/01/2019 Tues Day
              | IN (TIME & SGN) | OUT (TIME & SGN) | IN | OUT
Ayelech ...   | 12:00 ID1 Late5 | 14:00 ID1 2h | ...
```
SGN = Fingerprint ID verified (digital signature)
Print button creates hard copy like normal paper with @media print landscape.

## Backup Battery

- Power bank 10,000mAh with pass-through: Charger -> Power bank -> ESP32
- When power lost, power bank continues 30 hours
- ESP32 still logs offline, syncs later

## Troubleshooting

- If OLED black: try address 0x3D instead of 0x3C
- If fingerprint not found: check wiring TX->16 RX->17 cross, baud 57600, VCC 3.3V or 5V
- If WiFi fails: reset WiFiManager by uncommenting wm.resetSettings() and re-upload
- If POST fails: check serverURL https, check VPSDime firewall allows ESP32 IP, check Coolify domain

## Next Steps After Hardware Buy (Tomorrow Connect Checklist)

1. Flash ESP32 with this code from GitHub, set serverURL to your Coolify domain
2. Enroll 1-2 test fingerprints via Serial `enroll 1`
3. Test POST to /api/attendance/clock via Serial Monitor or device scan
4. Open /attendance on kitchen tablet, should show live clock + last scan + today's table
5. Open /admin -> Attendance tab, should show Today Live + Paper Sheet View + Staff Fingerprints
6. Test Paper Sheet View Print Hard Copy button -> prints hard copy like paper
7. Check Reports tab -> Daily Sales Last 7 Days sliding window shows 7 days, oldest removed next day
8. Verify offline queue: disconnect WiFi, scan finger, reconnect, check queue syncs
9. Final: Enroll all staff 40-50 x 1-2 fingers each via device + link in admin panel
