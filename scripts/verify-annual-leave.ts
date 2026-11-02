#!/usr/bin/env tsx
/**
 * YE AMET EREFT GUARD (owner, Oct 2026).
 *
 * The owner's rule: "Ye amet ereft" is yearly leave given as a run of days,
 * from one date to another, because the run and the number of days differ per
 * person. Those days must never be written absent, and the salary stays safe
 * as if the person worked. The repeating free weekday and the single free date
 * stay as they were, and a free weekday that is worked is still Free Week
 * overtime.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ANNUAL_LEAVE_MAX_DAYS,
  FREE_SCHEDULE_TYPES,
  isAnnualLeaveDate,
  isFreeDate,
  isWorkedFreeDay,
  leaveDays,
  ruleCoversDay,
  type FreeScheduleRule,
} from "../src/lib/free-schedule";

let failures = 0;
const pass = (name: string, ok: boolean) => {
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (!ok) failures++;
};

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const freeApi = read("src/app/api/attendance/free/route.ts");
const payrollApi = read("src/app/api/payroll/route.ts");
const dialog = read("src/components/rms/FreeScheduleDialog.tsx");
const migrate = read("src/db/migrate.ts");
const schema = read("src/db/schema.ts");

/* ── 1. the three kinds of free day ──────────────────────────────────────── */

pass("there are exactly three kinds: every week, one date, ye amet ereft", FREE_SCHEDULE_TYPES.join(",") === "weekly,dated,annual");

const weekly: FreeScheduleRule = { scheduleType: "weekly", weekday: 0, freeDate: null, freeUntil: null };
const dated: FreeScheduleRule = { scheduleType: "dated", weekday: null, freeDate: "2026-10-15", freeUntil: null };
const leave: FreeScheduleRule = { scheduleType: "annual", weekday: null, freeDate: "2026-01-01", freeUntil: "2026-01-14" };

pass("a repeating free weekday still repeats", ruleCoversDay(weekly, "2026-10-11") && ruleCoversDay(weekly, "2026-10-18") && !ruleCoversDay(weekly, "2026-10-12"));
pass("a single free date is that date only", ruleCoversDay(dated, "2026-10-15") && !ruleCoversDay(dated, "2026-10-16"));
pass("ye amet ereft covers every day from the first to the last, both ends counted", ruleCoversDay(leave, "2026-01-01") && ruleCoversDay(leave, "2026-01-07") && ruleCoversDay(leave, "2026-01-14"));
pass("and nothing before it or after it", !ruleCoversDay(leave, "2025-12-31") && !ruleCoversDay(leave, "2026-01-15"));
pass("a leave of one single day is legal", ruleCoversDay({ scheduleType: "annual", weekday: null, freeDate: "2026-02-02", freeUntil: "2026-02-02" }, "2026-02-02"));
pass("a broken range covers nothing instead of covering the whole year", !ruleCoversDay({ scheduleType: "annual", weekday: null, freeDate: "2026-02-10", freeUntil: "2026-02-01" }, "2026-02-05") && !ruleCoversDay({ scheduleType: "annual", weekday: null, freeDate: null, freeUntil: null }, "2026-02-05"));

const all = [weekly, dated, leave];
pass("any of the three makes the day free (so it is never an absence)", isFreeDate(all, "2026-10-11") && isFreeDate(all, "2026-10-15") && isFreeDate(all, "2026-01-07"));
pass("only ye amet ereft is leave", isAnnualLeaveDate(all, "2026-01-07") && !isAnnualLeaveDate(all, "2026-10-11") && !isAnnualLeaveDate(all, "2026-10-15"));
pass(
  "a free weekday or a free date still earns Free Week overtime when worked",
  isWorkedFreeDay(all, "2026-10-11") && isWorkedFreeDay(all, "2026-10-15")
);
pass(
  "a ye amet ereft day never becomes Free Week overtime, because it is already paid",
  !isWorkedFreeDay(all, "2026-01-07")
);

/* ── 2. counting the days of the run ─────────────────────────────────────── */

