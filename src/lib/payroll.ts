import { earlyOutMinutesFor, etMinutes, lateMinutesFor, parseHHMM, type RoleShift } from "@/lib/attendance";

export type FormulaContext = Record<string, number>;

/**
 * Excel rounds a half away from zero (2,946.277 -> 2,946.28; 5,402.585 ->
 * 5,402.59). Binary floats make that last one look like 5,402.584999999, so a
 * tiny relative nudge is needed before Math.round or the government sheet is
 * one cent short. The nudge is far smaller than a real half cent.
 */
export function roundMoney(n: number): number {
  const value = Number(n) || 0;
  return Math.round((value + Math.sign(value) * 1e-9) * 100) / 100;
}

const TOKEN_RE = /\s*(<=|>=|<>|!=|=|<|>|[A-Za-z][A-Za-z0-9_]*|\d+(?:\.\d+)?|[(),+\-*/%])\s*/gy;

/**
 * Safe Excel-like payroll evaluator. It deliberately supports only numbers,
 * approved named fields, arithmetic, percentages, comparisons, IF() and the
 * two clamps MAX() / MIN() the owner's own minute rule uses. It never uses
 * eval/Function and therefore cannot execute code.
 *
 * `round` is false for the payroll's own money chain: Excel displays two
 * decimals but keeps every digit behind them, so rounding tax and pension
 * separately made the Total Deduction and Net Pay one cent different from his
 * sheet. The public wrapper still rounds, because that is what a formula
 * typed and validated by the owner should show.
 */
function evaluate(expression: string, context: FormulaContext, round: boolean): number {
  const source = String(expression || "").trim().replace(/^=/, "");
  if (!source) throw new Error("Formula is not configured");
  const tokens: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    TOKEN_RE.lastIndex = cursor;
    const match = TOKEN_RE.exec(source);
    if (!match || match.index !== cursor) throw new Error(`Invalid formula near “${source.slice(cursor, cursor + 12)}”`);
    tokens.push(match[1]); cursor = TOKEN_RE.lastIndex;
  }
  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];
  const primary = (): number => {
    const token = take();
    if (token === "(") { const value = comparison(); if (take() !== ")") throw new Error("Missing closing parenthesis"); return value; }
    if (token === "+") return primary();
    if (token === "-") return -primary();
    if (/^\d/.test(token || "")) return Number(token);
    if (/^[A-Za-z]/.test(token || "")) {
      const fn = token.toUpperCase();
      if (fn === "IF") {
        if (take() !== "(") throw new Error("IF must be followed by parentheses");
        const condition = comparison(); if (take() !== ",") throw new Error("IF needs a value when true");
        const whenTrue = comparison(); if (take() !== ",") throw new Error("IF needs a value when false");
        const whenFalse = comparison(); if (take() !== ")") throw new Error("IF has an invalid closing parenthesis");
        return condition ? whenTrue : whenFalse;
      }
      // MAX(0, LateMinutes - 20) is the owner's own "max(0, ...)" clamp. It is
      // a whitelist, not a general function call: nothing here can run code.
      if (fn === "MAX" || fn === "MIN") {
        if (take() !== "(") throw new Error(`${fn} must be followed by parentheses`);
        const values = [comparison()];
        while (peek() === ",") { take(); values.push(comparison()); }
        if (take() !== ")") throw new Error(`${fn} has an invalid closing parenthesis`);
        return fn === "MAX" ? Math.max(...values) : Math.min(...values);
      }
      if (!Object.prototype.hasOwnProperty.call(context, token)) throw new Error(`Unknown field: ${token}`);
      return Number(context[token]) || 0;
    }
    throw new Error("Incomplete formula");
  };
  const percentage = (): number => { let value = primary(); while (peek() === "%") { take(); value /= 100; } return value; };
  const multiplication = (): number => { let value = percentage(); while (peek() === "*" || peek() === "/") { const op=take(), right=percentage(); if(op==="/"&&right===0)throw new Error("Division by zero"); value=op==="*"?value*right:value/right; } return value; };
  const addition = (): number => { let value=multiplication(); while(peek()==="+"||peek()==="-"){const op=take(),right=multiplication();value=op==="+"?value+right:value-right;} return value; };
  function comparison(): number {
    const left=addition(), op=peek();
    if (!["<","<=",">",">=","=","!=","<>"].includes(op)) return left;
    take(); const right=addition();
    return Number(op==="<"?left<right:op==="<="?left<=right:op===">"?left>right:op===">="?left>=right:op==="="?left===right:left!==right);
  }
  const result=comparison();
  if(at!==tokens.length)throw new Error(`Unexpected token: ${peek()}`);
  if(!Number.isFinite(result))throw new Error("Formula did not produce a valid number");
  return round ? roundMoney(result) : result;
}

