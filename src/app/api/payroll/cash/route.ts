import { NextResponse } from "next/server";
import { pool } from "@/db";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { computePayrollMoney, withDefaultPayrollFormulas } from "@/lib/payroll";
import { DEFAULT_CASH_SIGNOFF, type CashPayrollRow } from "@/lib/cash-payroll";

/**
 * CASH PAYROLL (owner, 2026-11-07)
 *
 * The second table under the TIN payroll: the people paid in cash, with no TIN.
 * His Excel has four columns (No., Employee Name, Net pay, Signature) and the
 * rows are either attendance members or names typed straight in. No tax, no
 * pension, no transport: one number per person, typed by the owner.
 *
 *   GET    ?period=2019-02        the rows, the sign-off names and the people
 *                                 who can still be added
 *   POST   add_member / add_name / rename / set_net_pay / remove / set_paid /
 *          save_signatures
 *
 * A person in the cash table this month is left OUT of the TIN payroll of the
 * same month (the payroll route reads this table). Next month he is back unless
 * he is added again.
 */

const money = (n: unknown) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
const asNumber = (n: unknown) => (n === undefined || n === null || n === "" ? null : money(String(n).replace(/,/g, "")));
const validPeriod = (v: unknown) => /^\d{4}-(0[1-9]|1[0-3])$/.test(String(v || ""));

type Row = {
  id: number;
  member_id: number | null;
  name: string;
  net_pay: string | number;
  note: string | null;
  sort_order: number | null;
  paid_at: Date | null;
};

async function readRows(periodKey: string): Promise<{ rows: CashPayrollRow[]; signoff: { preparedBy: string; checkedBy: string; approvedBy: string } }> {
  // A member row shows the member's CURRENT name, so a rename in Attendance
  // also shows here; a typed row keeps the name stored on the row itself.
  const q = await pool.query<Row>(
    `SELECT c.id, c.member_id, COALESCE(NULLIF(btrim(m.name), ''), c.name) AS name,
            c.net_pay, c.note, c.sort_order, c.paid_at
       FROM cash_payroll_entries c
       LEFT JOIN attendance_members m ON m.id = c.member_id
      WHERE c.period_key = $1
      ORDER BY c.sort_order, c.id`,
    [periodKey]
  );
  const s = await pool.query<{ prepared_by: string | null; checked_by: string | null; approved_by: string | null }>(
    "SELECT prepared_by, checked_by, approved_by FROM cash_payroll_signoff WHERE period_key=$1",
    [periodKey]
  );
  return {
    rows: q.rows.map((r) => ({
      id: Number(r.id),
      memberId: r.member_id === null ? null : Number(r.member_id),
      name: String(r.name || ""),
      netPay: money(r.net_pay),
      note: String(r.note || ""),
      paid: Boolean(r.paid_at),
      paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
      fromAttendance: r.member_id !== null,
      sortOrder: Number(r.sort_order || 0),
    })),
    signoff: {
      preparedBy: s.rows[0]?.prepared_by || DEFAULT_CASH_SIGNOFF.preparedBy,
      checkedBy: s.rows[0]?.checked_by || DEFAULT_CASH_SIGNOFF.checkedBy,
      approvedBy: s.rows[0]?.approved_by || DEFAULT_CASH_SIGNOFF.approvedBy,
    },
  };
}

/** Every active attendance member NOT already in this month's cash table. */
async function addableMembers(periodKey: string) {
  const q = await pool.query<{ id: number; name: string; role: string | null }>(
    `SELECT m.id, m.name, r.name AS role
       FROM attendance_members m
       LEFT JOIN attendance_roles r ON r.id = m.role_id
      WHERE COALESCE(m.active, true) = true
        AND NOT EXISTS (
          SELECT 1 FROM cash_payroll_entries c
           WHERE c.period_key = $1 AND c.member_id = m.id
        )
      ORDER BY m.name`,
    [periodKey]
  );
  return q.rows.map((r) => ({ id: Number(r.id), name: String(r.name), role: r.role || "No role" }));
}

