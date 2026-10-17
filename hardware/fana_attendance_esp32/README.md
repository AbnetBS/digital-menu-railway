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
FPC1020A VCC (Red)    -> ESP32 3.3V, AND ONLY 3.3V. The bare FPC1020A is a
                        2.2-3.6 V part: 5 V on it makes it run HOT, then scan
                        badly, then stop answering. Only a breakout board that
                        carries its own 3.3 V regulator may be fed 5 V - know
                        which one you hold before you power up.
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

### Which supply does THIS module want? (this is the heat question)

The Biovo / FPC1020A library ships **no voltage at all**, and its own troubleshooting
section says only "check VCC and GND" and "check the power supply". That is not laziness:
the sensor die and the carrier board want different things, and the two look similar on a
desk. So decide it from the board in your hand, never from what somebody said about a
module like yours.

| what the module looks like | what to feed it | why |
|---|---|---|
| the sensor die on a flex / 6 pads only, no components | **3.0 to 3.3 V**, never 5 V | VCC goes straight to a 3.3 V chip. 5 V is over-voltage: hot case, then bad scans, then silence |
| a small PCB with a 3-pin part next to VCC (marked `HT7333`, `662K`, `XC6206`, `AMS1117-3.3`, or a `ME6211`) and 4 header pins | **5 V is fine and often required** | that part IS the regulator. Feeding it 3.3 V leaves it no headroom, so the rail collapses every time the reader imaging-draws and the module resets mid-scan |
| a metal-cased module with 5 wires (VCC, GND, TX, RX, TOUCH), often sold as AS05 / FPM10A class | follow the marking; usually **5 V** | these carry their own regulator and a touch wire; note they also usually want a different baud and packet format than this sketch uses, so if it answers at 19200 with this sketch it is the family above, not this one |

Two consequences worth saying out loud, because both were argued at this door:

- **"It is hot" is a verdict, not an opinion.** Whatever the marking says, a module you
  cannot hold your finger on is being supplied wrongly or is already damaged. Do not
  "run it a bit longer to see"; unplug it.
- **3.3 V can be wrong too.** On a regulated module, 3.3 V in gives about 3.2 V out with no
  room for the imaging spike, which looks exactly like "the LCD is fine and the sensor
  ignores my finger" and is intermittent by nature. If the module came from the owner's
  box and it worked on 5 V, that is the most likely reason 3.3 V feels dead.

### Settle it with numbers, in five minutes

`sensor` on the Serial monitor (115200) asks the module 20 times and prints how many times
it answered. Run it once on each supply and write the two lines down:

1. 3.3 V, `sensor` -> note `answered: N/20` and the reply times. Touch the case.
2. 5 V, `sensor` -> same. Touch the case after the test, and again after ten minutes.
3. The winner is the supply that answers 20/20 **and** stays warm at most. Not the fastest,
   and not the one that answers once: a supply that answers when idle and drops out during
   imaging is the failure mode, and the `sensor hard` run (about 8 s of continuous asking)
   is what shows it.
4. Then measure at the module's own pins while a scan runs. Below about 2.9 V on a 3.3 V
   rail is a supply problem, not a code problem: a 100 uF capacitor across VCC and GND right
   at the module is the fix, and taking the LCD backlight off the same 3V3 pin is the other.
5. If 5 V answers reliably and does not heat the case, the owner was right for this module
   and there is nothing to change in the sketch. If 5 V heats the case, keep the module on
   its rated 3.0-3.3 V, put the answer-rate difference down to the supply headroom, and fix
   THAT (a stronger 3.3 V source or the capacitor), rather than pushing 5 V into a 3.3 V
   part because it answers more often.

Whichever wins, say so in the ordering note for the next device, because "3.3 V or 5 V,
whatever" is the sentence that started this. The role-derived Activity rest windows also help
the case temperature on purpose: in the gaps between padded shifts, the reader is not imaging
and the screen is dark.

