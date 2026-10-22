import { NextResponse } from "next/server";
import { pool } from "@/db";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { ethiopianDateToGregorian, ethiopianMonthBounds, gregorianDateToEthiopian } from "@/lib/payroll";

/**
 * HOLIDAY DATES (owner, Oct 2026).
 *
 * His words: the Holiday OT label must be clickable, "so that i can add
 * specific holiday dates ... then i will select the date and name of the
 * holiday there so the system knows when the holiday is".
 *
 *   GET    ?period=YYYY-MM   the holidays of that Ethiopian month (all when
 *                            no period is given), newest first
 *   POST   {date,name}       date is an Ethiopian YYYY-MM-DD, name is the
 *                            holiday itself ("Meskel", "Eid", ...)
 *   DELETE ?id=n             take one back
 *
 * The stored key is the Gregorian day the attendance sheet already uses, so a
 * worked holiday can be matched to a scan without another calendar in between.
 * Admin only: a holiday changes somebody's pay.
 */

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-3])$/;

function present(row: any) {
  const date = String(row.holiday_date);
  return { id: Number(row.id), date, dateEc: gregorianDateToEthiopian(date), name: String(row.name), createdAt: row.created_at };
}

export async function GET(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  const period = new URL(request.url).searchParams.get("period") || "";
  try {
    let rows;
    if (PERIOD_RE.test(period)) {
      const [year, month] = period.split("-").map(Number);
      const bounds = ethiopianMonthBounds(year, month);
      rows = await pool.query("SELECT * FROM payroll_holidays WHERE holiday_date BETWEEN $1 AND $2 ORDER BY holiday_date", [bounds.from, bounds.to]);
    } else {
      rows = await pool.query("SELECT * FROM payroll_holidays ORDER BY holiday_date DESC LIMIT 200");
    }
    return NextResponse.json(rows.rows.map(present));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || "").trim().slice(0, 120);
  if (!name) return NextResponse.json({ error: "Type the name of the holiday" }, { status: 400 });
  let holidayDate: string;
  try {
    // The owner reads the Ethiopian calendar, the sheet stores the Gregorian
    // day: one conversion, in the same helper the free dates already use.
    holidayDate = ethiopianDateToGregorian(String(body.date || ""));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Use an Ethiopian date YYYY-MM-DD" }, { status: 400 });
  }
  try {
    const row = await pool.query(
      `INSERT INTO payroll_holidays(holiday_date,name) VALUES($1,$2)
       ON CONFLICT(holiday_date) DO UPDATE SET name=$2
       RETURNING *`,
      [holidayDate, name]
    );
    await pool.query("INSERT INTO payroll_audit(action,detail) VALUES('holiday_saved',$1::jsonb)", [
      JSON.stringify({ date: holidayDate, dateEc: gregorianDateToEthiopian(holidayDate), name }),
    ]);
    return NextResponse.json(present(row.rows[0]));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save the holiday" }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "Holiday required" }, { status: 400 });
  try {
    await pool.query("DELETE FROM payroll_holidays WHERE id=$1", [id]);
    await pool.query("INSERT INTO payroll_audit(action,detail) VALUES('holiday_removed',$1::jsonb)", [JSON.stringify({ id })]);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not remove the holiday" }, { status: 400 });
  }
}
