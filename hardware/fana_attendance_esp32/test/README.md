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
defines the objects they declare. The simulated module in `enroll_host_test.cpp`
follows the protocol as this repository documents it:

- `ADD_1` / `ADD_2` x4 / `ADD_3` store a finger, and a step sent out of order
  answers **status 1** (command failed).
- **Rule 1:** once an ADD command has gone out, a non-ADD command inside the
  same session breaks it — every violation is counted in
  `mod.nonAddInsideSession` so a test can prove the sketch never commits one.
- `ADD_1` on an ID that already holds a template answers **status 7**,
  an empty glass answers **status 8**, and injected unclear images answer
  **status 6**.
- A simulated person reads the OLED and does what it asks, 800 ms later: lifts
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

`scripts/verify-fingerprint-enroll.ts` runs this suite as part of `npm test`
and also checks the wiring between the firmware, the API and the admin page.
