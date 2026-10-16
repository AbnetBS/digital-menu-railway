# FANA CAFE - Attendance Hardware

> **GitHub Repo File**: The upload sketch lives at `hardware/fana_attendance_esp32/fana_attendance_esp32.ino`. This review updates branch `arena/861dfe55-digital-menu-railway`; after merge, use the copy on `main`.

## Materials (core build)
- ESP32 WROOM Wifi Board 1,750 Br (Micro USB, use existing data cable)
- FPC1020A Fingerprint 4,500 Br (1000 capacity, capacitive, 360°, wet optimized, <0.45s)
- **20x4 character LCD, "2004", with the I2C backpack already soldered on** (GND/VCC/SDA/SCL)
- **Four-channel BSS138 bidirectional level shifter** (LV, A1-A4, GND / HV, B1-B4, GND)
- **2N2222 NPN transistor** + **1 kohm** and **10 kohm** resistors + **1N4007** diode (buzzer driver)
- Jumper wires: **12 male-male + 4 male-female** 2.54 mm Dupont recommended for the LCD + shifter
  (the sensor still needs its own 4 female-female wires; buy a couple extra of each - they are cheap)
- BreadBoard 750 Br
- Buzzer: small 5 V two-pin (voltage/type to confirm - see "Buzzer check")
- LED 5mm x2 20 Br (Green + Red)
- **UNVERIFIED so far**: the transistor's leg order, the resistor values, and the buzzer's
  type/voltage were never checked against the photo or a meter. Verify them BEFORE powering up:
  see "Verify before you power up" below.

Optional (you said not needed now):
- Power Bank 10,000mAh pass-through 1,800 Br for backup battery (30 hours)
- Plastic Box 300 Br
- Micro USB Female to Type-C Male converter DATA 150 Br
- Data cable Micro USB DATA 200 Br (use existing)
- Resistor 220ohm 20 Br
- 5V 2A Adapter 300 Br

Total with optional: ~11,920 Br

**Wire count (LCD build)**
- 4 Female-Female for the FPC1020A (VCC, GND, TX, RX). Nothing else is needed for the sensor.
- 4 Male-Female for the LCD backpack (GND, VCC, SDA, SCL) - the backpack's pins are male.
- ~6 Male-Male for the level shifter (3V3->LV, 5V->HV, GPIO21->A1, GPIO22->A2, GND low, GND high)
- ~6 Male-Male for the buzzer driver (GPIO23 -> 1k -> base, 10k base->GND, emitter->GND, buzzer +->5 V,
  buzzer -->collector, diode legs across the buzzer)
- 2 Male-Male for the green/red LEDs (plus 220 ohm resistors)
- Buy about 20 Male-Male and 8 Male-Female in total so a re-wire never stops the build.

## Wiring for ESP32 WROOM + FPC1020A + 20x4 I2C LCD

```
FPC1020A VCC (Red)    -> ESP32 3.3V (5V only if module is rated for 5V)
FPC1020A GND (Black)  -> ESP32 GND
FPC1020A TX (Yellow)  -> ESP32 GPIO16 (RX2)
FPC1020A RX (White)   -> ESP32 GPIO17 (TX2)
(FPC1020A pins 5 and 6 are NOT connected. The sketch does not use them.)

LCD THROUGH THE LEVEL SHIFTER (the LCD backpack is a 5 V part):
  ESP32 3V3           -> level shifter LV
  Regulated 5 V       -> level shifter HV   AND   LCD backpack VCC
  ESP32 GPIO21        -> level shifter A1    ->  B1 -> LCD backpack SDA
  ESP32 GPIO22        -> level shifter A2    ->  B2 -> LCD backpack SCL
  All GND together: ESP32 GND, shifter LV GND, shifter HV GND, backpack GND
  Channels A3/A4 - B3/B4 stay UNUSED.
  NEVER wire the backpack SDA/SCL straight to the ESP32 (5 V pull-ups).

BUZZER ON A TRANSISTOR (GPIO23 never drives the buzzer directly):
  ESP32 GPIO23        -> 1 kohm -> 2N2222 base
  2N2222 base         -> 10 kohm -> GND
  Buzzer +            -> regulated 5 V
  Buzzer -            -> 2N2222 collector
  2N2222 emitter      -> GND
  1N4007 (magnetic buzzers only): across the buzzer, STRIPED end to +5 V

Green LED +           -> GPIO18 -> 220ohm -> GND
Red LED +             -> GPIO19 -> 220ohm -> GND
```

The sensor needs only four wires: VCC, GND, RX, TX. The level shifter is NOT
the buzzer driver, and the buzzer driver has nothing to do with the LCD.

