"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, Pencil, Plus, Printer, Save, Trash2, TriangleAlert, UserPlus, X } from "lucide-react";
import { cashSheetTitle, cashTotal, type CashPayrollRow, type CashPayrollSignoff } from "@/lib/cash-payroll";

/**
 * THE CASH PAYROLL TABLE (owner, 2026-11-07)
 *
 * The second table under the TIN payroll, for the people paid in cash who have
 * no TIN number. His Excel, exactly: a title "CASH ON HAND FOR THE MONTH OF
 * <month>", then No. / Employee Name / Net pay / Signature, a TOTAL line, and
 * Prepared by / Checked by / Approved by blanks. No tax, no pension, no
 * transport, no basic salary: one number per person.
 *
 * What the owner can do here, in his words:
 *   - "add employee at bottom of the table"          -> Add employee row
 *   - "delete at the end of each row"                -> the bin at the end
 *   - "when the name is clicked make it renameable
 *      ... also the attendance staff member will be
 *      renamed"                                      -> click the name
 *   - "when i click new employee i can write new
 *      also existing from the attendance"            -> New person / From attendance
 *   - "separate print button too with approved by"   -> Print cash sheet
 *
 * A cash row of this month removes that person from the TIN sheet of the same
 * month (the payroll API reads this table), because he is paid from the cash
 * box. Next month he is back on the TIN sheet unless he is added again.
 */
