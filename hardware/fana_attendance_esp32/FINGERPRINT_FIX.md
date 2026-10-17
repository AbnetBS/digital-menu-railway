# FPC1020A enrollment and scanning - FANA CAFE attendance

> The **top section is the current state** (2026-10-16). Everything under it is
> kept as history: it records how the enrollment got to the flow that this
> document used to call final, and the readings of the sensor that are still
> true (rule 1 - no other command inside an enrollment session - is one of them).
>
> Two things about the guide below are now out of date, and both are deliberate
> history rather than errors: the display became a **20x4 I2C LCD** (so "the
> OLED says..." means "the LCD says..."), and the **six-capture order described
> below was wrong** - it is what made a finger report "added" and then refuse to
> scan. The prompts **PLACE FINGER**, **HOLD STILL**, **LIFT YOUR FINGER** and
> **LIFT, PLACE AGAIN** are unchanged; **KEEP STILL** is gone, because the
> finger is no longer held down through every capture. `Scan 1/6` came back by
> request (owner: the six cells are what people follow at the door): it is now
> the `ID n [......] k/6` progress row - three steps, then three confirm scans.

## Current state (2026-10-16): it said "Fingerprint Added", the scanner said "NOT REGISTERED"

**The report.** Add an employee's fingerprint: the device walks through the
guided scans, the admin page prints **Fingerprint Added ✓** - and when that
person next puts his finger on the scanner, the LCD says

```
NOT REGISTERED
Finger not enrolled
Ask admin to add it
```

**What that message actually is.** It is not a website message and it is not a
missing mapping. `NOT REGISTERED` is printed by the sketch when the
**FPC1020A itself** answers a scan with status `0x05 (NOUSER)`: the module saw
a finger and found no template for it. (A mapping the website is missing looks
different: the finger matches, `VERIFIED` shows, and the answer comes back
`NOT ACCEPTED / Fingerprint not enrolled`.) So the enrollment never really
happened, even though every command of it had answered `OK`.

**Why.** The recipe, not the wiring and not the UART. This module's own
protocol has exactly three enrollment commands - `0x01`, `0x02`, `0x03` - and
the vendor's `EnrollUser` example uses them as three separate captures:

```
enroll(id, 1)  ->  "Step 1 complete. Remove finger."             delay(1500)
enroll(id, 2)  ->  "Place the SAME finger again" ... remove      delay(1500)
enroll(id, 3)  ->  "Place the SAME finger one final time"        -> stored
```

The sketch sent **six** commands instead - `1, 2, 2, 2, 2, 3` - with the finger
held on the glass the whole time, because the PR #50 investigation below had
concluded (rightly!) that no other command may be sent mid-session and (wrongly)
that the finger must therefore never be lifted. Six pictures of one unmoving
press are accepted and merged into a model that can never be matched against a
finger placed normally again. The module reports `OK` all the way through,
because `OK` means "I took the pictures and wrote the record", not "this finger
will be found later".

**The fix, in three parts.**

| Part | What changed |
| --- | --- |
| 1. The recipe | `runCaptureSession()` now walks the module's own three steps - `finger.enroll(id, 1)`, `(id, 2)`, `(id, 3)` - **one capture each**, and asks for a **fresh placement per step** (`LIFT YOUR FINGER`, then `PLACE FINGER`). Still no sensor command between the steps: rule 1 below is untouched, the lift is timed with `delay()`, exactly like the vendor's `delay(1500)`. |
| 2. The proof | `confirmEnrolledFinger()` runs after the third step: three times in a row the glass is emptied, the person places the same finger again, and the module must answer the SEARCH with **this ID**. `ENROLL_OK` - and therefore the mapping, therefore `Fingerprint Added ✓` - is only ever reached through those three scans, and a match under somebody else's ID stops the job at once. One recognition would already have caught the old bug; three is what tells a damp, ridge-smudged finger apart from a working one, and it is what the last three cells of the progress bar are. |
| 3. The cleanup | A session that was accepted but not confirmed is retried as a whole new session, and the slot is freed **again** before the retry (the unconfirmed attempt may well have left a record under that ID, which would otherwise answer status 7 next time). |

**What the owner sees when the sensor does not confirm the finger:** the LCD
says **DOES NOT SCAN / finger does not scan successfully / Not saved - retry**,
the job fails on the admin page with
`the finger does not scan successfully: the sensor did not find it on N fresh
scan(s) after saving it (status 5: NOT REGISTERED)`, and **no** mapping is
written. The words are the same in both places on purpose (owner, 2026-10-16:
"if the finger has error or not scanning properly it must notify instead of
saying fingerprint added"): the phrase "Fingerprint added" is never printed for
a finger that was not found again. The false positive is now structurally
impossible - the device cannot call a finger added without having just found it
three times. What it prints when it *did* work says so too: **ADDED / scans
fine - ID n**, not a bare "added".

**Tests.** The host suite models the module the way the vendor documents it -
strict `1 -> 2 -> 3` order, and a model merged from one single press stored as
an *unusable* record that every later SEARCH answers 5 to. Section 9b replays
the old six-command recipe and asserts exactly this bug (all six OK, finger NOT
REGISTERED); 9b2 covers a finger that is found twice out of the three
confirmations (refused: two out of three is the "works at the desk, fails at
the door" finger); section 9c covers a module that answers OK and stores
nothing. Both
`bash hardware/fana_attendance_esp32/test/run.sh` and `npm test` run them.

**Confirming it on the device.** `diagnostics/enroll_diagnostic/enroll_diagnostic.ino`
grew a fourth mode and a **VERIFY** step that every mode now ends with: it asks
for a fresh placement and requires the SEARCH to answer ID 999. Run `c` (the old
recipe) and then `d` (the current one) with the same finger - `c` should print
`VERIFY FAILED` after six accepted scans, `d` should print `VERIFY OK`. That is
the whole difference between "the commands were answered" and "this finger works".

## Earlier state (2026-10-10): why the website button failed while Serial `enroll` worked

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

**The fix (kept - the pre-flight is still what both enrollment paths run):**
`enrollFingerprint()` runs a **pre-flight before the first ADD command** (the
only point where extra commands are still legal), so both paths start from an
identical sensor state:

| Step | Command | Why |
| --- | --- | --- |
| 1 | `COUNT` + `DELETE <id>` | free the slot up front, never mid-placement |
| 2 | `SEARCH` until the glass is **empty** | the OLED says **LIFT YOUR FINGER**; a finger left on the glass no longer poisons `ADD_1` |
| 3 | **PLACE FINGER** + settle, then `ADD_1` | the module sees a finger coming down, exactly as in the manual flow |

~~After that the six captures are unchanged: **only ADD commands**, 600 ms
settle, finger kept on the glass.~~ **This last part was the mistake** - see the
2026-10-16 section above: the six captures and the "keep the finger down" rule
came from reading "no commands mid-session" too broadly. What survived is
"no *other* commands mid-session", plus one placement per step.

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

**The fix as it stood then (history - see the 2026-10-16 section above for what
replaced it):** `enrollFingerprint()` sent the six ADD commands and nothing else
to the sensor. The finger was placed ONCE: the OLED showed **PLACE FINGER**,
waited 2.5 s for the finger to settle, then sent ADD_1 with a 30 s timeout. For
the five remaining captures the OLED showed **KEEP STILL**, waited 600 ms, and
sent the next ADD command. Recoveries used only TIME, never extra sensor
commands:

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
- **Enrollment is the module's own three steps, and sends no other command between them.** The only commands sent during a session are `ADD_1`, `ADD_2` and `ADD_3`, one capture each, from a fresh placement each. Everything else - the COUNT, the DELETE that frees a leftover slot, the SEARCH that waits for the glass to empty, and the **confirm scan** after the session - happens outside the session, because inside it the module accepts nothing but the remaining ADD steps.
- **One scan per placement.** A finger that stays on the sensor is scanned once. The device waits for the finger to be lifted before it accepts the next placement, so a finger left on the sensor for minutes is not posted again and again. The same guard keeps a finger left on the sensor after enrollment from clocking in by accident.
- **Fast result.** VERIFIED appears as soon as the sensor matches the finger. The website answer is awaited for at most 4 seconds, and there are no fixed delays in the scan path.
- **Automatic enrollment is guided on the LCD** and never counts scans that were
  not made - and since 2026-10-16 it never reports a finger the module cannot
  find again: the confirm scan has to pass first.
- **Automatic and manual enrollment are the same code.** Both call `enrollFingerprint()`, and both go through the same pre-flight, so the website button cannot drift away from the Serial command again.
- **A failed attempt is not a failed job.** The whole six-scan sequence is retried from a fresh lift and placement up to 3 times before the website is told.

## The enrollment flow: three steps, then three confirm scans

The sketch follows the reference flow for this FPC1020A module (the vendor
library's `EnrollUser` example), and adds the proof the example cannot give:

| LCD step | Module command | Captures |
| --- | --- | ---: |
| Step 1 of 3 - PLACE FINGER | ADD_1 (`step 1`) | 1 |
| Step 2 of 3 - LIFT, then PLACE FINGER | ADD_2 (`step 2`) | 1 |
| Step 3 of 3 - LIFT, then PLACE FINGER | ADD_3 (`step 3`) | 1 |
| Confirm scan 1/3 to 3/3 - PLACE FINGER each time | SEARCH | 3 (no ADD) |

That is **three accepted captures, each from its own placement**, and **three**
scans that have to find the finger before anything is called added. The LCD
shows **LIFT YOUR FINGER** first if the glass is not empty, then walks the
three steps, with the progress as **`ID 7 [......] 5/6`** - the last three cells
are the confirm scans, which is the count-up-to-6/6-then-done rhythm the owner
asked to keep.

- ~~The finger is placed once.~~ Each ADD command is sent only after the person
  had time to settle onto the glass (2.5 s after a fresh placement), so the
  module never captures a moving finger - and a fresh placement per step is what
  makes the merged model matchable later.
- The module itself gets up to 30 seconds per ADD command. If no finger is seen for 30 seconds in total, the job ends with "no finger was placed".
- If the module returns status 6 (image unclear), the OLED shows **HOLD STILL** and retries the **same capture** about a second later. After three unclear images in a row it asks for **LIFT, PLACE AGAIN** (a timed pause - no sensor command).
- An ID that the website already maps to a person is never overwritten, by a website job or by `enroll <id>`. If the sensor holds a template under an ID that no one is mapped to (a leftover), the sketch deletes that leftover **before** asking for a finger, so the DELETE can never land inside the session.
- If the captures cannot be finished - or a confirm scan does not find the
  finger - the device frees the slot again, asks for a fresh lift and placement
  and starts the whole sequence again, up to 3 times. Only then does the job end,
  with **DOES NOT SCAN** and the reason on the LCD and the same reason sent to
  the website. After a miss the LCD asks for **LIFT, PLACE AGAIN**, because the
  next confirm scan needs a new press like every other one.

## Add a fingerprint: two ways

### Path A: automatic (recommended)

1. In the admin site open **Attendance → Staff Members**.
2. Edit the person and press **ADD FINGERPRINT**.
3. The server picks an available ID from 1–1000 and sends the job to the connected device in real time.
4. Follow the LCD. If a finger is already on the glass it says **LIFT YOUR FINGER** first - take it off. Then place the finger flat and still when it says **PLACE FINGER** (step 1), **lift it and place it again** for step 2, and once more for step 3. It is the same finger every time; a fresh press every time is what makes the finger findable later.
5. The device then asks for three more placements - the **confirm scans** (cells 4, 5 and 6 of the bar). When the module answers all three with this ID, the LCD shows **ADDED / scans fine - ID n**, the device sends the mapping back and the admin page shows **Fingerprint Added ✓**. A finger the module cannot find on every one of them is a failed job that says the finger **does not scan successfully** - never a false ✓, and never the word "added".
6. While the device works, the admin page shows **Device is ready • ID n** as soon as the scanner picked the job up (before that it says **Waiting for the device**, which means the scanner is offline).
7. If no finger is placed within 30 seconds, or the enrollment cannot be finished after 3 attempts, the job is marked failed. The LCD shows **DOES NOT SCAN** with the reason, and the admin page prints the same reason - for example `step 2/3 not accepted: Image unclear - press flat, clean sensor (status 6)`, or `the finger does not scan successfully: the sensor did not find it on 3 fresh scan(s) after saving it (status 5: NOT REGISTERED)` - next to a **Try again** button.

### Path B: manual (enroll on the device, then map it)

1. Open the device Serial Monitor at **115200 baud**.
2. Type `enroll 7` (replace 7 with the sensor ID you intend to use, from 1–1000) and press Enter.
3. Follow the LCD (same flow as Path A: three steps, a fresh placement each, then the three confirm scans). When it succeeds, Serial and LCD say **Stored as ID 7 (a scan finds it) — map it: admin → Attendance → Staff Fingerprints**.
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
- [ ] Power the sensor from 5V **only if the module carries its own 3.3V regulator** (a 3-pin part next to VCC). A bare die on a flex is a 3.0-3.3V part and 5V on it runs hot, then scans badly, then stops answering; and 3.3V into a regulated module is often too little, which looks like a dead sensor. README -> "Which supply does THIS module want?" settles it with the `sensor` link test on each supply. Never guess, and never exceed the marking.
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