/** The validated, two-decimal result of one formula (settings preview, tests). */
export function evaluatePayrollFormula(expression: string, context: FormulaContext): number {
  return evaluate(expression, context, true);
}
/** Full precision, for a payslip that must match the owner's Excel exactly. */
export function evaluatePayrollFormulaExact(expression: string, context: FormulaContext): number {
  return evaluate(expression, context, false);
}

/** NetSalary is the optional take-home base; the shipped rule uses BasicSalary,
 *  the number the owner already types per employee. See
 *  netSalaryForMinuteRule below for exactly what NetSalary means. */
export const PAYROLL_VARIABLES = ["BasicSalary","TransportAllowance","GrossSalary","TaxableSalary","NetSalary","OvertimeHours","HolidayOtHours","FreeWeekOtHours","ShiftOtHours","ScheduledDays","ScheduledHours","DaysPresent","ApprovedAbsences","UnapprovedAbsences","LateCount","LateMinutes","EarlyOutCount","EarlyOutMinutes"] as const;
export type PayrollSettings={employerPensionRate:number;employeePensionRate:number;holidayOtFormula:string;freeWeekOtFormula:string;shiftOtFormula:string;incomeTaxFormula:string;absenceFormula:string;latenessFormula:string;earlyOutFormula:string;settingsApproved:boolean};
export const DEFAULT_INCOME_TAX_FORMULA="IF(TaxableSalary<=2000,0,IF(TaxableSalary<=4000,TaxableSalary*15%-300,IF(TaxableSalary<=7000,TaxableSalary*20%-500,IF(TaxableSalary<=10000,TaxableSalary*25%-850,IF(TaxableSalary<=14000,TaxableSalary*30%-1250,TaxableSalary*35%-2050)))))";
/** The formula fields the owner may edit. Everything else is a rate or a switch. */
export const PAYROLL_FORMULA_KEYS=["holidayOtFormula","freeWeekOtFormula","shiftOtFormula","incomeTaxFormula","absenceFormula","latenessFormula","earlyOutFormula"] as const;
export type PayrollFormulaKey=(typeof PAYROLL_FORMULA_KEYS)[number];
/** The three deduction boxes. An empty one is the owner's OFF switch. */
export const DEDUCTION_FORMULA_KEYS=["absenceFormula","latenessFormula","earlyOutFormula"] as const;

/* ── THE OWNER'S PER-MINUTE RULE (2026-10-27) ───────────────────────────────
 * He proposed: "assume an employee earns a net salary of 6,000 ETB per month"
 *   6,000 / 30 days = 200 ETB a day
 *   200 / 8 hours   = 25 ETB an hour
 *   25 / 60         = 0.4167 ETB a minute
 *   deduction = 0.4167 x max(0, late minutes - grace)
 * WHICH SALARY? The one he already types in the Basic Salary box. The three
 * overtime formulas pay BasicSalary / 30 / 8 per hour, so charging a missed
 * hour and paying an extra hour now use the SAME rate: 6,000 typed gives
 * exactly his 0.4167 ETB/min, with no second number to enter. NetSalary (the
 * take-home after tax and pension) is still an approved field, so changing
 * one word in the formula box switches the base to take-home pay. Net Pay
 * itself can never be the base: it is calculated after these deductions.
 * He also asked for early leaving to cost the same, with the grace taken from
 * each role's own "Maximum Late Time (min)" and "Leaving Grace (min)" instead
 * of a fixed 20 or 30. So:
 *   • the fixed grace in his formula is NOT in the formula. The attendance
 *     measurement already removes each role's own grace, per day, and the
 *     payroll receives `LateMinutes` / `EarlyOutMinutes` as CHARGEABLE minutes
 *     only (see lateMinutesFor / earlyOutMinutesFor in lib/attendance.ts).
 *   • MAX(0, ...) is kept because it is his own clamp and because a stored
 *     number from an old row can never make a deduction negative.
 *   • the exact fraction is used, never a pre-rounded 0.42: 40 minutes costs
 *     16.67 ETB, not 16.80 ETB. The result is rounded once, at the end.
 *   • absence now costs ONE FULL DAY of Basic Salary for each unapproved
 *     absence (2026-10-27): "if someone is absent the system will deduct the
 *     8 hour from his salary ... 6000/30 days and that daily value is their
 *     8 hour value". A day's wage IS eight hours here, so the formula is
 *     simply BasicSalary / 30 for that day. Approved leave and free days are
 *     already excluded before `UnapprovedAbsences` reaches the formula.
 *
 * These are defaults, not locked numbers: Formula Settings can edit or empty
 * them. Replace BasicSalary with NetSalary in the box to divide by the
 * take-home pay instead of the typed salary.
 */
