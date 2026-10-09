# FANA CAFE - Attendance Hardware

> **GitHub Repo File**: The upload sketch lives at `hardware/fana_attendance_esp32/fana_attendance_esp32.ino`. This review updates branch `arena/861dfe55-digital-menu-railway`; after merge, use the copy on `main`.

## Materials (core build - 8,720 Br before optional accessories)
- ESP32 WROOM Wifi Board 1,750 Br (Micro USB, use existing data cable)
- FPC1020A Fingerprint 4,500 Br (1000 capacity, capacitive, 360°, wet optimized, <0.45s)
- 0.96" OLED Module 950 Br
- Jumper Wires 40pcs (core build uses 16 wires; add 2 for recommended touch sense)
- BreadBoard 750 Br
- Buzzer 5V 150 Br
- LED 5mm x2 20 Br (Green + Red)
- Total core: 8,720 Br; the core wiring uses 16 wires, or 18 with touch sense connected

Optional (you said not needed now):
- Power Bank 10,000mAh pass-through 1,800 Br for backup battery (30 hours)
- Plastic Box 300 Br
- Micro USB Female to Type-C Male converter DATA 150 Br
- Data cable Micro USB DATA 200 Br (use existing)
- Resistor 220ohm 20 Br
- 5V 2A Adapter 300 Br

Total with optional: ~11,920 Br

**Core wire count: 16; add 2 recommended touch-sense wires (18 total)**
- 4 wires Female-Female for FPC1020A (VCC,GND,TX,RX)
- 2 recommended wires for FPC1020A touch sense (TOUCH OUT, V_TOUCH)
- 4 wires Female-Female for OLED (VCC,GND,SDA,SCL)
- 8 wires Male-Male for ESP32 breadboard power + buzzer + 2 LEDs + resistors

## Wiring for ESP32 WROOM + FPC1020A
```
FPC1020A VCC (Red)    -> ESP32 3.3V (5V only if module is rated for 5V)
FPC1020A GND (Black)  -> ESP32 GND
FPC1020A TX (Yellow)  -> ESP32 GPIO16 (RX2)
FPC1020A RX (White)   -> ESP32 GPIO17 (TX2)
FPC1020A TOUCH OUT (pin 5) -> ESP32 GPIO25
FPC1020A V_TOUCH (pin 6)   -> ESP32 3.3V
Buzzer +              -> ESP32 GPIO23
Buzzer -              -> GND
Green LED +           -> GPIO18 -> 220ohm -> GND
Red LED +             -> GPIO19 -> 220ohm -> GND
OLED VCC              -> 3.3V
OLED GND              -> GND
OLED SDA              -> GPIO21
OLED SCL              -> GPIO22
```

Use 16 jumper wires for the core build, or 18 when adding the two recommended touch-sense connections.

## Setup Steps

1. Install Arduino IDE 2.3.10
2. Add ESP32 boards: File -> Preferences -> Additional URL: https://dl.espressif.com/dl/package_esp32_index.json
3. Boards Manager -> esp32 -> Install
4. Install the **patched Biovo1020A library from this repository** (keep the tested copy unchanged), plus Adafruit SSD1306, Adafruit GFX Library, WiFiManager by tzapu, and ArduinoJson. Do not install/use the Adafruit fingerprint library for this module.
5. Wire FPC1020A TOUCH OUT (pin 5) to GPIO25 and V_TOUCH (pin 6) to 3.3V; touch sensing is enabled in this sketch.
6. Select Board: ESP32 Dev Module, Port: COMx, Upload Speed: 921600.
7. Upload the sketch from `hardware/fana_attendance_esp32/fana_attendance_esp32.ino`.
8. First boot: Phone WiFi -> connect to "Fana-Attendance-Setup" (password "fana12345") -> set restaurant WiFi.
9. The device will show its IP on the OLED. Test with a mapped staff finger; it should beep and POST to the server.

## Enroll Fingerprints — two ways

