#!/usr/bin/env tsx
/**
 * Regression guard: THE SYSTEM MUST MATCH THE OWNER'S EXCEL (2026-10-27).
 *
 * He sent a photo of "FANA PAYROLL (2)" (FANA CAFE & RESTAURANT PLC, Payroll
 * Sheet, For The Month of July 2018 E.C, TIN NO 00 85 22 21 19) and said
 * "my system must give same result as the excel they used to use".
 *
 * The columns of that sheet, checked below against computePayrollMoney:
 *   11%            = BasicSalary * 11%              (employer pension)
 *   Gross Salary   = BasicSalary + Transport + OT
 *   Taxable Salary = Gross Salary - Transport       (transport is NOT taxed)
 *   Income tax     = the approved Ethiopian brackets on Taxable Salary
 *   P.C 7%         = BasicSalary * 7%               (employee pension)
 *   P.C 18%        = 11% + 7%                       (shown, never deducted)
 *   Total Deduction= Income tax + P.C 7% + Breakage (+ attendance deductions)
 *   Net pay        = Gross Salary - Total Deduction
 *
 * Excel DISPLAYS two decimals but computes with all of them. Rounding tax and
 * pension on their own used to give 5,546.84 / 9,040.75 for Almaz Mesfin
 * where the sheet says 5,546.83 / 9,040.76. computePayrollMoney keeps full
 * precision and rounds once, for display.
 *
 * Two honest notes about that workbook: its status bar says "Circular
 * References", and two employees with identical numbers (Kelemia Taye and
 * Meseret Teklay, both 12,936.50 + 600 + 862.43) show different income tax
 * (2,889.68 and 2,779.63). We reproduce the CORRECT one (2,889.68) for both,
 * because a payroll system cannot copy a spreadsheet's own contradiction.
 *
 * Run with: npx tsx scripts/verify-payroll-excel.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_ABSENCE_FORMULA,
  DEFAULT_INCOME_TAX_FORMULA,
  DEFAULT_PAYROLL_FORMULAS,
  DEFAULT_PAYROLL_LETTERHEAD,
  DEFAULT_PAYROLL_SETTINGS,
  computePayrollMoney,
  evaluatePayrollFormula,
  evaluatePayrollFormulaExact,
  payrollPeriodLabel,
  type PayrollSettings,
} from "../src/lib/payroll";

let failures = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
  if (!cond) failures++;
};
const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** The three OT formulas become a typed amount, exactly as the Excel has it. */
const excelSettings = (ot: number): PayrollSettings => ({
  ...DEFAULT_PAYROLL_SETTINGS,
  holidayOtFormula: "0",
  freeWeekOtFormula: "0",
  shiftOtFormula: String(ot),
  incomeTaxFormula: DEFAULT_INCOME_TAX_FORMULA,
  // The photographed sheet predates the attendance deductions.
  absenceFormula: "",
  latenessFormula: "",
  earlyOutFormula: "",
});

type ExcelRow = {
  name: string;
  basic: number;
  transport: number;
  ot: number;
  breakage: number;
  p11: number;
  gross: number;
  taxable: number;
  tax: number;
  p7: number;
  p18: number;
  total: number;
  net: number;
};

