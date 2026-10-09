# FPC1020A enrollment fix — FANA CAFE attendance

## Why enrollment failed

The Serial Monitor showed enrollment **status 6 (IMAGEMESS)**, while a normal scan returned **status 5 (NOUSER)**. Those results tell us different things:

- **Status 5 during a scan:** the module took a usable image of the still finger and searched its database, but that fingerprint ID is not stored yet.
- **Status 6 during enrollment:** the module could not use the image it took. In the failed workflow, the capture command was sent just after the OLED asked for a finger, while the finger was still moving into place.

So communication with the sensor was working; it was capturing too early. The fix changes the enrollment workflow, not the vendored Biovo1020A library. Keep that library unchanged.

## Correct six-capture enrollment

The sketch now follows the reference flow for this FPC1020A module:

| OLED step | Module command | Captures |
| --- | --- | ---: |
| Step 1 of 3 | ADD_1 (`step 1`) | 1 |
| Step 2 of 3 | ADD_2 (`step 2`) | 4 |
| Step 3 of 3 | ADD_3 (`step 3`) | 1 |

That is **six accepted captures total**. Use the same finger and keep it pressed flat and still through successful captures. The OLED shows the step and capture number, for example **Step 2 of 3 — Capture 2/4**.

Before every capture, the sketch waits for the touch signal and then waits about **600 ms** for the finger to settle. If the module still returns status 6, the sketch shows **“Hold still — don't move”** and retries the **same capture** after about one second. It does not ask for a lift after the first unclear image. After three consecutive unclear images for that capture, it asks you to lift and place the finger flat again. Each individual capture is limited to five attempts.

If the ID already has a template on the sensor, the sketch keeps the existing behavior: it deletes that old template and retries the first capture under the same ID. A missing/offline sensor still stops enrollment and reports a wiring/power error.

## Add a fingerprint — two ways

### Path A: automatic (recommended)

1. In the admin site open **Attendance → Staff Members**.
2. Edit the person and press **ADD FINGERPRINT**.
3. The server picks an available ID from 1–1000 and sends the job to the connected device in real time.
4. Follow the OLED. Press the finger flat and still until each capture finishes; lift only if the screen asks you to.
5. The device sends the mapping back. The admin page shows **Fingerprint Added ✓**.

### Path B: manual (enroll on the device, then map it)

1. Open the device Serial Monitor at **115200 baud**.
2. Type `enroll 7` (replace 7 with the sensor ID you intend to use, from 1–1000) and press Enter.
3. Follow the OLED and keep the finger flat and still. When it succeeds, Serial and OLED say **Stored as ID 7 — map it: admin → Attendance → Staff Fingerprints**.
4. In the admin site open **Attendance → Staff Fingerprints**. Select the person, enter **the same sensor ID**, choose the finger name, and press **Add**.
5. The page confirms **Fingerprint Added for …**. That mapping lets scans identify the person; enrolling on the sensor alone does not assign a staff name.

Use the same ID in both places. If the selected ID is already on the device, the firmware's existing replace behavior deletes that template and enrolls the new finger under it.

## Two touch-sense wires (recommended and enabled in this sketch)

Connect these two module pins so the ESP32 knows when the finger has arrived:

```text
FPC1020A pin 5  TOUCH OUT  -> ESP32 GPIO25
FPC1020A pin 6  V_TOUCH    -> 3.3V
```

The sketch currently has `FINGER_TOUCH_PIN` enabled for GPIO25 and assumes `FINGER_TOUCH_ACTIVE HIGH`. If the signal never becomes active when a finger touches the sensor, change `FINGER_TOUCH_ACTIVE` from `HIGH` to `LOW`, upload again, and retry. Make sure pin 6 goes to **3.3V**, not GPIO25.

## Physical checklist

Before enrolling, check each item:

- [ ] Peel the protective film off the fingerprint sensor; the capacitive sensor cannot read through it.
- [ ] Clean the sensor surface and keep it free of oil, dust, and residue.
- [ ] Place the finger flat and press it **STILL**. Do not move until the capture finishes; this was the cause of the status-6 failures.
- [ ] If the finger is dry, lightly moisten it (for example, breathe on it). Wipe off sweat or excess moisture.
- [ ] Connect TOUCH OUT pin 5 → GPIO25 and V_TOUCH pin 6 → 3.3V; flip `FINGER_TOUCH_ACTIVE` to `LOW` only if this module's output is active-low.
- [ ] Keep the UART and power wires short and make sure GND is common.
- [ ] If captures still fail, add a **100 µF capacitor across module VCC and GND**, close to the module.
- [ ] Power the sensor from 5V **only if the module is marked/rated for 5V**. Otherwise use its rated supply; never guess or exceed its rating.
- [ ] Keep the sensor UART at **19200 baud, 8N1**.

## The library and the real-time flow

The patched `hardware/fana_attendance_esp32/libraries/Biovo1020A` remains unchanged. Its stale-reply handling and host tests protect UART communication, but they cannot make a moving finger image clear. The enrollment fix uses the library's existing compatible `enroll(id, step, timeout)` calls.

The automatic path still uses the existing server-pushed event stream. If that stream is unavailable, the existing slow fallback remains; clock-in/out, offline queueing, mappings, and their endpoints are not changed by this fix.

The library's host tests can be run without hardware:

```sh
cd hardware/fana_attendance_esp32/libraries/Biovo1020A/test
g++ -std=c++11 -I. -I../src host_test.cpp ../src/Biovo1020A.cpp -o host_test
./host_test
```
