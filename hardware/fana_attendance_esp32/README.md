# FANA CAFE - Attendance Hardware

> **GitHub Repo File**: The upload sketch lives at `hardware/fana_attendance_esp32/fana_attendance_esp32.ino`. What changed in Oct 2026 and why: **FINGERPRINT_FIX.md**.

## Materials (core build - 8,720 Br before optional accessories)
- ESP32 WROOM Wifi Board 1,750 Br (Micro USB, use existing data cable)
- FPC1020A Fingerprint 4,500 Br (1000 capacity, capacitive, 360°, wet optimized, <0.45s)
- 0.96" OLED Module 950 Br
- Jumper Wires 40pcs (core build uses 16 wires)
- BreadBoard 750 Br
- Buzzer 5V 150 Br
- LED 5mm x2 20 Br (Green + Red)
- Total core: 8,720 Br; the core wiring uses 16 wires

Optional (you said not needed now):
- Power Bank 10,000mAh pass-through 1,800 Br for backup battery (30 hours)
- Plastic Box 300 Br
- Micro USB Female to Type-C Male converter DATA 150 Br
- Data cable Micro USB DATA 200 Br (use existing)
- Resistor 220ohm 20 Br
- 5V 2A Adapter 300 Br

Total with optional: ~11,920 Br

**Core wire count: 16**
- 4 wires Female-Female for FPC1020A (VCC,GND,TX,RX). Pins 5 and 6 (touch sense) stay unconnected.
- 4 wires Female-Female for OLED (VCC,GND,SDA,SCL)
- 8 wires Male-Male for ESP32 breadboard power + buzzer + 2 LEDs + resistors

## Wiring for ESP32 WROOM + FPC1020A
```
FPC1020A VCC (Red)    -> ESP32 3.3V (5V only if module is rated for 5V)
FPC1020A GND (Black)  -> ESP32 GND
FPC1020A TX (Yellow)  -> ESP32 GPIO16 (RX2)
FPC1020A RX (White)   -> ESP32 GPIO17 (TX2)
FPC1020A pins 5 and 6 (touch sense) -> NOT CONNECTED
Buzzer +              -> ESP32 GPIO23
Buzzer -              -> GND
Green LED +           -> GPIO18 -> 220ohm -> GND
Red LED +             -> GPIO19 -> 220ohm -> GND
OLED VCC              -> 3.3V
OLED GND              -> GND
OLED SDA              -> GPIO21
OLED SCL              -> GPIO22
```

Use 16 jumper wires. The fingerprint sensor needs only its 4 wires: wiring the touch-sense pins made the old sketch slow and stuck.

## Setup Steps

1. Install Arduino IDE 2.3.10
2. Add ESP32 boards: File -> Preferences -> Additional URL: https://dl.espressif.com/dl/package_esp32_index.json
3. Boards Manager -> esp32 -> Install
4. Install the **patched Biovo1020A library from this repository** (keep the tested copy unchanged), plus Adafruit SSD1306, Adafruit GFX Library, WiFiManager by tzapu, and ArduinoJson (v6 or v7). Do not install/use the Adafruit fingerprint library for this module.
5. Wire the fingerprint sensor with 4 wires only (VCC, GND, TX -> GPIO16, RX -> GPIO17). If the server has `ATTENDANCE_DEVICE_TOKEN` set, copy it into `deviceToken` at the top of the sketch.
6. Select Board: ESP32 Dev Module, Port: COMx, Upload Speed: 921600.
7. Upload the sketch from `hardware/fana_attendance_esp32/fana_attendance_esp32.ino`.
8. First boot: Phone WiFi -> connect to "Fana-Attendance-Setup" (password "fana12345") -> set restaurant WiFi.
9. The OLED shows **PLACE FINGER**. A mapped finger shows **VERIFIED + name** at once, then **IN 08:05** from the server about a second later.

## Enroll Fingerprints: two ways

### Path A: automatic (recommended)
1. In admin, open **Attendance → Staff Members** and edit the person.
2. Press **ADD FINGERPRINT**. The server chooses a free sensor ID from 1-1000 and pushes the job to the device.
3. The OLED shows the name and guides the person: **PLACE**, **HOLD**, **LIFT**, same finger again, with **Step x of 6** and a countdown (25 s per capture, no tries are counted while nobody is touching).
4. The device sends the mapping back with the job number. The OLED says **FINGERPRINT ADDED** and the admin page shows **Fingerprint Added ✓**.
5. If it cannot finish, the OLED says why (for example *Finger already used by Abebe* or *No finger - timed out*) and the admin page shows **Fingerprint not added** with the reason and **Try again**.

### Path B: manual (enroll on the device, then map it)
1. Open the device Serial Monitor at **115200 baud**.
2. Type `enroll 7` (use a free ID, 1-1000; `free` prints the next one) and press Enter.
3. Follow the OLED. On success the device prints **Stored as ID 7. Map it: admin → Attendance → Staff Fingerprints**.
4. In admin, open **Attendance → Staff Fingerprints**. Select the person, enter the same ID, choose the finger name, and press **Add**.
5. The page confirms **Fingerprint Added for …**. `enroll` refuses an ID that is already mapped to somebody.

