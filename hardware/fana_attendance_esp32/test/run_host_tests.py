#!/usr/bin/env python3
"""Compile the R307 transport and the real sketch's enrollment flow on a host.

These tests emulate the UART, clock, LCD and website. They cannot validate a
physical reader's optics, flash, power, wiring, or actual matching performance.
"""
from pathlib import Path
import re
import subprocess
import tempfile

here = Path(__file__).resolve().parent
sketch = (here.parent / "fana_attendance_esp32.ino").read_text(encoding="utf-8")
constants = "\n".join(
    line for line in sketch.splitlines()
    if re.match(r"#define (?:ENROLL_|BIOVO_ACK_)", line)
)
enum_match = re.search(r"enum EnrollResult\s*:\s*uint8_t\s*\{.*?\n\};", sketch, re.S)
assert enum_match, "EnrollResult not found"
start = sketch.index("int searchGlass(uint16_t &matchedId, uint32_t waitMs) {")
end = sketch.index('// Serial "enroll <id>": store', start)
flow = sketch[start:end]
test = (here / "enrollment_flow_test.cpp").read_text(encoding="utf-8")
test = test.replace("// -- CONSTANTS FROM THE REAL SKETCH --", constants + "\n" + enum_match.group())
test = test.replace("// -- INSERT REAL FIRMWARE HERE --", flow)

with tempfile.TemporaryDirectory(prefix="fana-r307-test-") as temp:
    temp = Path(temp)
    generated = temp / "enrollment_flow_test.cpp"
    generated.write_text(test, encoding="utf-8")
    for source, name, stub in [
        (here / "r307_transport_test.cpp", "transport", "stub"),
        (generated, "enrollment", "stub"),
        (here / "offline_queue_test.cpp", "offline-queue", "queue_stub"),
    ]:
        exe = temp / name
        subprocess.run([
            "g++", "-std=c++11", "-Wall", "-Wextra", "-Werror", "-pthread",
            "-I", str(here / stub), str(source), "-o", str(exe),
        ], check=True)
        subprocess.run([str(exe)], check=True)
