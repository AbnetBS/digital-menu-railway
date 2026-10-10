#!/usr/bin/env bash
# Runs BOTH host test suites for the attendance device. No hardware, no
# Arduino IDE, no network - just g++:
#
#   1. the Biovo1020A library's own UART tests
#   2. the enrollment state machine of the REAL sketch, driven against a
#      simulated FPC1020A module and a simulated website
#
# Usage:  bash hardware/fana_attendance_esp32/test/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v g++ >/dev/null 2>&1; then
  echo "g++ is required to run the device host tests" >&2
  exit 1
fi

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

echo "== Biovo1020A library host tests =="
g++ -std=c++11 -Ilibraries/Biovo1020A/test -Ilibraries/Biovo1020A/src \
  libraries/Biovo1020A/test/host_test.cpp libraries/Biovo1020A/src/Biovo1020A.cpp \
  -o "$OUT/lib_test"
"$OUT/lib_test"

echo
echo "== enrollment state machine (fana_attendance_esp32.ino, simulated sensor) =="
# -Itest/stub comes FIRST: those headers stand in for the Arduino/ESP32 ones.
g++ -std=c++17 -O0 -Itest/stub -Ilibraries/Biovo1020A/src -I. \
  -x c++ test/enroll_host_test.cpp test/globals.cpp libraries/Biovo1020A/src/Biovo1020A.cpp \
  -o "$OUT/enroll_test"
"$OUT/enroll_test" | tr -d '\000' | grep -vE '^(Scan|Enrolling|Six scans|Freeing|Slot|Leftover|Finger|A finger|Real-time|Session|Reported|Announced|Mapping|Loaded|Fingerprint enrolled|Pending)'

echo
echo "All device host tests passed."
