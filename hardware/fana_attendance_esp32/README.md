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
2. The board hears the job on its event stream, or picks it up on its five second poll. Its LCD shows **PREPARING...** at once. The website says the job was received, not that the reader is already ready.
3. At **PLACE FINGER** the employee places the finger for capture 1.
4. The employee lifts it.
5. The same finger is placed again with a small position/angle change for capture 2.
6. The R307 combines the two captures and stores one template.
7. Lift again, then place the finger a **third time**. One fresh confirmation scan must find the same template ID.
8. Only then is the ID mapped to the employee on the website.

Use the same finger, place its pad flat and keep it still until the reader beeps.

**What changed in October 2026, and why.** The owner's report was: *"the LCD says PLACE FINGER 0/3, then it says no fingerprint and goes back to the idle screen, and the sensor never lights up."* Four things in the firmware produced exactly that:

- **The reader's light was never re-asserted during a job.** Some R307 variants switch their own illumination off after a capture or after answering "no finger"; the sketch asked for it back only every five seconds from the idle loop, which does not run while a job owns the reader. A dark glass answers "no finger" for a full minute. The light is now requested before every placement and again every four seconds inside the wait, and the wait is split into slices so those requests can actually happen between them.
- **Two and a half seconds of silence followed every prompt** before the first image was even asked for. That is now 0.7 s, and the lift pause is 0.9 s.
- **The mapping pre-flight could fail the whole job.** It insisted on a live name list from the website ("cannot check current fingerprint mappings; reconnect to the website and retry"). A weak link therefore turned Add Fingerprint into a failure even though the board already had the list in flash. The live list is still preferred, but the saved list is accepted when the link cannot answer, because the website only hands out IDs it believes are free. A device that has **never** received a list still refuses, because it truly cannot tell whose slot an ID is.
- **A failure used to say only "no finger".** It now says which no-finger it was: `no finger within 30 s: the reader answered 'no finger' 850 times and 'unclear' 0 times - check its light, power and the glass`. A reader that cannot see is a hardware problem; someone who never pressed is not. The two are no longer confused.

**Two waiting times that used to sit in front of the first prompt** are shorter as well: the receipt to the website gets three seconds instead of two eight-second attempts, and the name-list check gets 1.5 s when the list is already saved in flash (it is only a top-up; the saved list decides). Add Fingerprint now reaches **PLACE FINGER** in a second or two even on a weak link.

**And what is done about a reader that stays dark.** Four additions, in the order they happen:

- **The light is asked for three different ways, and never abandoned.** The sketch first requests plain LED-ON, then tries the previous breathing and steady-on aura fallbacks. A reader that refuses all of them is asked again later instead of being written off. `lamp` in Serial reports whether any layout was accepted.
- **A reader that has seen nothing for 6 s is re-synchronized** inside the placement window (a password handshake, which touches no template) and its light is asked for again. A module that was confused by an earlier command, or that came back late, is picked up here instead of answering "no finger" until the job dies.
- **At 10 s the LCD stops promising.** The bottom row changes from `Step 1/2 flat, still` to `Reader sees nothing`. The person at the door is then told the truth - the reader is not seeing the glass - instead of being asked to press harder at a glass that cannot see.
- **A window that saw nothing is asked again before the job fails.** `TRY AGAIN / Same finger, flat` appears once, the glass is checked for a lift, and a second 30 s window runs. Worst case, a job with nobody at the door ends in about a minute instead of two, and a reader that was briefly dark still enrolls.

**Last attempt: one steady press.** If the normal flow fails twice, the third and last session switches to taking *both* captures from a single steady placement (the flow the earlier firmware used, recorded in `diagnostics/enroll_diagnostic`). The LCD shows **KEEP IT DOWN**. This rescues a reader whose optics lose the finger between two placements. The confirm scan still requires a fresh placement, so "added" still means "the reader finds this finger again".

**The connection is needed to start a job, not to babysit it.** The job has to arrive from the website and the result has to go back, but a dropped request no longer aborts the session: the serial `enroll <id>` command also works while the board is offline (using the names saved in flash), and the ID can be mapped afterwards in **Attendance → Staff Fingerprints → Manual**.

