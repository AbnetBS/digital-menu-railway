# Fingerprint Fix - FPC1020A (FANA CAFE attendance device)

## What your error meant (simple words)

Your Serial Monitor said:

```
BIOVO enrollment failed at step 1; status = 6
```

**Status 6 means: "I saw a finger, but the picture (image) was too messy/unclear to use."**

Your wiring and baud rate were **fine** - the sensor was talking to the ESP32
correctly. The sensor simply did not like the fingerprint image it captured.
That is why it failed every time, no matter how you placed your finger.

## First: check the physical things (this fixes most cases)

1. **Peel the protective plastic film off the sensor.** New FPC1020A sensors
   ship with a thin protective sticker on the glass. A capacitive sensor CANNOT
   read a finger through it. This is the #1 cause of "image unclear".
2. **Clean the sensor surface** with a soft, slightly damp cloth, then dry it.
3. **Press flat and still.** Put the center of your finger flat on the sensor,
   press firmly, and do not move until the step finishes. Try your index or
   middle finger.
4. **Dry finger?** Breathe on it to add a little moisture. **Sweaty finger?**
   Wipe it first.
5. **Power:** keep the sensor wires short. If captures still fail, add a
   100uF capacitor across the sensor's VCC and GND pins. If your module is a
   5V version, power it from 5V instead of 3.3V (check the module marking -
   never exceed its rated voltage).
6. **Baud rate is 19200** (8N1) - already correct in the code. Do NOT use 57600.

## What I changed in the code (vs the version you sent me)

The GitHub file `fana_attendance_esp32.ino` is now YOUR version + these fixes:

### A. Enrollment now guides you properly (simple, fast, no errors)
- Shows clear steps: **"Place finger - Step 1 of 3"**, then
  **"Good! Lift finger / Then place again"**, then **"Step 2 of 3"**,
  **"Step 3 of 3"**.
- If the image is unclear (status 6), it does NOT fail. It shows
  **"Image unclear! Lift, place flat - Try 2/5"** and tries again -
  up to 5 guided tries per step. You just re-place your finger.
- If you enroll an ID that already has a finger on the module, the old
  finger is deleted automatically and the new one is stored (re-enroll works).
- If the sensor cable is unplugged, it says **"Sensor no reply - check
  wiring+power"** instead of a confusing code.

### B. Scanning a registered finger now says "Verified!"
- OLED shows the staff name + big **"Verified!"** + green LED + short beep,
  then sends to the server (same as before, now more reliable).
- **One touch = one clock event.** After a scan, the device waits until you
  lift your finger before it accepts the next scan. No more double clock-in
  if someone keeps their finger on the sensor.
- **"Not enrolled!"** is shown when a finger is scanned but not registered
  (before, this was confused with "no finger").
- **"Image unclear! Press flat+still / Clean the sensor"** is shown when the
  scan quality is bad.

### C. Library fix (the real "status = 6" bug)
Your sketch scans the sensor about once per second. When enrollment started,
a late reply from the previous scan could still be in the cable. The old
Biovo1020A library read the first 8 bytes blindly, so it could read that
stale reply and report a stale status - making enrollment fail with a
confusing "status = 6" even when everything was fine.

The **patched library** (in `libraries/Biovo1020A/` in this repo) now:
- uses a sliding 8-byte receive window and checks that the reply matches the
  command just sent - stale replies are discarded automatically;
- knows all status codes (5 = not enrolled, 6 = image unclear, 7 = ID exists,
  8 = no finger, 0xFF = no reply, 0xFE = garbled reply);
- has a `drain()` helper - the sketch flushes the cable before enrollment;
- yields while waiting, so a dead sensor cannot freeze the ESP32.

The patched library is tested on PC: `libraries/Biovo1020A/test/` (15 tests,
all passing). Run it yourself:

```
cd hardware/fana_attendance_esp32/libraries/Biovo1020A/test
g++ -std=c++11 -I. -I../src host_test.cpp ../src/Biovo1020A.cpp -o host_test
./host_test
```

### D. Other small fixes
- Sensor is retried 5 times at boot; if it was missing, the device re-checks
  it every 5 seconds and comes back by itself (no reboot needed).
- Idle screen shows "SENSOR OFFLINE!" when the sensor is not answering.
- Web page `/` and `/status` show sensor online/offline + template count.
- New Serial Monitor command: type `test` to ping the sensor.
- `empty` command beeps the success sound (it beeped the error sound before).
- Scan timeout raised 1000 ms -> 1500 ms so slow replies are not missed.

## How to install the fix

1. **Close Arduino IDE.**
2. Delete the old library: `Documents/Arduino/libraries/Biovo1020A`
3. Copy this folder to your libraries:
   `hardware/fana_attendance_esp32/libraries/Biovo1020A`
   -> `Documents/Arduino/libraries/Biovo1020A`
4. Open Arduino IDE, open
   `hardware/fana_attendance_esp32/fana_attendance_esp32.ino` (copy-paste
   from GitHub), select **ESP32 Dev Module**, upload.
5. Peel the film off the sensor, clean it, and enroll again:
   admin website -> Attendance -> Staff Fingerprints -> Add Fingerprint,
   then place the finger flat when the OLED says "Place finger - Step 1 of 3".

## Optional (recommended): touch-sense wire

The FPC1020A module has 2 extra pads: **TOUCH OUT (pin 5)** and
**V_TOUCH (pin 6)**. Wire:

```
FPC1020A TOUCH OUT (pin 5) -> ESP32 GPIO25
FPC1020A V_TOUCH   (pin 6) -> 3.3V
```

Then uncomment this line in the .ino:

```cpp
// #define FINGER_TOUCH_PIN 25
```

With this, the ESP32 only talks to the sensor when a finger is really on it -
fewer useless scans, cleaner images, less wear. (If it never triggers,
change `FINGER_TOUCH_ACTIVE` from `HIGH` to `LOW`.)

## Real-time updates (no more polling)

The device and the screens no longer ask the server "anything new?" every
few seconds. Everything is pushed only when something happens:

- **ESP32**: keeps one stream open to `/api/attendance/events?channel=device`.
  The admin presses "Add Fingerprint" -> the server pushes instantly -> the
  OLED shows "Enroll <name>" right away. No 2-second polling (that was
  43,200 tiny requests/day). If the stream is ever down, a slow 15 s fallback
  poll keeps enrollment working.
- **/attendance tablet page**: gets pushed the moment a scan is clocked
  in/out (was: refresh every 8 s).
- **Admin Attendance tab**: "Today Live" and "Fingerprint Added ✓" are
  instant (were: 8 s and 2 s polls).
- Between events the streams are idle (a heartbeat every 25 s), so server
  traffic is ~zero until something actually happens.

Server load after this change: the device makes ~1 small request only when
something happens (a scan, an enrollment, a mapping change) instead of
~43,000 requests/day.

## Expected Serial Monitor output after the fix

Enrollment:
```
Pending enrollment from the website: Abnet as ID 1
Enrolling ID #1
Enrollment step 1/3, attempt 1
Fingerprint enrolled successfully.
Mapping posted, HTTP 200
```

Scan:
```
Found ID #1 - Abnet
Server response: {"action":"clock_in", ...}
```

If you still see `status = 6` after several guided tries, it is physical:
peel the film / clean the sensor / press flatter / try another finger.
