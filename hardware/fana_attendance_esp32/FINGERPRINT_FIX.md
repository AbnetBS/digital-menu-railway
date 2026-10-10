# FPC1020A enrollment and scanning - FANA CAFE attendance

## Why enrollment failed

The Serial Monitor showed enrollment **status 6 (IMAGEMESS)**, while a normal scan returned **status 5 (NOUSER)**. Those results tell us different things:

- **Status 5 during a scan:** the module took a usable image of the finger and searched its database, but that fingerprint ID is not stored yet.
- **Status 6 during enrollment:** the module could not use the image it took. In the failed workflow, the capture command was sent while the finger was still moving into place.

So communication with the sensor was working; it was capturing too early. The fix changes the firmware workflow, not the vendored Biovo1020A library. Keep that library unchanged.

## What changed in the sketch

- **Four sensor wires only:** VCC, GND, RX, TX. The touch-sense wires (pin 5 to GPIO25, pin 6 to 3.3V) are no longer used, and the code no longer waits for them. Leave pins 5 and 6 unconnected.
- **Finger detection comes from the sensor itself.** The sketch asks the sensor to search. A status of 0x08 (timeout), 0x0F (finger lifted), or 0xFF (no reply) means "no finger". A match, status 0x05 (not enrolled), or status 0x06 (unclear image) means "finger on".
- **One scan per placement.** A finger that stays on the sensor is scanned once. The device waits for the finger to be lifted before it accepts the next placement, so a finger left on the sensor for minutes is not posted again and again.
- **Fast result.** VERIFIED appears as soon as the sensor matches the finger. The website answer is awaited for at most 4 seconds, and there are no fixed delays in the scan path.
- **Automatic enrollment is guided on the OLED** and never counts scans that were not made.

## Correct six-capture enrollment

The sketch follows the reference flow for this FPC1020A module:

| OLED step | Module command | Captures |
| --- | --- | ---: |
| Step 1 of 3 | ADD_1 (`step 1`) | 1 |
| Step 2 of 3 | ADD_2 (`step 2`) | 4 |
| Step 3 of 3 | ADD_3 (`step 3`) | 1 |

That is **six accepted captures total**. The OLED alternates **PLACE FINGER** and **LIFT FINGER**, and shows the progress, for example **Scan 2/6**.

- Nothing is counted while no finger is on the sensor. Each capture first waits for a finger (up to 30 seconds), then settles briefly, then captures.
- If the module returns status 6 (image unclear), the OLED shows **HOLD STILL** and retries the **same capture**. After three unclear images in a row, it asks for **LIFT, PLACE AGAIN**.
- An ID that the website already maps to a person is never overwritten, by a website job or by `enroll <id>`. If the sensor holds a template under an ID that no one is mapped to (a leftover), the sketch deletes that leftover and enrolls again.
- A failed capture or a missing finger ends the enrollment with a clear reason on the OLED. A website job is then reported as failed (see below), and the sketch does not retry it by itself.

## Add a fingerprint: two ways

### Path A: automatic (recommended)

1. In the admin site open **Attendance → Staff Members**.
2. Edit the person and press **ADD FINGERPRINT**.
3. The server picks an available ID from 1–1000 and sends the job to the connected device in real time.
4. Follow the OLED. Place the finger flat and still when it says PLACE FINGER, and lift it when it says LIFT FINGER.
5. When all six scans are accepted, the device sends the mapping back and the admin page shows **Fingerprint Added ✓**.
6. If no finger is placed within 30 seconds, or the enrollment cannot be finished, the job is marked failed. The OLED shows **Not added** with the reason. The admin page shows **Fingerprint was not added** with a **Try again** button.

### Path B: manual (enroll on the device, then map it)

1. Open the device Serial Monitor at **115200 baud**.
2. Type `enroll 7` (replace 7 with the sensor ID you intend to use, from 1–1000) and press Enter.
3. Follow the OLED and keep the finger flat and still. When it succeeds, Serial and OLED say **Stored as ID 7 — map it: admin → Attendance → Staff Fingerprints**.
4. In the admin site open **Attendance → Staff Fingerprints**. Select the person, enter **the same sensor ID**, choose the finger name, and press **Add**.
5. The page confirms **Fingerprint Added for …**. That mapping lets scans identify the person; enrolling on the sensor alone does not assign a staff name.

Use the same ID in both places. Other serial commands: `list`, `test`, and `empty confirm` (deletes every fingerprint on the sensor; plain `empty` only prints a warning).

## Physical checklist

Before enrolling, check each item:

- [ ] Peel the protective film off the fingerprint sensor; the capacitive sensor cannot read through it.
- [ ] Clean the sensor surface and keep it free of oil, dust, and residue.
- [ ] Place the finger flat and press it **STILL**. Do not move until the scan is accepted; lifting early is the most common cause of a failed enrollment.
- [ ] If the finger is dry, lightly moisten it (for example, breathe on it). Wipe off sweat or excess moisture.
- [ ] Wire the sensor with the four wires only: VCC, GND, TX to GPIO16, RX to GPIO17. Pins 5 and 6 stay unconnected.
- [ ] Keep the UART and power wires short and make sure GND is common.
- [ ] If captures still fail, add a **100 µF capacitor across module VCC and GND**, close to the module.
- [ ] Power the sensor from 5V **only if the module is marked/rated for 5V**. Otherwise use its rated supply; never guess or exceed its rating.
- [ ] Keep the sensor UART at **19200 baud, 8N1**.

## The library and the real-time flow

The patched `hardware/fana_attendance_esp32/libraries/Biovo1020A` remains unchanged. Its stale-reply handling and host tests protect UART communication, but they cannot make a moving finger image clear. The sketch uses the library's existing `enroll(id, step, timeout)`, `search(...)` and `getLastStatus()` calls.

The automatic path listens on the server's real-time event stream. If that stream is unavailable, the sketch checks for pending jobs every 15 seconds. Clock-in and clock-out, offline queueing, and the mapping endpoints work as before. A job that the device cannot finish is reported to `POST /api/attendance/mappings` with `{"action": "job_failed", "jobId": ..., "reason": ...}`.

The library's host tests can be run without hardware:

```sh
cd hardware/fana_attendance_esp32/libraries/Biovo1020A/test
g++ -std=c++11 -I. -I../src host_test.cpp ../src/Biovo1020A.cpp -o host_test
./host_test
```
