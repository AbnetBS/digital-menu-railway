# Biovo1020A (PATCHED copy for FANA CAFE attendance)

Patched copy of https://github.com/nahomyirga787-spec/Biovo1020A for the
FPC1020A fingerprint sensor used by `../fana_attendance_esp32.ino`.

## Install (replaces the GitHub version)

1. Close Arduino IDE.
2. Delete the old library folder `Documents/Arduino/libraries/Biovo1020A`.
3. Copy THIS folder (`hardware/fana_attendance_esp32/libraries/Biovo1020A`)
   to `Documents/Arduino/libraries/Biovo1020A`.
4. Reopen Arduino IDE and upload the sketch.

## What was fixed vs the GitHub v1.0.1

1. **Stale replies no longer poison commands (the "status = 6" bug).**
   The sketch polls the sensor with SEARCH about once per second. When an
   enrollment starts, a late SEARCH reply can still be in the UART buffer.
   The original `sendCommand()` read the first 8 incoming bytes blindly, so
   it could read that stale SEARCH reply, fail validation, and report a
   stale status byte - making enrollment fail with a confusing
   `status = 6` even though the sensor was fine. The patched `sendCommand()`
   re-syncs on the `0xF5` frame head, checks the echoed command byte, and
   discards frames that do not belong to the command just sent.
2. **Full status-code table** (`0x05` no-user, `0x06` image-messy,
   `0x07` user-exists, `0x08` timeout, `0x0F` finger-lifted) plus internal
   codes `0xFE` (garbled/wrong-command reply) and `0xFF` (no reply).
3. **`drain()`** - flush the UART and wait for a quiet line before
   enrollment, so no half-finished scan interferes.
4. **`statusText()`** - human-readable status strings for Serial/OLED.
5. Absolute frame deadline + `delay(1)` yield in the receive loop, so a dead
   sensor cannot busy-spin the ESP32 task for the whole timeout.

The public API is unchanged - existing sketches keep compiling.

## Tests (no hardware needed)

Host-side unit tests run on a PC with g++:

```
cd test
g++ -std=c++11 -I. -I../src host_test.cpp ../src/Biovo1020A.cpp -o host_test
./host_test
```

15 tests, all passing - including the stale-reply scenario that caused
"enroll failed, status = 6" on the attendance device.
