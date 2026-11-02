"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Calculator,
  CalendarDays,
  Check,
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Save,
  Settings,
  Trash2,
  TriangleAlert,
  Wallet,
  X,
} from "lucide-react";
import {
  DEFAULT_PAYROLL_FORMULAS,
  DEFAULT_PAYROLL_LETTERHEAD,
  DEFAULT_PAYROLL_SETTINGS,
  PAYROLL_VARIABLES,
  computePayrollMoney,
  currentEthiopianPeriod,
  gregorianDateToEthiopian,
  type PayrollSettings,
} from "@/lib/payroll";
import { OVERTIME_TYPE_LABELS, weekdayName, type OvertimeType } from "@/lib/attendance";
import HolidayManagerDialog from "@/components/rms/HolidayManagerDialog";

const birr = (n: number) => new Intl.NumberFormat("en-ET", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
/** The Excel leaves optional money cells blank when they are zero. */
const paper = (n: number, blankZero = false) => (blankZero && !n ? "" : birr(n));
const hrs = (n: number) => `${new Intl.NumberFormat("en-ET", { maximumFractionDigits: 2 }).format(n || 0)} h`;

function todayEc() {
  const key = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Addis_Ababa" });
  return gregorianDateToEthiopian(key);
}

const FORMULAS: Array<[keyof PayrollSettings, string, string]> = [
  ["holidayOtFormula", "Holiday OT (x2.5)", "BasicSalary / 30 / 8 * HolidayOtHours * 2.5"],
  ["freeWeekOtFormula", "Free week OT (x2)", "BasicSalary / 30 / 8 * FreeWeekOtHours * 2"],
  ["shiftOtFormula", "Shift OT (x1.5)", "BasicSalary / 30 / 8 * ShiftOtHours * 1.5"],
  ["nightShiftOtFormula", "Night shift OT (x1.75)", "BasicSalary / 30 / 8 * NightShiftOtHours * 1.75"],
  ["incomeTaxFormula", "Income tax", "Editable approved tax brackets from the supplied Excel sheet"],
  ["absenceFormula", "Absence deduction", "BasicSalary / 30 * UnapprovedAbsences"],
  ["latenessFormula", "Lateness deduction", "BasicSalary / 30 / 8 / 60 * MAX(0, LateMinutes)"],
  ["earlyOutFormula", "Early departure deduction", "BasicSalary / 30 / 8 / 60 * MAX(0, EarlyOutMinutes)"],
];

const EDITABLE: Record<string, { label: string; hint: string }> = {
  basicSalary: { label: "Basic salary", hint: "" },
  transportAllowance: { label: "Transport allowance", hint: "" },
};

/** What the row would pay if one of the two editable cells changed.
 *  This is the SAME computePayrollMoney the server uses, so the confirmation
 *  number, the saved row and the printed sheet all agree to the last cent. */
function previewNet(row: any, values: { basicSalary: number; transportAllowance: number; breakageShortage: number }, settings: PayrollSettings) {
  const a = row.attendance || {};
  const pay = computePayrollMoney({
    basicSalary: values.basicSalary,
    transportAllowance: values.transportAllowance,
    breakageShortage: values.breakageShortage,
    settings,
    attendance: {
      HolidayOtHours: a.holidayOtHours || 0,
      FreeWeekOtHours: a.freeWeekOtHours || 0,
      ShiftOtHours: a.shiftOtHours || 0,
      NightShiftOtHours: a.nightShiftOtHours || 0,
      ScheduledDays: a.scheduledDays || 0,
      ScheduledHours: a.scheduledHours || 0,
      DaysPresent: a.daysPresent || 0,
      ApprovedAbsences: a.approvedAbsences || 0,
      UnapprovedAbsences: a.unapprovedAbsences || 0,
      LateCount: a.lateCount || 0,
      LateMinutes: a.lateMinutes || 0,
      EarlyOutCount: a.earlyOutCount || 0,
      EarlyOutMinutes: a.earlyOutMinutes || 0,
    },
    prorationFactor: row.prorationFactor || 1,
  });
  return pay.display.netPay;
}

export default function PayrollTab() {
  const [period, setPeriod] = useState(currentEthiopianPeriod);
  const [periodDraft, setPeriodDraft] = useState(period);
  const [data, setData] = useState<any>(null);
  const [settings, setSettings] = useState<PayrollSettings>(DEFAULT_PAYROLL_SETTINGS);
  const [view, setView] = useState<"payroll" | "exceptions" | "settings">("payroll");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<null | { row: any; field: string; value: number; previous: number }>(null);
  const [payTarget, setPayTarget] = useState<any>(null);
  const [otMemberId, setOtMemberId] = useState<number | null>(null);
  const [holidayOpen, setHolidayOpen] = useState(false);
  // The company name and TIN printed on the government sheet. Stored in
  // site_settings, edited here, read by the payroll API for the letterhead.
  const [headerDraft, setHeaderDraft] = useState({ ...DEFAULT_PAYROLL_LETTERHEAD });

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setBusy(true);
      try {
        const [p, s] = await Promise.all([
          fetch(`/api/payroll?period=${period}`, { cache: "no-store" }),
          fetch("/api/payroll/settings", { cache: "no-store" }),
        ]);
        const pd = await p.json();
        const sd = await s.json();
        if (!p.ok) throw new Error(pd.error);
        if (!s.ok) throw new Error(sd.error);
        setData(pd);
        setSettings(sd);
        setHeaderDraft({
          companyName: pd.letterhead?.companyName || DEFAULT_PAYROLL_LETTERHEAD.companyName,
          tin: pd.letterhead?.tin || DEFAULT_PAYROLL_LETTERHEAD.tin,
        });
        setError("");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load payroll");
      } finally {
        if (!quiet) setBusy(false);
      }
    },
    [period]
  );
  useEffect(() => {
    // Deferred by a tick so the first paint is not a cascade of state writes.
    const timer = setTimeout(() => load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const act = async (body: any, success: string) => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/payroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period, ...body }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      await load(true);
      setMessage(success);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/payroll/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setSettings(d);
      await load(true);
      setMessage("Payroll formulas saved. Every row recalculated.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save settings");
    } finally {
      setBusy(false);
    }
  };

  const saveHeader = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payroll_company_name: headerDraft.companyName,
          payroll_tin: headerDraft.tin,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      await load(true);
      setMessage("Printed sheet header saved. Print the payroll to see it.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the printed header");
    } finally {
      setBusy(false);
    }
  };

  const askSave = (row: any, field: string, value: number) => {
    setError("");
    setPending({ row, field, value, previous: Number(row[field] || 0) });
  };
  const askPay = (row: any) => {
    setError("");
    setPayTarget(row);
  };

  const savePending = async () => {
    if (!pending) return;
    const { row, field, value } = pending;
    const values = {
      basicSalary: row.basicSalary,
      transportAllowance: row.transportAllowance,
      breakageShortage: row.breakageShortage,
      [field]: value,
    };
    const label = EDITABLE[field]?.label || field;
    const ok = await act(
      {
        action: "save_compensation",
        memberId: row.memberId,
        basicSalary: values.basicSalary,
        transportAllowance: values.transportAllowance,
      },
      `${label} saved. Gross, tax, pension, deductions and net pay were recalculated.`
    );
    if (ok) setPending(null);
  };

  const confirmPay = async () => {
    if (!payTarget) return;
    const row = payTarget;
    const turningOn = !row.paid;
    const ok = await act(
      { action: "mark_member_paid", memberId: row.memberId, paid: turningOn },
      turningOn
        ? `${row.employeeName} marked paid. Net pay ${birr(row.netPay)} ETB.`
        : `The paid tick was taken back from ${row.employeeName}.`
    );
    if (ok) setPayTarget(null);
  };

  const otRow = useMemo(() => data?.rows?.find((r: any) => r.memberId === otMemberId) || null, [data, otMemberId]);
  const locked = data ? ["approved", "paid"].includes(data.status) : false;
  const pendingPreview = pending && data ? previewNet(pending.row, {
    basicSalary: pending.field === "basicSalary" ? pending.value : pending.row.basicSalary,
    transportAllowance: pending.field === "transportAllowance" ? pending.value : pending.row.transportAllowance,
    breakageShortage: pending.row.breakageShortage,
  }, settings) : 0;

  return (
    <div id="fana-payroll" className="space-y-5 text-white">
      {/*
        GOVERNMENT PRINT SHEET (owner, 2026-10-27): "the current 1 have so
        many unnecessary thing like my dashboard ... since it send to
        government it must be formal like title, date, tin number". Everything
        except .print-sheet is hidden on paper: no dashboard, tabs, buttons,
        coloured cells, dialogs or status chips. The paper follows his Excel:
        company name, Payroll Sheet, month, TIN, the same columns, a Signature
        column and Prepared / Checked / Approved lines.
      */}
      <style>{`
        #fana-payroll .print-sheet { display: none; }
        @media print {
          @page { size: A3 landscape; margin: 10mm; }
          html, body { background: #fff !important; }
          #fana-admin { background: #fff !important; padding: 0 !important; margin: 0 !important; }
          #fana-admin > *:not(.max-w-7xl) { display: none !important; }
          #fana-admin > .max-w-7xl { max-width: none !important; margin: 0 !important; }
          .no-print { display: none !important; }
          #fana-payroll > *:not(.print-sheet) { display: none !important; }
          #fana-payroll .print-sheet {
            display: block !important; background: #fff !important; color: #000 !important;
            font-family: "Times New Roman", Times, serif;
          }
          .payroll-letterhead { text-align: center; margin-bottom: 8px; }
          .payroll-letterhead .company { font-size: 16pt; font-weight: 900; letter-spacing: .3px; }
          .payroll-letterhead .sheet-name { font-size: 13pt; font-weight: 800; margin-top: 2px; }
          .payroll-letterhead .month-row {
            display: flex; justify-content: space-between; align-items: baseline;
            font-size: 11pt; font-weight: 700; margin-top: 8px; text-align: left;
          }
          .payroll-letterhead .gregorian-range { text-align: left; font-size: 8pt; margin-top: 2px; }
          .payroll-paper { width: 100% !important; border-collapse: collapse !important; font-size: 8pt; }
          .payroll-paper thead { display: table-header-group; }
          .payroll-paper tfoot { display: table-footer-group; }
          .payroll-paper tr { break-inside: avoid; page-break-inside: avoid; }
          .payroll-paper th, .payroll-paper td {
            border: 1px solid #000 !important; padding: 3px 4px !important;
            vertical-align: middle !important; color: #000 !important; background: transparent !important;
          }
          .payroll-paper thead th { background: #eef1f7 !important; font-weight: 800; text-align: center; }
          .payroll-paper tfoot td { font-weight: 800; background: #f7f7f7 !important; }
          .payroll-paper .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
          .payroll-paper .center { text-align: center; }
          .payroll-paper .signature-cell { min-width: 80px; height: 28px; }
          .payroll-note { font-size: 7.5pt; margin-top: 6px; }
          .payroll-signoff { display: flex !important; justify-content: space-between; gap: 24px; margin-top: 16px; font-size: 9pt; }
          .payroll-signoff > div { flex: 1; }
          .payroll-signoff .rule { border-bottom: 1px solid #000; height: 20px; margin-top: 4px; }
        }
      `}</style>
      <div className="flex flex-wrap items-center gap-3 no-print">
        <div>
          <h2 className="text-2xl font-serif font-black text-amber-100 flex gap-2 items-center">
            <Wallet className="text-[#C9A227]" />
            Payroll
          </h2>
          <p className="text-xs text-stone-400">Ethiopian calendar • amounts in ETB • owner access only</p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <button
            onClick={() => setView("payroll")}
            className={`px-4 py-2 rounded-xl text-xs font-bold ${view === "payroll" ? "bg-[#C9A227] text-[#21130f]" : "bg-[#2C1B17]"}`}
          >
            Monthly Payroll
          </button>
          <button
            onClick={() => setView("exceptions")}
            className={`px-4 py-2 rounded-xl text-xs font-bold ${view === "exceptions" ? "bg-[#C9A227] text-[#21130f]" : "bg-[#2C1B17]"}`}
          >
            Deduction Exceptions
          </button>
          <button
            onClick={() => setView("settings")}
            className={`px-4 py-2 rounded-xl text-xs font-bold ${view === "settings" ? "bg-[#C9A227] text-[#21130f]" : "bg-[#2C1B17]"}`}
          >
            <Settings className="w-4 h-4 inline" /> Formula Settings
          </button>
        </div>
      </div>

      {message && (
        <div className="p-3 rounded-xl bg-emerald-950 border border-emerald-600 text-emerald-100 text-sm flex gap-2 items-start">
          <Check className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{message}</span>
          <button onClick={() => setMessage("")} className="ml-auto opacity-70" aria-label="Dismiss">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      {error && (
        <div className="p-3 rounded-xl bg-rose-950 border border-rose-600 text-rose-100 text-sm flex gap-2 items-start">
          <TriangleAlert className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError("")} className="ml-auto opacity-70" aria-label="Dismiss">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {view === "exceptions" ? (
        <ExceptionPanel data={data} act={act} />
      ) : view === "settings" ? (
        <div className="bg-[#2C1B17] border border-[#C9A227]/30 rounded-3xl p-5 space-y-5">
          <h3 className="font-bold text-amber-100">Payroll formula settings</h3>
          <div className="grid md:grid-cols-2 gap-3">
            <label className="text-xs">
              Employer pension %
              <input
                type="number"
                step="0.01"
                value={settings.employerPensionRate}
                onChange={(e) => setSettings({ ...settings, employerPensionRate: Number(e.target.value) })}
                className="block mt-1 w-full bg-[#1C120F] border border-stone-700 rounded-xl p-3"
              />
            </label>
            <label className="text-xs">
              Employee pension %
              <input
                type="number"
                step="0.01"
                value={settings.employeePensionRate}
                onChange={(e) => setSettings({ ...settings, employeePensionRate: Number(e.target.value) })}
                className="block mt-1 w-full bg-[#1C120F] border border-stone-700 rounded-xl p-3"
              />
            </label>
          </div>
          <div className="grid lg:grid-cols-2 gap-4">
            {FORMULAS.map(([key, label, hint]) => (
              <label key={key} className="text-xs font-bold text-amber-100">
                {label}
                <input
                  value={String(settings[key] || "")}
                  onChange={(e) => setSettings({ ...settings, [key]: e.target.value })}
                  placeholder={hint}
                  className="block mt-1 w-full bg-[#1C120F] border border-stone-700 rounded-xl p-3 font-mono text-white"
                />
              </label>
            ))}
          </div>
          <div className="rounded-xl bg-black/20 p-3 text-[11px] text-stone-300">
            <b>Fields:</b> {PAYROLL_VARIABLES.join(", ")}
          </div>
          <div className="rounded-xl bg-black/20 p-3 text-[11px] text-stone-300 space-y-3">
            <b className="text-amber-100 block">Printed sheet header (government form)</b>
            <div className="grid md:grid-cols-2 gap-3">
              <label className="text-xs">
                Company name
                <input
                  value={headerDraft.companyName}
                  onChange={(e) => setHeaderDraft({ ...headerDraft, companyName: e.target.value })}
                  className="block mt-1 w-full bg-[#1C120F] border border-stone-700 rounded-xl p-3 text-white"
                />
              </label>
              <label className="text-xs">
                TIN number
                <input
                  value={headerDraft.tin}
                  onChange={(e) => setHeaderDraft({ ...headerDraft, tin: e.target.value })}
                  className="block mt-1 w-full bg-[#1C120F] border border-stone-700 rounded-xl p-3 text-white"
                />
              </label>
            </div>
            <button
              disabled={busy}
              onClick={saveHeader}
              className="bg-white/10 px-5 py-2.5 rounded-xl text-xs font-bold disabled:opacity-50"
            >
              <Save className="w-4 h-4 inline" /> Save printed header
            </button>
          </div>
          <div className="flex flex-wrap gap-3 items-center">
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.settingsApproved}
                onChange={(e) => setSettings({ ...settings, settingsApproved: e.target.checked })}
              />
              I reviewed these formulas (kept in the audit trail).
            </label>
            <button
              onClick={() => setSettings({ ...settings, ...DEFAULT_PAYROLL_FORMULAS })}
              className="text-xs font-bold text-[#C9A227] underline decoration-dotted"
            >
              Reset to the rates the owner gave
            </button>
            <button
              disabled={busy}
              onClick={saveSettings}
              className="ml-auto bg-[#C9A227] text-[#21130f] px-6 py-3 rounded-xl font-black text-xs disabled:opacity-50"
            >
              <Save className="w-4 h-4 inline" /> Save formula settings
            </button>
          </div>
        </div>
      ) : (
        <>
          {/*
            THE PAPER. Hidden on screen, the only thing left when the owner
            presses Print. Mirrors his Excel: 18 columns, zeros left blank in
            the optional money cells, and an empty Signature box per person.
          */}
          <div className="print-sheet">
            <div className="payroll-letterhead">
              <div className="company">{data?.letterhead?.companyName || headerDraft.companyName}</div>
              <div className="sheet-name">Payroll Sheet</div>
              <div className="month-row">
                <div>For The Month of <b>{data?.letterhead?.monthLabel || period}</b></div>
                <div>TIN NO&nbsp; <b>{data?.letterhead?.tin || headerDraft.tin}</b></div>
              </div>
              <div className="gregorian-range">
                <div>Date: <b>{data?.letterhead?.dateEc || ""} E.C.</b> ({data?.letterhead?.dateLabel || ""} G.C.)</div>
                <div>Ethiopian month: {data?.letterhead?.periodLabel || ""} | Gregorian period: {data?.letterhead?.gregorianRange || ""}</div>
              </div>
            </div>
            <table className="payroll-paper">
              <thead>
                <tr>
                  <th>No.</th>
                  <th>Employee Name</th>
                  <th>Basic<br />Salary</th>
                  <th>11%</th>
                  <th>Transport<br />Allowance</th>
                  <th>OT</th>
                  <th>Gross<br />Salary</th>
                  <th>Taxable<br />salary</th>
                  <th>Income<br />tax</th>
                  <th>P.C 7 %</th>
                  <th>P.C 18%</th>
                  <th>Breakage<br />&amp;<br />shortage</th>
                  <th>Absence</th>
                  <th>Late</th>
                  <th>Early<br />out</th>
                  <th>Total<br />Deduction</th>
                  <th>Net pay</th>
                  <th>Signature</th>
                </tr>
              </thead>
              <tbody>
                {data?.rows?.map((r: any) => (
                  <tr key={r.memberId}>
                    <td className="center">{r.employeeNumber}</td>
                    <td>{r.employeeName}</td>
                    <td className="num">{paper(r.basicSalary)}</td>
                    <td className="num">{paper(r.employerPension)}</td>
                    <td className="num">{paper(r.transportAllowance)}</td>
                    <td className="num">{paper(r.overtimePay, true)}</td>
                    <td className="num">{paper(r.grossSalary)}</td>
                    <td className="num">{paper(r.taxableSalary)}</td>
                    <td className="num">{paper(r.incomeTax)}</td>
                    <td className="num">{paper(r.employeePension)}</td>
                    <td className="num">{paper(r.totalPension)}</td>
                    <td className="num">{paper(r.breakageShortage, true)}</td>
                    <td className="num">{paper(r.absenceDeduction, true)}</td>
                    <td className="num">{paper(r.latenessDeduction, true)}</td>
                    <td className="num">{paper(r.earlyOutDeduction, true)}</td>
                    <td className="num">{paper(r.totalDeduction)}</td>
                    <td className="num">{paper(r.netPay)}</td>
                    <td className="signature-cell" />
                  </tr>
                ))}
                {data && data.rows?.length === 0 && (
                  <tr>
                    <td colSpan={18} className="center">No staff in the attendance list yet.</td>
                  </tr>
                )}
              </tbody>
              {data?.rows?.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={2}>Total ({data.rows.length} people)</td>
                    <td className="num">{birr(data.rows.reduce((t: number, r: any) => t + r.basicSalary, 0))}</td>
                    <td className="num">{birr(data.rows.reduce((t: number, r: any) => t + r.employerPension, 0))}</td>
                    <td className="num">{birr(data.rows.reduce((t: number, r: any) => t + r.transportAllowance, 0))}</td>
                    <td className="num">{birr(data.rows.reduce((t: number, r: any) => t + r.overtimePay, 0))}</td>
                    <td className="num">{birr(data.rows.reduce((t: number, r: any) => t + r.grossSalary, 0))}</td>
                    <td className="num">{birr(data.rows.reduce((t: number, r: any) => t + r.taxableSalary, 0))}</td>
                    <td className="num">{birr(data.rows.reduce((t: number, r: any) => t + r.incomeTax, 0))}</td>
                    <td className="num">{birr(data.rows.reduce((t: number, r: any) => t + r.employeePension, 0))}</td>
                    <td className="num">{birr(data.rows.reduce((t: number, r: any) => t + r.totalPension, 0))}</td>
                    <td className="num">{birr(data.rows.reduce((t: number, r: any) => t + r.breakageShortage, 0))}</td>
                    <td className="num">{birr(data.rows.reduce((t: number, r: any) => t + r.absenceDeduction, 0))}</td>
                    <td className="num">{birr(data.rows.reduce((t: number, r: any) => t + r.latenessDeduction, 0))}</td>
                    <td className="num">{birr(data.rows.reduce((t: number, r: any) => t + r.earlyOutDeduction, 0))}</td>
                    <td className="num">{birr(data.rows.reduce((t: number, r: any) => t + r.totalDeduction, 0))}</td>
                    <td className="num">{birr(data.rows.reduce((t: number, r: any) => t + r.netPay, 0))}</td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
            <p className="payroll-note">
              Absence: one day of Basic Salary / 30 per unapproved absent day. Late and Early out: BasicSalary / 30 / 8 / 60 per
              chargeable minute after the role grace. Free days and approved exceptions are not deducted.
            </p>
            <div className="payroll-signoff">
              {[
                ["Prepared by", data?.preparedBy],
                ["Checked by", data?.checkedBy],
                ["Approved by", data?.approvedBy],
              ].map(([label, name]) => (
                <div key={label}>
                  <b>{label}</b>
                  <div>{name || ""}</div>
                  <div className="rule" />
                  <div>Name / Signature / Date</div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-[#2C1B17] rounded-2xl border border-[#C9A227]/30 p-4 flex flex-wrap gap-3 items-end no-print">
            <label className="text-xs text-amber-100">
              Payroll month (E.C.)
              <input
                type="text"
                inputMode="numeric"
                pattern="\d{4}-(0[1-9]|1[0-3])"
                placeholder="2019-02"
                value={periodDraft}
                onChange={(e) => setPeriodDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setPeriod(periodDraft);
                }}
                className="block mt-1 bg-[#1C120F] border border-stone-700 rounded-xl p-2"
              />
            </label>
            <button
              onClick={() => (periodDraft === period ? load() : setPeriod(periodDraft))}
              className="px-4 py-2.5 rounded-xl bg-white/10 text-xs font-bold"
            >
              <RefreshCw className="w-4 h-4 inline" /> Load
            </button>
            <button
              onClick={() => act({ action: "generate" }, "Payroll generated. The month's snapshot was saved for printing.")}
              className="px-4 py-2.5 rounded-xl bg-[#C9A227] text-[#21130f] text-xs font-black"
            >
              <Calculator className="w-4 h-4 inline" /> Generate / Recalculate
            </button>
            <button
              onClick={() => setHolidayOpen(true)}
              className="px-4 py-2.5 rounded-xl bg-violet-800/70 border border-violet-500/40 text-xs font-bold"
            >
              <CalendarDays className="w-4 h-4 inline" /> Holiday dates ({data?.holidays?.length || 0})
            </button>
            <button onClick={() => window.print()} className="px-4 py-2.5 rounded-xl bg-white/10 text-xs font-bold">
              <Printer className="w-4 h-4 inline" /> Print
            </button>
            <span className="ml-auto text-xs flex flex-wrap items-center gap-3">
              <span>
                Status: <b className="uppercase text-amber-300">{data?.status || "draft"}</b>
              </span>
              <span className="text-stone-400">
                Paid <b className="text-emerald-300">{data?.paidCount || 0}</b> of {data?.rows?.length || 0}
              </span>
            </span>
          </div>

          {data?.missingSettings?.length > 0 && (
            <div className="rounded-xl border border-rose-600 bg-rose-950/50 p-3 text-sm">
              <b>These formulas are empty:</b> {data.missingSettings.join(", ")}
            </div>
          )}

          <div className="overflow-x-auto bg-white text-black rounded-xl">
            <table className="w-full text-[11px] border-collapse whitespace-nowrap">
              <thead className="bg-stone-200">
                <tr>
                  {[
                    "No.",
                    "Employee Name",
                    "Basic Salary",
                    "Employer P.C 11%",
                    "Transport",
                    "OT",
                    "Gross",
                    "Taxable",
                    "Income Tax",
                    "Employee P.C 7%",
                    "Total P.C 18%",
                    "Breakage & Shortage",
                    "Absence",
                    "Lateness",
                    "Early Departure",
                    "Total Deduction",
                    "Net Pay",
                    "Paid",
                  ].map((h) => (
                    <th key={h} className="border p-2">
                      {h}
                      {["Basic Salary", "Transport"].includes(h) && <Pencil className="w-3 h-3 inline ml-1 text-stone-600" />}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data?.rows?.map((r: any) => (
                  <tr key={r.memberId} className={`hover:bg-amber-50 ${r.paid ? "bg-emerald-50/60" : ""}`}>
                    <td className="border p-2 text-center font-black text-stone-700">{r.employeeNumber}</td>
                    <td className="border p-2 font-bold">
                      {r.employeeName}
                      <div className="text-[9px] font-normal text-stone-500">
                        Present {r.attendance.daysPresent}/{r.attendance.scheduledDays} • Late {r.attendance.lateMinutes}m
                        {r.attendance.holidayOtHours > 0 ? ` • Holiday ${hrs(r.attendance.holidayOtHours)}` : ""}
                        {r.attendance.freeWeekOtHours > 0 ? ` • Free week ${hrs(r.attendance.freeWeekOtHours)}` : ""}
                      </div>
                    </td>
                    <EditableMoneyCell
                      value={r.basicSalary}
                      label="Basic salary"
                      disabled={busy || locked || r.paid}
                      onAsk={(value) => askSave(r, "basicSalary", value)}
                    />
                    <td className="border p-2 text-right">{birr(r.employerPension)}</td>
                    <EditableMoneyCell
                      value={r.transportAllowance}
                      label="Transport allowance"
                      disabled={busy || locked || r.paid}
                      onAsk={(value) => askSave(r, "transportAllowance", value)}
                    />
                    <td className="border p-1 text-right">
                      <button
                        onClick={() => setOtMemberId(r.memberId)}
                        title="Open the overtime of this person: H = holiday, F = free week, S = shift hours"
                        className="w-full px-1.5 py-1 rounded-md hover:bg-violet-100 text-violet-900"
                      >
                        <span className="font-black">{birr(r.overtimePay)}</span>
                        <span className="block text-[9px] font-normal text-violet-700">
                          H {r.otBreakdown.holiday.hours} • F {r.otBreakdown.freeWeek.hours} • S {r.otBreakdown.shift.hours}
                        </span>
                      </button>
                    </td>
                    <td className="border p-2 text-right">{birr(r.grossSalary)}</td>
                    <td className="border p-2 text-right">{birr(r.taxableSalary)}</td>
                    <td className="border p-2 text-right">{birr(r.incomeTax)}</td>
                    <td className="border p-2 text-right">{birr(r.employeePension)}</td>
                    <td className="border p-2 text-right">{birr(r.totalPension)}</td>
                    <td className="border p-2 text-right" title="Recorded in Store">{birr(r.breakageShortage)}</td>
                    <td className="border p-2 text-right">{birr(r.absenceDeduction)}</td>
                    <td className="border p-2 text-right" title="Chargeable minutes past the role's Maximum Late Time, at BasicSalary / 30 / 8 / 60 per minute">
                      {birr(r.latenessDeduction)}
                      <div className="text-[9px] font-normal text-stone-500">{r.attendance.lateMinutes} min</div>
                    </td>
                    <td className="border p-2 text-right" title="Chargeable minutes past the role's Leaving Grace, at BasicSalary / 30 / 8 / 60 per minute">
                      {birr(r.earlyOutDeduction)}
                      <div className="text-[9px] font-normal text-stone-500">{r.attendance.earlyOutMinutes} min</div>
                    </td>
                    <td className="border p-2 text-right">{birr(r.totalDeduction)}</td>
                    <td className="border p-2 text-right font-black">{birr(r.netPay)}</td>
                    <td className="border p-2 text-center no-print">
                      {r.paid ? (
                        <button
                          onClick={() => askPay(r)}
                          title={`Paid ${r.paidAt ? new Date(r.paidAt).toLocaleDateString("en-GB") : ""} • tap to take the tick back`}
                          className="inline-flex items-center gap-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-full pl-2 pr-3 py-1.5 font-black"
                        >
                          <CheckCircle2 className="w-4 h-4" /> Paid
                        </button>
                      ) : (
                        <button
                          onClick={() => askPay(r)}
                          disabled={busy || (data?.rows?.length || 0) === 0}
                          className="inline-flex items-center gap-1 bg-stone-800 hover:bg-black text-white rounded-full pl-2 pr-3 py-1.5 font-black disabled:opacity-40"
                        >
                          <Wallet className="w-4 h-4" /> Pay
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {!data && (
                  <tr>
                    <td colSpan={18} className="border p-8 text-center text-stone-500">
                      <Loader2 className="w-5 h-5 inline animate-spin" /> Loading the payroll...
                    </td>
                  </tr>
                )}
                {data && data.rows?.length === 0 && (
                  <tr>
                    <td colSpan={18} className="border p-8 text-center text-stone-500">
                      No staff in the attendance list yet. Add them in Attendance • Staff Members.
                    </td>
                  </tr>
                )}
              </tbody>
              {data?.rows?.length > 0 && (
                <tfoot className="bg-stone-100 font-black">
                  <tr>
                    <td className="border p-2" colSpan={2}>
                      Totals ({data.rows.length} people)
                    </td>
                    <td className="border p-2 text-right">{birr(data.rows.reduce((s: number, r: any) => s + r.basicSalary, 0))}</td>
                    <td className="border p-2 text-right">{birr(data.rows.reduce((s: number, r: any) => s + r.employerPension, 0))}</td>
                    <td className="border p-2 text-right">{birr(data.rows.reduce((s: number, r: any) => s + r.transportAllowance, 0))}</td>
                    <td className="border p-2 text-right">{birr(data.rows.reduce((s: number, r: any) => s + r.overtimePay, 0))}</td>
                    <td className="border p-2 text-right">{birr(data.rows.reduce((s: number, r: any) => s + r.grossSalary, 0))}</td>
                    <td className="border p-2 text-right">{birr(data.rows.reduce((s: number, r: any) => s + r.taxableSalary, 0))}</td>
                    <td className="border p-2 text-right">{birr(data.rows.reduce((s: number, r: any) => s + r.incomeTax, 0))}</td>
                    <td className="border p-2 text-right">{birr(data.rows.reduce((s: number, r: any) => s + r.employeePension, 0))}</td>
                    <td className="border p-2 text-right">{birr(data.rows.reduce((s: number, r: any) => s + r.totalPension, 0))}</td>
                    <td className="border p-2 text-right">{birr(data.rows.reduce((s: number, r: any) => s + r.breakageShortage, 0))}</td>
                    <td className="border p-2 text-right">{birr(data.rows.reduce((s: number, r: any) => s + r.absenceDeduction, 0))}</td>
                    <td className="border p-2 text-right">{birr(data.rows.reduce((s: number, r: any) => s + r.latenessDeduction, 0))}</td>
                    <td className="border p-2 text-right">{birr(data.rows.reduce((s: number, r: any) => s + r.earlyOutDeduction, 0))}</td>
                    <td className="border p-2 text-right">{birr(data.rows.reduce((s: number, r: any) => s + r.totalDeduction, 0))}</td>
                    <td className="border p-2 text-right">{birr(data.rows.reduce((s: number, r: any) => s + r.netPay, 0))}</td>
                    <td className="border p-2" />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <div className="bg-[#2C1B17] border border-[#C9A227]/30 rounded-2xl p-4 grid md:grid-cols-3 gap-3">
            {[
              ["preparedBy", "Prepared by"],
              ["checkedBy", "Checked by"],
              ["approvedBy", "Approved by"],
            ].map(([key, label]) => (
              <label key={key} className="text-xs text-amber-100">
                {label}
                <input
                  id={`payroll-${key}`}
                  defaultValue={data?.[key] || ""}
                  className="block mt-1 w-full bg-[#1C120F] border border-stone-700 rounded-xl p-3 text-white"
                />
              </label>
            ))}
            <button
              onClick={() =>
                act(
                  {
                    action: "save_signatures",
                    preparedBy: (document.getElementById("payroll-preparedBy") as HTMLInputElement)?.value,
                    checkedBy: (document.getElementById("payroll-checkedBy") as HTMLInputElement)?.value,
                    approvedBy: (document.getElementById("payroll-approvedBy") as HTMLInputElement)?.value,
                  },
                  "Sign-off names saved."
                )
              }
              className="md:col-span-3 bg-white/10 rounded-xl py-2 text-xs font-bold no-print"
            >
              Save sign-off names
            </button>
          </div>

          {data?.history?.length > 0 && (
            <div className="bg-[#2C1B17] border border-[#C9A227]/30 rounded-2xl p-4">
              <h3 className="font-bold text-amber-100 mb-2">Payroll history</h3>
              <div className="flex flex-wrap gap-2">
                {data.history.map((h: any) => (
                  <button
                    key={h.period_key}
                    onClick={() => {
                      setPeriod(h.period_key);
                      setPeriodDraft(h.period_key);
                    }}
                    className="bg-black/20 border border-stone-700 rounded-xl px-3 py-2 text-xs"
                  >
                    <b>{h.period_key} E.C.</b> • {h.status}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-3 justify-end no-print">
            <button
              disabled={busy || data?.status !== "draft"}
              onClick={() => act({ action: "approve" }, "Payroll approved and locked for editing.")}
              className="bg-emerald-700 disabled:opacity-40 px-5 py-3 rounded-xl text-xs font-black"
            >
              <CheckCircle2 className="w-4 h-4 inline" /> Approve and lock
            </button>
            <button
              disabled={busy || data?.status !== "approved"}
              onClick={() => act({ action: "mark_paid" }, "Payroll marked paid. Every person got the green tick.")}
              className="bg-sky-700 disabled:opacity-40 px-5 py-3 rounded-xl text-xs font-black"
            >
              <Wallet className="w-4 h-4 inline" /> Mark the whole month paid
            </button>
          </div>
        </>
      )}

      {holidayOpen && (
        <HolidayManagerDialog
          period={period}
          onClose={() => setHolidayOpen(false)}
          onChanged={() => load(true)}
        />
      )}

      {otRow && (
        <OvertimeDialog
          row={otRow}
          period={period}
          onClose={() => setOtMemberId(null)}
          onChanged={() => load(true)}
        />
      )}

      {pending && (
        <ConfirmDialog
          title={`Save this change?`}
          confirmLabel="Save and recalculate"
          cancelLabel="Don't save"
          busy={busy}
          error={error}
          onCancel={() => {
            setPending(null);
            setError("");
          }}
          onConfirm={savePending}
          lines={[
            `${pending.row.employeeName} • ${EDITABLE[pending.field]?.label || pending.field}`,
            `From ${birr(pending.previous)} to ${birr(pending.value)} ETB`,
            EDITABLE[pending.field]?.hint || "",
            `Net pay: ${birr(pending.row.netPay)} → ${birr(pendingPreview)} ETB`,
          ]}
        />
      )}

      {payTarget && (
        <ConfirmDialog
          title={payTarget.paid ? `Take the paid tick back from ${payTarget.employeeName}?` : `Pay ${payTarget.employeeName}?`}
          confirmLabel={payTarget.paid ? "Take the tick back" : "Yes, mark as paid"}
          cancelLabel="Don't"
          busy={busy}
          error={error}
          onCancel={() => {
            setPayTarget(null);
            setError("");
          }}
          onConfirm={confirmPay}
          lines={
            payTarget.paid
              ? ["The tick says this person was paid. Taking it back reopens the row for this month."]
              : [
                  `Net pay ${birr(payTarget.netPay)} ETB for ${period} E.C.`,
                  "The button turns into a green tick and the row stays locked against editing.",
                ]
          }
        />
      )}
    </div>
  );
}

/** One typed cell. A click opens the number, Enter asks, Escape thinks again. */
function EditableMoneyCell({
  value,
  label,
  disabled,
  onAsk,
}: {
  value: number;
  label: string;
  disabled: boolean;
  onAsk: (value: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [bad, setBad] = useState(false);

  const start = () => {
    if (disabled) return;
    setDraft(value ? String(value) : "");
    setBad(false);
    setEditing(true);
  };
  const submit = () => {
    const cleaned = draft.replace(/,/g, "").trim();
    const n = Number(cleaned);
    if (cleaned === "" || !Number.isFinite(n) || n < 0) {
      setBad(true);
      return;
    }
    setEditing(false);
    setBad(false);
    onAsk(Math.round(n * 100) / 100);
  };

  return (
    <td className={`border p-1 text-right ${editing ? "bg-amber-100" : disabled ? "" : "bg-amber-50/70 hover:bg-amber-100"}`}>
      {editing ? (
        <input
          autoFocus
          type="text"
          inputMode="decimal"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setBad(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={() => setEditing(false)}
          aria-label={`${label}. Type the number and press Enter.`}
          className={`w-32 text-right text-black px-2 py-1 rounded-md border-2 bg-white ${bad ? "border-rose-500" : "border-[#C9A227]"}`}
        />
      ) : (
        <button
          onClick={start}
          disabled={disabled}
          title={disabled ? "This row is closed" : `Tap to type the ${label.toLowerCase()}`}
          className="w-full px-1.5 py-1 rounded-md text-right disabled:cursor-not-allowed"
        >
          <span className={value ? "font-bold" : "text-stone-400"}>{value ? birr(value) : "Set"}</span>
        </button>
      )}
    </td>
  );
}

function ConfirmDialog({
  title,
  lines,
  confirmLabel,
  cancelLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  lines: string[];
  confirmLabel: string;
  cancelLabel: string;
  busy: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[70] bg-black/70 flex items-center justify-center p-4 no-print">
      <div className="w-full max-w-md bg-[#2C1B17] border border-[#C9A227] rounded-3xl p-5 space-y-4 text-white">
        <h3 className="font-serif font-black text-lg text-amber-100">{title}</h3>
        <div className="space-y-1.5">
          {lines.filter(Boolean).map((line, i) => (
            <p key={i} className={i === 0 ? "text-sm font-bold" : "text-xs text-stone-300"}>
              {line}
            </p>
          ))}
        </div>
        {error && (
          <div className="rounded-xl bg-rose-950 border border-rose-600 text-rose-100 text-xs p-3 flex gap-2">
            <TriangleAlert className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <button onClick={onCancel} className="bg-white/10 rounded-xl py-3 text-xs font-bold">
            <X className="w-4 h-4 inline" /> {cancelLabel}
          </button>
          <button
            disabled={busy}
            onClick={onConfirm}
            className="bg-[#C9A227] text-[#21130f] rounded-xl py-3 text-xs font-black disabled:opacity-50"
          >
            <Check className="w-4 h-4 inline" /> {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The three overtime kinds of one person, and what the scans measured. */
function OvertimeDialog({
  row,
  period,
  onClose,
  onChanged,
}: {
  row: any;
  period: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [type, setType] = useState<OvertimeType | "">("");
  const [dateEc, setDateEc] = useState(todayEc);
  const [hours, setHours] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const add = async () => {
    setErr("");
    setMsg("");
    if (!type) {
      setErr("Choose overtime type first.");
      return;
    }
    const n = Number(hours);
    if (!hours.trim() || !Number.isFinite(n) || n <= 0) {
      setErr("Type how many hours.");
      return;
    }
    setSaving(true);
    try {
      const r = await fetch("/api/attendance/overtime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: row.memberId, dateEc, type, hours: n, note, source: "admin" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not save the overtime");
      setMsg(`${d.replaced ? "Corrected" : "Saved"}: ${n} h of ${OVERTIME_TYPE_LABELS[type]} on ${dateEc} E.C.`);
      setHours("");
      setNote("");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the overtime");
    } finally {
      setSaving(false);
    }
  };

  const decide = async (entry: any) => {
    setErr("");
    setMsg("");
    setSaving(true);
    try {
      const r = await fetch("/api/attendance/overtime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: entry.excluded ? "give_again" : "dont_give",
          memberId: row.memberId,
          date: entry.date,
          type: entry.type,
          reason: entry.excluded ? undefined : "Given by mistake - do not pay",
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.success) throw new Error(d.error || "Could not change the overtime");
      setMsg(d.message);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not change the overtime");
    } finally {
      setSaving(false);
    }
  };

  const breakdown = row.otBreakdown || {};
  const breakdownCards = [
    ["free_week", "Free week OT", breakdown.freeWeek || { hours: 0, pay: 0, days: 0 }],
    ["holiday", "Holiday OT", breakdown.holiday || { hours: 0, pay: 0, days: 0 }],
    ["shift", "Shift OT", breakdown.shift || { hours: 0, pay: 0, days: 0 }],
    ["night_shift", "Night shift OT", breakdown.nightShift || { hours: 0, pay: 0, days: 0 }],
  ] as const;

  return (
    <div className="fixed inset-0 z-[70] bg-black/70 flex items-center justify-center p-4 no-print">
      <div className="w-full max-w-3xl bg-[#2C1B17] border border-[#C9A227] rounded-3xl p-5 space-y-4 max-h-[92vh] overflow-y-auto text-white">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-serif font-black text-lg text-amber-100">Overtime • {row.employeeName}</h3>
            <p className="text-[11px] text-stone-400">{period} E.C.</p>
            {row.paid && (
              <p className="text-[11px] text-emerald-200 mt-1">
                Paid for this month. Take the green tick back in the payroll row to edit.
              </p>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/10" aria-label="Close overtime">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {breakdownCards.map(([key, label, data]) => (
            <div key={key} className="bg-black/20 rounded-2xl p-3">
              <p className="text-[10px] uppercase font-black text-amber-200">{label}</p>
              <p className="text-xl font-black">{hrs(data.hours)}</p>
              <p className="text-[11px] text-emerald-300 font-bold">{birr(data.pay)} ETB</p>
            </div>
          ))}
        </div>

        {msg && <div className="p-2.5 rounded-xl bg-emerald-950 border border-emerald-600 text-emerald-100 text-xs">{msg}</div>}
        {err && <div className="p-2.5 rounded-xl bg-rose-950 border border-rose-600 text-rose-100 text-xs">{err}</div>}

        <div className="space-y-3">
          <label className="block text-[11px] font-bold text-amber-200">
            Choose overtime type
            <select
              value={type}
              onChange={(e) => setType((e.target.value || "") as OvertimeType | "")}
              className="block mt-1 w-full bg-[#1C120F] border border-stone-700 rounded-xl p-2.5 text-white"
            >
              <option value="">Choose one</option>
              <option value="free_week">FREE WEEK OT</option>
              <option value="holiday">Holiday OT</option>
              <option value="shift">Shift OT</option>
              <option value="night_shift">Night shift</option>
            </select>
          </label>
          {type !== "" && (
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="text-[11px] font-bold text-amber-200">
                Date (E.C.)
                <input
                  value={dateEc}
                  onChange={(e) => setDateEc(e.target.value)}
                  placeholder="2019-02-15"
                  inputMode="numeric"
                  className="block mt-1 w-full bg-[#1C120F] border border-stone-700 rounded-xl p-2.5 text-white"
                />
              </label>
              <label className="text-[11px] font-bold text-amber-200">
                Total hours
                <input
                  value={hours}
                  onChange={(e) => setHours(e.target.value)}
                  type="number"
                  min="0"
                  step="0.25"
                  inputMode="decimal"
                  placeholder="e.g. 2"
                  className="block mt-1 w-full bg-[#1C120F] border border-stone-700 rounded-xl p-2.5 text-white"
                />
              </label>
              <label className="text-[11px] font-bold text-amber-200 sm:col-span-2">
                Note (optional)
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Optional note"
                  className="block mt-1 w-full bg-[#1C120F] border border-stone-700 rounded-xl p-2.5 text-white"
                />
              </label>
              <button
                onClick={add}
                disabled={saving || row.paid}
                title={row.paid ? "Take the paid tick back first" : "Save this overtime row"}
                className="sm:col-span-2 bg-[#C9A227] text-[#21130f] rounded-xl py-3 text-xs font-black disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-4 h-4 inline animate-spin" /> : <Plus className="w-4 h-4 inline" />} Save overtime
              </button>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-[10px] uppercase font-black tracking-wide text-stone-400">
            Overtime history ({row.overtimeEntries.length})
          </p>
          {row.overtimeEntries.length === 0 && (
            <p className="text-xs text-stone-500">No overtime recorded for this month.</p>
          )}
          {row.overtimeEntries.map((entry: any) => (
            <div
              key={`${entry.id ?? "auto"}-${entry.date}-${entry.type}`}
              className={`flex items-center gap-3 rounded-xl p-3 ${entry.excluded ? "bg-rose-950/30 border border-rose-900/60" : "bg-black/20"}`}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-amber-100">
                  {entry.typeLabel} <span className="text-stone-500">•</span>{" "}
                  <span className={entry.excluded ? "line-through" : ""}>{hrs(entry.hours)}</span>
                  {entry.excluded && (
                    <span className="ml-2 text-[9px] font-black uppercase text-rose-300 not-italic">Not given</span>
                  )}
                </p>
                <p className="text-[11px] text-stone-400">
                  <span className="text-amber-200/80">{entry.date ? weekdayName(entry.date) : ""}</span>{" "}
                  {entry.dateEc} E.C. {entry.holidayName ? ` • ${entry.holidayName}` : ""}
                  {entry.automatic ? " • Holiday scan" : ""}
                  {entry.note && entry.note !== entry.holidayName ? ` • ${entry.note}` : ""}
                </p>
              </div>
              {entry.automatic && !entry.excluded && (
                <span className="text-[9px] font-black uppercase text-violet-300 bg-violet-950/60 border border-violet-700 rounded-full px-2 py-1 shrink-0">
                  Holiday scan
                </span>
              )}
              <button
                onClick={() => decide(entry)}
                disabled={saving || row.paid}
                title={
                  row.paid
                    ? "Take the paid tick back first"
                    : entry.excluded
                      ? "Give this overtime again"
                      : "Keep it in the history but do not pay it"
                }
                className={`px-3 py-2 rounded-xl text-[10px] font-black border disabled:opacity-40 shrink-0 ${
                  entry.excluded
                    ? "bg-emerald-900/50 border-emerald-700 text-emerald-200"
                    : "bg-rose-900/40 border-rose-700 text-rose-200"
                }`}
              >
                {entry.excluded ? "Give again" : "Don't give"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ExceptionPanel({ data, act }: { data: any; act: (body: any, success: string) => Promise<boolean> }) {
  const [memberId, setMemberId] = useState<number>(0);
  const row = data?.rows?.find((r: any) => r.memberId === memberId);
  const approve = async (event: any) => {
    const authorizedBy = prompt("Name of the person authorizing this exception");
    if (!authorizedBy) return;
    const reason = prompt("Reason (required)");
    if (!reason) return;
    await act(
      { action: "add_exception", memberId, date: event.date, exceptionType: event.type, authorizedBy, reason },
      "Exception approved. That deduction is not taken this month."
    );
  };
  return (
    <div className="space-y-4">
      <div className="bg-[#2C1B17] border border-[#C9A227]/30 rounded-2xl p-5">
        <h3 className="font-bold text-amber-100 mb-3">Absence, lateness and early departure exceptions</h3>
        <select
          value={memberId}
          onChange={(e) => setMemberId(Number(e.target.value))}
          className="bg-[#1C120F] border border-stone-700 rounded-xl p-3 min-w-64"
        >
          <option value={0}>Select employee</option>
          {data?.rows?.map((r: any) => (
            <option key={r.memberId} value={r.memberId}>
              {r.employeeName}
            </option>
          ))}
        </select>
      </div>
      {row && (
        <div className="bg-white text-black rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-stone-200">
              <tr>
                <th className="p-3 text-left">Date</th>
                <th>Event</th>
                <th>Details</th>
                <th>Deduction</th>
              </tr>
            </thead>
            <tbody>
              {row.attendanceEvents.map((e: any) => (
                <tr key={`${e.type}-${e.date}`} className="border-t">
                  <td className="p-3">{e.dateEc || e.date} E.C.</td>
                  <td className="capitalize">{e.type}</td>
                  <td>
                    {e.type === "lateness"
                      ? `${e.minutes} chargeable minutes late`
                      : e.type === "early_out"
                        ? `${e.minutes} chargeable minutes early departure`
                        : "No attendance recorded"}
                  </td>
                  <td>
                    {e.excused ? (
                      <span className="text-emerald-700 font-black">Do not deduct ✓</span>
                    ) : (
                      <button onClick={() => approve(e)} className="bg-emerald-700 text-white px-3 py-2 rounded-lg font-bold">
                        Do not deduct
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!row.attendanceEvents.length && <p className="p-5 text-stone-500">No absence or lateness events for this employee in this period.</p>}
        </div>
      )}
      <div className="bg-[#2C1B17] border border-[#C9A227]/30 rounded-2xl p-5">
        <h3 className="font-bold text-amber-100 mb-2">Exception history</h3>
        {data?.exceptions?.map((e: any) => (
          <div key={e.id} className="border-b border-stone-700 py-2 text-sm flex items-center gap-2">
            <div>
              <b>
                {e.attendance_date} • {e.exception_type}
              </b>{" "}
              • {e.authorized_by}: {e.reason}
            </div>
            <button
              onClick={() => act({ action: "remove_exception", id: e.id }, "Exception removed. The deduction applies again.")}
              className="ml-auto text-rose-300 p-1"
              aria-label="Remove exception"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
        {!data?.exceptions?.length && <p className="text-stone-500 text-sm">No exceptions approved for this month.</p>}
      </div>
    </div>
  );
}
