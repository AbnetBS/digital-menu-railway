# Fana attendance device — ESP32 + R307

The production sketch is `fana_attendance_esp32.ino`. It now targets the **R307 optical fingerprint reader** and keeps the existing Fana website workflow: remote enrollment jobs, fingerprint-to-member mapping, IN/OUT clocking, offline queue, 20×4 LCD, LEDs, buzzer, Wi-Fi setup and scheduled deep sleep.

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
7. Fresh confirmation placements must find the same template ID.
8. Only then is the ID mapped to the employee on the website.

The R307’s internal matcher supports rotated placements. Employees should still place the finger pad flat enough to capture useful ridge detail.

## Normal scan

- One placement produces one attendance event.
- The sensor returns a template ID.
- The ESP32 posts that ID to `/api/attendance/clock`.
- The LCD shows IN, OUT, late, already registered, or the server’s refusal.
- A finger left on the glass does not repeatedly clock.
- If internet is unavailable, the event is queued in LittleFS and synchronized later.

## First upload

1. Select **ESP32 Dev Module**.
2. Install the required libraries.
3. Confirm the R307 pinout and wiring.
4. Upload `fana_attendance_esp32.ino`.
5. Open Serial Monitor at **115200 baud**.
6. On first boot, join `Fana-Attendance-Setup` with password `fana12345`, then configure restaurant Wi-Fi.
7. Confirm Serial shows `Found R307 fingerprint sensor` and the template count.

## Offline attendance time

**A kept scan carries its own time.** When the network is unavailable, the ESP32 stores the scan in LittleFS with the moment the finger was placed. Kept scans are delivered oldest first after connectivity returns. If the device has not reached NTP since it was powered on it claims no time at all; the server then uses arrival time rather than accepting an invented timestamp.

## Serial commands

At 115200 baud:

- `enroll <id>` — enroll and confirm one R307 template manually
- `list` — report the number of stored templates
- `test` — one sensor communication test
- `sensor` — repeated link test
- `sensor hard` — longer repeated link test
- `empty` — explain the destructive command
- `empty confirm` — erase all templates
- `rest show` — show scanner awake/rest schedule
- `rest off` — keep the scanner awake
- `rest on` — allow the configured schedule to control sleep
- `rest reload` — reload the schedule
- `wifi` — the link as the board sees it: status, IP, signal in dBm, channel,
  access point, how many reconnects and radio resets it has done by itself
- `wifi scan` — every 2.4 GHz network the board can hear, with its strength
  (the fastest way to see whether the cafe's 2.4 GHz name is strong at the door)
- `wifi join` — forget the current socket and reconnect now

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
  credentials kept); allow at least 30 s between radio resets for slow routers;
  after 10 minutes restart the board as the last resort.
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
  This is what made "Add Fingerprint" work only near the router.
- **Requests wait 8 s instead of 4 s**, and the "device is ready" message is
  sent twice if the first one is lost.

### Making the signal stronger at the door (hardware)

The board's radio is the weak part, not the website. In order of effect:

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

The tested R307 reports a capacity of **1000 templates**. The sketch validates IDs against the capacity reported by the actual module rather than trusting only a product listing.

Existing FPC1020A templates cannot be transferred. Every employee must be enrolled again on the R307. Existing website employees, attendance history, payroll records and role settings remain unchanged.

## Activity schedule and battery operation

The admin **Activity** schedule comes automatically from Role & Time shifts. An
awake scanner refreshes immediately after edits. A sleeping scanner receives the
change at its next timer wake (up to 10 minutes), then uses 45-second rest slices
while a fingerprint job waits. Only the scanner and LCD sleep; website/PIN paths
remain available.

For battery operation, use watt-hours for planning: a nominal 10,000 mAh,
3.7 V bank is about 37 Wh, not 10,000 mAh at 5 V. A 6000 mAh label must likewise
be converted using its cell voltage. Avoid banks with Auto-shutoff at low load.

## Recovery and deployment checks

- The LCD connection line and dBm/bars describe the **local Wi-Fi radio link**, not proof that the internet or website is reachable. The device retries the website even if Wi-Fi stays connected during an internet outage. The router must use a compatible 2.4 GHz network.
- Flashing the website does not flash the ESP32. Compile and upload this sketch, then test by switching the access point off/on and separately interrupting/restoring internet while Wi-Fi stays up. Check that a scan during each outage appears in attendance, in order, and with the expected time. Check the LCD and Serial logs.
- LittleFS is no longer automatically formatted if mounting fails, to avoid erasing queued scans. The LCD says **SCAN NOT SAVED** when a queue write fails. A new/unformatted device may need one deliberate filesystem initialization; back up/recover any existing data before formatting.
- Kept scans are retried in order; a non-200 response or corrupt entry pauses the queue instead of deleting it. Check Serial for `Offline queue paused` and fix the server/token/mapping or inspect the device. Storage is finite and the current queue has no exactly-once delivery guarantee if a response or power is lost after the server commits. Reconcile attendance after an outage.
- A scan has an accurate saved time only if the device has synchronized its clock since its most recent boot. A long Wi-Fi outage can trigger a restart; after that, scans cannot carry a known time until NTP returns. The server accepts an offline timestamp up to three days old; older/unknown timestamps fall back to arrival time. Check the attendance report after outages, especially those spanning a restart or more than three days.
- Set `serverURL` to the real HTTPS site. To use `ATTENDANCE_DEVICE_TOKEN`, place the same secret in `deviceToken` and in Coolify, coordinating rollout so old firmware is not locked out. Never commit the secret. The default empty token leaves device endpoints open. Review TLS certificate verification for the installed ESP32 Arduino core before sending a token or relying on this over an untrusted network.
