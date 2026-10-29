import { NextResponse } from "next/server";
import { db } from "@/db";
import { attendanceBiometrics, attendanceEnrollJobs, attendanceMembers } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { deviceAllowed } from "@/lib/attendance-device";
import { publish, CHANNELS } from "@/lib/realtime";
import { markRestWakeRequested } from "@/lib/attendance-rest";
import { and, desc, eq } from "drizzle-orm";
import { ENROLL_JOB_TTL_MINUTES, MAX_FINGERS_PER_MEMBER } from "@/lib/attendance";

/**
 * FINGERPRINTS OF THE ATTENDANCE LIST (owner, Oct 2026).
 *
 * How it works, exactly as the owner asked:
 *
 *   1. Admin -> Attendance -> Staff Members -> Add Fingerprint.
 *   2. POST here with { action: "enroll", memberId: 5 } creates a PENDING job
 *      (the ID is picked by the server when the admin does not type one).
 *   3. The ESP32 hears the device event or polls for a pending job, then
 *      displays its preparation and place/lift instructions on the 20x4 LCD.
 *   4. The person places the same finger on the R307. The device stores it under
 *      that ID and posts it back to /api/attendance/mappings.
 *   5. The admin page polls `GET /api/attendance/biometrics?job=<id>` and reads
 *      the job as done, so it can print "Fingerprint Added ✓".
 *
 * The `?pending` read is for the device, authorized by the optional device token.
 * It carries names and IDs, never a PIN.
 */

