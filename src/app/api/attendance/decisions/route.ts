import { NextResponse } from "next/server";
import { pool } from "@/db";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { readStaffSession } from "@/lib/session";
import { monthAttendanceEvents } from "@/lib/attendance-month-events";
import { OVERTIME_TYPES } from "@/lib/attendance";
import {
  DECISION_KINDS,
  decisionKey,
  pendingCounts,
  type DecisionKind,
  type DecisionStatus,
} from "@/lib/attendance-decisions";

export const dynamic = "force-dynamic";

/**
 * THE DEDUCTION REPORT (owner, 2026-11-08).
 *
 * "when someone is late or absent it comes there, abnet late 30 min, deduct /
 * dont deduct" and "for overtime and absent and late and early out it waits for
 * the supervisor confirmation".
 *
 *   GET  ?period=2019-10   every event of the month with its decision, and the
 *                          count still waiting for a person.
 *   POST { period, memberId, date, type, decision, reason }
 *                          record one decision: "deduct" | "dont_deduct".
 *
 * The POST writes the same tables payroll already reads, so a decision taken
 * here is the money on the sheet, and a pending row is money nobody has taken:
 *   lateness / early_out / absence + dont_deduct -> payroll_exceptions (excused)
 *   lateness / early_out / absence + deduct      -> that row is deleted (the
 *                                                   deduction is the default
 *                                                   state of an approved event)
 *   overtime + deduct                            -> attendance_overtime, source
 *                                                   "supervisor"
 *   overtime + dont_deduct                       -> attendance_ot_exclusions
 * Every press is written to payroll_audit with the person's name, so "who let
 * this one go" is answerable months later.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-3])$/;

type Decision = "deduct" | "dont_deduct";

async function actorName(): Promise<string> {
  // An admin session may not carry a staff name; the supervisor login does.
  const staff = await readStaffSession().catch(() => null);
  return String((staff as { name?: string } | null)?.name || "Supervisor");
}

export async function GET(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  const period = new URL(request.url).searchParams.get("period") || "";
  if (!PERIOD_RE.test(period)) {
    return NextResponse.json({ error: "Valid Ethiopian period YYYY-MM required" }, { status: 400 });
  }
  try {
    const month = await monthAttendanceEvents(period);
    // A month the owner already approved or paid is READ ONLY: the report still
    // shows what was decided, and says why nothing can be pressed.
    const periodRow = await pool.query("SELECT status FROM payroll_periods WHERE period_key=$1", [period]);
    const status = String(periodRow.rows[0]?.status || "draft");
    return NextResponse.json({
      ...month,
      pending: pendingCounts(month.events),
      locked: status === "approved" || status === "paid" ? status : null,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  const body = await request.json().catch(() => ({}));
  const period = String(body?.period || "");
  const memberId = Number(body?.memberId);
  const date = String(body?.date || "");
  const type = String(body?.type || "") as DecisionKind;
  const decision = String(body?.decision || "") as Decision;
  const reason = String(body?.reason || "").trim();

  if (!PERIOD_RE.test(period) || !memberId || !DATE_RE.test(date) || !(DECISION_KINDS as readonly string[]).includes(type)) {
    return NextResponse.json({ error: "period, employee, date and event type are required" }, { status: 400 });
  }
  if (decision !== "deduct" && decision !== "dont_deduct") {
    return NextResponse.json({ error: "decision must be deduct or dont_deduct" }, { status: 400 });
  }


  /* A LOCKED MONTH STAYS LOCKED. Once the owner approved (or paid) a payroll
   * month, the numbers on that paper are final: a decision taken afterwards
   * would change a salary somebody may already have been handed. The report
   * still SHOWS the month; it just refuses to change it. */
  const periodRow = await pool.query("SELECT status FROM payroll_periods WHERE period_key=$1", [period]);
  const periodStatus = String(periodRow.rows[0]?.status || "draft");
  if (periodStatus === "approved" || periodStatus === "paid") {
    return NextResponse.json(
      { error: `This month's payroll is ${periodStatus}, so its decisions are locked.` },
      { status: 409 }
    );
  }

  const by = await actorName();
  const status: DecisionStatus = decision === "deduct" ? "approved" : "denied";
  const key = decisionKey({ memberId, date, type });

  try {
    if (type === "lateness" || type === "early_out" || type === "absence") {
      // One ledger row per event, upserted so pressing the other button later
      // simply changes the answer. Payroll moves money by this row, nothing else.
      await pool.query(
        `INSERT INTO payroll_deduction_decisions(period_key,member_id,attendance_date,event_type,decision,decided_by,reason)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(period_key,member_id,attendance_date,event_type)
         DO UPDATE SET decision=$5, decided_by=$6, reason=$7, decided_at=now()`,
        [period, memberId, date, type, decision, by, reason || (decision === "dont_deduct" ? "Reasonable excuse" : "")]
      );
      // The older table is kept in step: an excuse someone typed before this
      // screen existed must not survive a DEDUCT press, and a DO NOT DEDUCT must
      // be visible there too for any report that still reads it.
      if (decision === "dont_deduct") {
        await pool.query(
          `INSERT INTO payroll_exceptions(period_key,member_id,attendance_date,exception_type,authorized_by,reason)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT(period_key,member_id,attendance_date,exception_type)
           DO UPDATE SET authorized_by=$5, reason=$6, created_at=now()`,
          [period, memberId, date, type, by, reason || "Reasonable excuse"]
        );
      } else {
        await pool.query(
          "DELETE FROM payroll_exceptions WHERE period_key=$1 AND member_id=$2 AND attendance_date=$3 AND exception_type=$4",
          [period, memberId, date, type]
        );
      }
    } else if (type === "overtime") {
      const kind = String(body?.overtimeType || "shift");
      if (!(OVERTIME_TYPES as readonly string[]).includes(kind)) {
        return NextResponse.json({ error: "Unknown overtime kind" }, { status: 400 });
      }
      if (decision === "deduct") {
        // "Deduct" on an overtime row means ADD it: the row's own wording is
        // Add overtime. The minutes travel from the client, which read them
        // from the report; the server clamps them to a sane day.
        //
        // A row the system MEASURED (a scan on a free day, a holiday at the
        // door) may arrive without minutes, because the report only has the
        // event. In that case the server re-measures it from the scan instead
        // of refusing: the supervisor is confirming a measurement he can see,
        // he is not expected to retype the hours the clock already wrote.
        let minutes = Math.max(0, Math.min(24 * 60, Math.round(Number(body?.minutes) || 0)));
        if (minutes <= 0) {
          const measured = await pool.query<{ minutes: number }>(
            "SELECT minutes FROM attendance_overtime WHERE member_id=$1 AND date=$2 AND type=$3 ORDER BY id LIMIT 1",
            [memberId, date, kind]
          );
          minutes = Math.max(0, Math.min(24 * 60, Math.round(Number(measured.rows[0]?.minutes) || 0)));
        }
        /* THE RATE HE PICKED WINS ("let me choose per row"). When the supervisor
         * changes the rate on a row the clock measured, the measured row of the
         * ORIGINAL kind is not the record any more: it is removed (the ledger
         * above still holds the approved minutes and the chosen rate, which is
         * what pays), so the same visit can never be paid at two rates in the
         * old auto pass on the payroll. A manual row of the original kind is
         * left alone: that one was typed as work, not measured by a scan. */
        if (typeof body?.measuredType === "string" && body.measuredType !== kind) {
          await pool.query(
            "DELETE FROM attendance_overtime WHERE member_id=$1 AND date=$2 AND type=$3 AND source='auto'",
            [memberId, date, String(body.measuredType)]
          );
        }
        if (minutes <= 0) return NextResponse.json({ error: "Positive overtime minutes required" }, { status: 400 });
        const shiftLabel = body?.shiftLabel ? String(body.shiftLabel).slice(0, 40) : null;
        // The ledger keeps the exact hours that were approved, which is what
        // payroll reads. The overtime table row is the history of the entry.
        await pool.query(
          `INSERT INTO payroll_deduction_decisions(period_key,member_id,attendance_date,event_type,decision,decided_by,reason,minutes,overtime_type)
           VALUES($1,$2,$3,'overtime','deduct',$4,$5,$6,$7)
           ON CONFLICT(period_key,member_id,attendance_date,event_type)
           DO UPDATE SET decision='deduct', decided_by=$4, reason=$5, minutes=$6, overtime_type=$7, decided_at=now()`,
          [period, memberId, date, by, reason || "", minutes, kind]
        );
        /* ONE ROW PER (person, day, kind, shift) — the table's own unique key.
         * Pressing Add overtime is a CONFIRMATION of the row that is already
         * there (the hours typed on the Overtime tab, or measured at the door),
         * so it takes that row over: the same minutes, source 'supervisor' and
         * the name of the person who approved it. Nothing is duplicated, and a
         * holiday row is never doubled by a shift row of the same day. */
        // A row that came from the CLOCK (source 'auto': a holiday scan or a
        // visit on a free day) is the measurement itself and is left alone, so
        // a later Add overtime cannot replace the hours the clock wrote. The
        // ledger above is what pays; this table is the history of the entry.
        const taken = await pool.query<{ id: number; source: string }>(
          "SELECT id, source FROM attendance_overtime WHERE member_id=$1 AND date=$2 AND type=$3 ORDER BY id LIMIT 1",
          [memberId, date, kind]
        );
        if (taken.rows[0] && taken.rows[0].source === "auto") {
          // keep the measured row exactly as it is
        } else if (taken.rows[0]) {
          await pool.query(
            `UPDATE attendance_overtime
                SET minutes=$2, shift_label=COALESCE($3, shift_label), source='supervisor', entered_by=$4,
                    note=COALESCE(NULLIF($5,''), note)
              WHERE id=$1`,
            [taken.rows[0].id, minutes, shiftLabel, by, reason || ""]
          );
        } else {
          await pool.query(
            `INSERT INTO attendance_overtime(member_id,date,type,minutes,shift_label,source,entered_by,note)
             VALUES($1,$2,$3,$4,$5,'supervisor',$6,$7)`,
            [memberId, date, kind, minutes, shiftLabel, by, reason || null]
          );
        }
        await pool.query(
          "DELETE FROM attendance_ot_exclusions WHERE member_id=$1 AND date=$2 AND type=$3",
          [memberId, date, kind]
        );
      } else {
        // Do not add: kept in the history, never paid.
        await pool.query(
          `INSERT INTO payroll_deduction_decisions(period_key,member_id,attendance_date,event_type,decision,decided_by,reason,minutes,overtime_type)
           VALUES($1,$2,$3,'overtime','dont_deduct',$4,$5,0,$6)
           ON CONFLICT(period_key,member_id,attendance_date,event_type)
           DO UPDATE SET decision='dont_deduct', decided_by=$4, reason=$5, minutes=0, overtime_type=$6, decided_at=now()`,
          [period, memberId, date, by, reason || "Not allowed", kind]
        );
        await pool.query(
          "DELETE FROM attendance_ot_exclusions WHERE member_id=$1 AND date=$2 AND type=$3",
          [memberId, date, kind]
        );
        await pool.query(
          `INSERT INTO attendance_ot_exclusions(member_id,date,type,authorized_by,reason)
           VALUES($1,$2,$3,$4,$5)`,
          [memberId, date, kind, by, reason || "Not allowed"]
        );
      }
    } else if (type === "shortage") {
      // Breakage is typed on the payroll screen already; the report only shows
      // it, so a press here is refused rather than silently ignored.
      return NextResponse.json({ error: "Breakage and shortage is decided on the payroll screen" }, { status: 400 });
    }

    await pool.query(
      "INSERT INTO payroll_audit(period_key,member_id,action,detail) VALUES($1,$2,'attendance_decision',$3::jsonb)",
      [period, memberId, JSON.stringify({ date, type, decision, status, by, reason, key })]
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

  const monthResult = await monthAttendanceEvents(period);
  return NextResponse.json({
    ok: true,
    key,
    status,
    events: monthResult.events,
    pending: pendingCounts(monthResult.events),
  });
}
