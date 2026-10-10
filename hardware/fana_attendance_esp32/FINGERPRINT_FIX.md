# FPC1020A enrollment and scanning - FANA CAFE attendance

## Current state (2026-10-10): why the website button failed while Serial `enroll` worked

**The report:** pressing **ADD FINGERPRINT** in admin → Attendance showed the
same OLED guide as the manual flow (**PLACE FINGER**, **Scan 1/6**), but the
finger was never stored. The screen walked through the recovery prompts
(**HOLD STILL**, **LIFT, PLACE AGAIN**), then gave up, and the admin page
stopped waiting. `enroll <id>` on the Serial monitor kept working.

Both paths always called the **same** `enrollFingerprint()`, so the difference
could only be the state the sensor was in when the six captures began. There
were two:

1. **A leftover template under the ID the server picked.** The website chooses
   the lowest ID its own fingerprint table does not use. It cannot know about a
   template that sits on the sensor and was never mapped to anybody - an
   earlier failed job, or a Serial `enroll 1` from the setup checklist. `ADD_1`
   then answered status 7 (*ID already has a finger*), and the old code sent a
   **DELETE in the middle of the placement**. That is exactly what rule 1 below
   forbids, so every capture after it was refused.
2. **A finger already resting on the glass.** With `enroll <id>` the owner
   types the command first and only then reaches for the sensor, so `ADD_1`
   always saw a finger coming **down**. With the website button the person is
   usually standing at the scanner - often already leaning on it - when the job
   arrives over the event stream, so `ADD_1` captured a picture that existed
   before the command was sent, and every retry saw the same unmoving finger:
   status 6 (*image unclear*) until the attempts ran out.

**The fix:** `enrollFingerprint()` now runs a **pre-flight before the first ADD
command** (the only point where extra commands are still legal), so both paths
start from an identical sensor state:

| Step | Command | Why |
| --- | --- | --- |
| 1 | `COUNT` + `DELETE <id>` | free the slot up front, never mid-placement |
| 2 | `SEARCH` until the glass is **empty** | the OLED says **LIFT YOUR FINGER**; a finger left on the glass no longer poisons `ADD_1` |
| 3 | **PLACE FINGER** + settle, then `ADD_1` | the module sees a finger coming down, exactly as in the manual flow |

After that the six captures are unchanged: **only ADD commands**, 600 ms
settle, finger kept on the glass.

Three more things were wrong and are fixed:

- **A failed session failed the job.** Now the whole six-scan sequence is
  retried from a fresh lift and placement up to `ENROLL_MAX_SESSIONS` (3)
  times, because a broken session can only be repaired by starting a new one.
- **Waiting for a person ate the capture budget.** A *no finger* answer is not
  a failed capture, so it no longer consumes an attempt; the 30 s no-finger
  budget decides, and the reason reported is *no finger was placed*.
- **A garbled reply sent a `COUNT` mid-session** (`sensorAnswers()`), breaking
  the session it was trying to save. Recovery is now timed only.

**Nothing is silent any more.** The device posts
`{"action":"job_started"}` to `/api/attendance/mappings` **before** it touches
the sensor, and on failure `{"action":"job_failed", "reason": ...}` where the
reason names the scan and the status, e.g.
`scan 2/6 not accepted: Image unclear - press flat, clean sensor (status 6)`.
Both are stored on the job row (`started_at`, `detail`) and printed by the
admin page, so "the loading stopped" now always comes with a reason.

### Verifying it without the device

```sh
bash hardware/fana_attendance_esp32/test/run.sh
```

That compiles the **real sketch** against host stubs and runs the enrollment
state machine on a simulated FPC1020A and a simulated website: the reported
worst case (finger already on the glass **and** a leftover template on the
ID), unclear images, a session broken by a stray SEARCH, nobody coming to the
scanner, an ID that belongs to somebody else, and the full
`?pending` → `job_started` → `mapping` round trip. `npm test` runs it too
(`scripts/verify-fingerprint-enroll.ts`).

## The earlier regression: the search-between-scans rewrite and its fix

**What was broken on the device:** after PR #50, automatic enrollment failed on
scan 2 with **status 1 (Command failed)**, and manual `enroll <id>` failed the
same way, because both paths call `enrollFingerprint()`. A local-only attempt
(commit ee3873b, never merged) that removed the sensor commands between scans
then failed scan 2 with **status 6 (image unclear)** repeated until the
retries ran out.

**What the three device observations tell us:**

| Firmware | Between the six captures | Result on the device |
| --- | --- | --- |
| before PR #50 (420eb2b) | nothing - no sensor command at all; finger kept on the sensor, 600 ms settle before each ADD | manual enrollment worked |
| PR #50 (b3356fb) | SEARCH commands wait for lift and re-placement between every scan | scan 2 answered **status 1** - enroll failed |
| ee3873b (local only) | no commands - but forced lift, 4 s pause, only 300 ms settle before the ADD | scan 2 answered **status 6** repeatedly - enroll failed |

Two rules follow, and they match the upstream Biovo1020A library's own
`EnrollUser` example (back-to-back `enroll(id, step, 30000)` calls with a
plain pause, never a search in between):