/** The next free fingerprint ID in the configured R307 range (1-1000). */
function nextFreeId(taken: number[]): number | null {
  const used = new Set(taken);
  for (let id = 1; id <= 1000; id++) if (!used.has(id)) return id;
  return null;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const pending = searchParams.get("pending");
  const jobId = searchParams.get("job");
  const memberId = searchParams.get("memberId");

  // The device may poll pending jobs with its configured token. Admin reads
  // remain available with an admin session; an unset token keeps legacy access.
  if (pending !== "1" || !deviceAllowed(request)) {
    const auth = await requireAdmin();
    if (!auth.ok) return auth.response;
  }

  await ensureTablesExist();

  try {
    if (pending === "1") {
      const cutoff = new Date(Date.now() - ENROLL_JOB_TTL_MINUTES * 60 * 1000);
      // The door processes one job at a time and has a small JSON buffer.
      // Keep the existing response for other clients unless it opts into one.
      const limit = searchParams.get("limit") === "1" ? 1 : 20;
      const jobs = await db
        .select()
        .from(attendanceEnrollJobs)
        .where(eq(attendanceEnrollJobs.status, "pending"))
        .orderBy(desc(attendanceEnrollJobs.id))
        .limit(limit);
      const fresh = jobs.filter((j) => !j.createdAt || new Date(j.createdAt) >= cutoff);
      return NextResponse.json({
        count: fresh.length,
        jobs: fresh.map((j) => ({
          jobId: j.id,
          memberId: j.memberId,
          memberName: j.memberName || `Member ${j.memberId}`,
          fingerprintId: j.fingerprintId,
          // Ready-made LCD lines, longest first: the device's screen is a
          // 20x4 character LCD, so every line must fit 20 characters.
          // (The key is still called "oled" - older devices read that name.)
          oled: {
            line1: `Enroll ${String(j.memberName || j.memberId).substring(0, 13)}`,
            line2: `ID ${j.fingerprintId}`,
            line3: "Place finger",
            line4: "",
          },
        })),
      });
    }

    if (jobId) {
      const jobs = await db
        .select()
        .from(attendanceEnrollJobs)
        .where(eq(attendanceEnrollJobs.id, Number(jobId)))
        .limit(1);
      if (jobs.length === 0) return NextResponse.json({ error: "Job not found" }, { status: 404 });
      const job = jobs[0];
      return NextResponse.json({
        job: {
          id: job.id,
          memberId: job.memberId,
          memberName: job.memberName,
          fingerprintId: job.fingerprintId,
          status: job.status,
          // The device's own receipt or failure details. Receipt does not
          // imply the sensor is ready; the LCD gives the placement prompt.
          detail: job.detail,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
        },
        done: job.status === "done",
      });
    }

    const bios = memberId
      ? await db.select().from(attendanceBiometrics).where(eq(attendanceBiometrics.memberId, Number(memberId)))
      : await db.select().from(attendanceBiometrics);

    const members = await db.select().from(attendanceMembers);
    const nameOf = new Map(members.map((m) => [m.id, m.name]));

    return NextResponse.json(
      bios.map((b) => ({
        id: b.id,
        memberId: b.memberId,
        fingerprintId: b.fingerprintId,
        fingerName: b.fingerName,
        enrolledAt: b.enrolledAt,
        memberName: nameOf.get(b.memberId) || `Member ${b.memberId}`,
      }))
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  await ensureTablesExist();

  try {
    const body = await request.json();
    const action = String(body.action ?? "map");

    if (action === "cancel") {
      const jobId = Number(body.jobId);
      if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });
      await db
        .update(attendanceEnrollJobs)
        .set({ status: "cancelled", completedAt: new Date() })
        .where(eq(attendanceEnrollJobs.id, jobId));
      return NextResponse.json({ success: true, message: "Enrollment cancelled" });
    }

    // Which person? By id, or by the name typed in the form.
    let member: { id: number; name: string } | null = null;
    const byId = Number(body.memberId ?? body.id ?? 0);
    if (byId) {
      const found = await db.select().from(attendanceMembers).where(eq(attendanceMembers.id, byId)).limit(1);
      if (found.length === 0) return NextResponse.json({ error: "Member not found" }, { status: 404 });
      member = { id: found[0].id, name: found[0].name };
    } else {
      const name = String(body.memberName ?? body.staffName ?? "").trim();
      if (name) {
        const all = await db.select().from(attendanceMembers);
        const found = all.find((m) => m.name.toLowerCase() === name.toLowerCase());
        if (!found) return NextResponse.json({ error: `No member called ${name} on the attendance list` }, { status: 404 });
        member = { id: found.id, name: found.name };
      }
    }
    if (!member) return NextResponse.json({ error: "memberId required" }, { status: 400 });

    const existing = await db.select().from(attendanceBiometrics);
    const owned = existing.filter((b) => b.memberId === member!.id);

    if (action === "enroll") {
      if (owned.length >= MAX_FINGERS_PER_MEMBER) {
        return NextResponse.json(
          { error: `${member.name} already has ${owned.length} fingerprints (max ${MAX_FINGERS_PER_MEMBER})` },
          { status: 400 }
        );
      }

      const wanted = Number(body.fingerprintId ?? 0);
      let fingerprintId = wanted;
      if (fingerprintId) {
        if (fingerprintId < 1 || fingerprintId > 1000) {
          return NextResponse.json({ error: "fingerprintId must be 1-1000" }, { status: 400 });
        }
        const clash = existing.find((b) => b.fingerprintId === fingerprintId);
        if (clash) {
          return NextResponse.json({ error: `ID ${fingerprintId} is already used` }, { status: 409 });
        }
      } else {
        // An ID another person's still-open job is already waiting on is not
        // free either: two people enrolled at the same time must never be sent
        // the same sensor ID, or the second one overwrites the first.
        const openJobs = await db
          .select({ fingerprintId: attendanceEnrollJobs.fingerprintId })
          .from(attendanceEnrollJobs)
          .where(eq(attendanceEnrollJobs.status, "pending"));
        const taken = [...existing.map((b) => b.fingerprintId), ...openJobs.map((j) => j.fingerprintId)];
        const free = nextFreeId(taken);
        if (free === null) return NextResponse.json({ error: "No free fingerprint ID left" }, { status: 409 });
        fingerprintId = free;
      }

      // One waiting job per person: pressing the button again restarts it.
      await db
        .update(attendanceEnrollJobs)
        .set({ status: "cancelled", completedAt: new Date() })
        .where(and(eq(attendanceEnrollJobs.memberId, member.id), eq(attendanceEnrollJobs.status, "pending")));

      const job = await db
        .insert(attendanceEnrollJobs)
        .values({ memberId: member.id, memberName: member.name, fingerprintId, status: "pending" })
        .returning();

      // A finger is waiting: push the ESP32 instantly instead of it polling.
      publish(CHANNELS.device);
      // A finger job is the one case where waiting ten minutes is worse than
      // useless: the person is standing at the door to register, so the board is
      // told to look again within about a minute.
      await markRestWakeRequested();

      return NextResponse.json({
        job: {
          id: job[0].id,
          memberId: member.id,
          memberName: member.name,
          fingerprintId,
          status: "pending",
        },
        message: `Waiting for ${member.name} to place a finger (ID ${fingerprintId})`,
      });
    }

    // action === "map": the admin typed the ID the device already stored.
    const fingerprintId = Number(body.fingerprintId);
    if (!fingerprintId) return NextResponse.json({ error: "fingerprintId required" }, { status: 400 });
    if (fingerprintId < 1 || fingerprintId > 1000) {
      return NextResponse.json({ error: "fingerprintId must be 1-1000" }, { status: 400 });
    }
    const clash = existing.find((b) => b.fingerprintId === fingerprintId);
    if (clash) {
      const who = clash.memberId === member.id ? member.name : `member ${clash.memberId}`;
      return NextResponse.json({ error: `ID ${fingerprintId} is already enrolled for ${who}` }, { status: 409 });
    }
    if (owned.length >= MAX_FINGERS_PER_MEMBER) {
      return NextResponse.json(
        { error: `${member.name} already has ${owned.length} fingerprints (max ${MAX_FINGERS_PER_MEMBER})` },
        { status: 400 }
      );
    }

    const bio = await db
      .insert(attendanceBiometrics)
      .values({
        memberId: member.id,
        fingerprintId,
        fingerName: String(body.fingerName ?? "Right Index").slice(0, 50),
        enrolledBy: String(body.enrolledBy ?? "Admin").slice(0, 100),
      })
      .returning();

    // A hand-typed mapping closes any job still waiting for that finger.
    await db
      .update(attendanceEnrollJobs)
      .set({ status: "done", completedAt: new Date() })
      .where(
        and(
          eq(attendanceEnrollJobs.memberId, member.id),
          eq(attendanceEnrollJobs.fingerprintId, fingerprintId),
          eq(attendanceEnrollJobs.status, "pending")
        )
      );

    // A fingerprint mapping changed: push the device channel (the admin
    // page watching the job learns "Fingerprint Added ✓" instantly).
    publish(CHANNELS.device);

    return NextResponse.json({
      ...bio[0],
      memberName: member.name,
      message: `Fingerprint ID ${fingerprintId} added for ${member.name}`,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  await ensureTablesExist();

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    const fingerprintId = searchParams.get("fingerprintId");

    if (id) {
      await db.delete(attendanceBiometrics).where(eq(attendanceBiometrics.id, Number(id)));
      return NextResponse.json({ success: true, message: "Fingerprint deleted" });
    }
    if (fingerprintId) {
      await db.delete(attendanceBiometrics).where(eq(attendanceBiometrics.fingerprintId, Number(fingerprintId)));
      return NextResponse.json({ success: true, message: `Fingerprint ID ${fingerprintId} deleted` });
    }
    return NextResponse.json({ error: "id or fingerprintId required" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
