import { NextResponse } from "next/server";
import { db } from "@/db";
import { attendanceBiometrics, attendanceEnrollJobs, attendanceMembers } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { deviceAllowed } from "@/lib/attendance-device";
import { publish, CHANNELS } from "@/lib/realtime";
import { and, eq } from "drizzle-orm";
import { MAX_FINGERS_PER_MEMBER } from "@/lib/attendance";

/**
 * fingerprintId -> which person of the attendance list.
 *
 * GET  is what the ESP32 downloads to show a name on its OLED and to know who
 *      a scanned finger belongs to when the wifi drops (it caches the answer in
 *      LittleFS).
 * POST is the last step of "Add Fingerprint": the device stored the finger
 *      under the ID the pending job asked for and reports it back
 *      ({ fingerprintId: 5, staffName: "Abebe" }). The admin page is polling
 *      the job and prints "Fingerprint Added ✓" the moment this lands.
 *
 * Both are for the hardware, which has no login; an admin session is accepted
 * too, and ATTENDANCE_DEVICE_TOKEN locks the door when the owner sets it.
 */

export async function GET() {
  await ensureTablesExist();

  try {
    const biometrics = await db.select().from(attendanceBiometrics);
    const members = await db.select().from(attendanceMembers);
    const nameOf = new Map(members.map((m) => [m.id, m.name]));

    const mappings = biometrics.map((b) => ({
      fingerprintId: b.fingerprintId,
      memberId: b.memberId,
      memberName: nameOf.get(b.memberId) || `Member ${b.memberId}`,
      // `staffName` stays: the flashed firmware reads that key.
      staffName: nameOf.get(b.memberId) || `Member ${b.memberId}`,
      fingerName: b.fingerName,
    }));

    // { "1": "Mulu", "2": "Abebe" } - the quick OLED lookup on the device.
    const simpleMap: Record<number, string> = {};
    for (const m of mappings) simpleMap[m.fingerprintId] = m.memberName;

    return NextResponse.json({ count: mappings.length, mappings, simpleMap });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const device = deviceAllowed(request);
  const auth = await requireAdmin();
  if (!device && !auth.ok) return auth.response;

  await ensureTablesExist();

  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Send a JSON body" }, { status: 400 });
    }

    // The device could not finish the job (no finger, sensor error, ID taken).
    // Close the job as failed so the admin sees it at once instead of waiting
    // for the job to expire. Only a pending job can be closed this way.
    if (body.action === "job_failed") {
      const jobId = Number(body.jobId);
      if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });
      const reason = String(body.reason ?? "Device could not finish the job").slice(0, 120);
      await db
        .update(attendanceEnrollJobs)
        .set({ status: "failed", completedAt: new Date() })
        .where(and(eq(attendanceEnrollJobs.id, jobId), eq(attendanceEnrollJobs.status, "pending")));
      publish(CHANNELS.device);
      return NextResponse.json({ success: true, reason });
    }

    const fingerprintId = Number(body.fingerprintId);
    if (!fingerprintId || fingerprintId < 1 || fingerprintId > 1000) {
      return NextResponse.json({ error: "fingerprintId must be 1-1000" }, { status: 400 });
    }

    // Who is this finger? By id when the job gave one, otherwise by the name
    // the device was told to enroll.
    let member: { id: number; name: string } | null = null;
    const byId = Number(body.memberId ?? 0);
    const byName = String(body.memberName ?? body.staffName ?? "").trim();

    if (byId) {
      const found = await db.select().from(attendanceMembers).where(eq(attendanceMembers.id, byId)).limit(1);
      if (found.length > 0) member = { id: found[0].id, name: found[0].name };
    }
    if (!member && byName) {
      const all = await db.select().from(attendanceMembers);
      const found = all.find((m) => m.name.toLowerCase() === byName.toLowerCase());
      if (found) member = { id: found.id, name: found.name };
    }
    if (!member) {
      return NextResponse.json(
        { error: `No member of the attendance list matches ${byName || `id ${byId}`}` },
        { status: 404 }
      );
    }

    const existing = await db.select().from(attendanceBiometrics);
    const clash = existing.find((b) => b.fingerprintId === fingerprintId);
    if (clash && clash.memberId !== member.id) {
      return NextResponse.json(
        { error: `ID ${fingerprintId} is already enrolled for member ${clash.memberId}` },
        { status: 409 }
      );
    }

    const owned = existing.filter((b) => b.memberId === member!.id);
    if (!clash && owned.length >= MAX_FINGERS_PER_MEMBER) {
      return NextResponse.json(
        { error: `${member.name} already has ${owned.length} fingerprints (max ${MAX_FINGERS_PER_MEMBER})` },
        { status: 400 }
      );
    }

    // The same finger reported twice (the device retried) is not an error: the
    // mapping is already there, so just answer with it.
    const bio =
      clash ??
      (
        await db
          .insert(attendanceBiometrics)
          .values({
            memberId: member.id,
            fingerprintId,
            fingerName: String(body.fingerName ?? "Right Index").slice(0, 50),
            enrolledBy: "device",
          })
          .returning()
      )[0];

    // Close the job that asked for this finger, so the admin page can show
    // "Fingerprint Added ✓".
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

    // The device stored a finger: push the device channel so the admin page
    // watching the job prints "Fingerprint Added ✓" instantly.
    publish(CHANNELS.device);

    return NextResponse.json({
      success: true,
      id: bio.id,
      memberId: member.id,
      memberName: member.name,
      fingerprintId,
      message: `Fingerprint Added for ${member.name} (ID ${fingerprintId})`,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