/**
 * The person's own monthly take-home, as a suggestion when he is added to the
 * cash table: the same money chain the TIN sheet uses, without the month's
 * attendance deductions (a cash worker's agreed net pay is his wage). Nothing
 * is stored until the owner confirms it.
 */
async function suggestedNetPay(memberId: number): Promise<number> {
  const [comp, settings] = await Promise.all([
    pool.query<{ basic_salary: string | null; transport_allowance: string | null }>(
      "SELECT basic_salary, transport_allowance FROM payroll_compensation WHERE member_id=$1",
      [memberId]
    ),
    pool.query<{ settings: Record<string, unknown> | null }>("SELECT settings FROM payroll_settings WHERE id=1"),
  ]);
  const basic = Number(comp.rows[0]?.basic_salary || 0);
  const transport = Number(comp.rows[0]?.transport_allowance || 0);
  if (!basic) return 0;
  const pay = computePayrollMoney({
    basicSalary: basic,
    transportAllowance: transport,
    breakageShortage: 0,
    settings: withDefaultPayrollFormulas(settings.rows[0]?.settings || {}),
  });
  return money(pay.display.netPay);
}

export async function GET(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  const period = new URL(request.url).searchParams.get("period");
  if (!validPeriod(period)) return NextResponse.json({ error: "Valid Ethiopian period YYYY-MM required" }, { status: 400 });
  try {
    const [{ rows, signoff }, addable] = await Promise.all([readRows(period!), addableMembers(period!)]);
    return NextResponse.json({
      periodKey: period,
      rows,
      signoff,
      addable,
      total: rows.reduce((sum, r) => money(sum + r.netPay), 0),
      count: rows.length,
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
  const period = String(body.period || "");
  const action = String(body.action || "");
  if (!validPeriod(period)) return NextResponse.json({ error: "Valid Ethiopian period required" }, { status: 400 });

  try {
    if (action === "add_member") {
      const memberId = Number(body.memberId);
      if (!memberId) throw new Error("Employee required");
      const member = await pool.query<{ name: string }>("SELECT name FROM attendance_members WHERE id=$1", [memberId]);
      if (!member.rows[0]) throw new Error("That person is not in the attendance list");
      const netPay = asNumber(body.netPay) ?? (await suggestedNetPay(memberId));
      await pool.query(
        `INSERT INTO cash_payroll_entries(period_key,member_id,name,net_pay,note,sort_order,updated_at)
         VALUES($1,$2,$3,$4::numeric,$5,(SELECT COALESCE(max(sort_order),0)+1 FROM cash_payroll_entries WHERE period_key=$1),now())
         ON CONFLICT (period_key, member_id) WHERE member_id IS NOT NULL
         DO UPDATE SET net_pay = COALESCE(EXCLUDED.net_pay, cash_payroll_entries.net_pay), updated_at = now()`,
        [period, memberId, member.rows[0].name, netPay, String(body.note || "")]
      );
      await pool.query("INSERT INTO payroll_audit(period_key,action,detail) VALUES($1,'cash_payroll_member_added',$2::jsonb)", [
        period,
        JSON.stringify({ memberId, name: member.rows[0].name, netPay }),
      ]);
    } else if (action === "add_name") {
      // "i can write my new employees that their fingerprint isn't registered":
      // no attendance row, no fingerprint, just a name and the money.
      const name = String(body.name || "").trim();
      if (!name) throw new Error("Employee name required");
      const netPay = asNumber(body.netPay) ?? 0;
      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO cash_payroll_entries(period_key,member_id,name,net_pay,note,sort_order,updated_at)
         VALUES($1,NULL,$2,$3::numeric,$4,(SELECT COALESCE(max(sort_order),0)+1 FROM cash_payroll_entries WHERE period_key=$1),now())
         RETURNING id`,
        [period, name.slice(0, 120), netPay, String(body.note || "")]
      );
      await pool.query("INSERT INTO payroll_audit(period_key,action,detail) VALUES($1,'cash_payroll_name_added',$2::jsonb)", [
        period,
        JSON.stringify({ id: inserted.rows[0]?.id, name, netPay }),
      ]);
    } else if (action === "rename") {
      const id = Number(body.id);
      const name = String(body.name || "").trim();
      if (!id || !name) throw new Error("Employee and new name required");
      const row = await pool.query<{ member_id: number | null }>(
        "SELECT member_id FROM cash_payroll_entries WHERE id=$1 AND period_key=$2",
        [id, period]
      );
      if (!row.rows[0]) throw new Error("That cash row was not found");
      const memberId = row.rows[0].member_id === null ? null : Number(row.rows[0].member_id);
      // A member row follows the attendance name, so the rename is written
      // there too: "when i rename on that list also the attendance staff
      // member will be renamed". One name, one place, both lists agree.
      if (memberId) {
        await pool.query("UPDATE attendance_members SET name=$1, updated_at=now() WHERE id=$2", [name.slice(0, 100), memberId]);
      }
      await pool.query("UPDATE cash_payroll_entries SET name=$1, updated_at=now() WHERE id=$2", [name.slice(0, 120), id]);
      await pool.query("INSERT INTO payroll_audit(period_key,action,detail) VALUES($1,'cash_payroll_renamed',$2::jsonb)", [
        period,
        JSON.stringify({ id, memberId, name }),
      ]);
    } else if (action === "set_net_pay") {
      const id = Number(body.id);
      if (!id) throw new Error("Cash row required");
      const netPay = asNumber(body.netPay);
      if (netPay === null) throw new Error("Net pay required");
      await pool.query("UPDATE cash_payroll_entries SET net_pay=$1::numeric, updated_at=now() WHERE id=$2 AND period_key=$3", [
        netPay,
        id,
        period,
      ]);
      await pool.query("INSERT INTO payroll_audit(period_key,action,detail) VALUES($1,'cash_payroll_amount_saved',$2::jsonb)", [
        period,
        JSON.stringify({ id, netPay }),
      ]);
    } else if (action === "remove") {
      const id = Number(body.id);
      if (!id) throw new Error("Cash row required");
      const removed = await pool.query<{ member_id: number | null; name: string }>(
        "DELETE FROM cash_payroll_entries WHERE id=$1 AND period_key=$2 RETURNING member_id, name",
        [id, period]
      );
      await pool.query("INSERT INTO payroll_audit(period_key,action,detail) VALUES($1,'cash_payroll_removed',$2::jsonb)", [
        period,
        JSON.stringify({ id, memberId: removed.rows[0]?.member_id ?? null, name: removed.rows[0]?.name }),
      ]);
    } else if (action === "set_paid") {
      const id = Number(body.id);
      if (!id) throw new Error("Cash row required");
      const paid = body.paid === undefined ? true : Boolean(body.paid);
      await pool.query(
        "UPDATE cash_payroll_entries SET paid_at = CASE WHEN $1 THEN now() ELSE NULL END, updated_at=now() WHERE id=$2 AND period_key=$3",
        [paid, id, period]
      );
      await pool.query("INSERT INTO payroll_audit(period_key,action,detail) VALUES($1,'cash_payroll_paid',$2::jsonb)", [
        period,
        JSON.stringify({ id, paid }),
      ]);
    } else if (action === "save_signatures") {
      await pool.query(
        `INSERT INTO cash_payroll_signoff(period_key,prepared_by,checked_by,approved_by,updated_at)
         VALUES($1,$2,$3,$4,now())
         ON CONFLICT (period_key) DO UPDATE SET prepared_by=$2, checked_by=$3, approved_by=$4, updated_at=now()`,
        [period, String(body.preparedBy || ""), String(body.checkedBy || ""), String(body.approvedBy || "")]
      );
    } else {
      throw new Error("Unknown cash payroll action");
    }

    const { rows, signoff } = await readRows(period);
    return NextResponse.json({
      success: true,
      rows,
      signoff,
      addable: await addableMembers(period),
      total: rows.reduce((sum, r) => money(sum + r.netPay), 0),
      count: rows.length,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
