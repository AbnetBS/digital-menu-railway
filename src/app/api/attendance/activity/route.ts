import { NextResponse } from "next/server";
import { db } from "@/db";
import { attendanceActiveWindows, siteSettings } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { deviceAllowed } from "@/lib/attendance-device";
import { markRestWakeRequested, readRestWakeHint } from "@/lib/attendance-rest";
import { publish, CHANNELS } from "@/lib/realtime";
import { and, asc, eq } from "drizzle-orm";
import {
  REST_MAX_WINDOWS,
  clockLabelOfMinute,
  isAwakeAt,
  minuteOfDayET,
  minutesUntilChange,
  parseRestOverride,
  type ActiveWindow,
} from "@/lib/attendance";

/**
 * THE ACTIVITY PANEL (owner, Oct 2026): the hours the door scanner is awake.
 *
 * "can i add in activity button ... the admin will add time of inactivity ...
 * when someone try to place finger by that inactivity time the system wont
 * answer ... then when the last time end it start again ... another add time
 * interval ... because the intervals arent same ... this will protect the
 * system for over using power and less the being damaged by continues power
 * supply"
 *
 * What ships, from his own reading of it: the rows he adds are the hours the
 * door is OPEN. Outside every enabled row the device puts itself to sleep, and
 * it wakes on its own when the next row starts. Each row has its own on/off,
 * which is how a person at 15:05 gets in: switch the row off, the scanner
 * lights up, switch it back on.
 *
 *   GET   the schedule, for the panel AND for the device (it caches this in
 *         flash and keeps obeying it when the internet is down)
 *   POST  admin only: {action:"add"|"update"|"toggle"|"remove"|"override"}
 *
 * Nothing here can close the tablet's name + PIN keypad, the paper sheet or
 * this page: the rest is the scanner, not the system.
 */

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "9:5" -> "09:05", or null when it is not a time of day. */
function hhmm(value: unknown): string | null {
  const m = HHMM.exec(String(value ?? "").trim());
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

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

function rowsToWindows(rows: typeof attendanceActiveWindows.$inferSelect[]): ActiveWindow[] {
  return rows.map((r) => ({
    id: r.id,
    from: r.fromTime,
    to: r.toTime,
    label: r.label ?? null,
    enabled: r.enabled !== false,
  }));
}

export async function GET(request: Request) {
  const device = deviceAllowed(request);
  const auth = await requireAdmin();
  if (!device && !auth.ok) return auth.response;

  await ensureTablesExist();

  try {
    const rows = await db
      .select()
      .from(attendanceActiveWindows)
      .orderBy(asc(attendanceActiveWindows.sortOrder), asc(attendanceActiveWindows.id));
    const windows = rowsToWindows(rows);
    const now = new Date();
    const override = parseRestOverride(await readOverride(), now);
    const at = minuteOfDayET(now);
    const awake = isAwakeAt(windows, at);
    const untilChange = minutesUntilChange(windows, at);
    const hint = await readRestWakeHint(now);
    const { sliceSeconds, jobWaiting, wakeRequestedAt } = hint;

    return NextResponse.json({
      windows,
      override,
      awakeNow: awake,
      // What the panel says: "rests in 45 min, awake again at 18:00".
      at: clockLabelOfMinute(at),
      changeInMinutes: untilChange,
      changeTo: awake ? "resting" : "awake",
      nextChangeLabel: clockLabelOfMinute(at + untilChange),
      maxWindows: REST_MAX_WINDOWS,
      // How soon the board will look again. The panel shows it, the device
      // obeys it: 45 s while an edit is fresh or a finger job waits, 600 s on a
      // quiet night. This is what makes a change reach the door in about a
      // minute without a second channel or any new wiring.
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

  // Every edit of these hours marks the moment, so a board that is resting
  // shortens its next sleep to about 45 s and picks the change up at once
  // (owner: "i want the system to start working if he changes the time").
  await markRestWakeRequested();

  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const id = Number(body.id ?? 0);

    if (action === "add" || action === "update") {
      const from = hhmm(body.from);
      const to = hhmm(body.to);
      if (!from || !to) {
        return NextResponse.json({ error: "Both times are needed, like 06:00 and 15:00" }, { status: 400 });
      }
      const label = String(body.label ?? "").trim().slice(0, 40) || null;
      const values = { fromTime: from, toTime: to, label, updatedAt: new Date() };

      if (action === "add") {
        const all = await db.select({ id: attendanceActiveWindows.id }).from(attendanceActiveWindows);
        if (all.length >= REST_MAX_WINDOWS) {
          return NextResponse.json(
            { error: `You can list up to ${REST_MAX_WINDOWS} intervals. Remove one first.` },
            { status: 400 }
          );
        }
        const same = await db
          .select()
          .from(attendanceActiveWindows)
          .where(and(eq(attendanceActiveWindows.fromTime, from), eq(attendanceActiveWindows.toTime, to)))
          .limit(1);
        if (same.length > 0) {
          return NextResponse.json({ error: `${from} to ${to} is already listed` }, { status: 409 });
        }
        const created = (await db.insert(attendanceActiveWindows).values(values).returning())[0];
        publish(CHANNELS.device);
        return NextResponse.json({ success: true, window: created, message: `${from} to ${to} added` });
      }

      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const updated = (
        await db.update(attendanceActiveWindows).set(values).where(eq(attendanceActiveWindows.id, id)).returning()
      )[0];
      if (!updated) return NextResponse.json({ error: "That interval is gone already" }, { status: 404 });
      publish(CHANNELS.device);
      return NextResponse.json({ success: true, window: updated, message: "Interval changed" });
    }

    if (action === "toggle") {
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const rows = await db.select().from(attendanceActiveWindows).where(eq(attendanceActiveWindows.id, id)).limit(1);
      if (rows.length === 0) return NextResponse.json({ error: "That interval is gone already" }, { status: 404 });
      const enabled = rows[0].enabled === false;
      const updated = (
        await db
          .update(attendanceActiveWindows)
          .set({ enabled, updatedAt: new Date() })
          .where(eq(attendanceActiveWindows.id, id))
          .returning()
      )[0];
      publish(CHANNELS.device);
      return NextResponse.json({
        success: true,
        window: updated,
        message: `${updated.fromTime} to ${updated.toTime} is now ${enabled ? "on" : "off"}`,
      });
    }

    if (action === "remove") {
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const removed = await db.delete(attendanceActiveWindows).where(eq(attendanceActiveWindows.id, id)).returning();
      if (removed.length === 0) return NextResponse.json({ error: "That interval is gone already" }, { status: 404 });
      publish(CHANNELS.device);
      return NextResponse.json({ success: true, message: "Interval removed" });
    }

    if (action === "override") {
      const mode = String(body.mode ?? "");
      if (mode === "awake") {
        await writeOverride("awake");
      } else if (mode === "minutes") {
        const minutes = Math.max(1, Math.min(24 * 60, Number(body.minutes) || 15));
        const until = new Date(Date.now() + minutes * 60000).toISOString();
        await writeOverride(`awake_until=${until}`);
      } else if (mode === "schedule") {
        await writeOverride("schedule");
      } else {
        return NextResponse.json({ error: "What should the scanner do?" }, { status: 400 });
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
    }

    return NextResponse.json({ error: `Unknown action: ${action || "(none)"}` }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