### Sensor status codes (official protocol)
Enrollment status **6 = this ID is already used** on the sensor (the device deletes the leftover and continues), **7 = this finger is already saved** under another ID, **8 = no finger yet** (keep waiting). Six captures: step 1 once, step 2 four times, step 3 once.

### Physical checklist
- Remove the sensor's protective film; clean the sensor surface.
- Press the finger flat; use the same finger for all six captures.
- If a finger is dry, lightly moisten it; wipe off sweat or excess moisture.
- Keep wires short. If the sensor resets when WiFi starts, place a **100 µF capacitor across module VCC and GND**.
- Use 5V power **only if the module is specifically rated for 5V**. UART stays at 19200 baud.

### Tests without hardware
`cd hardware/fana_attendance_esp32/test && ./run_tests.sh` builds the real sketch on a PC against a simulated sensor, OLED and website and plays 16 situations (fast verify, idle then scan, enrollment, offline, legacy module...). See FINGERPRINT_FIX.md.

## Workflow

1. Idle: OLED shows "Place finger", tablet /attendance shows live clock
2. Scan: FPC1020A finds the ID, OLED shows VERIFIED + name with green LED + beep in about 0.3 s; the POST to /api/attendance/clock runs in the background and its answer (IN/OUT/Late) follows
3. Tablet /attendance updates in REAL TIME (SSE push from the server) the moment a scan lands - no polling
4. The ESP32 keeps one real-time event stream open (/api/attendance/events): the admin presses "Add Fingerprint"
   and the device is told INSTANTLY (no 2-second polling). A slow 15 s fallback poll runs only if the stream is down.
4. Admin /admin -> Attendance tab shows paper sheet view like your photo: Employee Name | Date | IN Time & Finger | OUT Time & Finger | Total Hours | Late
   - Print button: In Paper Sheet View, click "Print Hard Copy" -> prints only the table like normal paper (landscape, black border, FANA CAFÉ header) for hard copy filing
5. Offline: Saves to LittleFS queue with the real scan time, syncs when internet back (recorded at the scan time, not the sync time), OLED still works from local cache
6. Sales: Owner reports now show only last 7 days daily sales sliding window (7th removed when new day starts) - total sales all-time replaced

## New Features Oct 2026

- ESP32 code in GitHub: File lives at hardware/fana_attendance_esp32/fana_attendance_esp32.ino - update in GitHub, copy-paste to Arduino IDE
- Print Attendance Sheet: Admin -> Attendance -> Paper Sheet View -> Print Hard Copy -> hard copy like paper sheet image you sent. Uses @media print landscape.
- Last 7 Days Sales: Reports tab now shows Daily Sales Last 7 Days sliding window. API /api/reports returns last7DaysSales array (date, label, revenue, orders) reversed oldest->newest. When new Ethiopian day starts, oldest drops automatically.
- Ready for hardware connect tomorrow: All APIs tested, typecheck passes, build passes 54 pages, mappings public, clock public, today/logs admin, biometrics admin, shifts admin.

## API Endpoints (on your VPSDime VPS)

- POST /api/attendance/clock {fingerprintId, deviceId, scannedAt} -> clock IN/OUT at the scan time, returns OLED message (device token or admin when ATTENDANCE_DEVICE_TOKEN is set)
- GET /api/attendance/today -> today's live logs for kiosk
- GET /api/attendance/logs?from=2026-10-01&to=2026-10-07 -> paper sheet data
- GET /api/attendance/mappings -> fingerprintId -> staffName for ESP32 cache (public, no auth for ESP32)
- POST /api/attendance/biometrics {memberId, fingerprintId, fingerName} -> manually map an ID already stored on the sensor (default action: map)
- POST /api/attendance/biometrics {action: "enroll", memberId} -> open the automatic enrollment job
- GET /api/attendance/biometrics?pending=1 -> device reads the pending job
- POST /api/attendance/biometrics {action: "device_failed", jobId, reason} -> device reports a job it could not finish
- POST /api/attendance/mappings {fingerprintId, memberId, jobId} -> device reports the finger it stored
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
A person is marked absent only from their registration date through Ethiopian today; earlier dates and future dates stay blank.

## Backup Battery

- Power bank 10,000mAh with pass-through: Charger -> Power bank -> ESP32
- When power lost, power bank continues 30 hours
- ESP32 still logs offline, syncs later

## Troubleshooting

- If OLED black: try address 0x3D instead of 0x3C
- **Device slow or stuck:** make sure pins 5 and 6 of the sensor are NOT connected (4 wires only).
- **Enrollment says "ID busy on sensor":** type `delete <id>` in the Serial Monitor and press Add Fingerprint again.
- If fingerprint sensor not answering: check wiring TX->16 RX->17 cross,
  GND, VCC 3.3V (or 5V if the module is a 5V version), **baud 19200** (8N1)
- If fingerprint not found (but scans work): the finger is not stored on the sensor -
  the OLED says "NOT REGISTERED - Ask the admin". "NOT ADDED - Ask admin to map ID x"
  means the sensor knows the finger but the website has no mapping for that ID.
- If WiFi fails: type `wifi reset` in the Serial Monitor; the device restarts into the setup hotspot
- If POST fails: check serverURL https, check VPSDime firewall allows ESP32 IP, check Coolify domain
- Serial Monitor commands (115200 baud): `enroll <id>`, `delete <id>`, `count`, `free`, `test`, `empty`, `wifi reset`

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
