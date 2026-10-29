# Fana attendance device — ESP32 + R307

The production sketch is `fana_attendance_esp32.ino`. It now targets the **R307 optical fingerprint reader** and keeps the existing Fana website workflow: remote enrollment jobs, fingerprint-to-member mapping, IN/OUT clocking, offline queue, 20×4 LCD, LEDs, buzzer, Wi-Fi setup and optional scheduled deep sleep. The scanner now stays awake by default.

## Required libraries

Install with Arduino IDE Library Manager:

- **Adafruit Fingerprint Sensor Library** by Adafruit
- **hd44780** by Bill Perry
- **WiFiManager** by tzapu
- **ArduinoJson 6**

The old `Biovo1020A` library and FPC diagnostics remain in the repository only as historical/legacy material. The production R307 sketch does not use them.

## R307 wiring

**Verify the connector pinout supplied with your exact unit. Wire colours are not standardized.**

| R307 | ESP32 WROOM |
|---|---|
| VCC | Regulated supply specified by the seller (normally 5 V for R307) |
| GND | GND |
| TX | GPIO16 / RX2 |
| RX | GPIO17 / TX2 |

The ESP32 UART is 3.3 V logic. All grounds must be common. Do not connect an unknown wire by colour alone.

The sketch opens UART2 at **57600 baud, 8N1**, matching the tested R307 shown by the device information output.

## Other hardware

### 20×4 LCD with I²C backpack, through a bidirectional level shifter

| Connection | Destination |
|---|---|
| ESP32 3V3 | level-shifter LV |
| regulated 5 V | level-shifter HV and LCD VCC |
| GPIO21 | A1 → B1 → LCD SDA |
| GPIO22 | A2 → B2 → LCD SCL |
| all grounds | common GND |

### Indicators

- Green LED: GPIO18 through 220 Ω
- Red LED: GPIO19 through 220 Ω
- Active buzzer driver: GPIO23 through a transistor as documented in the sketch header

## R307 enrollment flow

1. Admin presses **Add Fingerprint** on the website.
2. The device receives the pending job.
3. The employee places the finger for capture 1.
4. The employee lifts it.
5. The same finger is placed again with a small position/angle change for capture 2.
6. The R307 combines the two captures and stores one template.
7. Lift again, then place the finger a **third time**. One fresh confirmation scan must find the same template ID.
8. Only then is the ID mapped to the employee on the website.

Use the same finger, place its pad flat and keep it still until the reader beeps. The firmware retries transient unclear images without lowering the sensor's matching security. If it reports a different ID, check whether that finger is already enrolled. Enrollment needs a live website connection, including the Serial `enroll <id>` command: the device checks current mappings before preparing a slot, so an offline/stale list cannot authorize deletion. Keep one scanner active and do not manually change fingerprint mappings while an enrollment is underway; the website and reader cannot atomically lock a physical slot across the network.

## Normal scan and offline attendance time

- One placement produces one attendance event; a held finger does not clock repeatedly.
- **Every recognized scan is saved in LittleFS first**, whether Wi-Fi is strong, weak or disconnected. The LCD and beep confirm **saved on this device**, not yet accepted by the website. It no longer shows an immediate server IN/OUT result.
- Networking, reconnects and queue delivery run in a separate task. A slow HTTP call or a setup portal does not intentionally wait in the scanner loop. A deliberate remote enrollment temporarily owns the reader; enrollment needs connectivity.
- **A kept scan carries its own time.** The device timestamps the successful image-capture reply, before matching and network delays. Kept scans are delivered oldest first once the website is reachable; IN/OUT, date and lateness use the recorded scan time, not reconnection time. The server stores a receipt with each unique scan and commits attendance and automatic overtime together, making retries after a lost response safe.
- Sync the clock before the outage: after power-on, allow Wi-Fi and NTP (UDP 123) to work, and check that the LCD shows the time. During an outage the ESP32 estimates time using its monotonic clock; there can be a few seconds of error and oscillator drift over long outages.
- If a scan occurs before the first NTP sync, it is saved with boot-relative uptime. If NTP succeeds later **without an intervening power loss**, a durable boot-time anchor reconstructs an estimate for that scan, including after a later reboot. If power is lost before that first sync, the absolute time is unknowable without a battery-backed RTC: the record is retained for **manual review**, never stamped as arrival. Legacy untimed records get the same treatment.
- If a cached fingerprint-to-employee mapping changed before a scan reaches the server, or a newer attendance record was already written first, the conflicting record is retained for manual review rather than silently credited to the wrong person. Keep fingerprint mappings stable while scans are queued. Legacy scans or a device with no cached member mapping cannot prove the original employee; review such changes carefully.
- The queue has finite flash space. If flash is full, damaged or unavailable, or a write is incomplete, the LCD says **SCAN NOT SAVED** and an error sounds. Do not assume attendance was recorded; use the supervised PIN/paper backup and inspect the storage. Do not format or erase flash without recovering the queue and review records.

## First upload and staged deployment

