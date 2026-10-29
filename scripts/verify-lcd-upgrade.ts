#!/usr/bin/env tsx
/** Production LCD regression guard, independent of the retired FPC host emulator. */
import { readFileSync } from "node:fs";import path from "node:path";
const fw=readFileSync(path.resolve(__dirname,"../hardware/fana_attendance_esp32/fana_attendance_esp32.ino"),"utf8");let failed=0;
const check=(n:string,o:boolean)=>{console.log(`${o?"✅":"❌"} ${n}`);if(!o)failed++;};
check("20x4 hd44780 I2C LCD remains configured",fw.includes("hd44780_I2Cexp lcd")&&fw.includes("#define LCD_COLS      20")&&fw.includes("#define LCD_ROWS      4"));
check("LCD initialization diagnoses wiring failure",fw.includes("lcd.begin(LCD_COLS, LCD_ROWS)")&&fw.includes("20x4 LCD not found"));
check("row writer pads and bounds visible text",fw.includes("void lcdWriteRow")&&fw.includes("LCD_COLS"));
check("idle screen reports reader and network state",fw.includes("void showIdleScreen")&&fw.includes("SENSOR OFFLINE!")&&fw.includes("WiFi:"));
check("matches carry sensor confidence into the attendance flow",fw.includes("uint8_t permission")&&fw.includes("finger.search(matchedId, permission"));
check("unknown fingers remain clear",fw.includes("showSensorWarning")&&fw.includes("NOT REGISTERED")&&fw.includes("Finger not enrolled"));
check("enrollment screen displays placement progress",fw.includes("void showEnrollScreen")&&fw.includes("ENROLL_SCANS")&&fw.includes("PLACE FINGER")&&fw.includes("LIFT YOUR FINGER"));
check("successful and failed enrollment results are visible",fw.includes('showBig(memberName, "ADDED"')&&fw.includes('showLines("ENROLL FAILED",')&&fw.includes('"Reader saw nothing"')&&fw.includes("enrollReason(result)"));
check("attendance answer screen remains available",fw.includes("void showClockAnswer")&&fw.includes("void showRefused"));
check("sensor recovery provides actionable wiring text",fw.includes("power + common GND")&&fw.includes("wiring TX/RX"));
if(failed){console.error(`\n❌ LCD guard failed (${failed})`);process.exit(1)}console.log("\n✅ LCD guard passed");