### Path A: automatic (recommended)
1. In admin, open **Attendance → Staff Members** and edit the person.
2. Press **ADD FINGERPRINT**. The server chooses a free sensor ID from 1–1000 and pushes the job to the device.
3. Follow the OLED; the device enrolls the finger and sends the mapping back. The admin page shows **Fingerprint Added ✓**.

### Path B: manual (enroll on the device, then map it)
1. Open the device Serial Monitor at **115200 baud**.
2. Type `enroll 7` (use the ID you want, 1–1000) and press Enter.
3. Follow the OLED. On success the device prints and displays: **Stored as ID 7 — map it: admin → Attendance → Staff Fingerprints**.
4. In admin, open **Attendance → Staff Fingerprints**. Select the person, enter the same ID, choose the finger name, and press **Add**.
5. The page confirms **Fingerprint Added for …**. The ID must match the one stored on the device.

### The six captures and status-6 retry
Each fingerprint is captured six times: **Step 1 = one ADD_1 capture; Step 2 = four ADD_2 captures; Step 3 = one ADD_3 capture.** Keep the same finger flat and still through successful captures. The OLED identifies the progress, for example **Step 2 of 3, Capture 2/4**.

With touch sense, before each capture the device waits for a finger on TOUCH OUT and gives it about **600 ms to settle**. If the module returns status 6 (image unclear), the device says **“Hold still — don't move”** and retries the same capture after about one second. It asks you to lift and place flat only after three consecutive unclear images; each capture has at most five attempts.

### Physical checklist
- Remove the sensor's protective film; clean the sensor surface.
- Press the finger flat and **STILL**. Do not move until the capture finishes — movement caused the reported failure.
- If a finger is dry, lightly moisten it; wipe off sweat or excess moisture.
- Connect TOUCH OUT pin 5 → ESP32 GPIO25 and V_TOUCH pin 6 → 3.3V. If touch is not detected, change `FINGER_TOUCH_ACTIVE` from `HIGH` to `LOW` in the sketch and upload again.
- Keep wires short. If captures still fail, place a **100 µF capacitor across module VCC and GND**.
- Use 5V power **only if the module is specifically rated for 5V**; otherwise use its rated voltage. UART stays at 19200 baud.

## Workflow

1. Idle: OLED shows "Place finger", tablet /attendance shows live clock
2. Scan: FPC1020A finds ID in <0.45 sec, OLED shows name, green LED + beep, POST to /api/attendance/clock
3. Tablet /attendance updates in REAL TIME (SSE push from the server) the moment a scan lands - no polling
4. The ESP32 keeps one real-time event stream open (/api/attendance/events): the admin presses "Add Fingerprint"
   and the device is told INSTANTLY (no 2-second polling). A slow 15 s fallback poll runs only if the stream is down.
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
- POST /api/attendance/biometrics {memberId, fingerprintId, fingerName} -> manually map an ID already stored on the sensor (default action: map)
- POST /api/attendance/biometrics {action: "enroll", memberId} -> open the automatic enrollment job
- GET /api/attendance/biometrics?pending=1 -> device reads the pending job
- GET /api/attendance/members -> admin member list, including each member's fingers[] IDs
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
- **Enrollment returns status 6 (image unclear):** the old workflow captured
  while the finger was moving into place. The new flow retries the same capture
  while you hold still, then asks you to lift only after three unclear tries.
  See **FINGERPRINT_FIX.md** and use the physical checklist above.
- If fingerprint sensor not answering: check wiring TX->16 RX->17 cross,
  GND, VCC 3.3V (or 5V if the module is a 5V version), **baud 19200** (8N1)
- If fingerprint not found (but scans work): the finger is not enrolled -
  the OLED says "Not enrolled! Ask admin to add this finger"
- If WiFi fails: reset WiFiManager by uncommenting wm.resetSettings() and re-upload
- If POST fails: check serverURL https, check VPSDime firewall allows ESP32 IP, check Coolify domain
- Serial Monitor commands: `enroll <id>`, `list`, `empty`, `test` (115200 baud)

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
