#!/usr/bin/env tsx
/**
 * Static checks for the TIN payroll Delete / From attendance pair (owner,
 * 2026-11-14) and the removed scan-confirmation banner.
 *   - Delete takes a person off the TIN payroll for every month (the removal
 *     table is not per month) and never touches attendance.
 *   - From attendance lists people not on this month's TIN sheet and adds back.
 *   - The attendance screen no longer asks for scan confirmation.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const migrate = read("src/db/migrate.ts");
const payrollRoute = read("src/app/api/payroll/route.ts");
const payrollTab = read("src/components/rms/PayrollTab.tsx");
const attendanceTab = read("src/components/rms/AttendanceTab.tsx");

// Removal table exists and is global (no period key).
assert.match(migrate, /CREATE TABLE IF NOT EXISTS payroll_removed_members \(\s*member_id integer PRIMARY KEY/);

// Payroll rows skip removed people; attendance is not written by these actions.
assert.match(payrollRoute, /!removedIds\.has\(Number\(member\.id\)\)/);
const removeBlock = payrollRoute.slice(payrollRoute.indexOf('action === "remove_member"'), payrollRoute.indexOf('action === "save_compensation"'));
assert.match(removeBlock, /INSERT INTO payroll_removed_members/);
assert.doesNotMatch(removeBlock, /attendance_members|attendance_logs/, "Delete must not change attendance");
assert.match(removeBlock, /isPaid\(period, id\)/, "a paid person cannot be removed this month");
const restoreBlock = payrollRoute.slice(payrollRoute.indexOf('action === "restore_member"'), payrollRoute.indexOf('action === "save_compensation"'));
assert.match(restoreBlock, /DELETE FROM payroll_removed_members/);
assert.match(restoreBlock, /DELETE FROM cash_payroll_entries/, "restoring a cash person must not pay him twice");

// UI: Delete beside Pay, From attendance beside New person.
assert.match(payrollTab, /action: "remove_member"/);
assert.match(payrollTab, /action: "restore_member"/);
assert.match(payrollTab, />\s*Delete\s*<\/button>|<Trash2 className="w-4 h-4" \/> Delete/);
assert.match(payrollTab, /From attendance/);

// The scan-confirmation banner is gone: registration is automatic.
assert.doesNotMatch(attendanceTab, /Waiting for Confirmation/);
assert.doesNotMatch(attendanceTab, /Confirm on Sheet/);

console.log("✅ TIN payroll Delete / From attendance and automatic scan listing checks PASSED");
