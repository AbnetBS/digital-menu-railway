#!/usr/bin/env tsx
/**
 * Regression guard for the 20x4 I2C LCD upgrade (and the transistor-driven
 * buzzer that came with it).
 *
 * The device used to drive a 128x64 Adafruit SSD1306 OLED. It now drives a
 * "2004" 20x4 character LCD through a BSS138 level shifter, using the hd44780
 * library, which finds the backpack's I2C address by itself - the sketch must
 * not assume one.
 *
 * What this checks:
 *   A. the sketch really is converted: hd44780 only, no Adafruit, no
 *      `lcd.println()` (the library makes that a compile error), clear() only
 *      in the init function, the four display functions rewritten for 20x4,
 *   B. the buzzer stayed on GPIO23 and did not grow a connection to the LCD,
 *   C. the enrollment flow still sends the sensor NOTHING but its six ADD
 *      commands (the display code must not talk to the sensor or the network),
 *   D. the wiring documentation and the host-test stubs match the sketch,
 *   E. the compiled host test still proves the 20x4 behaviour on a simulated
 *      LCD.
 *
 * Run with: npx tsx scripts/verify-lcd-upgrade.ts
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

let failures = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
  if (!cond) failures++;
};

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel: string) => existsSync(path.join(ROOT, rel));

const rawFirmware = read("hardware/fana_attendance_esp32/fana_attendance_esp32.ino");
/* Comments are prose, not code: drop them before counting calls. */
const firmware = rawFirmware.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const readme = read("hardware/fana_attendance_esp32/README.md");
const testReadme = read("hardware/fana_attendance_esp32/test/README.md");
const lcdStub = read("hardware/fana_attendance_esp32/test/stub/hd44780.h");

/* ── A. the sketch is converted to the 20x4 LCD ───────────────────────────── */

