import { NextResponse } from "next/server";
import { pool } from "@/db";
import { ensureTablesExist } from "@/db/migrate";
import { requireAdmin } from "@/lib/session";
import {
  DEFAULT_PAYROLL_SETTINGS,
  DEDUCTION_FORMULA_KEYS,
  PAYROLL_FORMULA_KEYS,
  PAYROLL_VARIABLES,
  evaluatePayrollFormula,
  withDefaultPayrollFormulas,
} from "@/lib/payroll";

/**
 * FORMULA SETTINGS (payroll improvement, Oct 2026).
 *
 * The owner's rates are the starting point, not a locked spreadsheet: the
 * holiday, free week and shift formulas already hold 2.5, 2 and 1.5 when
 * nobody has typed anything, so the payroll calculates from the first day.
 * An empty overtime or tax box falls back to the owner's default instead of
 * turning a whole column into zeros, and saving is still checked by the safe
 * evaluator (MAX(), MIN() and IF() included).
 *
 * Since 2026-10-27 the lateness and early departure boxes DO ship with the
 * owner's per-minute rule (BasicSalary / 30 / 8 / 60 per chargeable minute,
 * the salary he types per employee), because he finally gave one. NetSalary
 * is an approved alternative base. Absence ships with his one-day rule:
 * BasicSalary / 30 * UnapprovedAbsences (a whole 8 hour day per absence).
 * Any of the three can still be emptied, and an empty box SAVES AS EMPTY (no
 * deduction), instead of being filled with a formula he did not ask for.
 */
export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  const result = await pool.query("SELECT settings, approved FROM payroll_settings WHERE id=1");
  const row = result.rows[0];
  return NextResponse.json({
    ...withDefaultPayrollFormulas(row?.settings || {}),
    settingsApproved: Boolean(row?.approved || !row),
  });
}

export async function PUT(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  const body = await request.json().catch(() => ({}));
  const settings = withDefaultPayrollFormulas(body);
  settings.employerPensionRate = Math.max(0, Number(settings.employerPensionRate) || 0);
  settings.employeePensionRate = Math.max(0, Number(settings.employeePensionRate) || 0);

  // One example row of numbers is enough to catch a typo: unknown field,
  // unbalanced bracket, division by zero, anything that is not arithmetic.
  const example: Record<string, number> = Object.fromEntries(PAYROLL_VARIABLES.map((key) => [key, 100]));
  for (const key of PAYROLL_FORMULA_KEYS) {
    const formula = String(settings[key] || "").trim();
    // An empty deduction box is the owner saying "do not deduct this"; it is
    // stored empty and evaluated as zero, never replaced by a made-up rule.
    // Overtime and tax boxes are filled from the owner's defaults when they
    // are empty, so those four are always checked by the evaluator below.
    if (!formula && (DEDUCTION_FORMULA_KEYS as readonly string[]).includes(key)) {
      settings[key] = "";
      continue;
    }
    try {
      evaluatePayrollFormula(formula, example);
    } catch (error) {
      return NextResponse.json(
        { error: `${key}: ${error instanceof Error ? error.message : error}` },
        { status: 400 }
      );
    }
    settings[key] = formula;
  }

  const approved = Boolean(body.settingsApproved);
  const stored = { ...settings, settingsApproved: undefined } as Record<string, unknown>;
  delete stored.settingsApproved;
  await pool.query(
    `INSERT INTO payroll_settings(id,settings,approved,approved_at,updated_at) VALUES(1,$1::jsonb,$2,CASE WHEN $2 THEN now() ELSE NULL END,now())
     ON CONFLICT(id) DO UPDATE SET settings=$1::jsonb, approved=$2, approved_at=CASE WHEN $2 THEN now() ELSE NULL END, updated_at=now()`,
    [JSON.stringify(stored), approved]
  );
  await pool.query("INSERT INTO payroll_audit(action,detail) VALUES('settings_saved',$1::jsonb)", [
    JSON.stringify({ approved, formulas: settings }),
  ]);
  return NextResponse.json({ ...DEFAULT_PAYROLL_SETTINGS, ...settings, settingsApproved: approved });
}