export const PAYROLL_WORK_DAYS_PER_MONTH = 30;
export const PAYROLL_WORK_HOURS_PER_DAY = 8;
export const PAYROLL_MINUTES_PER_MONTH = PAYROLL_WORK_DAYS_PER_MONTH * PAYROLL_WORK_HOURS_PER_DAY * 60;
export const DEFAULT_LATENESS_FORMULA = `BasicSalary / ${PAYROLL_WORK_DAYS_PER_MONTH} / ${PAYROLL_WORK_HOURS_PER_DAY} / 60 * MAX(0, LateMinutes)`;
export const DEFAULT_EARLY_OUT_FORMULA = `BasicSalary / ${PAYROLL_WORK_DAYS_PER_MONTH} / ${PAYROLL_WORK_HOURS_PER_DAY} / 60 * MAX(0, EarlyOutMinutes)`;
/** One absent day loses the whole 8 hour day, never a fraction of it. */
export const DEFAULT_ABSENCE_FORMULA = `BasicSalary / ${PAYROLL_WORK_DAYS_PER_MONTH} * UnapprovedAbsences`;

/**
 * THE OWNER'S RATES (Oct 2026). Holiday work 2.5, a free week given up 2, a
 * second shift covered 1.5, all on BasicSalary / 30 / 8 per hour. They are
 * DEFAULTS, not laws: Formula Settings can change any of them, and a saved
 * empty overtime/tax formula falls back to these so a fresh install still
 * calculates instead of printing zeros. The lateness and early departure
 * boxes now ship with HIS minute rule, and absence with the one-day rule.
 */
export const DEFAULT_PAYROLL_FORMULAS:Record<PayrollFormulaKey,string>={
 holidayOtFormula:"BasicSalary / 30 / 8 * HolidayOtHours * 2.5",
 freeWeekOtFormula:"BasicSalary / 30 / 8 * FreeWeekOtHours * 2",
 shiftOtFormula:"BasicSalary / 30 / 8 * ShiftOtHours * 1.5",
 incomeTaxFormula:DEFAULT_INCOME_TAX_FORMULA,
 absenceFormula:DEFAULT_ABSENCE_FORMULA,
 latenessFormula:DEFAULT_LATENESS_FORMULA,
 earlyOutFormula:DEFAULT_EARLY_OUT_FORMULA,
};
export const DEFAULT_PAYROLL_SETTINGS:PayrollSettings={employerPensionRate:11,employeePensionRate:7,...DEFAULT_PAYROLL_FORMULAS,settingsApproved:false};
/**
 * A key an older install never stored gets the shipped rule. A box the owner
 * emptied ON PURPOSE is present in the saved settings with an empty string and
 * stays empty (that is his off switch, and it must survive the new defaults).
 * Empty overtime/tax boxes still fall back to the owner's rates.
 */
export function withDefaultPayrollFormulas(raw:Partial<PayrollSettings>|null|undefined):PayrollSettings{
 const source=(raw||{}) as Record<string,unknown>;
 const out={...DEFAULT_PAYROLL_SETTINGS,...source} as PayrollSettings;
 for(const key of PAYROLL_FORMULA_KEYS){
  const present=Object.prototype.hasOwnProperty.call(source,key);
  const value=String(source[key]??"").trim();
  if(present&&!value&&(DEDUCTION_FORMULA_KEYS as readonly string[]).includes(key)){out[key]="";continue;}
  out[key]=value||DEFAULT_PAYROLL_FORMULAS[key];
 }
 return out;
}
/**
 * The formulas a payroll cannot run without: the three overtime kinds and the
 * income tax. The deduction formulas are NOT here on purpose: they are the
 * owner's own rules, and an empty one simply deducts zero.
 */