pass(
  "the sketch includes Wire plus the hd44780 library and its I2Cexp i/o class",
  firmware.includes("#include <Wire.h>") &&
    firmware.includes("#include <hd44780.h>") &&
    firmware.includes("#include <hd44780ioClass/hd44780_I2Cexp.h>")
);
pass(
  "the Adafruit OLED library is gone from the sketch",
  !firmware.includes("Adafruit_SSD1306") &&
    !firmware.includes("Adafruit_GFX") &&
    !firmware.includes("SSD1306_WHITE") &&
    !firmware.includes("display.begin(")
);
pass(
  "the display is a 20x4 LCD",
  /#define LCD_COLS\s+20/.test(firmware) && /#define LCD_ROWS\s+4/.test(firmware) &&
    firmware.includes("lcd.begin(LCD_COLS, LCD_ROWS)")
);
pass(
  "the I2C address is found, not assumed (auto-locate object, address only optional)",
  firmware.includes("hd44780_I2Cexp lcd;") &&
    rawFirmware.includes("// #define LCD_I2C_ADDRESS 0x27") &&
    firmware.includes("#ifdef LCD_I2C_ADDRESS") &&
    firmware.includes("lcd.getProp(hd44780_I2Cexp::Prop_addr)")
);
pass(
  "the forbidden lcd.println() is never used (hd44780 makes it a compile error)",
  !/\blcd\.println\(/.test(firmware) && /\blcd\.print\(/.test(firmware)
);
pass(
  "the screen is cleared once (init) - updates do not flicker",
  (firmware.match(/\blcd\.clear\(\)/g) || []).length === 1 &&
    firmware.includes("bool startLcd()") &&
    firmware.indexOf("lcd.clear()") > firmware.indexOf("int status = lcd.begin(")
);
pass(
  "the four display functions are rewritten for 20 characters",
  ["void showLines(", "void showBig(", "void showEnrollScreen(", "void showIdleScreen("].every((f) =>
    firmware.includes(f)
  ) &&
    (firmware.match(/lcdWriteRow\(/g) || []).length >= 8 &&
    firmware.includes("static String lcdFit(const String &text, uint8_t width)") &&
    firmware.includes("static String lcdCenter(const String &text, uint8_t width)")
);
pass(
  "the old 128x64 progress rectangle became a text bar",
  !firmware.includes("fillRect(") &&
    firmware.includes("bar += (i < done ? '#' : '.')") &&
    firmware.includes('" [" + bar + "] "')
);
pass(
  "every printed row is padded to the 20 characters of the glass",
  /static void lcdWriteRow\(uint8_t row, const String &text\)[\s\S]{0,220}lcdFit\(text, LCD_COLS\)/.test(
    firmware
  ) &&
    firmware.includes("if (fitted == String(lcdShown[row])) return;") &&
    firmware.includes("lcdShown[row][LCD_COLS] = '\\0';")
);
pass(
  "the LCD is retried when it is missing, but never during an enrollment",
  firmware.includes("void checkLcdHealth()") &&
    firmware.includes("if (lcdReady || enrollmentActive) return;") &&
    firmware.includes("EnrollmentGuard enrollmentGuard;")
);
pass(
  "the sketch tells the operator which address was found, on the Serial Monitor",
  firmware.includes('"20x4 LCD ready, backpack found at I2C address 0x"') &&
    firmware.includes('"Run diagnostics/lcd_check/lcd_check.ino to see the I2C addresses."')
);
pass(
  "the address-discovery sketch exists and really scans the bus first",
  exists("hardware/fana_attendance_esp32/diagnostics/lcd_check/lcd_check.ino") &&
    read("hardware/fana_attendance_esp32/diagnostics/lcd_check/lcd_check.ino").includes(
      "for (uint8_t addr = 0x03; addr <= 0x77; addr++)"
    )
);

/* ── B. the buzzer: same pin, on a transistor, not the shifter ────────────── */

pass(
  "the buzzer stays on GPIO23 and the beeps are unchanged by default",
  /#define BUZZER_PIN\s+23/.test(firmware) &&
    firmware.includes("digitalWrite(BUZZER_PIN, HIGH);") &&
    firmware.includes("digitalWrite(BUZZER_PIN, LOW);")
);
pass(
  "a PASSIVE buzzer is a documented one-line switch, not a silent break",
  rawFirmware.includes("// #define BUZZER_IS_PASSIVE 1") &&
    /#ifdef BUZZER_IS_PASSIVE[\s\S]{0,120}tone\(BUZZER_PIN/.test(firmware)
);
pass(
  "the buzzer never moved onto the LCD pins or the level shifter",
  !firmware.includes("BUZZER_PIN 21") && !firmware.includes("BUZZER_PIN 22") &&
    readme.includes("The level shifter is NOT\nthe buzzer driver")
);
pass(
  "the buzzer is documented as a transistor driver with its protection diode",
  readme.includes("2N2222 base") && readme.includes("10 kohm") &&
    readme.includes("STRIPED end to +5 V") && readme.includes("collector")
);

/* ── C. the enrollment rule survives the display change ───────────────────── */

const captureSession = firmware.slice(
  firmware.indexOf("EnrollResult runCaptureSession("),
  firmware.indexOf("EnrollResult enrollFingerprint(")
);
pass(
  "between the six captures the display code sends the sensor nothing",
  !/finger\.(?!enroll|getLastStatus)/.test(captureSession) &&
    !captureSession.includes("getCount(") &&
    !/\bhttp\b/i.test(captureSession)
);
pass(
  "the six-capture order and the prompts the simulated person needs are intact",
  firmware.includes("const uint8_t captureSteps[6] = {1, 2, 2, 2, 2, 3}") &&
    firmware.includes("finger.enroll((uint16_t)id, captureSteps[cap]") &&
    firmware.includes('"LIFT YOUR FINGER"') &&
    firmware.includes('"PLACE FINGER"') &&
    firmware.includes('"KEEP STILL"') &&
    firmware.includes('"LIFT, PLACE AGAIN"')
);
const displayCalls = [...firmware.matchAll(/show(?:Lines|Big|EnrollScreen)\(([\s\S]*?)\);/g)].map(
  (m) => m[1]
);
const longDisplayLiterals = displayCalls
  .flatMap((args) => args.match(/"[^"\n]*"/g) || [])
  .filter((lit) => lit.length - 2 > 20);
pass(
  "every literal handed to the LCD fits 20 characters",
  displayCalls.length > 20 && longDisplayLiterals.length === 0,
  `too long: ${longDisplayLiterals.join(", ")}`
);
pass(
  "the screen still fits 4 rows with the prompts the guards expect",
  displayCalls.some((args) => args.includes('"LIFT YOUR FINGER"')) &&
    displayCalls.some((args) => args.includes('"PLACE FINGER"')) &&
    displayCalls.some((args) => args.includes('"HOLD STILL"'))
);

/* ── D. the host-test stubs and the docs match ────────────────────────────── */

pass(
  "the hd44780 stub replaces the OLED stubs",
  exists("hardware/fana_attendance_esp32/test/stub/hd44780.h") &&
    exists("hardware/fana_attendance_esp32/test/stub/hd44780ioClass/hd44780_I2Cexp.h") &&
    !exists("hardware/fana_attendance_esp32/test/stub/Adafruit_SSD1306.h") &&
    !exists("hardware/fana_attendance_esp32/test/stub/Adafruit_GFX.h")
);
pass(
  "the stub models the real library's 20x4 glass and its no-println rule",
  lcdStub.includes("#define LCD_STUB_COLS 20") &&
    lcdStub.includes("#define LCD_STUB_ROWS 4") &&
    lcdStub.includes("lcdWrapHits") &&
    lcdStub.includes("lcdShortRowWrites") &&
    lcdStub.includes("println() deliberately missing")
);
pass(
  "the test harness reads the simulated glass and the LCD counters",
  read("hardware/fana_attendance_esp32/test/enroll_host_test.cpp").includes(
    "=== 10. the 20x4 LCD"
  ) &&
    read("hardware/fana_attendance_esp32/test/globals.cpp").includes("char lcdGrid[")
);
pass(
  "the wiring documentation is the LCD build, with the shifter and the checks",
  readme.includes("20x4") &&
    !readme.includes("0.96\" OLED") &&
    readme.includes("level shifter LV") &&
    readme.includes("hd44780") &&
    readme.includes("Verify before you power up") &&
    readme.includes("NEVER wire the backpack SDA/SCL straight to the ESP32")
);
pass(
  "the host-test README documents the LCD simulation",
  testReadme.includes("hd44780") && testReadme.includes("20x4")
);
pass(
  "the level shifter and the ESP32 5 V caution are spelled out",
  readme.includes("Never wire the backpack") ||
    readme.includes("NEVER wire the backpack SDA/SCL straight to the ESP32")
);

/* ── E. the compiled host test proves the behaviour ───────────────────────── */

const testDir = path.join(ROOT, "hardware/fana_attendance_esp32/test");
if (!existsSync(path.join(testDir, "run.sh"))) {
  pass("the device host test suite exists", false, testDir);
} else {
  const hasGpp = spawnSync("g++", ["--version"]).status === 0;
  if (!hasGpp) {
    console.log("⚠️  g++ not found - the compiled LCD test was skipped");
  } else {
    const run = spawnSync("bash", [path.join(testDir, "run.sh")], { encoding: "utf8" });
    const out = `${run.stdout || ""}${run.stderr || ""}`;
    pass(
      "the compiled sketch passes on a simulated 20x4 LCD",
      run.status === 0 && (out.match(/^FAIL /gm) || []).length === 0,
      out.split("\n").filter((l) => l.startsWith("FAIL") || l.includes("error:")).slice(0, 6).join("\n")
    );
    pass(
      "every row really is a full 20 characters with no leftovers",
      out.includes("PASS a shorter line leaves no leftovers from a longer one") &&
        out.includes("PASS the shorter line filled its row completely (no leftovers)") &&
        out.includes("PASS and no row was ever left half-written")
    );
    pass(
      "nothing ever wraps past column 19",
      out.includes("PASS no row ran past column 19") &&
        out.includes("PASS no row ever ran past column 19 in any screen")
    );
    pass(
      "the screen is not redrawn while it is unchanged (no flicker)",
      out.includes("PASS an unchanged screen is not redrawn (no flicker)") &&
        out.includes("PASS the screen was never cleared during enrollment (no flicker)")
    );
    pass(
      "the enrollment progress is text and the idle/offline lines survived",
      out.includes("PASS the enrollment screen shows the ID and the six-cell text bar") &&
        out.includes("PASS the bar is followed by the accepted-scan count") &&
        out.includes("PASS offline is still reported on the LCD") &&
        out.includes("PASS a dead sensor is still reported on the LCD")
    );
    pass(
      "a device with no LCD still runs, and the retry finds it again",
      out.includes("PASS without an LCD nothing is written and nothing crashes") &&
        out.includes("PASS a later retry finds the LCD again")
    );
  }
}

if (failures > 0) {
  console.error(`\n❌ LCD UPGRADE GUARD FAILED (${failures})\n`);
  process.exit(1);
}
console.log("\n✅ LCD upgrade guard PASSED");
console.log("   • the sketch drives a 20x4 I2C LCD through the hd44780 library");
console.log("   • the address is found at run time, never assumed");
console.log("   • every row is 20 characters, updates do not flicker, progress is text");
console.log("   • the fingerprint flow and the GPIO23 buzzer are untouched");
