# Host tests for the attendance device (no hardware needed)

```sh
bash hardware/fana_attendance_esp32/test/run.sh
```

Two suites, both compiled and run by `g++` on a PC:

1. **`libraries/Biovo1020A/test/host_test.cpp`** — the UART layer of the
   patched sensor library: frame re-sync, stale replies, checksums, timeouts.
2. **`enroll_host_test.cpp`** — the **real sketch**. It `#include`s
   `fana_attendance_esp32.ino` and runs `enrollFingerprint()` and
   `checkPendingEnroll()` against a simulated FPC1020A module and a simulated
   website, so the enrollment state machine is executed, not just read.

## What the simulation models

`stub/` holds the Arduino/ESP32 headers the sketch includes; `globals.cpp`
defines the objects they declare. That includes **`stub/hd44780.h` +
`stub/hd44780ioClass/hd44780_I2Cexp.h`**, a simulated 20x4 character LCD that
stands in for the real hd44780 library: `print()` writes into a 20x4 grid and
calls `screenHook`, an over-long line wraps and is counted as a wrap, a row
write that stops before column 19 is counted as a short write, `clear()` is
counted, and `println()` deliberately does not exist (the real library makes it
a compile error). The tests use those counters to prove the sketch always
writes full 20-character rows, never spills past column 19 and never clears the
screen while it is only updating it.

The simulated module in `enroll_host_test.cpp`
follows the protocol as this repository documents it:

- `ADD_1` / `ADD_2` x4 / `ADD_3` store a finger, and a step sent out of order
  answers **status 1** (command failed).
- **Rule 1:** once an ADD command has gone out, a non-ADD command inside the
  same session breaks it — every violation is counted in
  `mod.nonAddInsideSession` so a test can prove the sketch never commits one.
- `ADD_1` on an ID that already holds a template answers **status 7**,
  an empty glass answers **status 8**, and injected unclear images answer
  **status 6**.
- A simulated person reads the LCD and does what it asks, 800 ms later: lifts
  for anything that says `LIFT`, places the finger for `PLACE FINGER`.

## The cases it covers

| # | Scenario | Expected |
| --- | --- | --- |
| 1 | empty glass, finger placed after `PLACE FINGER` | enrolled, only ADD commands in the session |
| 2 | **the reported bug**: finger already on the glass **and** a leftover template under the ID | enrolled anyway; the device asked for a lift first |
| 3 | unclear image on a later capture | recovered, still only ADD commands |
| 4 | nobody comes to the scanner | `ENROLL_NO_FINGER`, reason says so, and it stops within the budget |
| 5 | a stray `SEARCH` breaks the session mid-way | the whole sequence is retried and finishes |
| 6 | website job end to end | `?pending` → `job_started` → mapping, with the right payloads |
| 7 | a job that fails | `job_failed` carries the reason |
| 8 | an ID that already belongs to somebody | never deleted, no ADD command sent |
| 9 | the **old** command ordering | it did violate rule 1; the new ordering does not |
| 10 | the 20x4 LCD: idle (online + offline), a long line followed by a short one, an unchanged screen, the result screen, the enrollment progress bar, a missing LCD and the retry | every row is a full 20 characters with no leftovers, nothing wraps past column 19, an unchanged row is not rewritten (no flicker), progress is text, and a device without an LCD still runs |

`scripts/verify-fingerprint-enroll.ts` and `scripts/verify-lcd-upgrade.ts` run
this suite as part of `npm test` and also check the wiring between the
firmware, the API and the admin page. The LCD guard additionally proves the
sketch no longer references Adafruit SSD1306/GFX, that it never calls the
forbidden `lcd.println()`, that `lcd.clear()` appears only in the init function,
and that the wiring documentation matches the sketch's pins.