export default function CashPayrollPanel({
  period,
  monthLabel,
  dateEc,
  dateLabel,
  companyName,
  tin,
  onChanged,
  onSaved,
  onFailed,
  onPrint,
}: {
  period: string;
  monthLabel: string;
  dateEc: string;
  dateLabel: string;
  companyName: string;
  tin: string;
  onChanged: () => void;
  /** A success line for the payroll page's green banner. */
  onSaved: (message: string) => void;
  /** A failure line for the payroll page's red banner. */
  onFailed: (message: string) => void;
  /** The payroll page puts itself into cash print mode and opens the printer. */
  onPrint: () => void;
}) {
  const birr = (n: number) => new Intl.NumberFormat("en-ET", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
  const [rows, setRows] = useState<CashPayrollRow[]>([]);
  const [signoff, setSignoff] = useState<CashPayrollSignoff>({ preparedBy: "", checkedBy: "", approvedBy: "" });
  const [addable, setAddable] = useState<Array<{ id: number; name: string; role: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Which row is open for an edit, and what is being typed.
  const [editing, setEditing] = useState<null | { id: number; field: "name" | "netPay"; draft: string }>(null);
  const [adding, setAdding] = useState<null | "new" | "attendance">(null);
  const [newName, setNewName] = useState("");
  const [newPay, setNewPay] = useState("");
  const [pickMember, setPickMember] = useState("");
  const [pickPay, setPickPay] = useState("");
  const [signDraft, setSignDraft] = useState(signoff);
  // A delete asks first, in the panel itself: the browser's blocking confirm
  // is not allowed on the tablet and it cannot be read aloud on a phone.
  const [confirmRemove, setConfirmRemove] = useState<CashPayrollRow | null>(null);

  const apply = (body: {
    rows?: CashPayrollRow[];
    signoff?: CashPayrollSignoff;
    addable?: Array<{ id: number; name: string; role: string }>;
  }) => {
    if (body.rows) setRows(body.rows);
    if (body.signoff) {
      setSignoff(body.signoff);
      setSignDraft(body.signoff);
    }
    if (body.addable) setAddable(body.addable);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/payroll/cash?period=${period}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not load the cash payroll");
      apply(d);
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load the cash payroll");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    const timer = setTimeout(() => load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const act = async (payload: Record<string, unknown>, success: string) => {
    setBusy(true);
    setErr("");
    onFailed?.("");
    try {
      const r = await fetch("/api/payroll/cash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period, ...payload }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "That did not work");
      apply(d);
      onSaved?.(success);
      onChanged();
      return true;
    } catch (e) {
      const text = e instanceof Error ? e.message : "That did not work";
      setErr(text);
      onFailed?.(text);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const total = useMemo(() => cashTotal(rows), [rows]);
  const paidCount = rows.filter((r) => r.paid).length;

  const saveEdit = async () => {
    if (!editing) return;
    const value = editing.draft.trim();
    if (editing.field === "name") {
      if (!value) {
        setEditing(null);
        return;
      }
      const row = rows.find((r) => r.id === editing.id);
      const ok = await act(
        { action: "rename", id: editing.id, name: value },
        row?.fromAttendance
          ? "Name saved. The attendance list uses the same name."
          : "Name saved."
      );
      if (ok) setEditing(null);
      return;
    }
    const cleaned = value.replace(/,/g, "");
    const n = Number(cleaned);
    if (cleaned === "" || !Number.isFinite(n) || n < 0) {
      setErr("Type the net pay as a number, for example 4000");
      return;
    }
    const ok = await act({ action: "set_net_pay", id: editing.id, netPay: Math.round(n * 100) / 100 }, "Net pay saved.");
    if (ok) setEditing(null);
  };

  const addNamed = async () => {
    if (!newName.trim()) {
      setErr("Write the name of the person first.");
      return;
    }
    const n = Number(newPay.replace(/,/g, "") || 0);
    const ok = await act(
      { action: "add_name", name: newName.trim(), netPay: Number.isFinite(n) ? Math.round(n * 100) / 100 : 0 },
      `${newName.trim()} added to the cash payroll.`
    );
    if (ok) {
      setNewName("");
      setNewPay("");
      setAdding(null);
    }
  };

  const addExisting = async () => {
    const id = Number(pickMember);
    if (!id) {
      setErr("Choose the person from the attendance list.");
      return;
    }
    const n = pickPay.trim() === "" ? undefined : Number(pickPay.replace(/,/g, ""));
    const ok = await act(
      { action: "add_member", memberId: id, netPay: Number.isFinite(n as number) ? n : undefined },
      "Added to the cash payroll. He is no longer on the TIN sheet for this month."
    );
    if (ok) {
      setPickMember("");
      setPickPay("");
      setAdding(null);
    }
  };

  return (
    <div className="cash-payroll-panel bg-white text-black rounded-2xl border-2 border-violet-400">
      {/* ── the printed cash sheet: hidden on screen, the only thing the cash
             print button leaves on the paper ───────────────────────────────── */}
      <style>{`
        #fana-cash-payroll .cash-print-sheet { display: none; }
        @media print {
          /* The cash print button puts #fana-payroll into cash-print-mode for
             the length of that one print, so the printer shows the cash sheet
             INSTEAD of the TIN sheet. The normal Print button never sets it. */
          #fana-payroll.cash-print-mode > .print-sheet { display: none !important; }
          #fana-payroll.cash-print-mode > .cash-payroll-panel { display: block !important; }
          #fana-payroll.cash-print-mode > .cash-payroll-panel #fana-cash-payroll .cash-print-sheet {
            display: block !important; background: #fff !important; color: #000 !important;
          }
          #fana-cash-payroll .cash-paper { width: 100% !important; border-collapse: collapse !important; font-size: 10pt; }
          #fana-cash-payroll .cash-paper thead { display: table-header-group; }
          #fana-cash-payroll .cash-paper th, #fana-cash-payroll .cash-paper td {
            border: 1px solid #000 !important; padding: 5px 6px !important; color: #000 !important; background: transparent !important;
          }
          #fana-cash-payroll .cash-paper thead th { background: #eef1f7 !important; font-weight: 800; text-align: center; }
          #fana-cash-payroll .cash-paper tfoot td { font-weight: 800; background: #f7f7f7 !important; }
          #fana-cash-payroll .cash-paper .num { text-align: right; white-space: nowrap; }
          #fana-cash-payroll .cash-paper .center { text-align: center; }
        }
      `}</style>

      <div id="fana-cash-payroll">
        <div className="cash-print-sheet p-2">
          <div style={{ textAlign: "center", marginBottom: 10 }}>
            <div style={{ fontSize: "15pt", fontWeight: 900, letterSpacing: 0.3 }}>{companyName}</div>
            <div style={{ fontSize: "12pt", fontWeight: 800, marginTop: 2 }}>CASH PAYROLL SHEET</div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10pt", fontWeight: 700, marginTop: 8 }}>
              <div>{cashSheetTitle(monthLabel)}</div>
              <div>TIN NO&nbsp; <b>{tin}</b></div>
            </div>
            <div style={{ fontSize: "8pt", marginTop: 2, textAlign: "left" }}>
              Date: {dateEc ? `${dateEc} E.C.` : ""} {dateLabel ? `(${dateLabel} G.C.)` : ""} | Ethiopian month: {monthLabel}
            </div>
          </div>
          <table className="cash-paper">
            <thead>
              <tr>
                <th style={{ width: "6%" }}>S No</th>
                <th>Employee Name</th>
                <th style={{ width: "22%" }}>Net pay</th>
                <th style={{ width: "24%" }}>Signature</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id}>
                  <td className="center">{i + 1}</td>
                  <td>{r.name}</td>
                  <td className="num">{birr(r.netPay)}</td>
                  <td style={{ height: 26 }} />
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="center" colSpan={4}>
                    No cash employee added for this month.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>TOTAL</td>
                <td className="num">{birr(total)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 24, marginTop: 22, fontSize: "9.5pt" }}>
            {[
              ["Prepared by", signoff.preparedBy],
              ["Checked by", signoff.checkedBy],
              ["Approved by", signoff.approvedBy],
            ].map(([label, name]) => (
              <div key={label} style={{ flex: 1 }}>
                <b>{label}</b>
                <div style={{ minHeight: 16 }}>{name || ""}</div>
                <div style={{ borderBottom: "1px solid #000", height: 18 }} />
                <div style={{ fontSize: "8pt" }}>Name / Signature / Date</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── on screen ───────────────────────────────────────────────────────── */}
      <div className="no-print">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b-2 border-violet-300 bg-violet-50 rounded-t-2xl">
          <div>
            <h3 className="font-serif font-black text-base text-violet-950">CASH PAYROLL (no TIN)</h3>
            <p className="text-[11px] text-violet-800">
              Paid in cash: no tax, no pension, no transport. Net pay only, then {paidCount} of {rows.length} paid.
            </p>
            <p className="text-[10px] text-violet-700/80">
              Anyone in this table this month is left out of the TIN table above. A name typed here needs no attendance.
            </p>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <button
              onClick={() => {
                setAdding(adding === "new" ? null : "new");
                setErr("");
              }}
              className="px-3 py-2 rounded-xl bg-violet-700 text-white text-xs font-bold"
            >
              <Plus className="w-4 h-4 inline" /> New person
            </button>
            <button
              onClick={() => {
                setAdding(adding === "attendance" ? null : "attendance");
                setErr("");
              }}
              className="px-3 py-2 rounded-xl bg-violet-100 text-violet-900 border border-violet-400 text-xs font-bold"
            >
              <UserPlus className="w-4 h-4 inline" /> From attendance
            </button>
            <button
              onClick={onPrint}
              className="px-3 py-2 rounded-xl bg-[#C9A227] text-[#21130f] text-xs font-black"
            >
              <Printer className="w-4 h-4 inline" /> Print cash sheet
            </button>
          </div>
        </div>

        {err && (
          <div className="m-3 p-2.5 rounded-xl bg-rose-50 border border-rose-300 text-rose-800 text-xs flex gap-2 items-start">
            <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" /> {err}
            <button onClick={() => setErr("")} className="ml-auto" aria-label="Dismiss">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {adding === "new" && (
          <div className="m-3 p-3 rounded-xl bg-violet-50 border border-violet-300 grid sm:grid-cols-[1fr_160px_auto] gap-2 items-end">
            <label className="text-[11px] font-bold text-violet-900">
              Employee name (no fingerprint needed)
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Abebe Kebede"
                className="block mt-1 w-full bg-white border border-violet-300 rounded-lg p-2 text-black"
              />
            </label>
            <label className="text-[11px] font-bold text-violet-900">
              Net pay (ETB)
              <input
                value={newPay}
                onChange={(e) => setNewPay(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="block mt-1 w-full bg-white border border-violet-300 rounded-lg p-2 text-black"
              />
            </label>
            <button
              onClick={addNamed}
              disabled={busy}
              className="px-4 py-2.5 rounded-lg bg-violet-700 text-white text-xs font-black disabled:opacity-50"
            >
              <Plus className="w-4 h-4 inline" /> Add
            </button>
          </div>
        )}

        {adding === "attendance" && (
          <div className="m-3 p-3 rounded-xl bg-violet-50 border border-violet-300 grid sm:grid-cols-[1fr_160px_auto] gap-2 items-end">
            <label className="text-[11px] font-bold text-violet-900">
              Person from the attendance list
              <select
                value={pickMember}
                onChange={(e) => setPickMember(e.target.value)}
                className="block mt-1 w-full bg-white border border-violet-300 rounded-lg p-2 text-black"
              >
                <option value="">Choose the person</option>
                {addable.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.role})
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] font-bold text-violet-900">
              Net pay (ETB)
              <input
                value={pickPay}
                onChange={(e) => setPickPay(e.target.value)}
                inputMode="decimal"
                placeholder="His own net pay"
                className="block mt-1 w-full bg-white border border-violet-300 rounded-lg p-2 text-black"
              />
            </label>
            <button
              onClick={addExisting}
              disabled={busy}
              className="px-4 py-2.5 rounded-lg bg-violet-700 text-white text-xs font-black disabled:opacity-50"
            >
              <Plus className="w-4 h-4 inline" /> Add
            </button>
          </div>
        )}

        {confirmRemove && (
          <div className="mx-3 mb-2 p-3 rounded-xl bg-rose-50 border border-rose-300 text-xs">
            <p className="font-bold text-rose-900">
              Remove {confirmRemove.name} from this month&apos;s cash payroll?
            </p>
            <p className="text-rose-700 mt-0.5">
              He comes off the cash sheet only. His attendance, fingerprints and pay history stay.
            </p>
            <div className="flex gap-2 mt-2">
              <button
                onClick={async () => {
                  const row = confirmRemove;
                  setConfirmRemove(null);
                  await act({ action: "remove", id: row.id }, `${row.name} removed from the cash payroll.`);
                }}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg bg-rose-600 text-white font-black disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5 inline" /> Remove him
              </button>
              <button
                onClick={() => setConfirmRemove(null)}
                className="px-3 py-1.5 rounded-lg bg-white border border-rose-300 text-rose-800 font-bold"
              >
                Keep him
              </button>
            </div>
          </div>
        )}

        <div className="px-3 pb-2">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-violet-100">
                <th className="border border-violet-300 p-2 w-12">S No</th>
                <th className="border border-violet-300 p-2 text-left">Employee Name</th>
                <th className="border border-violet-300 p-2 text-right w-40">Net pay</th>
                <th className="border border-violet-300 p-2 text-center w-24">Paid</th>
                <th className="border border-violet-300 p-2 w-14"> </th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={5} className="border border-violet-200 p-6 text-center text-stone-500">
                    <Loader2 className="w-4 h-4 inline animate-spin" /> Loading the cash payroll...
                  </td>
                </tr>
              )}
              {!loading &&
                rows.map((r, i) => {
                  const editingName = editing?.id === r.id && editing.field === "name";
                  const editingPay = editing?.id === r.id && editing.field === "netPay";
                  return (
                    <tr key={r.id} className={r.paid ? "bg-emerald-50" : "hover:bg-violet-50"}>
                      <td className="border border-violet-200 p-2 text-center font-black text-stone-600">{i + 1}</td>
                      <td className="border border-violet-200 p-1">
                        {editingName ? (
                          <input
                            autoFocus
                            value={editing.draft}
                            onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void saveEdit();
                              if (e.key === "Escape") setEditing(null);
                            }}
                            onBlur={() => setEditing(null)}
                            className="w-full border-2 border-violet-500 rounded px-2 py-1 text-black"
                          />
                        ) : (
                          <button
                            onClick={() => setEditing({ id: r.id, field: "name", draft: r.name })}
                            title={
                              r.fromAttendance
                                ? "Click to rename. The attendance staff member gets the same name."
                                : "Click to rename this cash employee."
                            }
                            className="w-full text-left px-2 py-1 rounded hover:bg-violet-100 font-bold flex items-center gap-1.5"
                          >
                            <Pencil className="w-3 h-3 text-violet-500 shrink-0" />
                            <span>{r.name}</span>
                            {!r.fromAttendance && (
                              <span className="text-[9px] font-normal text-stone-400 uppercase">typed</span>
                            )}
                          </button>
                        )}
                      </td>
                      <td className="border border-violet-200 p-1 text-right">
                        {editingPay ? (
                          <input
                            autoFocus
                            value={editing.draft}
                            inputMode="decimal"
                            onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void saveEdit();
                              if (e.key === "Escape") setEditing(null);
                            }}
                            onBlur={() => setEditing(null)}
                            className="w-full text-right border-2 border-violet-500 rounded px-2 py-1 text-black"
                          />
                        ) : (
                          <button
                            onClick={() => setEditing({ id: r.id, field: "netPay", draft: r.netPay ? String(r.netPay) : "" })}
                            title="Click to type the net pay"
                            className="w-full text-right px-2 py-1 rounded hover:bg-violet-100 font-bold"
                          >
                            {r.netPay ? birr(r.netPay) : <span className="text-stone-400">Set</span>}
                          </button>
                        )}
                      </td>
                      <td className="border border-violet-200 p-1 text-center">
                        <button
                          onClick={() =>
                            void act(
                              { action: "set_paid", id: r.id, paid: !r.paid },
                              r.paid ? `${r.name} marked unpaid.` : `${r.name} marked paid.`
                            )
                          }
                          disabled={busy}
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-black disabled:opacity-50 ${
                            r.paid ? "bg-emerald-600 text-white" : "bg-stone-200 text-stone-700"
                          }`}
                        >
                          <Check className="w-3 h-3" /> {r.paid ? "Paid" : "Pay"}
                        </button>
                      </td>
                      <td className="border border-violet-200 p-1 text-center">
                        <button
                          onClick={() => setConfirmRemove(r)}
                          disabled={busy}
                          className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-100 disabled:opacity-40"
                          aria-label={`Remove ${r.name}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="border border-violet-200 p-5 text-center text-stone-500">
                    Nobody paid in cash this month yet. Use New person or From attendance above.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="bg-violet-100 font-black">
                <td colSpan={2} className="border border-violet-300 p-2">
                  TOTAL ({rows.length} {rows.length === 1 ? "person" : "people"})
                </td>
                <td className="border border-violet-300 p-2 text-right">{birr(total)}</td>
                <td colSpan={2} className="border border-violet-300 p-2" />
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="px-3 pb-4 grid md:grid-cols-3 gap-2">
          {[
            ["preparedBy", "Prepared by"],
            ["checkedBy", "Checked by"],
            ["approvedBy", "Approved by"],
          ].map(([key, label]) => (
            <label key={key} className="text-[11px] font-bold text-violet-900">
              {label}
              <input
                value={(signDraft as Record<string, string>)[key] || ""}
                onChange={(e) => setSignDraft({ ...signDraft, [key]: e.target.value })}
                className="block mt-1 w-full bg-white border border-violet-300 rounded-lg p-2 text-black"
              />
            </label>
          ))}
          <button
            onClick={() => void act({ action: "save_signatures", ...signDraft }, "Cash sheet sign-off saved.")}
            disabled={busy}
            className="md:col-span-3 bg-violet-100 hover:bg-violet-200 text-violet-900 border border-violet-300 rounded-xl py-2 text-xs font-bold disabled:opacity-50"
          >
            <Save className="w-4 h-4 inline" /> Save sign-off names
          </button>
        </div>
      </div>
    </div>
  );
}