**Keep the sensor's red wire out of the 5 V rail row that feeds the LCD backpack
and the buzzer.** On a breadboard those two rows sit next to each other, and the
backpack and the buzzer genuinely want 5 V - so "it works, the screen is bright,
the sensor is hot" is most of the time that one wire in the wrong row. The LCD
backpack is a 5 V part, the fingerprint module is not.

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
3. Follow the LCD; the device enrolls the finger, **scans it once more to be sure the
   sensor really has it**, and only then sends the mapping back. The admin page shows
   **Fingerprint Added ✓** - and since October 2026 that ✓ means the finger actually works,
   not just that the commands were answered.

### Path B: manual (enroll on the device, then map it)
1. Open the device Serial Monitor at **115200 baud**.
2. Type `enroll 7` (use the ID you want, 1–1000) and press Enter.
3. Follow the LCD. On success the device prints and displays: **Stored as ID 7 — map it: admin → Attendance → Staff Fingerprints**.
4. In admin, open **Attendance → Staff Fingerprints**. Select the person, enter the same ID, choose the finger name, and press **Add**.
5. The page confirms **Fingerprint Added for …**. The ID must match the one stored on the device.

### Automatic enrollment, step by step
When you press **Add Fingerprint** on the website, the device shows the person's name and walks
them through the fingerprint module's own enrollment protocol: **three steps, one placement each,
and then three confirm scans**. Six placements in total, and the bar counts all six.

- The admin page says **Waiting for the device** and then **Device is ready • ID n** the moment the scanner picked the job up. If it never changes, the scanner is offline.
- If a finger is already resting on the glass the LCD says **LIFT YOUR FINGER** first. Take it off - the module has to see a finger coming DOWN, and a finger that was there before the job started is what used to make the automatic enrollment fail while the Serial command worked.
- **Step 1:** the LCD says **PLACE FINGER**. Put the finger flat and still; the module takes the picture itself, so hold it there until the row moves.
- **Steps 2 and 3:** the LCD says **LIFT YOUR FINGER** and then **PLACE FINGER** again - the SAME finger, freshly placed each time. This is what the sensor's own three-step protocol asks for, and it is what makes a template that can be found again later.
- The second row shows `ID 7 [......] 1/6`: one `#` per accepted step, then one per confirm scan that found the finger. Work up to `6/6` and it is done.
- **Confirm scans (4/6 to 6/6):** after the third step the device asks for the same finger three more times, freshly placed each time, and searches after every placement. The finger is only reported as **ADDED** when the module answers **all three** with this ID. Nothing is sent to the website before that.
- Between the three ADD commands the device sends the sensor NOTHING. Any other command mid-enrollment makes the module refuse the next step with status 1 - this is what broke enrollment in PR #50 and is still true (see FINGERPRINT_FIX.md).
- Each ADD command gives the module up to 30 seconds. If no finger is seen for 30 seconds, the step ends with "no finger was placed".
- If the image is not clear (sensor status 6), the LCD says **HOLD STILL** and the same step is retried about a second later. After three unclear images it says **LIFT, PLACE AGAIN**.
- If a session cannot be finished - or one of the confirm scans does not find the finger - the device frees the slot, asks for a fresh lift and placement and starts the whole sequence again, up to 3 attempts.
- If nobody places a finger, or all 3 attempts fail, the job is marked **failed** and the device says so out loud: the LCD shows **DOES NOT SCAN**, the reason, and **Not saved - retry**. A finger that was not confirmed is NEVER reported as added, so the admin page cannot print a ✓ for it; the page shows the same reason (which step, which sensor status) with a **Try again** button. The device does not loop on its own.

### Why the LCD has to say ADDED only after a scan
The module answers `OK` to an enrollment command when it has *taken and merged the
pictures*. That is not the same as "this finger can be found again". The first releases
of this sketch sent six commands from one unmoving press, every command answered OK, the
admin page printed **Fingerprint Added ✓** - and the next scan said **NOT REGISTERED**,
because the stored model could never be matched. That is why `enrollFingerprint()` now
finishes with three confirm scans, and why a finger the module cannot find again is a
**failed job** whose reason says the finger **does not scan successfully** - on the LCD at
the door and on the admin page, in the same words, so nobody reads a success that was
never measured.