1. Back up the database and deploy the updated website **before** this firmware. The new server receipts are required for safe retries; old server versions do not provide this guarantee. The first schema upgrade can take database locks, so stage it outside a busy shift.
2. Select **ESP32 Dev Module** with a partition that includes LittleFS. Tested compile: ESP32 Arduino core 2.0.17, ArduinoJson 6.21.5, WiFiManager 2.0.17, hd44780 1.3.2 and Adafruit Fingerprint 2.1.3. Confirm the R307 pinout and wiring.
3. Keep `fana_attendance_esp32.ino`, `R307Compat.h` and `OfflineQueue.h` in the same sketch folder. Compile and upload using settings that **preserve LittleFS and existing queues**; an erase-all upload destroys pending attendance. Deploying the website alone does not flash the reader.
4. Open Serial Monitor at **115200 baud**. On first boot, join `Fana-Attendance-Setup` with password `fana12345` and configure restaurant Wi-Fi. The setup portal closes after its timeout; the reader remains available while it is open.
5. While online, confirm the sensor is found, the correct employee mappings load, and the LCD shows the current time. Enroll and confirm a test finger, then test an existing employee's IN/OUT scans and held-finger latch. Do not erase existing templates as a troubleshooting shortcut.
6. Test at the actual door: disconnect the access point, scan two known employees, reconnect, and verify their original scan times in attendance. Also interrupt internet while Wi-Fi stays associated. Check serial output, storage errors, manual-review warnings and the reader light. Physical tests are essential; the host simulation and compiler do not test optics, power or the installed network.

### Long outages, device authorization and TLS

The server accepts recorded scans older than three days only if `ATTENDANCE_DEVICE_TOKEN` is configured and the device sends the matching token; otherwise it responds 403 and leaves them queued, never writes the arrival time. Set the same private token in the server environment and the sketch's `deviceToken`, coordinating rollout with all existing scanners. Never commit or share the secret. With no token the device endpoints remain publicly callable and only the three-day window is allowed.

On ESP32 Arduino core 2.x, the legacy URL-only `HTTPClient` call **does not verify the HTTPS certificate**. Before using a token on an untrusted network, set `serverRootCA` in the sketch to the site's correct PEM root CA and use an `https://` `serverURL`; test certificate validation and plan for certificate/CA rotation. Otherwise an attacker on the network could impersonate the server or obtain the token. The firmware warns on Serial if a token is configured without verified HTTPS. Do not enable a server token until the installed firmware can authenticate with it.

### Reader's blue light

Scanning and the LED request do not depend on Wi-Fi. The firmware requests the optional R307 LED-ON command at detection and reasserts it when supported. R307 variants differ: some do not support continuous host-controlled illumination or may turn it off after capture. No physical reader was available for verification, so continuous blue light is **not guaranteed**; check this exact unit's behavior and specifications. Unsupported LED control does not disable scanning.

## Serial commands

At 115200 baud:

- `enroll <id>` — enroll and confirm one R307 template manually; the website must be reachable to check mappings, and an admin must then map that ID to the employee
- `list` — report the number of stored templates
- `test` — one sensor communication test
- `sensor` — repeated link test
- `sensor hard` — longer repeated link test
- `empty` — explain the destructive command
- `empty confirm` — erase all templates
- `rest show` — show scanner awake/rest schedule
- `rest off` — keep the scanner awake
- `rest on` — explicitly allow the configured schedule to put the scanner to sleep (not compatible with always-available scanning)
- `rest reload` — reload the schedule
- `wifi` — the link as the board sees it: status, IP, signal in dBm, channel,
  access point, how many reconnects and radio resets it has done by itself
