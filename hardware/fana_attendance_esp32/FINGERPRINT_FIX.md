# FPC1020A fix (Oct 2026): 4 wires, fast clock-in, enrollment that never gets stuck

This replaces the earlier "status 6 = unclear image" fix. That diagnosis was
wrong, and the touch-sense wiring it added made the device slow and stuck.

## What was wrong, and what the sketch does now

| Problem the owner saw | Real cause | Now |
| --- | --- | --- |
| Device slow / stuck with pins 5 and 6 wired; finger did nothing | The sketch waited for the touch pin (GPIO25) before it read the sensor. When the pin never changed, the loop waited forever. | **Touch sense removed.** Only VCC, GND, TX, RX. The sensor itself reports "finger / no finger". |
| Clock-in took about 5 s | Each scan did a full HTTPS handshake to the server, then `delay(3000)` + `delay(2000)` before the next scan. Reconnecting the event stream also blocked scanning. | The scan loop never touches the network. **VERIFIED + name in about 0.3 s** (from the local name cache), the server answer (IN 08:05 / Late) about 1 s later. The HTTPS connection stays open. All network work runs on the second CPU core. |
| A finger verified earlier says "not registered" after the device sat idle | One capture with no retry, and the sensor's capture timeout was never set, so a finger still landing on the glass was searched as a bad image. | The capture window is set at boot (command 0x2E). A first unclear read is retried silently twice before anything is shown. "Not registered" appears only for a finger that really is not stored. |
| "Add Fingerprint": OLED counts 1/5, 2/5... then an error without any finger placed | Status **6** means **"this ID is already used on the sensor"**, not "unclear image". Status **8** means **"no finger yet"**. Both were counted as failed tries. | 6 = delete the leftover and enroll under that ID. 7 = this finger is already stored under another ID (a leftover is removed, a finger that belongs to another person is refused with their name). 8 = keep waiting. The person gets 25 s per capture, and the OLED counts down. |

Status codes (official Biovo/FPC1020A protocol): 0 OK, 1 fail, 4 full,
5 no such user, **6 ID occupied**, **7 finger already exists**, **8 timeout (no finger)**.

## Wiring: 4 wires only

```text
FPC1020A VCC -> ESP32 3.3V  (5V only if your module is marked 5V)
FPC1020A GND -> ESP32 GND
FPC1020A TX  -> ESP32 GPIO16 (RX2)
FPC1020A RX  -> ESP32 GPIO17 (TX2)
Pins 5 (TOUCH OUT) and 6 (V_TOUCH): leave them unconnected
```

UART is 19200 baud, 8N1. If the OLED says SENSOR ERROR, TX and RX are usually swapped.

## Add a fingerprint: two ways

### A. Automatic (admin button)

1. Admin -> Attendance -> Staff Members -> **Add Fingerprint**.
2. The device shows the name and the ID at once (real-time push).
3. The OLED guides the person: **PLACE** (put finger flat), **HOLD** (keep still),
   **LIFT** (lift the finger), then the same finger again. A bar shows **Step x of 6**,
   and a countdown shows the seconds left for each capture.
4. The device stores the finger, sends the mapping (with the job number, so it
   can never be saved under the wrong person), and shows **FINGERPRINT ADDED**.
   The admin page shows **Fingerprint Added ✓**.
5. If it cannot finish (nobody came for 25 s, the finger already belongs to
   somebody else, sensor trouble), the OLED says why and the admin page shows
   **Fingerprint not added** with the same reason and a **Try again** button.
   The device never retries the job in a loop.

The finger still lying on the sensor after enrolling is **not** clocked in. The device waits for it to be lifted first.

### B. Manual (backup)

1. Serial Monitor at 115200 baud: type `enroll 7` (any free ID 1-1000; `free` prints one).
2. Follow the OLED, same steps as above.
3. Serial and OLED say: **Stored as ID 7. Map it: admin → Attendance → Staff Fingerprints**.
4. In admin -> Staff Fingerprints, select the person, type the same ID, press **Add**.

`enroll` refuses an ID that is already mapped to a person, so an employee's
finger can never be overwritten by mistake. `delete 7` removes ID 7 from the sensor.

## Offline

When WiFi or the server is down, scans still show VERIFIED at once. They are saved
with the **real scan time** and sent when the connection is back, so an 08:00 IN
synced at 10:00 is still recorded at 08:00 (the server accepts scan times up to
72 hours old). A 404 (finger not mapped on the website) is shown once and never queued.

## Security

If the owner sets `ATTENDANCE_DEVICE_TOKEN` on the server, put the same value in
`deviceToken` at the top of the sketch. Then only the scanner (or an admin) can clock
in by fingerprint ID, read pending jobs, report mappings or report a failed job.
Without a token everything works as before.

## Physical checklist

- Peel the protective film off the sensor and keep it clean.
- Press the finger flat. For enrollment, use the middle of the finger and press the same finger each time.
- Very dry finger: breathe on it lightly. Wet finger: wipe it.
- Short wires, common GND. If the sensor resets when the WiFi starts, put a 100 µF capacitor across the module's VCC and GND.

## Tests (no hardware needed)

```sh
cd hardware/fana_attendance_esp32/test
./run_tests.sh
```

This runs the library's host tests, then builds the real sketch on the PC
against a simulated FPC1020A, OLED, WiFi and website (with ArduinoJson v6 and v7).
It plays through 16 situations: fast verify, a finger left on the sensor, a finger
still landing, an unknown finger, automatic enrollment (waiting for the person,
leftover IDs, duplicates, somebody else's finger, nobody coming), offline and
sync, a module without the 0x2E command, manual enrollment and 150 names.
It needs `g++` and `git` (ArduinoJson is cloned once into a temp folder).

The Biovo1020A library itself is unchanged.