Each placement prompt has up to 30 seconds, and a window that saw nothing is asked once more, inside the overall enrollment budget; the firmware retries early no-finger replies and transient unclear images without lowering matching security. If the job fails, the LCD holds the reason for six seconds and the website receives the detail; an interrupted failure report is retried for about two minutes, then released so it cannot block later jobs. If a verified capture was stored but the website did not confirm the employee and ID, the mapping is retried for about five minutes without repeating the capture; after that the job is closed with the stored ID, because the template is real and the admin can map it by hand. The unconfirmed owner is never added to the scanner's offline cache. Pending mapping and failure reports are kept in RAM, not persisted across a reboot. Keep one scanner active and do not manually change fingerprint mappings while an enrollment is underway; the website and reader cannot atomically lock a physical slot across the network.

### If Add Fingerprint still does not add

Read the Serial log at 115200 baud while the job runs. Every step prints what the reader answered:

| Serial line | What it means | What to do |
|---|---|---|
| `Capture 1/2, attempt 1` then `Capture accepted` | the reader saw and accepted the image | place the finger again at the next prompt |
| `No image yet; still waiting for this placement` (repeating) | the reader is answering "no finger" | keep the finger flat on the glass; check that the glass is lit |
| `The reader has seen nothing yet: re-syncing it and asking for its light` | nothing answered for 6 s; the window repairs itself once | nothing yet - watch the next lines |
| LCD shows `Reader sees nothing` under `PLACE FINGER` | 10 s and the reader has not seen a finger at all | the reader cannot see: run `watch 10` and place a finger - if it still says no finger, it is the light, the glass, the power or the wiring, not the sketch |
| LCD shows `ENROLL FAILED / Reader saw nothing` | the whole job was blind; that flag survives the window | the reader never saw the glass: same checks as above. A person who simply did not press gets `no finger was placed` instead |
| `reader answers during the wait: no-finger 812, unclear 0` | nothing ever touched the glass/optics | clean the glass, check the reader's red light, power and GND |
| `unclear 14` | the reader sees something but the image is unusable | clean the glass, press flatter, dry the finger |
| `the two captures did not match` | two different fingers (or two very different placements) | use the same finger, same area of the pad |
| `the sensor did not find the stored finger ... (NOT REGISTERED)` | the template did not really store | run it again; the third session uses the one-press flow |
| `cannot ...` / `sensor did not answer` | the UART link failed | type `sensor` in Serial; check TX→16, RX→17, common GND, 5 V supply |

`lamp` in Serial asks the reader directly to switch its light on and reports whether it acknowledged; `watch` proves whether the reader can see a finger at all (place one and lift it while it runs); `test` runs one communication check; `enroll <id>` runs the whole flow without the website.


## Normal scan and offline attendance time

- One placement produces one attendance event; a held finger does not clock repeatedly.
- **Fast, and ready again at once (owner, Oct 2026).** The owner's target: a group of four people, each one scanned, verified and told where it went in *under four seconds*, Wi-Fi or no Wi-Fi, with the reader live again the moment the green light comes on. Two changes get there. First, while a **matched** finger still rests on the glass the board no longer runs full matches: it asks the reader one cheap question ("is anything on the glass?", answer in tens of milliseconds) so the lift is noticed immediately and the next person is scanned without the dead second that used to sit after every scan. Second, the reader's illumination is re-asserted right after each scan instead of up to five seconds later. The Serial log prints the real number for every scan: `Scan saved and shown in 1240 ms from the finger image`.
- **The two cases look different at a glance (owner, Oct 2026).** He asked for exactly this: *"if there is good connection the system write name, time and sent to website, but if the connection is poor or not connected it says saved on offline queue."*

  | Link | Row 1 | Row 2 | Row 3 | Row 4 |
  |---|---|---|---|---|
  | working, waiting | employee name | **SENDING TO WEBSITE** | `Time HH:MM:SS` | `Wait for receipt` |
  | confirmed | employee name | **SENT TO WEBSITE** | `Time HH:MM:SS` | `Attendance IN` / `Attendance OUT` |
  | no Wi-Fi | employee name | **SAVED OFFLINE** | `Time HH:MM:SS` | `No Wi-Fi now` |
  | link up, no answer | employee name | **SAVED OFFLINE** | `Time HH:MM:SS` | `Site not replying` |

  Every scan is written to LittleFS before anything else, so the scan is never lost - and the screen never says "saved on device" while the website has confirmed it. A **Wi-Fi association alone is not proof**: only the website's own receipt for that exact scan turns the row into **SENT TO WEBSITE**. The waiting screen used to flip to `SAVED OFFLINE` after 1.8 s, which is shorter than one round trip through a weak router, so delivered scans were being reported as "saved on device"; the budget is now **8 s**, and the last row says *why* a scan is still in the queue. An `ALREADY REGISTERED / No new entry` response is shown as such, not as a new IN/OUT.