export function requiredPayrollSettingsMissing(s:PayrollSettings):string[]{const m:string[]=[];if(!s.holidayOtFormula)m.push("Holiday OT formula");if(!s.freeWeekOtFormula)m.push("Free Week OT formula");if(!s.shiftOtFormula)m.push("Shift OT formula");if(!s.incomeTaxFormula)m.push("Income tax formula");return m;}

/**
 * OPTIONAL BASE. The "net salary" of the owner's example, in the money of
 * THIS payslip: take-home pay (gross minus income tax and the employee's
 * pension) BEFORE the attendance and breakage deductions and before any
 * starter/leaver proration. Net Pay itself cannot be used as the base: it is
 * calculated after these very deductions, so a formula that divides by it
 * would be circular. The shipped rule divides BasicSalary instead, because
 * that is the number the owner types and the number the overtime rates use.
 */
export function netSalaryForMinuteRule(gross:number,incomeTax:number,employeePension:number):number{
 return Math.max(0,Number(gross||0)-Number(incomeTax||0)-Number(employeePension||0));
}
/** The exact per-minute rate for whichever salary base a formula uses. */
export function minuteDeductionRate(salaryBase:number):number{
 return (Number(salaryBase)||0)/PAYROLL_MINUTES_PER_MONTH;
}
/**
 * One bad day may cost at most one day's wage. Counting a 10 hour lateness and
 * a 10 hour early departure on the same day would take two days of pay for one
 * day's work, so the chargeable minutes of a single log are capped at the 8
 * hours the rate itself assumes. Lateness is counted first, then whatever is
 * left of the cap may be charged for leaving early.
 */
export const MAX_CHARGEABLE_MINUTES_PER_DAY=PAYROLL_WORK_HOURS_PER_DAY*60;
export function chargeableDayMinutes(rawLate:number,rawEarly:number):{late:number;early:number}{
 const late=Math.max(0,Math.min(MAX_CHARGEABLE_MINUTES_PER_DAY,Math.round(Number(rawLate)||0)));
 const early=Math.max(0,Math.min(MAX_CHARGEABLE_MINUTES_PER_DAY-late,Math.round(Number(rawEarly)||0)));
 return{late,early};
}

/* ── THE EXCEL MONEY CHAIN (owner, 2026-10-27) ──────────────────────────────
 * "my system must give same result as the excel they used to use". His sheet
 * (FANA PAYROLL, July 2018 E.C) computes:
 *   11%            = BasicSalary * 11%              (employer pension)
 *   Gross Salary   = BasicSalary + Transport + OT
 *   Taxable Salary = Gross Salary - Transport       (transport is not taxed)
 *   Income tax     = the approved bracket formula on Taxable Salary
 *   P.C 7%         = BasicSalary * 7%               (employee pension)
 *   P.C 18%        = 11% + 7%                       (shown, never deducted)
 *   Total Deduction= Income tax + P.C 7% + Breakage + attendance deductions
 *   Net pay        = Gross Salary - Total Deduction
 * The important detail is PRECISION: Excel shows two decimals but keeps every
 * digit behind them. Rounding tax and pension separately made our Total
 * Deduction 5,546.84 and Net pay 9,040.75 where his sheet says 5,546.83 and
 * 9,040.76. So every step here stays exact; only `display` is rounded, once,
 * for the paper and the screen.
 */