1. **Once ADD_1 has gone out, only the remaining ADD commands may be sent.**
   Any other command (SEARCH, COUNT, ...) inside an enrollment session makes
   the module refuse the next ADD step with status 1 ("Command failed").
2. **An ADD command must reach the module while the finger already rests flat
   and still on the glass.** A capture taken while the finger is still moving
   down comes back as status 6 ("image unclear").

**The fix (this branch):** `enrollFingerprint()` sends the six ADD commands
and nothing else to the sensor. The finger is placed ONCE: the OLED shows
**PLACE FINGER**, waits 2.5 s for the finger to settle, then sends ADD_1 with
a 30 s timeout. For the five remaining captures the OLED shows **KEEP STILL**,
waits 600 ms, and sends the next ADD command. Recoveries use only TIME, never
extra sensor commands:

- **status 6** (image unclear): the OLED says **HOLD STILL** and the SAME
  capture is resent about 1 s later - the finger is already in place. After
  three unclear images in a row: **LIFT, PLACE AGAIN** with a 2.5 s pause,
  then a fresh placement.
- **status 8** (no finger): a fresh **PLACE FINGER** window; enrollment gives
  up with "no finger was placed" after 30 s total without a finger.
- **status 1** or any other unexpected status: **LIFT, PLACE AGAIN** with a
  fresh placement. No other command is sent at the module.
- **0xFE / 0xFF** (garbled / no reply): sensor health check; enrollment
  aborts as "sensor not answering" if the sensor stays silent.

Every attempt is printed to Serial as
`Scan N/6 not accepted, status X (text) after Y ms` - the duration matters,
because it shows whether the module waits for a finger inside the ADD command
or answers at once.

**Device confirmation is still pending.** The fix restores exactly the
strategy that enrolled fingers before PR #50, and it matches the library
vendor's own example, but the final proof is one full six-scan enrollment on
the real device. To compare all three strategies on the device, flash
`diagnostics/enroll_diagnostic/enroll_diagnostic.ino` INSTEAD of the product
sketch and send `a`, `b`, or `c` in the Serial Monitor (115200 baud):