- **A warning never stops the door, and a refused finger never closes it.** A nonmatching finger (`NOT RECOGNIZED / Finger not enrolled / Ask admin to add it`), a wrong-side press, a garbled press (`NOT RECOGNIZED / Press again, flat`) or an unclear one (`IMAGE UNCLEAR / Press flat and still / Clean the glass`) is shown for 3 s with the **red LED** and a distinctive **two-pulse buzzer** - and the scanner keeps reading the glass the whole time; the last row says **Door keeps scanning**. Two separate faults used to make this a blank, silent, dark glass:
  1. The old code put a *refused* placement into the same one-scan latch used for a match, so after a wrong finger the door stopped matching and only watched for a lift - the "it goes dark for five seconds and I have to time my finger" report. A refusal never sets the latch now: the very next pass searches again, and a good scan taken while the warning is still on the LCD replaces it on the spot. Only a **matched** finger holds the latch, so nobody is clocked twice.
  2. Some readers answer a bad press with a *garbled* frame or an unexpected status, and the sketch treated anything it did not recognise as "nobody touched the glass" - so no warning, no red LED, no buzzer and no message ever appeared. The driver now counts the images the reader actually captured during the search (`searchSawFinger()`), and the door believes that evidence: a finger that was seen is reported, whatever the status byte says. Nothing is ever invented for an empty glass, and a wiring fault is still reported separately as **SENSOR NOT answering** (with the red LED and the error beep).
  3. A **definite** no-match is answered immediately - the old code ran a whole second capture before saying anything, which is what made the red light feel late.
- **Light frames can no longer stall the door.** The optional light command never marks the link dirty and never drains the line, so a reader that answers it with a garbled frame can no longer make the sketch sit in recovery - a scan path stall that also looked like "the sensor goes black".
- The scanner, Wi-Fi services and the wakeable queue sender run independently. A new scan wakes the sender immediately; it checks a disconnected radio about once a second and waits about three seconds between failed website attempts (each request can itself take up to eight seconds). It sends oldest first and verifies a matching event ID, original time, employee/fingerprint and result before removing a scan; an HTTP 200 from a captive portal or an old website is not confirmation. A deliberate remote enrollment temporarily owns the reader and needs connectivity. If other scans are still ahead in the queue, a newly saved scan waits for them.
- **A kept scan carries its own time.** The device timestamps the successful image-capture reply, before matching and network delays. IN/OUT, date and lateness use that recorded time, not reconnection time. The website stores a receipt with each unique scan and commits attendance and automatic overtime together, making retries after a lost response safe. The open attendance paper sheet listens for updates and refreshes periodically while visible; a delayed scan appears under its original day, not necessarily the day selected on the sheet.
- Sync the clock before the outage: after power-on, allow Wi-Fi and NTP (UDP 123) to work, and check that the LCD shows the time. If NTP is unavailable but the updated website is reachable, the device can estimate the clock from the website over HTTP(S). This fallback uses network round-trip time and is approximate. HTTPS certificate validation may itself require an already-set clock; test this on the installed configuration. During an outage the ESP32 estimates time using its monotonic clock; network delay, clock synchronization and oscillator drift can cause error.
- If a scan occurs before the first clock sync, it is saved with boot-relative uptime. If NTP or the website clock succeeds later **without an intervening power loss**, a durable boot-time anchor reconstructs an estimate for that scan, including after a later reboot. If power is lost before that first sync, the absolute time is unknowable without a battery-backed RTC: the record is retained for **manual review**, never stamped as arrival. Legacy untimed records get the same treatment.
- If a cached fingerprint-to-employee mapping changed before a scan reaches the server, or a newer attendance record was already written first, the conflicting record is retained for manual review rather than silently credited to the wrong person. Keep fingerprint mappings stable while scans are queued. Legacy scans or a device with no cached member mapping cannot prove the original employee; review such changes carefully.
- The queue has finite flash space. If flash is full, damaged or unavailable, or a write is incomplete, the LCD says **SCAN NOT SAVED** and an error sounds. Do not assume attendance was recorded; use the supervised PIN/paper backup and inspect the storage. Do not format or erase flash without recovering the queue and review records.