export type PayrollMoneyInputs={
 basicSalary:number;
 transportAllowance:number;
 breakageShortage:number;
 settings:PayrollSettings;
 /** The attendance fields the editable formulas may reference. */
 attendance?:Partial<Record<(typeof PAYROLL_VARIABLES)[number],number>>;
 prorationFactor?:number;
};
export type PayrollMoneyValues={
 overtimeHours:number;
 holidayOtPay:number;freeWeekOtPay:number;shiftOtPay:number;overtimePay:number;
 grossSalary:number;taxableSalary:number;
 employerPension:number;employeePension:number;totalPension:number;
 incomeTax:number;netSalary:number;
 absenceDeduction:number;latenessDeduction:number;earlyOutDeduction:number;
 totalDeduction:number;fullMonthNetPay:number;netPay:number;
};
const money2=roundMoney;
export function computePayrollMoney(input:PayrollMoneyInputs):{raw:PayrollMoneyValues;display:PayrollMoneyValues;context:FormulaContext}{
 const a=input.attendance||{};
 const num=(v:unknown)=>Number(v)||0;
 const s=input.settings;
 const holidayHours=num(a.HolidayOtHours),freeWeekHours=num(a.FreeWeekOtHours),shiftHours=num(a.ShiftOtHours);
 const context:FormulaContext={
  BasicSalary:num(input.basicSalary),
  TransportAllowance:num(input.transportAllowance),
  GrossSalary:0,TaxableSalary:0,NetSalary:0,
  OvertimeHours:holidayHours+freeWeekHours+shiftHours,
  HolidayOtHours:holidayHours,FreeWeekOtHours:freeWeekHours,ShiftOtHours:shiftHours,
  ScheduledDays:num(a.ScheduledDays),ScheduledHours:num(a.ScheduledHours),DaysPresent:num(a.DaysPresent),
  ApprovedAbsences:num(a.ApprovedAbsences),UnapprovedAbsences:num(a.UnapprovedAbsences),
  LateCount:num(a.LateCount),LateMinutes:num(a.LateMinutes),
  EarlyOutCount:num(a.EarlyOutCount),EarlyOutMinutes:num(a.EarlyOutMinutes),
 };
 // Empty formula = no money. A bad formula is a zero, never a crash on a
 // government-facing sheet. Math.max keeps a deduction from going negative.
 const calc=(f:string)=>{try{return f?Math.max(0,evaluatePayrollFormulaExact(f,context)):0;}catch{return 0;}};
 const holidayOtPay=calc(s.holidayOtFormula);
 const freeWeekOtPay=calc(s.freeWeekOtFormula);
 const shiftOtPay=calc(s.shiftOtFormula);
 const overtimePay=holidayOtPay+freeWeekOtPay+shiftOtPay;
 const grossSalary=context.BasicSalary+context.TransportAllowance+overtimePay;
 context.GrossSalary=grossSalary;
 const taxableSalary=grossSalary-context.TransportAllowance;
 context.TaxableSalary=taxableSalary;
 const employerPension=context.BasicSalary*num(s.employerPensionRate)/100;
 const employeePension=context.BasicSalary*num(s.employeePensionRate)/100;
 const incomeTax=calc(s.incomeTaxFormula);
 const netSalary=netSalaryForMinuteRule(grossSalary,incomeTax,employeePension);
 context.NetSalary=netSalary;
 const absenceDeduction=calc(s.absenceFormula);
 const latenessDeduction=calc(s.latenessFormula);
 const earlyOutDeduction=calc(s.earlyOutFormula);
 const totalDeduction=incomeTax+employeePension+num(input.breakageShortage)+absenceDeduction+latenessDeduction+earlyOutDeduction;
 const fullMonthNetPay=grossSalary-totalDeduction;
 const netPay=fullMonthNetPay*num(input.prorationFactor??1);
 const raw:PayrollMoneyValues={
  overtimeHours:context.OvertimeHours,
  holidayOtPay,freeWeekOtPay,shiftOtPay,overtimePay,grossSalary,taxableSalary,
  employerPension,employeePension,totalPension:employerPension+employeePension,
  incomeTax,netSalary,absenceDeduction,latenessDeduction,earlyOutDeduction,
  totalDeduction,fullMonthNetPay,netPay,
 };
 const display=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,money2(v)])) as PayrollMoneyValues;
 return{raw,display,context};
}

/* ── the printed government sheet's letterhead ─────────────────────────────
 * Copied from the owner's Excel (FANA PAYROLL, July 2018 E.C): the PLC name,
 * "Payroll Sheet", the month, and the TIN on the right. Both strings are
 * editable in Formula Settings (site_settings keys payroll_company_name and
 * payroll_tin) so a fresh install still prints a correct header on day one.
 */