- `a` = mode A: SEARCH between scans (PR #50 style)
- `b` = mode B: no commands between scans, 4 s lift pause (ee3873b style)
- `c` = mode C: place once and keep the finger on (current firmware style)

The tool runs one six-scan enrollment under test ID 999 and prints every
sensor reply with a timestamp and the raw frame. Share the log if a mode
fails. It uses the Biovo1020A library unchanged.

## Why enrollment failed the first time (history, PR #49 era)

The Serial Monitor showed enrollment **status 6 (IMAGEMESS)**, while a normal scan returned **status 5 (NOUSER)**. Those results tell us different things:

- **Status 5 during a scan:** the module took a usable image of the finger and searched its database, but that fingerprint ID is not stored yet.
- **Status 6 during enrollment:** the module could not use the image it took. In that failed workflow, the capture command was sent while the finger was still moving into place.

So communication with the sensor was working; it was capturing too early. That fix changed the firmware workflow, not the vendored Biovo1020A library. Keep that library unchanged.

## What the sketch does today

- **Four sensor wires only:** VCC, GND, RX, TX. The extra sense wires (sensor pins 5 and 6) are not used and stay unconnected.
- **Idle scanning uses the sensor's own SEARCH.** A status of 0x08 (timeout), 0x0F (finger lifted), or 0xFF (no reply) means "no finger". A match, status 0x05 (not enrolled), or status 0x06 (unclear image) means "finger on".
- **Enrollment sends NO commands at all between the six captures.** The only commands sent during a session are the six ADD steps. Everything else - the COUNT, the DELETE that frees a leftover slot, and the SEARCH that waits for the glass to empty - happens in the pre-flight, **before** `ADD_1` goes out, because after that the module accepts nothing but the remaining ADD steps.
- **One scan per placement.** A finger that stays on the sensor is scanned once. The device waits for the finger to be lifted before it accepts the next placement, so a finger left on the sensor for minutes is not posted again and again. The same guard keeps a finger left on the sensor after enrollment from clocking in by accident.
- **Fast result.** VERIFIED appears as soon as the sensor matches the finger. The website answer is awaited for at most 4 seconds, and there are no fixed delays in the scan path.
- **Automatic enrollment is guided on the OLED** and never counts scans that were not made.
- **Automatic and manual enrollment are the same code.** Both call `enrollFingerprint()`, and both go through the same pre-flight, so the website button cannot drift away from the Serial command again.
- **A failed attempt is not a failed job.** The whole six-scan sequence is retried from a fresh lift and placement up to 3 times before the website is told.

## The six-capture enrollment flow

The sketch follows the reference flow for this FPC1020A module:

| OLED step | Module command | Captures |
| --- | --- | ---: |
| Step 1 of 3 | ADD_1 (`step 1`) | 1 |
| Step 2 of 3 | ADD_2 (`step 2`) | 4 |
| Step 3 of 3 | ADD_3 (`step 3`) | 1 |

That is **six accepted captures total, all from ONE placement**. The OLED
shows **LIFT YOUR FINGER** if the glass is not empty, then **PLACE FINGER**
once, then **KEEP STILL**, with the progress shown as **Scan 2/6** and a
filling bar.

- The finger is placed once. Each ADD command is sent only after a settle pause (2.5 s for the first capture, 600 ms between later captures), so the module never captures a moving finger.
- The module itself gets up to 30 seconds per ADD command. If no finger is seen for 30 seconds in total, the job ends with "no finger was placed".
- If the module returns status 6 (image unclear), the OLED shows **HOLD STILL** and retries the **same capture** about a second later. After three unclear images in a row it asks for **LIFT, PLACE AGAIN** (a timed pause - no sensor command).
- An ID that the website already maps to a person is never overwritten, by a website job or by `enroll <id>`. If the sensor holds a template under an ID that no one is mapped to (a leftover), the sketch deletes that leftover **before** asking for a finger, so the DELETE can never land inside the session.
- If the six captures cannot be finished, the device asks for a fresh lift and placement and starts the whole sequence again, up to 3 times. Only then does the job end, with a clear reason on the OLED and the same reason sent to the website.

## Add a fingerprint: two ways

### Path A: automatic (recommended)

1. In the admin site open **Attendance → Staff Members**.
2. Edit the person and press **ADD FINGERPRINT**.
3. The server picks an available ID from 1–1000 and sends the job to the connected device in real time.
4. Follow the OLED. If a finger is already on the glass it says **LIFT YOUR FINGER** first - take it off. Then place the finger flat and still when it says **PLACE FINGER**, and KEEP IT ON the sensor while the five remaining scans are taken. Do not lift until the device says it is done.
5. When all six scans are accepted, the device sends the mapping back and the admin page shows **Fingerprint Added ✓**.
6. While the device works, the admin page shows **Device is ready • ID n** as soon as the scanner picked the job up (before that it says **Waiting for the device**, which means the scanner is offline).
7. If no finger is placed within 30 seconds, or the enrollment cannot be finished after 3 attempts, the job is marked failed. The OLED shows **Not added** with the reason, and the admin page prints the same reason - for example `scan 2/6 not accepted: Image unclear - press flat, clean sensor (status 6)` - next to a **Try again** button.

### Path B: manual (enroll on the device, then map it)

1. Open the device Serial Monitor at **115200 baud**.
2. Type `enroll 7` (replace 7 with the sensor ID you intend to use, from 1–1000) and press Enter.
3. Follow the OLED (same flow as Path A) and keep the finger flat and still. When it succeeds, Serial and OLED say **Stored as ID 7 — map it: admin → Attendance → Staff Fingerprints**.
4. In the admin site open **Attendance → Staff Fingerprints**. Select the person, enter **the same sensor ID**, choose the finger name, and press **Add**.
5. The page confirms **Fingerprint Added for …**. That mapping lets scans identify the person; enrolling on the sensor alone does not assign a staff name.

Use the same ID in both places. Other serial commands: `list`, `test`, and `empty confirm` (deletes every fingerprint on the sensor; plain `empty` only prints a warning).

## Physical checklist

Before enrolling, check each item:

- [ ] Peel the protective film off the fingerprint sensor; the capacitive sensor cannot read through it.
- [ ] Clean the sensor surface and keep it free of oil, dust, and residue.
- [ ] Place the finger flat and press it **STILL**. Do not move or lift until all six scans are accepted; lifting early is the most common cause of a failed enrollment.
- [ ] If the finger is dry, lightly moisten it (for example, breathe on it). Wipe off sweat or excess moisture.
- [ ] Wire the sensor with the four wires only: VCC, GND, TX to GPIO16, RX to GPIO17. Pins 5 and 6 stay unconnected.
- [ ] Keep the UART and power wires short and make sure GND is common.
- [ ] If captures still fail, add a **100 µF capacitor across module VCC and GND**, close to the module.
- [ ] Power the sensor from 5V **only if the module is marked/rated for 5V**. Otherwise use its rated supply; never guess or exceed its rating.
- [ ] Keep the sensor UART at **19200 baud, 8N1**.

## The library and the real-time flow

The patched `hardware/fana_attendance_esp32/libraries/Biovo1020A` remains unchanged. Its stale-reply handling and host tests protect UART communication, but they cannot make a moving finger image clear. The sketch uses the library's existing `enroll(id, step, timeout)`, `search(...)`, `drain()` and `getLastStatus()` calls. `drain(150)` runs right before the first ADD command so a late reply from the idle scan loop cannot be mistaken for an enrollment reply.

The automatic path listens on the server's real-time event stream. If that stream is unavailable, the sketch checks for pending jobs every 15 seconds. Clock-in and clock-out, offline queueing, and the mapping endpoints work as before. A job that the device cannot finish is reported to `POST /api/attendance/mappings` with `{"action": "job_failed", "jobId": ..., "reason": ...}`.

The library's host tests can be run without hardware:

```sh
cd hardware/fana_attendance_esp32/libraries/Biovo1020A/test
g++ -std=c++11 -I. -I../src host_test.cpp ../src/Biovo1020A.cpp -o host_test
./host_test
```
