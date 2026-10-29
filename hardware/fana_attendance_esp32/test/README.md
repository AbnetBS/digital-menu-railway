# R307 firmware regression tests

Run `npm run test:firmware` (Python 3 and `g++` required). These host tests:

- Exercise the production `R307Compat.h` with a simulated serial reader: delayed and corrupt replies, timeouts, full-capacity search, image quality, capture, matching, optional LED commands and late-reader recovery.
- Compile the **actual enrollment functions extracted from the `.ino`** with mocked hardware: fresh lifts, two captures, exact-ID confirmation, errors and protection of mapped slots.
- Compile the actual `OfflineQueue.h` with an in-memory filesystem and mutexes: FIFO order, legacy CRLF records, a stalled sender concurrent with a new scan, retry after a failed cursor write, reboot, torn files, durable clock anchors and retention for manual review.

The former native harness emulated the old FPC/Biovo reader; it was replaced by these R307 tests. The filesystem and serial devices here are test doubles: they do not prove real flash durability, LEDs, fingerprint quality, power, wiring, Wi-Fi or NTP behavior.

The full sketch also compiled locally for **ESP32 Dev Module** using Arduino core 2.0.17, WiFiManager 2.0.17, ArduinoJson 6.21.5, Adafruit Fingerprint 2.1.3 and hd44780 1.3.2 (1,143,533 bytes, or 87% of the default 1,310,720-byte app partition; 49,088 bytes of static RAM). A compile is not a physical test. Keep `OfflineQueue.h` and `R307Compat.h` with the `.ino`, deploy the server first, preserve LittleFS during upload, and validate the complete system on the installed hardware.

For server behavior, a disposable PostgreSQL instance can run `TEST_DATABASE_URL=postgresql://... npm run test:attendance-postgres`. It creates and drops a uniquely named test database; never use production. The test exercises original times, concurrent retries, authentication, conflicts and atomic overtime rollback through the real route.
