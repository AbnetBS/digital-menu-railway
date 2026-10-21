import { NextResponse } from "next/server";
import { db } from "@/db";
import { attendanceRoleShifts, siteSettings } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { deviceAllowed } from "@/lib/attendance-device";
import { markRestWakeRequested, readRestWakeHint } from "@/lib/attendance-rest";
import { publish, CHANNELS } from "@/lib/realtime";
import { asc, eq } from "drizzle-orm";
import {
  REST_MAX_WINDOWS,
  clockLabelOfMinute,
  isAwakeAt,
  roleShiftsToScannerSchedule,
  minuteOfDayET,
  minutesUntilChange,
  parseRestOverride,
} from "@/lib/attendance";

/**
 * Scanner hours are derived from every configured Role & Time shift: open one
 * hour before its start and one hour after its end, merging overlaps. The same
 * result is returned to the admin panel and the ESP32, which caches it for
 * offline use. Role edits publish an immediate refresh to an awake board and
 * request a quick follow-up check; a board already in deep sleep reads the new
 * schedule at its next timer wake (up to the normal ten-minute slice).
 *
 * The only Activity-panel writes left are temporary "keep awake" overrides.
 * The tablet PIN path, paper sheet and admin page are not gated by scanner rest.
 */

async function readOverride(): Promise<string> {
  const rows = await db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, "attendance_rest_override"))
    .limit(1);
  return rows[0]?.value ?? "schedule";
}

async function writeOverride(value: string): Promise<void> {
  await db
    .insert(siteSettings)
    .values({ key: "attendance_rest_override", value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: new Date() } });
}

export async function GET(request: Request) {
  const device = deviceAllowed(request);
  const auth = await requireAdmin();
  if (!device && !auth.ok) return auth.response;

  await ensureTablesExist();

  try {
    const shiftRows = await db
      .select({ startTime: attendanceRoleShifts.startTime, endTime: attendanceRoleShifts.endTime })
      .from(attendanceRoleShifts)
      .orderBy(asc(attendanceRoleShifts.sortOrder), asc(attendanceRoleShifts.id));
    const schedule = roleShiftsToScannerSchedule(shiftRows);
    const windows = schedule.windows;
    const now = new Date();
    const override = parseRestOverride(await readOverride(), now);
    const at = minuteOfDayET(now);
    const scheduleAwakeNow = isAwakeAt(windows, at);
    const awake = scheduleAwakeNow || override.mode !== "schedule";
    const untilChange = minutesUntilChange(windows, at);
    const alwaysAwake = windows.length === 0 || windows.some((w) => w.from === w.to && w.enabled !== false);
    const hint = await readRestWakeHint(now);
    const { sliceSeconds, jobWaiting, wakeRequestedAt } = hint;

    return NextResponse.json({
      windows,
      shiftCount: schedule.shiftCount,
      overflow: schedule.overflow,
      alwaysAwake,
      override,
      awakeNow: awake,
      scheduleAwakeNow,
      // This boundary is from Role & Time; an awake override may hold the door open past it.
      at: clockLabelOfMinute(at),
      changeInMinutes: untilChange,
      changeTo: scheduleAwakeNow ? "resting" : "awake",
      nextChangeLabel: clockLabelOfMinute(at + untilChange),
      maxWindows: REST_MAX_WINDOWS,
      // Maximum sleep slice the device should use after this response: 45 s
      // while an edit is fresh or a finger job waits, 600 s on a quiet night.
      // This cannot interrupt a deep-sleep timer already in progress.
      sliceSeconds,
      jobWaiting,
      wakeRequestedAt,
      // What the device caches and obeys on its own. Deliberately flat and
      // numbers-only: the ESP32 has no date parser, and its clock is the same
      // NTP clock its offline scans are stamped with. `keptAwake` is the
      // admin's "keep it awake", `wakeUntilEpoch` its "for N minutes" version,
      // `sliceSeconds` the longest sleep it may take in one go right now.
      device: {
        windows: windows.map((w) => ({ from: w.from, to: w.to, enabled: w.enabled !== false })),
        keptAwake: override.mode === "awake",
        wakeUntilEpoch:
          override.mode === "awake_until" ? Math.floor(new Date(override.untilAt).getTime() / 1000) : 0,
        sliceSeconds,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  await ensureTablesExist();

  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body.action ?? "");
    if (action !== "override") {
      return NextResponse.json(
        { error: "Scanner hours are automatic now. Edit the shifts under Attendance → Role & Time." },
        { status: 409 }
      );
    }
    const mode = String(body.mode ?? "");
    if (mode !== "awake" && mode !== "minutes" && mode !== "schedule") {
      return NextResponse.json({ error: "What should the scanner do?" }, { status: 400 });
    }

    // The override itself changes what the device will do, so ask a resting
    // board to check its next schedule slice sooner.
    await markRestWakeRequested();
    if (mode === "awake") {
      await writeOverride("awake");
    } else if (mode === "minutes") {
      const minutes = Math.max(1, Math.min(24 * 60, Number(body.minutes) || 15));
      const until = new Date(Date.now() + minutes * 60000).toISOString();
      await writeOverride(`awake_until=${until}`);
    } else {
      await writeOverride("schedule");
    }

    publish(CHANNELS.device);
    return NextResponse.json({
      success: true,
      override: await readOverride(),
      message:
        mode === "schedule"
          ? "The rest schedule rules again"
          : mode === "minutes"
            ? `Awake for ${body.minutes || 15} minutes, then resting again`
            : "The scanner stays awake until you turn this off",
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