**After flashing this build:** every finger that was added with the old recipe has to be
enrolled again - the sensor never held a usable template for those, only a record the
website believed. For each person: admin -> Attendance -> Staff Fingerprints -> remove their
old entry, then press **ADD FINGERPRINT** once more and have them place the same finger for
the three steps and the three confirm scans. Fingers that already scan correctly are unaffected,
and nothing on the sensor is wiped by this change.

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
5. Offline: Saves to LittleFS queue, syncs when internet back; the LCD says "Wifi Not Connected" on row 2 and keeps working from local cache.
   **A kept scan carries its own time.** Each queued line stores `scannedAt` (the moment the finger was placed, from the same NTP clock as the LCD row) and sends it with the scan, so the website writes it at the time it really happened and not at the time the internet came back. Without that, a person who scanned on time during an outage would be marked late, and an IN and an OUT that were both kept would arrive seconds apart and lose the OUT to the one-hour repeat lock. The website refuses a `scannedAt` in the future or older than 3 days and stamps the arrival time instead, and the log note keeps both times. If the device has not reached NTP since it was powered on it claims no time at all, and the scan is stamped on arrival exactly as before. Kept scans are delivered oldest first, so the IN always arrives before its OUT.
6. Sales: Owner reports now show only last 7 days daily sales sliding window (7th removed when new day starts) — total sales all-time replaced

## New Features Oct 2026

- ESP32 code in GitHub: File lives at hardware/fana_attendance_esp32/fana_attendance_esp32.ino - update in GitHub, copy-paste to Arduino IDE
- Print Attendance Sheet: Admin -> Attendance -> Paper Sheet View -> Print Hard Copy -> hard copy like paper sheet image you sent. Uses @media print landscape.
- Last 7 Days Sales: Reports tab now shows Daily Sales Last 7 Days sliding window. API /api/reports returns last7DaysSales array (date, label, revenue, orders) reversed oldest->newest. When new Ethiopian day starts, oldest drops automatically.
- Ready for hardware connect tomorrow: All APIs tested, typecheck passes, build passes 54 pages, mappings public, clock public, today/logs admin, biometrics admin, shifts admin.
- **Overtime, three kinds (owner, 2026-10-16).** The door tablet's `Overtime` button now asks
  *which kind*: **Holiday OT**, **Free week OT** or **Shift OT**, with an optional hours box.
  Leave the hours empty and the overtime is the time the person actually worked that day, read
  off his own scans. The row is on the admin page (Attendance -> **Overtime**, beside the
  Leaderboard) the moment it is saved, and that day's box on the paper sheet turns violet. There
  is no approval queue: what is written is the record.
- **Shift OT does not need anybody to remember it.** When a person's OUT scan is more than
  **1 h 30 min** past the end of his role's shift, the clock-out itself writes the Shift OT row
  for him, with the hours measured as exactly the time past the end of the shift. The LCD says
  `OUT 19:12 / OT 2h 12m`. A number an admin or the tablet typed for that day is never
  overwritten by the stopwatch.
- **Automatic scanner hours from Role & Time (owner, 2026-10-18).** The Activity tab no longer needs manually typed intervals. It reads every saved shift under Attendance -> **Role & Time** and pads it by one hour: a role shift of `12:00` to `20:00` makes the scanner awake `11:00` to `21:00`. Overlapping or touching padded periods merge; gaps remain deep-sleep periods. For example, shifts `06:00-07:00` and `08:00-09:00` produce one awake period `05:00-10:00`. All times repeat daily on the Addis Ababa clock; role schedules currently have no weekday field.
  Edit a role's entrance or time-out under **Role & Time** and the Activity preview updates automatically. A board that is awake receives the live device refresh immediately. A board already in deep sleep cannot hear a push, so it loads the new schedule at its next timer wake (up to 10 minutes, or sooner if a generated window is due). The server marks the change so the board uses 45-second rest slices after that fetch while the change is fresh. The ESP32 caches the generated windows, so it keeps the last schedule if the website goes offline.
  No saved role shifts means **stay awake all day** (a safe default, not a locked door). If the generated schedule exceeds the ESP32's supported window count, it also stays awake all day rather than miss a worker's shift. The Activity tab shows the generated periods and retains the temporary **Keep scanner awake** override controls. The tablet PIN keypad, paper sheet and admin page work independently of scanner sleep.
  Outside the generated periods, the ESP32 deep-sleeps: LCD dark, fingerprint reader not polled, no fingerprint scan answered. It wakes itself for the next period. The sensor stays powered; the code simply does not ask it to image while nobody is expected.