pass("14 days, both ends counted", leaveDays("2026-01-01", "2026-01-14") === 14);
pass("one day", leaveDays("2026-02-02", "2026-02-02") === 1);
pass("a backwards range is zero, never negative", leaveDays("2026-02-10", "2026-02-01") === 0);
pass("empty dates count nothing", leaveDays(null, "2026-02-01") === 0 && leaveDays("2026-02-01", null) === 0);
pass("a whole year is allowed and one day more is not", ANNUAL_LEAVE_MAX_DAYS === 366 && leaveDays("2026-01-01", "2027-01-01") === 366);

/* ── 3. the API stores the run ───────────────────────────────────────────── */

pass("the API accepts the third kind", freeApi.includes("FREE_SCHEDULE_TYPES") && freeApi.includes("scheduleType === \"annual\""));
pass("it reads a first and a last Ethiopian date", freeApi.includes("freeUntilInput") && freeApi.includes("ethiopianDateToGregorian(freeUntilInput || freeDateInput)"));
pass("it refuses a last day before the first", freeApi.includes("The last day of the leave cannot be before the first day"));
pass("it caps one entry at a year", freeApi.includes("ANNUAL_LEAVE_MAX_DAYS"));
pass("it stores the last day of the run", freeApi.includes("freeUntil: scheduleType === \"annual\" ? freeUntil : null"));
pass("ye amet ereft is whole days, not hours", freeApi.includes('startTime: scheduleType === "annual" ? "00:00" : startTime') && freeApi.includes('endTime: scheduleType === "annual" ? "23:59" : endTime'));
pass("the list gives back the Ethiopian dates and the number of days", freeApi.includes("freeUntilEc") && freeApi.includes("days:"));

/* ── 4. the database keeps the last day ──────────────────────────────────── */

pass("the table has a free_until column", migrate.includes("free_until varchar(10)"));
pass("an existing database gains it without a manual step", migrate.includes("attendance_free_schedules: {") && migrate.includes("free_until: { type: \"text\" }"));
pass("the drizzle schema declares it", schema.includes('freeUntil: varchar("free_until"'));
pass("the schema version moved, so a live database self-heals", (/SCHEMA_VERSION = "(\d{4}-\d{2}-\d{2}-\d+)"/.exec(migrate)?.[1] ?? "") >= "2026-10-24-1");

/* ── 5. the payroll honours the run ──────────────────────────────────────── */

pass("the payroll uses the shared free-day rules", payrollApi.includes('from "@/lib/free-schedule"') && payrollApi.includes("isFreeDate(freeSchedules, date)"));
pass("no absence is taken on a free day of any kind", payrollApi.includes("!isFree(d)"));
pass("only registered holiday dates auto-generate overtime in payroll, so neither ye amet ereft nor free days auto-add Free Week OT", !payrollApi.includes("isWorkedFree") && payrollApi.includes("const holiday = holidayByDate.get(date)"));
pass(
  "the old inline weekday test is gone, because it would read a leave row as Sunday",
  !payrollApi.includes('f.schedule_type === "dated" ? f.free_date === date : Number(f.weekday)')
);

/* ── 6. the screen asks from and to ──────────────────────────────────────── */

pass("the three kinds are buttons, not a hidden list", dialog.includes('title: "Every week"') && dialog.includes('title: "One date"') && dialog.includes('title: "Ye amet ereft"'));
pass("ye amet ereft asks for a first and a last date", dialog.includes("Ye amet ereft from (E.C.)") && dialog.includes("Until (E.C.)"));
pass("it says how many days the run will pay", dialog.includes("will be paid as if he worked"));
pass("the note is optional", dialog.includes("Note (optional)"));
pass("the button adds it", dialog.includes('"Add ye amet ereft"'));
pass("the list shows the run and its length", dialog.includes("Ye amet ereft • ${from} to ${to} E.C.") && dialog.includes("PAID, NOT ABSENT"));
pass("a backwards run is stopped before it is sent", dialog.includes("The last day of the leave cannot be before the first day."));
pass("the free schedule still explains that free dates are not absences", dialog.includes("Free dates are not counted as absences."));

console.log("");
if (failures > 0) {
  console.error(`\n❌ YE AMET EREFT GUARD FAILED (${failures})\n`);
  process.exit(1);
}
console.log("✅ Ye amet ereft guard PASSED");
console.log("   • every week, one date, and a from-to leave run");
console.log("   • leave days are never absences and are paid as if worked");
console.log("   • a worked free weekday is still Free Week overtime, a leave day is not");