export const DEFAULT_PAYROLL_LETTERHEAD={companyName:"FANA CAFÉ & RESTAURANT PLC",tin:"00 85 22 21 19"};
export const ETHIOPIAN_MONTH_NAMES=["Meskerem","Tikimt","Hidar","Tahsas","Tir","Yekatit","Megabit","Miazia","Ginbot","Sene","Hamle","Nehase","Pagume"] as const;
/** "2019-02" -> "Tikimt 2019 E.C" for the printed sheet's month line. */
export function payrollPeriodLabel(period:string):string{
 const [year,month]=String(period||"").split("-").map(Number);
 if(!Number.isInteger(year)||!Number.isInteger(month)||month<1||month>13)return String(period||"");
 return `${ETHIOPIAN_MONTH_NAMES[month-1]} ${year} E.C`;
}

/* ─── honoring a worked holiday, a free week and a covered shift ─────────────
 * The owner (Oct 2026): "the system calculates, the supervisor only adds the
 * salary, the breakage and shortage, the overtime, the exceptions when the
 * employee gives a reasonable reason". So the three overtime kinds are
 * measured from the scans he already takes:
 *
 *   holiday    a day the owner registered with a name (Holiday dates button)
 *              and on which the person has a completed scan;
 *   free_week  a date that is in the person's own free schedule and on which
 *              he still worked;
 *   shift      a normal working day where he stayed past the end of his shift.
 *
 * 2026-10-28, the owner's final version of all of this:
 *   • the buffer is 1:15 (75 min), for ALL THREE kinds. "they will stay doing
 *     transferring, change cloth and other and sometimes they stay maximum of
 *     1:15 hour ... if that person scan his finger in 9:00 he will get
 *     undeserved 1:15 hour". Past the buffer the whole time past the end pays.
 *   • a worked holiday / free day is paid by the TOTAL TIME WORKED, measured
 *     on the shift with that ROLE's own Maximum Late Time and Leaving Grace:
 *     "if that person in 12:30 and left 9:00 he will earn 8 hour if he can
 *     late upto 30 min in his role time interval ... if he has 20 min only max
 *     late time and he late 30 min he get 7:50 ... what depends is his role
 *     maximum late and early time". So a late minute inside the role grace is
 *     paid, and only the chargeable minutes past it are lost.
 *   • "only if they excede 1 hour barrier": a visit shorter than an hour is
 *     not overtime at all, so a quick errand cannot earn a whole shift.
 *   • a second shift (more than the normal 8 h worked in one day) is Shift OT
 *     by workedShiftOtMinutes in lib/attendance.ts.
 */
export const OT_ARRIVAL_GRACE_MINUTES=30; // fallback when a role has no Maximum Late Time
export const OT_BUFFER_MINUTES=75;
export const OT_MIN_WORK_MINUTES=60;
/** A scan line from the attendance sheet: camelCase from the app, snake_case
 *  straight out of the database query. Both are accepted, so a caller can pass
 *  the row it already has instead of rebuilding it. */