## First upload and staged deployment

1. Back up the database and deploy the updated website **before** this firmware. This firmware requires receipt responses containing the matching event ID and original time; an older website will leave scans queued rather than falsely say SENT. The first schema upgrade can take database locks, so stage it outside a busy shift.
2. Select **ESP32 Dev Module** with a partition that includes LittleFS. Compiled for ESP32 Arduino core 2.0.17, WiFiManager 2.0.17 and hd44780 1.3.2 with both ArduinoJson 6.21.5 / Adafruit Fingerprint 2.1.3 and ArduinoJson 7.4.3 / Fingerprint 2.1.4. The local compile used a third-party Xtensa compiler; upload and serial discovery were not tested. Confirm the R307 pinout and wiring.
3. Keep `fana_attendance_esp32.ino`, `R307Compat.h` and `OfflineQueue.h` in the same sketch folder. Compile and upload using settings that **preserve LittleFS and existing queues**; an erase-all upload destroys pending attendance. Deploying the website alone does not flash the reader.
4. Open Serial Monitor at **115200 baud**. On first boot, join `Fana-Attendance-Setup` with password `fana12345` and configure restaurant Wi-Fi. The setup portal closes after its timeout; the reader remains available while it is open.
5. While online, confirm the sensor is found, the correct employee mappings load, and the LCD shows the current time. Enroll and confirm a test finger, then test an existing employee's IN/OUT scans and held-finger latch. Do not erase existing templates as a troubleshooting shortcut.
6. Test at the actual door: disconnect the access point, scan at least three known employees, reconnect, and verify all their original scan times in the open attendance paper sheet (choose the original date). Also interrupt internet while Wi-Fi stays associated. Check that an unsent scan says **SAVED OFFLINE**, a confirmed one says **SENT TO WEBSITE** with the right employee and time, and that putting an unregistered finger shows `NOT RECOGNIZED` and red with two buzzer pulses, and then scan a registered finger while the warning is visible. Inspect Serial, storage errors, manual-review warnings and the reader light. Physical tests are essential; the host simulation and compiler do not test optics, power or the installed network.

### Long outages, device authorization and TLS

The server accepts recorded scans older than three days only if `ATTENDANCE_DEVICE_TOKEN` is configured and the device sends the matching token; otherwise it responds 403 and leaves them queued, never writes the arrival time. Set the same private token in the server environment and the sketch's `deviceToken`, coordinating rollout with all existing scanners. Never commit or share the secret. With no token the device endpoints remain publicly callable and only the three-day window is allowed.

On ESP32 Arduino core 2.x, the legacy URL-only `HTTPClient` call **does not verify the HTTPS certificate**. Before using a token on an untrusted network, set `serverRootCA` in the sketch to the site's correct PEM root CA and use an `https://` `serverURL`; test certificate validation and plan for certificate/CA rotation. Otherwise an attacker on the network could impersonate the server or obtain the token. The firmware warns on Serial if a token is configured without verified HTTPS. Do not enable a server token until the installed firmware can authenticate with it.

### Reader's light

Scanning and the light request do not depend on Wi-Fi. The rule (owner, Oct 2026) is that the glass must be lit and blinking whenever the door is open, and that **nothing may have to wait for a dark window**.

- **Order kept from the build that worked.** Plain `LED-ON` is tried first, then the *aura* breathing-blue layout with unlimited cycles (the module blinks blue by itself), then a steady blue in the same layout. The flashing-first order that stopped registered scans in PR #70 is **not** used.
- **The working layout is remembered**, so a normal re-assert is a single short frame instead of three probes.
- **Refresh:** every 0.7 s while idle, and **forced** 0.3 s after every capture - matched, unregistered, unclear or empty glass. "Forced" means it skips the miss backoff, because the moment the reader takes an image is exactly when some variants switch their own LED off. The miss backoff is 1.2 s (it was 4 s, which the owner experienced as "it goes black and comes back after about five seconds").
- **Never fatal, never blocking:** light frames skip the quiet-line drain and do not mark the link dirty, they are skipped outright while a reply is still arriving (that reply may be a scan result), and a reader that refuses every layout is simply asked again later. Scanning, matching and enrollment do not depend on the answer.
- **It can never make the door slow.** After three full refusals only *one* layout is probed per call, and after six the sketch probes once every 30 s (still forever, still recovering the moment the reader answers). Probing therefore costs about 200 ms occasionally instead of three timeouts every second.

