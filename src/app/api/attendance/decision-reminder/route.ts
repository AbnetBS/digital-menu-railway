import { NextResponse } from "next/server";
import { pool } from "@/db";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { REMINDER_TIME_RE } from "@/lib/attendance-reminders";

/**
 * The Decide-deductions notification for ONE phone (the admin's own device).
 *   GET               ?endpoint=...  -> { enabled, time }
 *   POST              { endpoint, time: "HH:MM" }  -> on, at that time (Addis Ababa)
 *   DELETE            ?endpoint=...  -> off
 * Admin only: the notification opens the Decide deductions screen, and that
 * screen's data is admin-only too.
 */
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  const endpoint = new URL(request.url).searchParams.get("endpoint") || "";
  const row = await pool.query<{ time_hhmm: string; enabled: boolean }>(
    "SELECT time_hhmm, enabled FROM attendance_decision_reminders WHERE endpoint=$1",
    [endpoint]
  );
  if (!row.rows[0]) return NextResponse.json({ enabled: false, time: "09:00" }, { headers: NO_STORE });
  return NextResponse.json({ enabled: row.rows[0].enabled, time: row.rows[0].time_hhmm }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  const body = (await request.json().catch(() => ({}))) as { endpoint?: unknown; time?: unknown };
  const endpoint = String(body.endpoint || "");
  const time = String(body.time || "");
  if (!REMINDER_TIME_RE.test(time)) return NextResponse.json({ error: "Enter the time as HH:MM" }, { status: 400, headers: NO_STORE });
  // The phone must already be armed for alerts (the subscribe step) first.
  const sub = await pool.query("SELECT 1 FROM push_subscriptions WHERE endpoint=$1", [endpoint]);
  if (!endpoint || !sub.rows[0]) {
    return NextResponse.json({ error: "Turn on phone notifications first, then set the time." }, { status: 400, headers: NO_STORE });
  }
  await pool.query(
    `INSERT INTO attendance_decision_reminders(endpoint,staff_name,time_hhmm,enabled,last_sent_on,updated_at)
     VALUES($1,'Owner',$2,true,NULL,now())
     ON CONFLICT(endpoint) DO UPDATE SET time_hhmm=$2, enabled=true, last_sent_on=NULL, updated_at=now()`,
    [endpoint, time]
  );
  return NextResponse.json({ ok: true, enabled: true, time }, { headers: NO_STORE });
}

export async function DELETE(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  const endpoint = new URL(request.url).searchParams.get("endpoint") || "";
  await pool.query("UPDATE attendance_decision_reminders SET enabled=false, updated_at=now() WHERE endpoint=$1", [endpoint]);
  return NextResponse.json({ ok: true, enabled: false }, { headers: NO_STORE });
}