### Verify before you power up (the photo was not conclusive)
1. **Transistor leg order.** A 2N2222 in a TO-92 package is usually
   E-B-C when the flat side faces you with the legs pointing down, but the
   markings were never checked. Confirm with a multimeter diode test or the
   datasheet for the exact part you hold, and name the legs before wiring.
2. **Resistors.** Read 1 kohm (brown-black-red) and 10 kohm
   (brown-black-orange) off the bands or measure them. Swap them and the
   transistor will not switch the buzzer.
3. **Buzzer.** Two pins, and 5 V rated? An ACTIVE buzzer clicks/beeps when you
   touch it across a 5 V supply; a PASSIVE buzzer needs a drive signal and
   stays silent on plain DC. The sketch drives GPIO23 HIGH/LOW (active
   buzzer). For a passive one, uncomment `#define BUZZER_IS_PASSIVE` in the
   sketch and it uses tone() instead. A magnetic buzzer gets the 1N4007; a
   piezo one does not need it.
4. **LCD backpack.** 5 V VCC through the shifter's HV side, and the contrast
   pot (the blue one) is normal to need adjusting on first power-up.
5. **5 V source.** ESP32 boards accept 5 V on VIN/5V only from a regulated
   supply, and many boards must NOT be fed there while USB is plugged in.
   Confirm your exact board first; otherwise power the 5 V rail from a USB
   adapter and keep the ESP32 on its own USB cable.
6. **Wires.** 12 male-male + 4 male-female were recommended, not confirmed as
   bought. You need roughly the counts listed above.

## Setup Steps

1. Install Arduino IDE 2.3.10
2. Add ESP32 boards: File -> Preferences -> Additional URL: https://dl.espressif.com/dl/package_esp32_index.json
3. Boards Manager -> esp32 -> Install
4. Install these libraries (Arduino IDE -> Library Manager):
   - **hd44780** by Bill Perry (duinoWitchery) - the 20x4 I2C LCD. This replaces
     Adafruit SSD1306 + Adafruit GFX Library, which are no longer used.
   - **ArduinoJson** (v6.x) and **WiFiManager** by tzapu.
   - The **patched Biovo1020A library from this repository** - install the copy
     in `hardware/fana_attendance_esp32/libraries/Biovo1020A` (Sketch ->
     Include Library -> Add .ZIP Library, or copy the folder into your
     Arduino `libraries` directory). Keep the tested copy unchanged.
   Do not install/use the Adafruit fingerprint library for this module.
5. Wire the sensor with the four wires only (see the table above). No touch wires.
6. Select Board: ESP32 Dev Module, Port: COMx, Upload Speed: 921600.
7. Upload the sketch from `hardware/fana_attendance_esp32/fana_attendance_esp32.ino`.
8. First boot: Phone WiFi -> connect to "Fana-Attendance-Setup" (password "fana12345") -> set restaurant WiFi.
9. The LCD shows `Fana Cafe Attendance / Place finger / Wifi Connected / Time 14:05:30`.
   Row 2 says in one plain word whether the scan will reach the website (`Wifi Not Connected`
   when it will not - the scans are then saved on the device and synced later), and row 3 is the
   wall clock from NTP on Ethiopian time (UTC+3). `Time not set yet` means the WiFi is up but NTP
   never answered: check that the router lets the device out on UDP 123. The device's IP address
   and the template count moved to its own status page (`http://<device-ip>/`) and to the Serial
   monitor, so the person at the door reads only what he needs.
   If it is blank or shows only blocks, run the LCD check below (the contrast
   pot and the level shifter are the first things to look at). Then test with a
   mapped staff finger; it should beep and POST to the server.

## Enroll Fingerprints — two ways

### Path A: automatic (recommended)
1. In admin, open **Attendance → Staff Members** and edit the person.
2. Press **ADD FINGERPRINT**. The server chooses a free sensor ID from 1–1000 and pushes the job to the device.
3. Follow the LCD; the device enrolls the finger and sends the mapping back. The admin page shows **Fingerprint Added ✓**.

### Path B: manual (enroll on the device, then map it)
1. Open the device Serial Monitor at **115200 baud**.
2. Type `enroll 7` (use the ID you want, 1–1000) and press Enter.
3. Follow the LCD. On success the device prints and displays: **Stored as ID 7 — map it: admin → Attendance → Staff Fingerprints**.
4. In admin, open **Attendance → Staff Fingerprints**. Select the person, enter the same ID, choose the finger name, and press **Add**.
5. The page confirms **Fingerprint Added for …**. The ID must match the one stored on the device.

### Automatic enrollment, step by step
When you press **Add Fingerprint** on the website, the device shows the person's name and walks them through six scans taken from ONE placement:

