import { NextResponse } from "next/server";
import { pool } from "@/db";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import { DEFAULT_PAYROLL_SETTINGS, evaluatePayrollFormula, PAYROLL_VARIABLES } from "@/lib/payroll";

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  const result = await pool.query("SELECT settings, approved FROM payroll_settings WHERE id=1");
  const row = result.rows[0];
  return NextResponse.json({ ...DEFAULT_PAYROLL_SETTINGS, ...(row?.settings || {}), settingsApproved: Boolean(row?.approved) });
}

export async function PUT(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  const body = await request.json().catch(() => ({}));
  const settings = { ...DEFAULT_PAYROLL_SETTINGS, ...body, settingsApproved: undefined } as any;
  settings.employerPensionRate = Math.max(0, Number(settings.employerPensionRate) || 0);
  settings.employeePensionRate = Math.max(0, Number(settings.employeePensionRate) || 0);
  const example = Object.fromEntries(PAYROLL_VARIABLES.map((key) => [key, 100]));
  for (const key of ["holidayOtFormula", "freeWeekOtFormula", "shiftOtFormula", "incomeTaxFormula", "absenceFormula", "latenessFormula", "earlyOutFormula"]) {
    const formula = String(settings[key] || "").trim();
    if (formula) {
      try { evaluatePayrollFormula(formula, example); }
      catch (error) { return NextResponse.json({ error: `${key}: ${error instanceof Error ? error.message : error}` }, { status: 400 }); }
    }
    settings[key] = formula;
  }
  const approved = Boolean(body.settingsApproved);
  delete settings.settingsApproved;
  await pool.query(
    `INSERT INTO payroll_settings(id,settings,approved,approved_at,updated_at) VALUES(1,$1::jsonb,$2,CASE WHEN $2 THEN now() ELSE NULL END,now())
     ON CONFLICT(id) DO UPDATE SET settings=$1::jsonb, approved=$2, approved_at=CASE WHEN $2 THEN now() ELSE NULL END, updated_at=now()`,
    [JSON.stringify(settings), approved]
  );
  await pool.query("INSERT INTO payroll_audit(action,detail) VALUES('settings_saved',$1::jsonb)", [JSON.stringify({ approved })]);
  return NextResponse.json({ success: true, ...settings, settingsApproved: approved });
}
