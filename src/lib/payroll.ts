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
export const DEFAULT_PAYROLL_SETTINGS:PayrollSettings={employerPensionRate:11,employeePensionRate:7,holidayOtFormula:"",freeWeekOtFormula:"",shiftOtFormula:"",incomeTaxFormula:DEFAULT_INCOME_TAX_FORMULA,absenceFormula:"",latenessFormula:"",earlyOutFormula:"",settingsApproved:false};
export function requiredPayrollSettingsMissing(s:PayrollSettings):string[]{const m:string[]=[];if(!s.holidayOtFormula)m.push("Holiday OT formula");if(!s.freeWeekOtFormula)m.push("Free Week OT formula");if(!s.shiftOtFormula)m.push("Shift OT formula");if(!s.incomeTaxFormula)m.push("Income tax formula");if(!s.absenceFormula)m.push("Absence deduction formula");if(!s.latenessFormula)m.push("Lateness deduction formula");if(!s.earlyOutFormula)m.push("Early departure deduction formula");if(!s.settingsApproved)m.push("Manager settings approval");return m;}

export function ethiopianMonthBounds(year:number,month:number):{from:string;to:string}{
  if(!Number.isInteger(year)||year<1900||year>2200||!Number.isInteger(month)||month<1||month>13)throw new Error("Invalid Ethiopian payroll month");
  const formatter=new Intl.DateTimeFormat("en-u-ca-ethiopic",{year:"numeric",month:"numeric",day:"numeric",timeZone:"Africa/Addis_Ababa"});
  const matches=(d:Date)=>{const p=Object.fromEntries(formatter.formatToParts(d).map(x=>[x.type,x.value]));return Number(p.year)===year&&Number(p.month)===month;};
  const scanStart=new Date(Date.UTC(year+7,7,1));let first:Date|null=null,last:Date|null=null;
  for(let offset=0;offset<=430;offset++){const d=new Date(scanStart);d.setUTCDate(d.getUTCDate()+offset);if(matches(d)){if(!first||d<first)first=d;if(!last||d>last)last=d;}}
  if(!first||!last)throw new Error("Could not map that Ethiopian month");
  return{from:first.toISOString().slice(0,10),to:last.toISOString().slice(0,10)};
}
