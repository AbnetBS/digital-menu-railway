import { NextResponse } from "next/server";
import { db } from "@/db";
import { attendanceRoles, attendanceRoleShifts } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { asc, eq } from "drizzle-orm";
import { parseHHMM, type RoleShift } from "@/lib/attendance";

/**
 * ATTENDANCE -> ROLE & TIME (owner, Oct 2026).
 *
 * "Different roles have a different time of entrance and a different time of
 * getting out": Cleaner 06:00 -> 14:00, Chef 07:00 -> 16:00, Waiter morning
 * 08:00 -> 14:00 AND afternoon 14:00 -> 22:00. The role owns the times, so the
 * sheet needs no Shifts tab any more: late is simply "15 minutes after the
 * entrance time of the role this person belongs to".
 *
 * A role is written as one row in attendance_roles plus one row per period in
 * attendance_role_shifts, and the whole form is saved with Done.
 */

type IncomingShift = { label?: unknown; startTime?: unknown; endTime?: unknown };

/** Clean the shift rows of the form. Null when one of them cannot be saved. */
function cleanShifts(raw: unknown): RoleShift[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RoleShift[] = [];
  for (const item of raw as IncomingShift[]) {
    const label = String(item.label ?? "").trim();
    const startTime = String(item.startTime ?? "").trim();
    const endTime = String(item.endTime ?? "").trim();
    // An empty row in the form is simply skipped; a half-filled one is an error
    // the admin must fix, otherwise the role would get a nonsense time.
    if (!label && !startTime && !endTime) continue;
    if (!label || parseHHMM(startTime) === null || parseHHMM(endTime) === null) return null;
    out.push({ label: label.slice(0, 40), startTime, endTime });
  }
  return out;
}

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  await ensureTablesExist();

  try {
    const roles = await db.select().from(attendanceRoles).orderBy(asc(attendanceRoles.name));
    const shifts = await db
      .select()
      .from(attendanceRoleShifts)
      .orderBy(asc(attendanceRoleShifts.sortOrder), asc(attendanceRoleShifts.id));

    return NextResponse.json(
      roles.map((r) => ({
        id: r.id,
        name: r.name,
        shifts: shifts
          .filter((s) => s.roleId === r.id)
          .map((s) => ({
            id: s.id,
            label: s.label,
            startTime: s.startTime,
            endTime: s.endTime,
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
    if (!name) return NextResponse.json({ error: "Role name required" }, { status: 400 });

    const shifts = cleanShifts(body.shifts);
    if (shifts === null) {
      return NextResponse.json(
        { error: "Every period needs a name, a time of entrance and a time out" },
        { status: 400 }
      );
    }
    if (shifts.length === 0) {
      return NextResponse.json({ error: "Add at least one period with its times" }, { status: 400 });
    }

    const role = await db
      .insert(attendanceRoles)
      .values({ name: name.slice(0, 80) })
      .returning();

    await db.insert(attendanceRoleShifts).values(
      shifts.map((s, i) => ({
        roleId: role[0].id,
        label: s.label,
        startTime: s.startTime,
        endTime: s.endTime,
        sortOrder: i,
      }))
    );

    return NextResponse.json({ ...role[0], shifts, message: `Role ${role[0].name} added` });
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

    const patch: { name?: string } = {};
    if (body.name !== undefined) {
      const name = String(body.name ?? "").trim();
      if (!name) return NextResponse.json({ error: "Role name required" }, { status: 400 });
      patch.name = name.slice(0, 80);
    }

    if (Object.keys(patch).length > 0) {
      await db.update(attendanceRoles).set(patch).where(eq(attendanceRoles.id, id));
    }

    // The form is the whole truth about the periods: rewrite them on Done.
    if (body.shifts !== undefined) {
      const shifts = cleanShifts(body.shifts);
      if (shifts === null) {
        return NextResponse.json(
          { error: "Every period needs a name, a time of entrance and a time out" },
          { status: 400 }
        );
      }
      if (shifts.length === 0) {
        return NextResponse.json({ error: "Add at least one period with its times" }, { status: 400 });
      }
      await db.delete(attendanceRoleShifts).where(eq(attendanceRoleShifts.roleId, id));
      await db.insert(attendanceRoleShifts).values(
        shifts.map((s, i) => ({
          roleId: id,
          label: s.label,
          startTime: s.startTime,
          endTime: s.endTime,
          sortOrder: i,
        }))
      );
    }

    return NextResponse.json({ id, message: "Role saved" });
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

    await db.delete(attendanceRoleShifts).where(eq(attendanceRoleShifts.roleId, id));
    await db.delete(attendanceRoles).where(eq(attendanceRoles.id, id));
    return NextResponse.json({ success: true, message: "Role deleted" });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