- **Somebody at the door during a rest period** can be let in with the Activity tab's **Keep scanner awake** button, or the timed keep-awake override. **Use role schedule again** clears the override. A fingerprint enrollment job follows the same timer-wake limit: an already-sleeping board first sees it at its next scheduled wake; after that, the job keeps its rest slices to 45 seconds. The tablet's **name + PIN keypad** at `/attendance` is unaffected and can clock people in while the scanner rests.
- **What "asleep" means, and its one limit.** The board uses real deep sleep (no polling loop, no screen, ~a few microamps) and wakes itself by timer. Long rests are slept in **slices of at most 10 minutes**: every slice ends in a short boot that re-reads role times from the website, re-checks NTP and delivers any kept scan. A fresh role-time change or waiting `Add Fingerprint` job makes the server ask for **45-second slices on subsequent sleeps**; this cannot shorten a sleep timer the board has already started. If you need the board awake right now, press **Keep scanner awake**, or type `rest off` on the Serial monitor; `rest on` returns to the generated role schedule.
  An `Add Fingerprint` job opened while the board is resting is not lost: it is read at the next timer wake (up to 10 minutes if the board had just entered deep sleep), opens the event stream, and starts registration. The board never sleeps while scanning or enrolling, while a result is being read on the LCD (8 s grace), before NTP has answered since power-on, or while the schedule is unknown. The generated schedule is cached in flash (`/rest.json`), so a dead internet at 03:00 changes nothing: the last role-derived hours are still obeyed.