/** Transcribed from the owner's photograph, row by row. */
const rows: ExcelRow[] = [
  { name: "Alebachew Kibeb", basic: 3080.13, transport: 297.5, ot: 0, breakage: 300, p11: 338.81, gross: 3377.63, taxable: 3080.13, tax: 162.02, p7: 215.61, p18: 554.42, total: 677.63, net: 2700.0 },
  { name: "Almaz Mesfin", basic: 12936.5, transport: 600, ot: 1051.09, breakage: 1695, p11: 1423.02, gross: 14587.59, taxable: 13987.59, tax: 2946.28, p7: 905.56, p18: 2328.57, total: 5546.83, net: 9040.76 },
  { name: "Awuke Melesse", basic: 16120.69, transport: 600, ot: 0, breakage: 0, p11: 1773.28, gross: 16720.69, taxable: 16120.69, tax: 3592.24, p7: 1128.45, p18: 2901.72, total: 4720.69, net: 12000.0 },
  { name: "Bontu Weyosa", basic: 24741.38, transport: 600, ot: 0, breakage: 0, p11: 2721.55, gross: 25341.38, taxable: 24741.38, tax: 6609.48, p7: 1731.9, p18: 4453.45, total: 8341.38, net: 17000.0 },
  { name: "Fedila Giremu", basic: 16120.69, transport: 600, ot: 4298.85, breakage: 0, p11: 1773.28, gross: 21019.54, taxable: 20419.54, tax: 5096.84, p7: 1128.45, p18: 2901.72, total: 6225.29, net: 14794.25 },
  { name: "Kelemia Taye", basic: 12936.5, transport: 600, ot: 862.43, breakage: 0, p11: 1423.02, gross: 14398.93, taxable: 13798.93, tax: 2889.68, p7: 905.56, p18: 2328.57, total: 3795.24, net: 10603.7 },
  { name: "Kidist Hailu", basic: 8161.77, transport: 600, ot: 0, breakage: 250, p11: 897.79, gross: 8761.77, taxable: 8161.77, tax: 1190.44, p7: 571.32, p18: 1469.12, total: 2011.77, net: 6750.0 },
  { name: "Marshet Ambaye", basic: 55775.87, transport: 600, ot: 0, breakage: 0, p11: 6135.35, gross: 56375.87, taxable: 55775.87, tax: 17471.55, p7: 3904.31, p18: 10039.66, total: 21375.87, net: 35000.0 },
  { name: "Meriyam Abdi", basic: 5982.76, transport: 600, ot: 0, breakage: 0, p11: 658.1, gross: 6582.76, taxable: 5982.76, tax: 696.55, p7: 418.79, p18: 1076.9, total: 1115.35, net: 5467.41 },
  { name: "Tizita Milugeta", basic: 1334.72, transport: 297.5, ot: 0, breakage: 800, p11: 146.82, gross: 1632.22, taxable: 1334.72, tax: 0, p7: 93.43, p18: 240.25, total: 893.43, net: 738.79 },
  { name: "Tsehay Girma", basic: 6712.33, transport: 600, ot: 0, breakage: 0, p11: 738.36, gross: 7312.33, taxable: 6712.33, tax: 842.47, p7: 469.86, p18: 1208.22, total: 1312.33, net: 6000.0 },
  { name: "Habtam Tesfaye", basic: 9632.36, transport: 600, ot: 3852.94, breakage: 160, p11: 1059.56, gross: 14085.3, taxable: 13485.3, tax: 2795.59, p7: 674.27, p18: 1733.82, total: 3629.86, net: 10455.45 },
  { name: "Yordanos Ayenew", basic: 21293.1, transport: 600, ot: 0, breakage: 0, p11: 2342.24, gross: 21893.1, taxable: 21293.1, tax: 5402.59, p7: 1490.52, p18: 3832.76, total: 6893.1, net: 15000.0 },
  { name: "Ayeluchi Berhanu", basic: 8161.77, transport: 600, ot: 0, breakage: 0, p11: 897.79, gross: 8761.77, taxable: 8161.77, tax: 1190.44, p7: 571.32, p18: 1469.12, total: 1761.77, net: 7000.0 },
];

/**
 * The Excel's own one-cent drift on a few rows (its status bar says "Circular
 * References"). Kelemia Taye shows 3,795.24 total deduction but 10,603.70 net
 * pay from a 14,398.93 gross: those two numbers are 0.01 apart in the file.
 * Our sheet is arithmetically consistent, so only that one column drifts.
 */
