# R307 firmware regression tests

The former native harness emulated the proprietary FPC/Biovo packet protocol and
was removed during the R307 migration. It could not exercise the Adafruit
Fingerprint packet engine and would give false confidence.

R307 production integration is guarded by:

- `scripts/verify-fingerprint-enroll.ts` — adapter operations, two-capture model
  creation, two confirmation placements, capacity, mappings, deletion and erase.
- `scripts/verify-sensor-link.ts` — 57600 UART configuration, reader health,
  watchdog recovery, diagnostics and wiring documentation.
- `scripts/verify-attendance-listing.ts` — complete website enrollment and
  attendance workflow integration.

Run these with `npm test`. Final acceptance still requires uploading the sketch
to the ESP32 and testing against the physical R307 because a host mock cannot
validate optical capture or the sensor's matching engine.