A no-match result does not prove a person is unenrolled: a registered finger placed on its side can also fail to match. The screen asks the employee to retry flat or ask the admin. Unclear images ask them to press flat and clean the sensor. The two-pulse rejection sound, red LED and LCD warning do not deliberately pause the scan loop. After a successful match the employee must lift their finger so the same placement cannot clock twice. Enrollment, real sensor communication timeouts and hardware limitations can still temporarily occupy the reader.

If the glass stays dark while the LCD asks for a finger, type `lamp` in Serial. It now reports **which of the three layouts** the reader accepted (`plain LED-ON`, `breathing blue`, `steady blue`) or that it refused all three - in which case the variant controls its own illumination and a dark glass during a placement is power, GND or the glass, not a lost command. The same information is on the device status page as `readerLightLayout` and `readerLightMisses`.

## Serial commands

At 115200 baud:

- `enroll <id>` — enroll and confirm one R307 template manually. It works with or without the website: the names saved in flash are enough to prove the slot is free (only a board that has never downloaded a list refuses). An admin must then map that ID to the employee in Attendance → Staff Fingerprints
- `list` — report the number of stored templates
- `lamp` — ask the reader to switch its illumination on and report whether it acknowledged (a reader that never acknowledges does its own lighting; this tells you which kind you have)
- `watch` (`watch 30`) — watch the glass for 10 s (or up to 60 s): prints every change between "finger on the glass", "glass empty" and "no answer", then a count of each. This is the fastest proof that the reader can see a finger at all, and it works with no website, no LCD and no card.
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
- `queue status` — show the delivery state, HTTP code, next queued event ID and known scan time. An older installed sketch may not support this command. This does not print the entire queue.
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
  - `Offline 34s - saved` disconnected and retrying (live counter), and the
    scan is safe on the device anyway
  - `No wifi - scans safe` never joined since it was powered on; the door still
    works, because Wi-Fi is needed to ADD a fingerprint, not to take attendance

  The bars are filled blocks: four at −55 dBm or better, three below −55, two
  below −65, one below −75, none below −85. If the `down` counter is moving,
  the board is working on it; nobody needs to unplug it.
- **A stronger access point is preferred.** When the link is up but below
  −78 dBm, every 5 minutes the board scans and rejoins if another access point
  with the same name is at least 8 dBm stronger (a mesh, or a second router).
- **A new fingerprint job is polled about every 5 s** even when the real-time stream
  looks connected, because a weak link can leave that socket open and silent.
  The event stream can trigger pickup sooner; slow or busy requests can add delay.
  This does not prove Wi-Fi caused a particular enrollment failure.
- **Requests wait 8 s instead of 4 s**, and the receipt message is
  sent twice if the first one is lost. If the failure report is unconfirmed,
  the scanner retries the report without repeating the fingerprint capture.

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
- `Offline queue paused, HTTP ...` means delivery is retried while the record remains on the device. `Website reply did not confirm this scan; kept on device` means an incompatible website, captive portal or invalid/mismatched response; it is not confirmation. Authentication errors, unrecognized mappings, bad time, storage damage or a missing server require attention. Run `queue status` and check the latest HTTP/Serial errors. A 409 conflict or an unrecoverable pre-clock record is copied to the review file and flagged on the LCD as `Scans need review!`; inspect it privately with `queue review`.
- Old firmware accepted any HTTP 200 without validating the receipt. If it already removed a scan after an unrelated HTTP 200, the firmware update cannot recreate that event; check server logs and existing backups, and reconcile the three reported missing scans manually if necessary. Preserve flash and templates while investigating.
- Preserve the existing LittleFS partition on upgrade. The firmware never automatically formats on mount failure. A new/unformatted device may need one **deliberate** filesystem initialization; back up existing data before any format.
- The queue appends records and retains acknowledged bytes until it drains fully. A persistent backlog, repeated review records or anchor files can fill flash. Monitor capacity and resolve failures promptly. Anchors are small and retained for any still-queued records.
- Queue and review files contain staff identifiers and scan data. Protect physical/Serial access and backups. The optional local status page reports whether review is required but does not expose the review records.
- Verify the optional LED command and uninterrupted operation on the actual R307, ESP32, power supply and network before relying on this change in production. The compiled firmware has not been flashed or tested on the user's hardware.
