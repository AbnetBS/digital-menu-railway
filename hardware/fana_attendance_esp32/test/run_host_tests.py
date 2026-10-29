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
feedback = (here / "scan_feedback_test.cpp").read_text(encoding="utf-8")
feedback_start = sketch.index("enum DeliveryKind : uint8_t")
feedback_end = sketch.index("// END SCAN FEEDBACK STATE", feedback_start)
receipt_start = sketch.index("bool receiptMatches(")
receipt_end = sketch.index("// END RECEIPT VALIDATION", receipt_start)
feedback = feedback.replace("// -- INSERT REAL DELIVERY TYPES AND STATE --", sketch[feedback_start:feedback_end])
feedback = feedback.replace("// -- INSERT REAL RECEIPT VALIDATION --", sketch[receipt_start:receipt_end])

with tempfile.TemporaryDirectory(prefix="fana-r307-test-") as temp:
    temp = Path(temp)
    generated = temp / "enrollment_flow_test.cpp"
    generated.write_text(test, encoding="utf-8")
    feedback_generated = temp / "scan_feedback_test.cpp"
    feedback_generated.write_text(feedback, encoding="utf-8")
    for source, name, stub in [
        (here / "r307_transport_test.cpp", "transport", "stub"),
        (generated, "enrollment", "stub"),
        (here / "offline_queue_test.cpp", "offline-queue", "queue_stub"),
        (feedback_generated, "scan-feedback", "stub"),
    ]:
        exe = temp / name
        subprocess.run([
            "g++", "-std=c++11", "-Wall", "-Wextra", "-Werror", "-pthread",
            "-I", str(here / stub), str(source), "-o", str(exe),
        ], check=True)
        subprocess.run([str(exe)], check=True)

    # Run the real sender and wakeable task with fake HTTP/Wi-Fi/FreeRTOS.
    # Only transport/JSON are doubles; the queue and algorithm are the sketch's.
    offline_marker = sketch.index("/* ── Offline queue:")
    sender_start = sketch.index("bool saveToQueue(int fingerprintId", offline_marker)
    sender_end = sketch.index("void wakeDeliveryTask()", sender_start)
    wake_end = sketch.index("// NTP is preferred", sender_end)
    task_start = sketch.index("void deliveryTask(void *) {", wake_end)
    task_end = sketch.index("void periodicSync() {", task_start)
    delivery = (here / "queue_delivery_test.cpp").read_text(encoding="utf-8")
    delivery = delivery.replace("// -- INSERT REAL DELIVERY TYPES AND STATE --", sketch[feedback_start:feedback_end])
    delivery = delivery.replace("// -- INSERT REAL QUEUE SENDER AND TASK --",
                                sketch[sender_start:sender_end] + sketch[sender_end:wake_end] + sketch[task_start:task_end])
    generated = temp / "queue_delivery_test.cpp"
    generated.write_text(delivery, encoding="utf-8")
    exe = temp / "queue-delivery"
    subprocess.run([
        "g++", "-std=c++11", "-Wall", "-Wextra", "-Werror", "-pthread",
        "-I", str(here / "queue_stub"), "-I", str(here.parent), str(generated), "-o", str(exe),
    ], check=True)
    subprocess.run([str(exe)], check=True)
