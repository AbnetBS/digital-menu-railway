#!/usr/bin/env bash
# PC tests for the attendance device. No hardware needed.
#  1. Biovo1020A library unit tests (unchanged library)
#  2. The full sketch compiled against ArduinoJson v6 AND v7, then every
#     cafe scenario run in its own process on a simulated FPC1020A.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SKETCH_DIR="$(dirname "$HERE")"
LIB="$SKETCH_DIR/libraries/Biovo1020A"
DEPS="${TMPDIR:-/tmp}/fana-attendance-test-deps"
OUT="${TMPDIR:-/tmp}/fana-attendance-test-build"
mkdir -p "$DEPS" "$OUT"

echo "== Biovo1020A library tests"
g++ -std=c++11 -I"$LIB/test" -I"$LIB/src" "$LIB/test/host_test.cpp" "$LIB/src/Biovo1020A.cpp" -o "$OUT/lib_test"
"$OUT/lib_test" | tail -1

fail=0
for ver in v6.21.5 v7.4.2; do
  if [ ! -d "$DEPS/ArduinoJson-$ver" ]; then
    git clone -q --depth 1 --branch "$ver" https://github.com/bblanchon/ArduinoJson.git "$DEPS/ArduinoJson-$ver" 2>/dev/null
  fi
  echo "== Sketch + ArduinoJson $ver"
  g++ -std=c++17 -x c++ -Wall -Wextra -Wno-unused-parameter -Wno-deprecated-declarations \
    -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 -DARDUINOJSON_ENABLE_ARDUINO_STREAM=0 \
    -DARDUINOJSON_ENABLE_ARDUINO_PRINT=0 -DARDUINOJSON_ENABLE_PROGMEM=0 \
    -I"$HERE/stubs" -I"$LIB/src" -I"$DEPS/ArduinoJson-$ver/src" \
    "$HERE/device_sim_test.cpp" -x c++ "$LIB/src/Biovo1020A.cpp" -o "$OUT/sim_$ver"
  for s in $("$OUT/sim_$ver" --list); do
    if ! "$OUT/sim_$ver" "$s"; then fail=1; fi
  done
done
if [ "$fail" = 0 ]; then echo "ALL DEVICE TESTS PASSED"; else echo "SOME DEVICE TESTS FAILED"; exit 1; fi
