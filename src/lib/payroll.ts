import { etMinutes, parseHHMM, type RoleShift } from "@/lib/attendance";

export type FormulaContext = Record<string, number>;

const TOKEN_RE = /\s*(<=|>=|<>|!=|=|<|>|[A-Za-z][A-Za-z0-9_]*|\d+(?:\.\d+)?|[(),+\-*/%])\s*/gy;

/**
 * Safe Excel-like payroll evaluator. It deliberately supports only numbers,
 * approved named fields, arithmetic, percentages, comparisons and IF(). It
 * never uses eval/Function and therefore cannot execute code.
 */
export function evaluatePayrollFormula(expression: string, context: FormulaContext): number {
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
      if (token.toUpperCase() === "IF") {
        if (take() !== "(") throw new Error("IF must be followed by parentheses");
        const condition = comparison(); if (take() !== ",") throw new Error("IF needs a value when true");
        const whenTrue = comparison(); if (take() !== ",") throw new Error("IF needs a value when false");
        const whenFalse = comparison(); if (take() !== ")") throw new Error("IF has an invalid closing parenthesis");
        return condition ? whenTrue : whenFalse;
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
  return Math.round((result+Number.EPSILON)*100)/100;
}

export const PAYROLL_VARIABLES = ["BasicSalary","TransportAllowance","GrossSalary","TaxableSalary","OvertimeHours","HolidayOtHours","FreeWeekOtHours","ShiftOtHours","ScheduledDays","ScheduledHours","DaysPresent","ApprovedAbsences","UnapprovedAbsences","LateCount","LateMinutes","EarlyOutCount","EarlyOutMinutes"] as const;
export type PayrollSettings={employerPensionRate:number;employeePensionRate:number;holidayOtFormula:string;freeWeekOtFormula:string;shiftOtFormula:string;incomeTaxFormula:string;absenceFormula:string;latenessFormula:string;earlyOutFormula:string;settingsApproved:boolean};
export const DEFAULT_INCOME_TAX_FORMULA="IF(TaxableSalary<=2000,0,IF(TaxableSalary<=4000,TaxableSalary*15%-300,IF(TaxableSalary<=7000,TaxableSalary*20%-500,IF(TaxableSalary<=10000,TaxableSalary*25%-850,IF(TaxableSalary<=14000,TaxableSalary*30%-1250,TaxableSalary*35%-2050)))))";
/** The formula fields the owner may edit. Everything else is a rate or a switch. */
export const PAYROLL_FORMULA_KEYS=["holidayOtFormula","freeWeekOtFormula","shiftOtFormula","incomeTaxFormula","absenceFormula","latenessFormula","earlyOutFormula"] as const;
export type PayrollFormulaKey=(typeof PAYROLL_FORMULA_KEYS)[number];
/**
 * THE OWNER'S RATES (payroll improvement, Oct 2026). He gave the formulas in
 * his own words: holiday work 2.5, a free week given up 2, a second shift
 * covered 1.5, all on BasicSalary / 30 / 8 per hour. They are DEFAULTS, not
 * laws: Formula Settings can change any of them, and a saved empty formula
 * falls back to these, so a fresh install (or an old one whose formulas were
 * never written) still calculates instead of printing zeros.
 */
export const DEFAULT_PAYROLL_FORMULAS:Record<PayrollFormulaKey,string>={
 holidayOtFormula:"BasicSalary / 30 / 8 * HolidayOtHours * 2.5",
 freeWeekOtFormula:"BasicSalary / 30 / 8 * FreeWeekOtHours * 2",
 shiftOtFormula:"BasicSalary / 30 / 8 * ShiftOtHours * 1.5",
 incomeTaxFormula:DEFAULT_INCOME_TAX_FORMULA,
 absenceFormula:"BasicSalary / 30 * UnapprovedAbsences",
 latenessFormula:"BasicSalary / 30 / 8 / 60 * LateMinutes",
 earlyOutFormula:"BasicSalary / 30 / 8 / 60 * EarlyOutMinutes",
};
export const DEFAULT_PAYROLL_SETTINGS:PayrollSettings={employerPensionRate:11,employeePensionRate:7,...DEFAULT_PAYROLL_FORMULAS,settingsApproved:false};
/** A saved settings row with an empty formula means "use the owner's default". */
export function withDefaultPayrollFormulas(raw:Partial<PayrollSettings>|null|undefined):PayrollSettings{const out={...DEFAULT_PAYROLL_SETTINGS,...(raw||{})};for(const key of PAYROLL_FORMULA_KEYS){if(!String(out[key]||"").trim())out[key]=DEFAULT_PAYROLL_FORMULAS[key];}return out;}
export function requiredPayrollSettingsMissing(s:PayrollSettings):string[]{const m:string[]=[];if(!s.holidayOtFormula)m.push("Holiday OT formula");if(!s.freeWeekOtFormula)m.push("Free Week OT formula");if(!s.shiftOtFormula)m.push("Shift OT formula");if(!s.incomeTaxFormula)m.push("Income tax formula");if(!s.absenceFormula)m.push("Absence deduction formula");if(!s.latenessFormula)m.push("Lateness deduction formula");if(!s.earlyOutFormula)m.push("Early departure deduction formula");return m;}

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
 * The one rule all three obey is the buffer he described: a person who leaves
 * within one hour of the end of his shift is not overtime, because changing
 * clothes and eating are not work. Staying past that hour pays the whole time
 * past the end (shift ends 8:00, out 10:00 -> 2 hours), exactly his example.
 * Arriving up to 30 minutes late still earns the full shift (his free-week
 * example: 12:30 instead of 12:00 still pays 8 hours); later than that loses
 * only the minutes past the 30.
 */
export const OT_ARRIVAL_GRACE_MINUTES=30;
export const OT_BUFFER_MINUTES=60;
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
 if(inShifted>=end)return 0;
 // Inside the 30 minute grace the shift counts from its own start (his
 // free-week example: 12:30 instead of 12:00 still pays 8 hours). Past the
 // grace only the minutes above the 30 are lost, never the whole lateness.
 const countedIn=start+Math.max(0,inShifted-start-OT_ARRIVAL_GRACE_MINUTES);
 const base=Math.max(0,end-countedIn);
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