- **The supervisor keypad no longer locks itself after 2 minutes (owner: it "doesnt have
  benefit").** The door tablet's backup PIN keypad is still locked until an attendance
  supervisor opens it with his own name and PIN, and it still needs that unlock on the server -
  but it now stays open until someone presses **Lock now**, with no countdown, no auto-lock and
  no renewal traffic. Fingerprint scans never needed it, and still do not.

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
- POST /api/attendance/overtime {memberId, type: holiday|free_week|shift, hours?, shiftLabel?} -> write one overtime row (the tablet and the admin page both call this; empty `hours` means the day's own worked hours). Without `type` it is the old plain switch that only flags the day.
- GET /api/attendance/overtime?from&to -> the rows of a range with the name, the times and the hours; DELETE /api/attendance/overtime?id=n (admin) takes one row back
- GET /api/attendance/activity -> the hours derived from all saved role shifts (1-hour buffer before/after), the admin override, and what the device would do now (`awakeNow`, `changeInMinutes`, `nextChangeLabel`, plus the flat `device` block the ESP32 caches). Admin session or device token.
- POST /api/attendance/activity {action: "override", mode: "awake"|"minutes"|"schedule", minutes?} -> temporary keep-awake override, admin only. Manual interval writes are rejected; edit role start/end times under Attendance -> Role & Time. Role saves publish a `device` event for an awake board and set a wake hint; a board already in deep sleep loads the change at its next timer wake (up to 10 minutes), then uses 45-second sleep slices while the hint is fresh.

The device itself serves only its status page (`/` and `/status`). It has no `/enroll`, `/logs` or `/mappings` routes.
- GET /api/attendance/members -> admin member list, including each member's fingers[] IDs
- GET/POST /api/attendance/shifts -> Morning/Afternoon shifts
- GET /api/reports -> now includes last7DaysSales sliding window 7 days

## Running on a power bank (the 22.5 W / 10000 mAh one, Oct 2026)

Worked from datasheet currents, not from the label. The cells are 3.7 V, so
`10000 mAh x 3.7 V = 37 Wh`, and the 5 V USB port gives back about 80-85 % of that after the boost
converter: **roughly 30 Wh of real energy, about 6000 mAh at 5 V.** The 22.5 W figure is the port's
ceiling and is not what this system asks for: it wants about 1.2 W, so any 5 V USB port is enough.

| state | what is running | current at 5 V |
|---|---|---|
| awake | WiFi, a SEARCH every 1.5 s (the reader imaging), LCD lit | ~230-260 mA |
| resting, on a normal devkit board | board in deep sleep, LCD dark, sensor powered but never imaged | ~30-45 mA |
| resting, on a bare module with a low-quiescent 3.3 V regulator | as above | ~15-20 mA |

That 30-45 mA floor is not the sleep failing. It is the devkit board's own regulator and USB chip,
which stay awake whatever the ESP32 does. It is also why a deep sleep is worth having without any
MOSFET on the sensor.

Hours on one charge = `6000 mAh / average current`, and the day's average is
`(awake hours x 250 + resting hours x 38) / 24`:

| scanner-awake hours generated from role shifts | average | on a 10000 mAh bank |
|---|---|---|
| 24 h a day (no role shifts or roles covering all day) | ~250 mA | **~24 h** |
| 16 h (e.g. 06:00-22:00) | ~180 mA | ~33 h |
| 12 h | ~145 mA | ~41 h |
| 8 h | ~109 mA | ~55 h |
| 6 h | ~91 mA | ~66 h |
| 4 h | ~73 mA | ~82 h |
| 2 h | ~56 mA | ~108 h |

Two things to read off that table. First, the gaps between the padded role shifts are what buy the time: **one day becomes two to four days**, and a 20000 mAh bank turns that into a week. The hours shown in Activity are generated from Role & Time, not entered there. Second, below about 6 scanner-awake hours the bank is being spent by the sleep floor rather than by the scanner, so a bigger bank helps more than tighter timing does.

For "charger in, power bank in the middle, ESP32 on the bank, so a cut in the mains does not stop the
system", two traps are worth knowing before the first night:

1. **Auto-shutoff is the one that will bite.** Many banks stop supplying when the load falls under
   ~50-80 mA, and a resting board sits right at that line. If the bank cuts out, the board is off and
   cannot ask for power again - the door would look broken at 03:00 with nothing wrong in the sketch.
   Turn on the bank's low-current / always-on mode (on Xiaomi-style banks a double press of the power
   button, some have a 12 h mode), or use a bank or UPS module that has no auto-shutoff. Test it on
   purpose: adjust Role & Time so the padded schedule leaves about an hour of deep sleep, and see
   whether the bank is still answering.
2. **Pass-through (charging while it powers the load) is not on every bank,** and where it exists it
   is slow and warm: the bank refills over hours, not minutes. The load here is small so that is
   fine, but daily cycling of a phone-grade cell is a year or two of life; a purpose-built 18650 UPS
   module (load sharing, no auto-shutoff) does the same job for less money and no guessing. Worth it
   only if the cuts are a daily event.

Nothing is lost when the bank does die: kept scans are in the ESP32's flash (LittleFS is built to
survive a cut in the middle of a write), and names, hours and pending jobs are re-read from the
website at the next boot. The tablet at /attendance works through a rest period and through a power
cut either way, and a scan made while everything is off is simply not recorded - the same as any
scanner without power.

If more hours are wanted later, the next 20 % is the LCD backlight during the open hours (~50-60 mA
of the ~250): blanking it after a minute or two with nobody at the sensor and lighting it again when
a finger is placed. It is not switched on by default, because a dark screen during opening hours
looks like a breakdown to the person standing there, and that trade is the owner's to make.

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
- ESP32 still logs offline, syncs later - and each kept scan is stamped with the moment of the finger, so a night without internet does not move anybody's hours

## Troubleshooting

