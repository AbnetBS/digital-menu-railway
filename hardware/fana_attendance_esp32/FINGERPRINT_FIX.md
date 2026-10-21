# Legacy FPC/Biovo diagnostic note

The production attendance reader has migrated to the **R307**. The previous
FPC1020A/Biovo1020A protocol, 19200-baud instructions, voltage diagnosis, and
host packet emulator are obsolete and must not be used on the production unit.

Use [`README.md`](README.md) for the current R307 wiring, required Adafruit
Fingerprint Sensor Library, 57600-baud setup, enrollment workflow, Serial
commands, and diagnostics.

Important migration facts:

- FPC templates cannot be copied into the R307. Re-enroll each employee.
- Existing website employees and attendance history remain intact.
- Verify the exact seller-provided connector pinout; R307 wire colours vary.
- Use the module's specified supply (commonly regulated 5 V), common ground,
  and crossed UART TX/RX.