- The admin page says **Waiting for the device** and then **Device is ready • ID n** the moment the scanner picked the job up. If it never changes, the scanner is offline.
- If a finger is already resting on the glass the LCD says **LIFT YOUR FINGER** first. Take it off - a finger that was there before the job started is what used to make the automatic enrollment fail while the Serial command worked.
- The LCD then says **PLACE FINGER** once, then **KEEP STILL** while the five remaining scans are taken. The second row shows `ID 7 [######] 2/6`: one `#` per accepted capture. Do not lift the finger until the device is done.
- Between the six captures the device sends the sensor NOTHING but the six ADD commands. Any other command mid-enrollment makes the module refuse the next scan with status 1 - this is what broke enrollment in PR #50 and is fixed now (see FINGERPRINT_FIX.md).
- The order is fixed: one scan of step 1, four scans of step 2, one scan of step 3 - the same finger, flat and still on the sensor the whole time.
- Each ADD command gives the module up to 30 seconds. If no finger is seen for 30 seconds in total, the job ends with "no finger was placed".
- If the image is not clear (sensor status 6), the LCD says **HOLD STILL** and the same scan is retried about a second later. After three unclear images it says **LIFT, PLACE AGAIN**.
- If the six scans still cannot be finished, the device asks for a fresh lift and placement and starts the whole sequence again - up to 3 attempts - before it gives up.
- If nobody places a finger within 30 seconds, or all 3 attempts fail, the job is marked **failed**. The LCD shows **Not added** with the first 20 characters of the reason, and the admin page prints the same reason (which scan, which sensor status) with a **Try again** button. The device does not loop on its own.

### Physical checklist
- Remove the sensor's protective film; clean the sensor surface.
- Press the finger flat and **STILL**. Do not move until the scan is accepted. Lifting early is the most common cause of a failed enrollment.
- If a finger is dry, lightly moisten it; wipe off sweat or excess moisture.
- Keep wires short. If captures still fail, place a **100 µF capacitor across module VCC and GND**.
- Use 5V power **only if the module is specifically rated for 5V**; otherwise use its rated voltage. UART stays at 19200 baud.

## Workflow

1. Idle: the LCD shows `Fana Cafe Attendance / Place finger / Wifi Connected / Time HH:MM:SS`
   (the clock row moves once a second, from NTP, on Ethiopian time), tablet /attendance shows the live sheet
2. Scan: one placement = one scan. The finger is matched and **VERIFIED** shows at once, then the website answers in about 1-2 seconds (IN / OUT / late / not registered). The device goes back to "Place finger" by itself. A finger that stays on the sensor is never posted twice.
3. Tablet /attendance updates in REAL TIME (SSE push from the server) the moment a scan lands - no polling
4. The ESP32 keeps one real-time event stream open (/api/attendance/events): the admin presses "Add Fingerprint"
   and the device is told INSTANTLY (no 2-second polling). A slow 15 s fallback poll runs only if the stream is down.
4. Admin /admin -> Attendance tab shows paper sheet view like your photo: Employee Name | Date | IN Time & Finger | OUT Time & Finger | Total Hours | Late
   - Print button: In Paper Sheet View, click "Print Hard Copy" -> prints only the table like normal paper (landscape, black border, FANA CAFÉ header) for hard copy filing
5. Offline: Saves to LittleFS queue, syncs when internet back; the LCD says "Wifi Not Connected" on row 2 and keeps working from local cache
6. Sales: Owner reports now show only last 7 days daily sales sliding window (7th removed when new day starts) — total sales all-time replaced

## New Features Oct 2026

- ESP32 code in GitHub: File lives at hardware/fana_attendance_esp32/fana_attendance_esp32.ino - update in GitHub, copy-paste to Arduino IDE
- Print Attendance Sheet: Admin -> Attendance -> Paper Sheet View -> Print Hard Copy -> hard copy like paper sheet image you sent. Uses @media print landscape.
- Last 7 Days Sales: Reports tab now shows Daily Sales Last 7 Days sliding window. API /api/reports returns last7DaysSales array (date, label, revenue, orders) reversed oldest->newest. When new Ethiopian day starts, oldest drops automatically.
- Ready for hardware connect tomorrow: All APIs tested, typecheck passes, build passes 54 pages, mappings public, clock public, today/logs admin, biometrics admin, shifts admin.

## API Endpoints (on your VPSDime VPS)