export type OvertimeLogLike={clockIn?:Date|string|null;clockOut?:Date|string|null;totalMinutes?:number|null;clock_in?:Date|string|null;clock_out?:Date|string|null;total_minutes?:number|null};
export function recognizedOtMinutes(shift:RoleShift|null|undefined,log:OvertimeLogLike|null|undefined):number{
 if(!log)return 0;
 const clockIn=log.clockIn??log.clock_in??null;
 const clockOut=log.clockOut??log.clock_out??null;
 const totalMinutes=log.totalMinutes??log.total_minutes??null;
 if(!clockIn||!clockOut){
  // Half a day is no proof of hours. A stored total (the paper sheet's own
  // number) is still measured, so an old closed day keeps its hours.
  const stored=Math.round(Number(totalMinutes)||0);
  return stored>0?Math.min(stored,24*60):0;
 }
 const inM=etMinutes(clockIn),outM=etMinutes(clockOut);
 const start=parseHHMM(shift?.startTime??null),endRaw=parseHHMM(shift?.endTime??null);
 if(start===null||endRaw===null){
  // No role times: the hours between the two scans are all we know.
  const worked=outM>=inM?outM-inM:outM+24*60-inM;
  return Math.min(24*60,Math.max(0,worked));
 }
 const crossesMidnight=endRaw<=start;
 const end=crossesMidnight?endRaw+24*60:endRaw;
 const inShifted=crossesMidnight&&inM<start?inM+24*60:inM;
 const outShifted=crossesMidnight&&outM<start?outM+24*60:outM;
 if(outShifted<=inShifted)return 0;
 const worked=outShifted-inShifted;
 // The 1 hour barrier: a short visit is not a worked holiday / free day.
 if(worked<OT_MIN_WORK_MINUTES)return 0;
 if(inShifted>=end){
  // Came in after the shift had ended. Everything he actually worked is the
  // overtime, but the 1:15 clothing/transfer buffer is still removed.
  return worked>OT_BUFFER_MINUTES?Math.min(24*60,Math.round(worked)):0;
 }
 // The role's OWN grace: a late minute inside Maximum Late Time is paid, and
 // an early minute inside Leaving Grace is paid. Only chargeable minutes are
 // removed from the shift, so a 20 min grace with a 30 min lateness loses 10
 // minutes (8:00 becomes 7:50), exactly the owner's example.
 const roleShift: RoleShift={
  ...(shift||{label:"",startTime:"",endTime:""}),
  lateGraceMinutes:shift?.lateGraceMinutes??OT_ARRIVAL_GRACE_MINUTES,
  earlyLeaveGraceMinutes:shift?.earlyLeaveGraceMinutes??0,
 };
 const late=lateMinutesFor(roleShift,inM);
 const early=earlyOutMinutesFor(roleShift,outM);
 const shiftLength=Math.max(0,end-start);
 const base=Math.max(0,shiftLength-late-early);
 const past=outShifted-end;
 const extra=past>OT_BUFFER_MINUTES?past:0;
 return Math.min(24*60,Math.round(base+extra));
}
/** Minutes -> the hours a payroll formula multiplies, rounded like money. */
export function minutesToHours(minutes:number):number{return Math.round(((Number(minutes)||0)/60+Number.EPSILON)*100)/100;}


export function ethiopianMonthBounds(year:number,month:number):{from:string;to:string}{
  if(!Number.isInteger(year)||year<1900||year>2200||!Number.isInteger(month)||month<1||month>13)throw new Error("Invalid Ethiopian payroll month");
  const formatter=new Intl.DateTimeFormat("en-u-ca-ethiopic",{year:"numeric",month:"numeric",day:"numeric",timeZone:"Africa/Addis_Ababa"});
  const matches=(d:Date)=>{const p=Object.fromEntries(formatter.formatToParts(d).map(x=>[x.type,x.value]));return Number(p.year)===year&&Number(p.month)===month;};
  const scanStart=new Date(Date.UTC(year+7,7,1));let first:Date|null=null,last:Date|null=null;
  for(let offset=0;offset<=430;offset++){const d=new Date(scanStart);d.setUTCDate(d.getUTCDate()+offset);if(matches(d)){if(!first||d<first)first=d;if(!last||d>last)last=d;}}
  if(!first||!last)throw new Error("Could not map that Ethiopian month");
  return{from:first.toISOString().slice(0,10),to:last.toISOString().slice(0,10)};
}

/** Convert an Ethiopian YYYY-MM-DD date entered by the owner to the stored Gregorian day key. */
export function ethiopianDateToGregorian(value:string):string {
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value||"").trim());
  if(!match)throw new Error("Use Ethiopian date YYYY-MM-DD");
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  const bounds=ethiopianMonthBounds(year,month);
  const length=Math.round((Date.parse(bounds.to)-Date.parse(bounds.from))/86400000)+1;
  if(day<1||day>length)throw new Error(`That Ethiopian month has ${length} days`);
  return new Date(Date.parse(bounds.from)+(day-1)*86400000).toISOString().slice(0,10);
}

/** Display a stored Gregorian attendance day as Ethiopian YYYY-MM-DD. */
export function gregorianDateToEthiopian(value:string):string {
  const date=new Date(`${value}T12:00:00Z`);
  if(Number.isNaN(date.getTime()))return value;
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-u-ca-ethiopic",{year:"numeric",month:"2-digit",day:"2-digit",timeZone:"Africa/Addis_Ababa"}).formatToParts(date).map(p=>[p.type,p.value]));
  return `${parts.year}-${String(parts.month).padStart(2,"0")}-${String(parts.day).padStart(2,"0")}`;
}

/** The Ethiopian month the owner is standing in, as YYYY-MM. */
export function currentEthiopianPeriod(now: Date = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-u-ca-ethiopic", { year: "numeric", month: "numeric", timeZone: "Africa/Addis_Ababa" })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${String(parts.month).padStart(2, "0")}`;
}
