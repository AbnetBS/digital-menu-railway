import { NextResponse } from "next/server";
import { db } from "@/db";
import { attendanceBiometrics, attendanceMembers, attendanceRoles } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { hashSecret } from "@/lib/auth";
import { asc, eq } from "drizzle-orm";

/**
 * ATTENDANCE -> STAFF MEMBERS (owner, Oct 2026).
 *
 * This is the attendance listing, and it is deliberately NOT the staff login
 * list: "cleaners, managers and the others do not use my system, so they have
 * no login page". Everyone who clocks in with a finger is added here, with the
 * role that decides his times and a backup PIN for a wet or dirty finger.
 *
 * `?public=1` is the name list the door tablet shows in its dropdown. It is
 * names and roles only - never a PIN, never a fingerprint ID.
 */

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const pub = searchParams.get("public");

  if (pub !== "1") {
    const auth = await requireAdmin();
    if (!auth.ok) return auth.response;
  }

  await ensureTablesExist();

  try {
    const members = await db.select().from(attendanceMembers).orderBy(asc(attendanceMembers.name));
    const roles = await db.select().from(attendanceRoles);
    const roleName = new Map(roles.map((r) => [r.id, r.name]));

    if (pub === "1") {
      // The kiosk dropdown: active people only, nothing secret.
      return NextResponse.json(
        members
          .filter((m) => m.active !== false)
          .map((m) => ({
            id: m.id,
            name: m.name,
            role: m.roleId ? roleName.get(m.roleId) || "No role" : "No role",
            hasPin: Boolean(m.pin),
          }))
      );
    }

    const bios = await db.select().from(attendanceBiometrics);

    return NextResponse.json(
      members.map((m) => ({
        id: m.id,
        name: m.name,
        roleId: m.roleId,
        roleName: m.roleId ? roleName.get(m.roleId) || "No role" : "No role",
        active: m.active !== false,
        pinSet: Boolean(m.pin),
        fingers: bios
          .filter((b) => b.memberId === m.id)
          .map((b) => ({
            id: b.id,
            fingerprintId: b.fingerprintId,
            fingerName: b.fingerName,
            enrolledAt: b.enrolledAt,
          })),
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
    const name = String(body.name ?? "").trim();
    if (!name) return NextResponse.json({ error: "Name required" }, { status: 400 });

    const roleId = body.roleId ? Number(body.roleId) : null;
    if (roleId) {
      const role = await db.select().from(attendanceRoles).where(eq(attendanceRoles.id, roleId)).limit(1);
      if (role.length === 0) return NextResponse.json({ error: "Role not found" }, { status: 404 });
    }

    const pin = String(body.pin ?? "").trim();
    const member = await db
      .insert(attendanceMembers)
      .values({
        name: name.slice(0, 100),
        roleId,
        // The PIN is the backup for a wet finger: stored hashed, never echoed.
        pin: pin ? await hashSecret(pin) : null,
      })
      .returning();

    return NextResponse.json({
      id: member[0].id,
      name: member[0].name,
      roleId: member[0].roleId,
      pinSet: Boolean(member[0].pin),
      message: `${member[0].name} added to the attendance list`,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  await ensureTablesExist();

  try {
    const body = await request.json();
    const id = Number(body.id);
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const patch: { name?: string; roleId?: number | null; pin?: string | null; active?: boolean } = {};

    if (body.name !== undefined) {
      const name = String(body.name ?? "").trim();
      if (!name) return NextResponse.json({ error: "Name required" }, { status: 400 });
      patch.name = name.slice(0, 100);
    }
    if (body.roleId !== undefined) patch.roleId = body.roleId ? Number(body.roleId) : null;
    if (body.active !== undefined) patch.active = Boolean(body.active);
    // An empty PIN field keeps the old PIN; typing a new one replaces it.
    if (body.pin !== undefined && String(body.pin ?? "").trim() !== "") {
      patch.pin = await hashSecret(String(body.pin).trim());
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
    }

    const updated = await db
      .update(attendanceMembers)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(attendanceMembers.id, id))
      .returning();

    if (updated.length === 0) return NextResponse.json({ error: "Member not found" }, { status: 404 });

    return NextResponse.json({ id, message: "Member saved" });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  await ensureTablesExist();

  try {
    const id = Number(new URL(request.url).searchParams.get("id"));
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    await db.delete(attendanceBiometrics).where(eq(attendanceBiometrics.memberId, id));
    await db.delete(attendanceMembers).where(eq(attendanceMembers.id, id));
    return NextResponse.json({ success: true, message: "Member removed from the attendance list" });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