- **The fingerprint module gets hot.** This is not normal and it is not the
  sketch: nothing in the code can push more current into a module than its own
  supply does. Work through it in this order, with a multimeter, powered off
  between steps:
  1. **Measure VCC to GND at the sensor's own pins**, not at the ESP32 board. It
     must read 3.0-3.3 V. Anything above 3.6 V means the module is being fed 5 V
     (see the wiring note above): that is the heat, and it will also be the
     reason it answers badly before it stops answering altogether.
  2. **Polarity.** Red to VCC, black to GND. A swapped pair makes a module hot
     and stone dead at the same time, which is often exactly what "it got hot and
     now it never scans" means. If the module has already been run like this for
     a while, test it on a known-good 3.3 V supply before blaming the code: a
     cooked module answers 0 out of 20 no matter who asks.
  3. **Which part is hot?** Touch the small flat module and the ESP32 board's
     regulator separately. If the *board's* regulator is the hot one, the sensor
     is drawing its imaging current through the ESP32's 3V3 pin (which is behind
     a small LDO, shared with the LCD backlight); power the sensor from the same
     regulated 3.3 V but not through the board's pin, or take the backlight off
     that rail. A 3.3 V supply sagging below ~2.9 V while a scan runs is the
     classic cause of a module that resets itself mid-command.
  4. **Confirm it with the link test**: `sensor` on the Serial monitor (115200)
     asks the module 20 times and prints how many times it answered; `sensor
     hard` hammers it for about 8 seconds, which is the way to see whether it
     fails only once it is warm. Every round answered = wiring, baud and module
     are fine and the heat is a supply or airflow question. Silence = power or
     wiring. Garbled = levels, baud, or the voltage drooping during imaging.
  Continuous imaging is *not* the heat source at the rates this sketch uses: a
  SEARCH that answers in a fraction of a second once every 1.5 s leaves the
  reader imaging a few percent of the time, which is warm at most. (And since
  the role-derived Activity rest windows shipped, in the gaps between padded
  shifts it is not imaging and the screen is dark.)
- **The LCD works, the WiFi says connected, and a finger does nothing.** There
  are four causes, and the board now says which one it is:
  1. **The module stopped answering while the board was running.** (And the
     mirror of it: a module that answers a slow COUNT but misses scans is BUSY,
     usually a few hundred templates to search through, and the board says
     `Sensor is busy, not dead` while it waits longer for scans, up to 4 s. That
     is not a fault and nothing has to be fixed.) The row that
     used to read `Place finger` now reads `SENSOR OFFLINE!`, and the screen says
     "SENSOR NOT / answering. Check / power 3.3V and / wiring TX/RX". This is a
     link watchdog (6 silent checks in a row): a module that answers "no finger"
     is alive and nothing is reported, so an occasional garbled frame does not
     drop the sensor. The board keeps looking for it every 5 seconds and the
     screen says `Sensor back!` when it returns - no reboot, no reflash. The
     counters are also on the device's own status page (`sensorSilentPasses`,
     `sensorStatus`, `sensorSilentMs`) for whoever is standing there with a phone.
  2. **The board is sitting in its setup hotspot** (`Fana-Attendance-Setup`),
     because the saved router did not answer. While WiFiManager waits there, the
     loop does not run at all, so nothing is scanned - a perfectly wired door
     looks dead. That wait now has a hard end (12 s per attempt, 180 s in the
     hotspot, then a restart that tries again). If the screen shows the hotspot
     or an address like 192.168.4.1, that is this, not the sensor.
  3. **It is resting.** Check the clock against the generated-window preview in
     Attendance -> Activity (the hours come from Role & Time). A rest leaves the
     screen DARK (the backlight is switched off), so "the LCD is lit" normally
     rules this out; if it is lit and `Time` is shown, it is not the schedule.
     `rest show` on the Serial monitor prints what the board believes.
  4. **It is scanning and the finger is simply not enrolled.** That case is
     loud, not silent: the screen says `NOT REGISTERED / Finger not enrolled /
     Ask admin to add it`, so a red LED and a beep with no text at all is not
     this one.

- **"The scanner does not answer, the screen is dark"** - look at the clock first. If it is
  outside the generated hours shown in Attendance -> Activity (from Role & Time), that is the rest
  working: the board wakes itself for the next role window. To open the door now, press **Keep
  scanner awake** in Activity or type `rest off` on the Serial monitor; `rest show` prints what the
  board believes. A board that has never reached NTP since power-on refuses to sleep at all, so a
  dark screen is never a wrong clock.

