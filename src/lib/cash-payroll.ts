/**
 * THE CASH PAYROLL (owner, 2026-11-07)
 *
 * His ask: "on payroll i want to add cash payroll below the main payroll, that
 * 2nd table for employees with no TIN number, so all that tax, transport ...
 * these doesn't considered because they get paid by cash ... there will be
 * separate print button too with approved by ... these spaces".
 *
 * The sheet he sent is his own Excel: CASH ON HAND FOR THE MONTH OF SEPTEMBER
 * 2019 E.C, then No. / Employee Name / Net pay / Signature, a TOTAL line and
 * Prepared by / Checked by / Approved by blanks under it. That is the whole
 * table: no basic salary, no pension, no income tax, no transport. Those
 * columns exist on the TIN payroll because the government needs them; a cash
 * employee has no TIN, so the money is one number the owner types.
 *
 * WHO IS IN IT
 *   • an attendance member, added from the picker (he keeps his fingerprint and
 *     stays on the paper attendance sheet), or
 *   • a name typed straight into the table, for the people who do not work
 *     regularly and never scan a finger ("i can write my new employees that
 *     their fingerprint isn't registered").
 *
 * A cash row of this MONTH removes that person from the TIN payroll of the same
 * month, because he is paid from the cash box. Next month, if he is not added
 * again, he is back on the TIN sheet: the decision is per month.
 *
 * RENAME: a member row shows the name from the attendance list, so renaming it
 * also renames the member (owner: "when i rename on that list also the
 * attendance staff member will be renamed"); a typed row is renamed on its own.
 */

export type CashPayrollRow = {
  id: number;
  memberId: number | null;
  name: string;
  netPay: number;
  note: string;
  paid: boolean;
  paidAt: string | null;
  /** True when the row follows an attendance member (rename syncs both). */
  fromAttendance: boolean;
  sortOrder: number;
};

export type CashPayrollSignoff = {
  preparedBy: string;
  checkedBy: string;
  approvedBy: string;
};

export const DEFAULT_CASH_SIGNOFF: CashPayrollSignoff = {
  preparedBy: "",
  checkedBy: "",
  approvedBy: "",
};

/** The label printed above the cash table, exactly as his Excel writes it. */
export function cashSheetTitle(monthLabel: string): string {
  return `CASH ON HAND FOR THE MONTH OF ${monthLabel.toUpperCase()}`;
}

/** Sum of the cash rows, rounded like money because it is money. */
export function cashTotal(rows: Array<Pick<CashPayrollRow, "netPay">>): number {
  const total = rows.reduce((sum, row) => sum + (Number(row.netPay) || 0), 0);
  return Math.round((total + Number.EPSILON) * 100) / 100;
}