- POST /api/attendance/clock {fingerprintId, deviceId} -> clock IN/OUT, returns the message the device shows
- GET /api/attendance/today -> today's live logs for kiosk
- GET /api/attendance/logs?from=2026-10-01&to=2026-10-07 -> paper sheet data
- GET /api/attendance/mappings -> fingerprintId -> staffName for ESP32 cache (public, no auth for ESP32)
- POST /api/attendance/biometrics {memberId, fingerprintId, fingerName} -> manually map an ID already stored on the sensor (default action: map)
- POST /api/attendance/biometrics {action: "enroll", memberId} -> open the automatic enrollment job
- GET /api/attendance/biometrics?pending=1 -> device reads the pending job
- POST /api/attendance/mappings {action: "job_started", jobId, fingerprintId} -> device says it picked the job up, BEFORE it touches the sensor; the admin page shows "Device is ready"
- POST /api/attendance/mappings {action: "job_failed", jobId, reason} -> device reports a failed enrollment job (marks it failed on the website, and the page prints the reason)

The device itself serves only its status page (`/` and `/status`). It has no `/enroll`, `/logs` or `/mappings` routes.
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

- If the LCD is blank or shows blocks: run `diagnostics/lcd_check/lcd_check.ino` (see the LCD check above). Blank/blocks with the backlight on is the contrast pot; no I2C address answering is wiring or power, and the sketch never assumes the address.
- **Enrollment says HOLD STILL (sensor status 6, image unclear):** keep the finger flat and still. The device retries the same scan on its own, and retries the whole six-scan sequence up to 3 times. If it keeps failing, clean the sensor and check the physical checklist above. The admin page now prints the exact scan and status, so you can see where it stopped.
- **The admin page stays on "Waiting for the device":** the scanner never picked the job up. Check that it is powered, on the same WiFi, and that `serverURL` in the sketch points at the live domain.
- **Run the enrollment tests without the hardware:** `bash hardware/fana_attendance_esp32/test/run.sh` compiles the real sketch against host stubs and runs the enrollment state machine on a simulated sensor.
- **Enrollment keeps failing on the device:** flash `diagnostics/enroll_diagnostic/enroll_diagnostic.ino` INSTEAD of the product sketch and send `a`, `b` or `c` in the Serial Monitor (115200 baud). It runs one six-scan test enrollment and prints every sensor reply with a timestamp; `a` replays the old PR #50 strategy, `b` the lift-pause strategy, `c` the current keep-the-finger-on strategy. Share the log so the statuses can be compared.
- If fingerprint sensor not answering: check wiring TX->16 RX->17 cross,
  GND, VCC 3.3V (or 5V if the module is a 5V version), **baud 19200** (8N1)
- If fingerprint not found (but scans work): the finger is not enrolled -
  the LCD says **NOT REGISTERED / Finger not enrolled / Ask admin to add it**
- If WiFi fails: reset WiFiManager by uncommenting wm.resetSettings() and re-upload
- If the LCD's bottom row stays on `Time not set yet`: the WiFi is up but NTP never answered.
  The router must let the device out on UDP 123 (`pool.ntp.org`, `time.nist.gov`). Nothing else
  depends on it - scans, enrollment and the queue all work without the clock.
- If POST fails: check serverURL https, check VPSDime firewall allows ESP32 IP, check Coolify domain
- Serial Monitor commands (115200 baud): `enroll <id>` (manual enrollment, 1-1000), `list`, `test`, `empty confirm` (deletes ALL fingerprints on the sensor; plain `empty` only prints a warning)

## Next Steps After Hardware Buy (Tomorrow Connect Checklist)

0. Power OFF. Verify the transistor leg order, the 1 kohm / 10 kohm markings and
   the buzzer type first ("Verify before you power up"), then wire the LCD
   through the level shifter and the buzzer on the transistor.
1. Flash the ESP32 with this code from GitHub, set serverURL to your Coolify domain
1a. If the LCD is blank: flash `diagnostics/lcd_check/lcd_check.ino`, note the
   I2C address it reports, fix the contrast pot, then re-flash the product sketch.
   Confirm the Serial Monitor says `20x4 LCD ready, backpack found at I2C address 0x..`.
2. Enroll 1-2 test fingerprints via Serial `enroll 1`
3. Test POST to /api/attendance/clock via Serial Monitor or device scan
4. Open /attendance on kitchen tablet, should show live clock + last scan + today's table
5. Open /admin -> Attendance tab, should show Today Live + Paper Sheet View + Staff Fingerprints
6. Test Paper Sheet View Print Hard Copy button -> prints hard copy like paper
7. Check Reports tab -> Daily Sales Last 7 Days sliding window shows 7 days, oldest removed next day
8. Verify offline queue: disconnect WiFi, scan finger, reconnect, check queue syncs
9. Final: Enroll all staff 40-50 x 1-2 fingers each via device + link in admin panel