- If the LCD is blank or shows blocks: run `diagnostics/lcd_check/lcd_check.ino` (see the LCD check above). Blank/blocks with the backlight on is the contrast pot; no I2C address answering is wiring or power, and the sketch never assumes the address.
- **Enrollment says HOLD STILL (sensor status 6, image unclear):** keep the finger flat and still. The device retries the same step on its own, and retries the whole three-step sequence up to 3 times. If it keeps failing, clean the sensor and check the physical checklist above. The admin page prints the exact step and status, so you can see where it stopped.
- **The admin page says Fingerprint Added, but the scanner says NOT REGISTERED:** fixed in October 2026, and it cannot happen silently any more. NOT REGISTERED is the module's own answer (status 5) to a scan of a finger it has no template for - so the enrollment had been *accepted* but never *stored in a usable way*. The device now runs three confirm scans before it reports a finger as added, and the enrollment follows the module's own three steps with a fresh placement per step. A finger it cannot find on every one of those scans is a failed job, on the LCD and on the admin page, with the reason `the finger does not scan successfully: the sensor did not find it on N fresh scan(s) after saving it (status 5: NOT REGISTERED)`. See FINGERPRINT_FIX.md.
- **The admin page stays on "Waiting for the device":** the scanner never picked the job up. Check that it is powered, on the same WiFi, and that `serverURL` in the sketch points at the live domain.
- **Run the enrollment tests without the hardware:** `bash hardware/fana_attendance_esp32/test/run.sh` compiles the real sketch against host stubs and runs the enrollment state machine on a simulated sensor.
- **Enrollment keeps failing on the device:** flash `diagnostics/enroll_diagnostic/enroll_diagnostic.ino` INSTEAD of the product sketch and send `a`, `b`, `c` or `d` in the Serial Monitor (115200 baud). It runs one test enrollment under ID 999, prints every sensor reply with a timestamp, and then **verifies** - a fresh placement that must SEARCH back to ID 999, which is the difference between "the commands were answered" and "this finger works". `a` replays the old PR #50 strategy, `b` the lift-pause strategy, `c` the six-commands-from-one-press strategy that produced the "added but NOT REGISTERED" report, `d` the current three-step strategy. Run `c` and then `d` with the same finger: `c` should end in `VERIFY FAILED`, `d` in `VERIFY OK`. Share the log if `d` does not.
- If fingerprint sensor not answering: check wiring TX->16 RX->17 cross,
  GND, VCC 3.3V (or 5V if the module is a 5V version), **baud 19200** (8N1)
- If fingerprint not found (but scans work): the finger is not enrolled -
  the LCD says **NOT REGISTERED / Finger not enrolled / Ask admin to add it**
- If WiFi fails: reset WiFiManager by uncommenting wm.resetSettings() and re-upload
- If the LCD's bottom row stays on `Time not set yet`: the WiFi is up but NTP never answered.
  The router must let the device out on UDP 123 (`pool.ntp.org`, `time.nist.gov`). Nothing else
  depends on it - scans, enrollment and the queue all work without the clock.
- If POST fails: check serverURL https, check VPSDime firewall allows ESP32 IP, check Coolify domain
- Serial Monitor commands (115200 baud): `enroll <id>` (manual enrollment, 1-1000), `list`, `test`, `sensor` (20 checks: how many answers the module gives, and how fast), `sensor hard` (about 8 seconds of continuous asking, the way to see a failure that only appears when the module is warm), `rest show` / `rest off` / `rest on` / `rest reload`, `empty confirm` (deletes ALL fingerprints on the sensor; plain `empty` only prints a warning)

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
8. Verify offline queue: disconnect WiFi, scan finger, note the LCD clock, reconnect, check the queue syncs AND the sheet shows the time of the scan (not the time it arrived); the log note of that line says "Offline scan: finger at HH:MM, reached the server HH:MM"
9. Final: Enroll all staff 40-50 x 1-2 fingers each via device + link in admin panel