- `wifi scan` — every 2.4 GHz network the board can hear, with its strength
  (the fastest way to see whether the cafe's 2.4 GHz name is strong at the door)
- `wifi join` — forget the current socket and reconnect in the background
- `queue review` — print records requiring manual reconciliation. The `reason` and original record are shown; keep the output private.
- `queue review clear CONFIRM` — erase the review file **only after** copying and manually reconciling every record. A power cut between copy and acknowledgement can leave duplicate review lines; compare event IDs.

## WiFi that stays connected

The board heals its own link. This is what changed, and why.

- **Modem sleep is off.** `WiFi.setSleep(false)`. A sleeping radio answers late
  and can miss the moment a fingerprint job is waiting. The board is on mains,
  so the extra power costs nothing.
- **Full transmit power.** `WiFi.setTxPower(WIFI_POWER_19_5dBm)`.
- **It no longer restarts when the router is out.** It keeps scanning, keeps the
  scans in LittleFS, and reconnects in the background.
- **Reconnect escalation.** Ask the driver (`WiFi.reconnect()`) every 8 s; after
  45 s reset the radio (`WiFi.disconnect(true, false)` then `WiFi.begin()`,
  credentials kept); allow at least 30 s between radio resets for slow routers.
  Do not restart the whole board merely because Wi-Fi has been down for ten minutes.
- **The LCD tells the truth while it does this, and shows the strength.** Row 2
  carries the connection word, the number and four bars in its twenty
  characters:

  - `Connected -58dB ████` strong Wi-Fi link (not proof of internet)
  - `Connected -72dB ██__` usable, but there is room to improve
  - `Connected -88dB ____` the "only works near the router" case
  - `Wifi down 34s` disconnected and retrying (live counter)
  - `Wifi Not Connected` never joined since it was powered on

  The bars are filled blocks: four at −55 dBm or better, three below −55, two
  below −65, one below −75, none below −85. If the `down` counter is moving,
  the board is working on it; nobody needs to unplug it.
- **A stronger access point is preferred.** When the link is up but below
  −78 dBm, every 5 minutes the board scans and rejoins if another access point
  with the same name is at least 8 dBm stronger (a mesh, or a second router).
- **A new fingerprint job is polled every 15 s** even when the real-time stream
  looks connected, because a weak link can leave that socket open and silent.
  This can help when the stream stays open but stops delivering events; it does not prove Wi-Fi caused a particular enrollment failure.
- **Requests wait 8 s instead of 4 s**, and the "device is ready" message is
  sent twice if the first one is lost.

### Making the signal stronger at the door (hardware)

A weak radio link is one possible cause, not proof that the website or reader is healthy. Check the signal and Serial logs at the installed location. Possible improvements:

1. **2.4 GHz only.** The ESP32 has no 5 GHz radio. If the router publishes one
   name for both bands, the phone picks 5 GHz and works; the board is left with
   a distant 2.4 GHz signal. Give the 2.4 GHz band its own name (for example
   `Fana-2.4G`), connect the board to that, and keep channel width at 20 MHz on
   channel 1, 6 or 11.
2. **A 2.4 GHz access point near the door.** A cheap access point or repeater
   wired to the router, 5–10 m from the scanner with one wall at most, is worth
   more than any firmware setting. Put it high and away from metal.
3. **Antenna.** Keep the board out of a metal box and off the wall; the PCB
   antenna needs air. If the board has a u.FL/IPEX connector, use an external
   2–3 dBi antenna instead of the PCB one.
4. **Power.** A weak 5 V supply browns out the radio exactly when it transmits:
   the device then disconnects during requests, which looks like weak WiFi. Use
   a 5 V 2 A supply and a short, thick cable.
5. **WPA2-PSK.** The ESP32 does not join a WPA3-only network, and mixed WPA2/WPA3
   can make it fail after a router firmware update.
6. **A DHCP reservation** for the board, so its address never changes.

Run `wifi scan` at the door with the board powered from the same spot it will
live in. −50 dBm is excellent, −60 good, −70 usable, −80 marginal, below −85 the
enrollment and the real-time stream will be unreliable.

## Capacity

The R307 previously reported a capacity of **1000 slots**. The sketch checks the actual reader's reported capacity and searches that whole range. It treats capacity as the number of zero-based slots, so a 1000-slot reader accepts website IDs **1–999** (slot 0 is reserved); the website currently permits ID 1000, which this firmware rejects. Verify the range against the physical unit before relying on the last slot.

Existing FPC1020A templates cannot be transferred. Every employee must be enrolled again on the R307. Existing website employees, attendance history, payroll records and role settings remain unchanged.

## Activity schedule and battery operation

The scanner stays awake by default, independently of the website's Activity schedule. `rest on` is an explicit technician opt-in to the earlier deep-sleep schedule until the next boot; during sleep it cannot read fingerprints. Leave rest off for uninterrupted attendance. If deliberately enabled, Role & Time edits reach a sleeping board at its next timer wake (up to 10 minutes); it then uses 45-second rest slices while a fingerprint job waits. Only the scanner and LCD sleep; website/PIN paths remain available.

If the device loses power during an outage, even an always-awake setting cannot keep it running: use suitable backup power, and add a battery-backed RTC if exact times are required through a power cut before NTP has ever synchronized. For battery planning, use watt-hours: a nominal 10,000 mAh, 3.7 V bank is about 37 Wh, not 10,000 mAh at 5 V; a 6000 mAh label also needs its cell voltage to calculate Wh. Avoid banks with Auto-shutoff at low load.

## Recovery and deployment checks

- A connected Wi-Fi indicator and dBm describe only the radio, not the internet or website. At −90 dBm, connectivity may be highly unreliable; the local queue is the fallback, not a substitute for a nearby 2.4 GHz access point.
- `Offline queue paused, HTTP ...` means delivery is retried while the record remains on the device. Authentication errors, unrecognized mappings, bad time, storage damage or a missing server require attention. A 409 conflict or an unrecoverable pre-NTP record is copied to the review file and flagged on the LCD as `Scans need review!`; inspect it with `queue review`.
- Preserve the existing LittleFS partition on upgrade. The firmware never automatically formats on mount failure. A new/unformatted device may need one **deliberate** filesystem initialization; back up existing data before any format.
- The queue appends records and retains acknowledged bytes until it drains fully. A persistent backlog, repeated review records or anchor files can fill flash. Monitor capacity and resolve failures promptly. Anchors are small and retained for any still-queued records.
- Queue and review files contain staff identifiers and scan data. Protect physical/Serial access and backups. The optional local status page reports whether review is required but does not expose the review records.
- Verify the optional LED command and uninterrupted operation on the actual R307, ESP32, power supply and network before relying on this change in production. The compiled firmware has not been flashed or tested on the user's hardware.