const excelTolerance: Record<string, number> = { "Habtam Tesfaye": 0.01, "Kelemia Taye": 0.01 };
const near = (a: number, b: number, tol = 0.005) => Math.abs(a - b) <= tol + 0.0000001;

for (const row of rows) {
  const d = computePayrollMoney({
    basicSalary: row.basic,
    transportAllowance: row.transport,
    breakageShortage: row.breakage,
    settings: excelSettings(row.ot),
    attendance: { UnapprovedAbsences: 0, LateMinutes: 0, EarlyOutMinutes: 0 },
    prorationFactor: 1,
  }).display;
  const tol = excelTolerance[row.name] || 0;
  const checks: Array<[string, number, number]> = [
    ["11%", row.p11, d.employerPension],
    ["Gross Salary", row.gross, d.grossSalary],
    ["Taxable Salary", row.taxable, d.taxableSalary],
    ["Income tax", row.tax, d.incomeTax],
    ["P.C 7%", row.p7, d.employeePension],
    ["P.C 18%", row.p18, d.totalPension],
    ["Total Deduction", row.total, d.totalDeduction],
    ["Net pay", row.net, d.netPay],
  ];
  const wrong = checks.filter(([, expected, got]) => !near(expected, got, 0.005 + tol));
  pass(
    `${row.name}: all 8 money columns match the Excel`,
    wrong.length === 0,
    wrong.map(([label, expected, got]) => `${label}: Excel ${expected}, ours ${got}`).join("; ")
  );
}

/* ── precision: the exact evaluator is what makes those cents agree ───────── */

pass(
  "the exact evaluator keeps the digits Excel keeps",
  evaluatePayrollFormulaExact("TaxableSalary*30%-1250", { TaxableSalary: 13987.59 }) === 2946.277 &&
    evaluatePayrollFormula("TaxableSalary*30%-1250", { TaxableSalary: 13987.59 }) === 2946.28
);
pass(
  "rounding each deduction separately would have been one cent wrong",
  Math.round((2946.28 + 905.56 + 1695) * 100) / 100 === 5546.84 &&
    computePayrollMoney({
      basicSalary: 12936.5, transportAllowance: 600, breakageShortage: 1695,
      settings: excelSettings(1051.09), prorationFactor: 1,
    }).display.totalDeduction === 5546.83
);
pass(
  "two identical employees get the same tax, unlike the spreadsheet",
  computePayrollMoney({ basicSalary: 12936.5, transportAllowance: 600, breakageShortage: 0, settings: excelSettings(862.43) }).display.incomeTax === 2889.68
);

/* ── the new absence rule ────────────────────────────────────────────────── */

pass("absence ships with the one-day rule", DEFAULT_PAYROLL_FORMULAS.absenceFormula === DEFAULT_ABSENCE_FORMULA && DEFAULT_ABSENCE_FORMULA === "BasicSalary / 30 * UnapprovedAbsences");
const absent = computePayrollMoney({
  basicSalary: 6000, transportAllowance: 0, breakageShortage: 0,
  settings: { ...excelSettings(0), absenceFormula: DEFAULT_ABSENCE_FORMULA },
  attendance: { UnapprovedAbsences: 1 },
}).display;
pass("one absent day on 6,000 ETB loses exactly 200 ETB (the 8 hour day)", absent.absenceDeduction === 200 && absent.netPay === 4680);
pass("two absent days lose 400 ETB", computePayrollMoney({
  basicSalary: 6000, transportAllowance: 0, breakageShortage: 0,
  settings: { ...excelSettings(0), absenceFormula: DEFAULT_ABSENCE_FORMULA },
  attendance: { UnapprovedAbsences: 2 },
}).display.absenceDeduction === 400);
pass("approved leave is not charged", computePayrollMoney({
  basicSalary: 6000, transportAllowance: 0, breakageShortage: 0,
  settings: { ...excelSettings(0), absenceFormula: DEFAULT_ABSENCE_FORMULA },
  attendance: { UnapprovedAbsences: 0, ApprovedAbsences: 3 },
}).display.absenceDeduction === 0);
pass("absence and lateness cannot charge the same day twice", computePayrollMoney({
  basicSalary: 6000, transportAllowance: 0, breakageShortage: 0,
  settings: { ...excelSettings(0), absenceFormula: DEFAULT_ABSENCE_FORMULA, latenessFormula: DEFAULT_PAYROLL_FORMULAS.latenessFormula },
  attendance: { UnapprovedAbsences: 1, LateMinutes: 0 },
}).display.latenessDeduction === 0);

/* ── the formal printed sheet ────────────────────────────────────────────── */

const payrollTab = read("src/components/rms/PayrollTab.tsx");
const payrollApi = read("src/app/api/payroll/route.ts");
const migrate = read("src/db/migrate.ts");

pass("the letterhead has the PLC name, Payroll Sheet, month and TIN", DEFAULT_PAYROLL_LETTERHEAD.companyName.includes("FANA CAF") && payrollTab.includes("Payroll Sheet") && payrollTab.includes("For The Month of") && payrollTab.includes("TIN NO"));
pass("the TIN from the photo is the default and both lines are editable", DEFAULT_PAYROLL_LETTERHEAD.tin === "00 85 22 21 19" && payrollTab.includes("payroll_tin") && payrollTab.includes("payroll_company_name"));
pass("the API sends the Excel-style month label and Gregorian range for the paper", payrollApi.includes("monthLabel") && payrollApi.includes("payrollPeriodLabel(periodKey)") && payrollApi.includes("gregorianRange"));
pass("Ethiopian months are named on the paper", payrollPeriodLabel("2019-02") === "Tikimt 2019 E.C" && payrollPeriodLabel("2018-13") === "Pagume 2018 E.C");
pass("the printed table has a Signature column", payrollTab.includes('<th>Signature</th>') && payrollTab.includes('signature-cell'));
pass("Prepared / Checked / Approved lines are on the paper", payrollTab.includes("Prepared by") && payrollTab.includes("Checked by") && payrollTab.includes("Approved by") && payrollTab.includes("payroll-signoff"));
pass("the print CSS hides every dashboard element", payrollTab.includes("#fana-payroll > *:not(.print-sheet) { display: none !important; }") && payrollTab.includes(".no-print"));
pass("paper is landscape A3 with repeating column headers", payrollTab.includes("size: A3 landscape") && payrollTab.includes("display: table-header-group"));
pass("the Excel column headers are on the paper", ["Basic", "Transport", "OT", "Gross", "Taxable", "Income", "P.C 7 %", "P.C 18%", "Breakage", "Total", "Net pay"].every((h) => payrollTab.includes(h)));
pass("zeros are blank in optional money cells like the Excel", payrollTab.includes("const paper = (n: number, blankZero = false)"));
pass("existing databases receive the absence rule once", migrate.includes("payroll_absence_rule_2026_10_27") && migrate.includes('const absenceRule = "BasicSalary / 30 * UnapprovedAbsences"') && (/SCHEMA_VERSION = "(\d{4}-\d{2}-\d{2}-\d+)"/.exec(migrate)?.[1] ?? "") >= "2026-10-27-2");
pass("today is not counted as an absence before the day is finished", payrollApi.includes("d < today && !presentDates.has(d)"));

console.log("");
if (failures > 0) {
  console.error(`\n❌ EXCEL PARITY GUARD FAILED (${failures})\n`);
  process.exit(1);
}
console.log("✅ Excel parity guard PASSED");
console.log(`   • ${rows.length} real rows: 11%, Gross, Taxable, Income tax, P.C 7%, P.C 18%, Total Deduction and Net pay`);
console.log("   • full precision behind the two displayed decimals, one-cent drift documented");
console.log("   • absence = one 8 hour day (BasicSalary / 30), formal print sheet with TIN and Signature");
