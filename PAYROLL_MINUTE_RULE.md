# Payroll rules and the printed government sheet

Updated 2026-10-28: Basic Salary is the base, absence costs one full day, the
numbers match the owner's Excel, Print produces a formal sheet, and all three
overtime kinds follow the 1:15 buffer, the one-hour work barrier, the role's
own grace and the "Don't give" decision.

## 0. Which salary do I use?

**The Basic Salary box you already type for each employee.** That is the only
salary you enter. There is no second "net salary" field: the payroll still
calculates income tax, the 7% pension, the transport and Net Pay by itself.

Type **6,000 ETB** in Basic Salary and the minute rule gives exactly your
example: **0.4167 ETB per chargeable minute**. It also matches the three
overtime formulas, which pay `BasicSalary / 30 / 8` per hour: an hour you miss
costs the same 25 ETB an extra hour earns.

If you truly meant take-home pay as the base, replace the word `BasicSalary`
with `NetSalary` in the formula boxes (gross minus tax and the employee
pension, before attendance deductions). Net Pay itself is circular and can
never be used as a base.

## 1. The three attendance deductions

Shipped formulas in Payroll → Formula Settings (all editable, all can be
emptied to switch them off):

```
latenessFormula   = BasicSalary / 30 / 8 / 60 * MAX(0, LateMinutes)
earlyOutFormula   = BasicSalary / 30 / 8 / 60 * MAX(0, EarlyOutMinutes)
absenceFormula    = BasicSalary / 30 * UnapprovedAbsences
```

* **Late / early out:** 6,000 / 30 / 8 / 60 = 0.4167 ETB per chargeable
  minute. `MAX(0, ...)` is your clamp. The exact fraction is used, never a
  pre-rounded 0.42: 40 minutes costs 16.67 ETB, not 16.80.
* **Absence:** one unapproved absent day loses **BasicSalary / 30**, which is
  the whole 8 hour day (6,000 ETB a month → 200 ETB). That is what you asked
  for: "deduct the 8 hour from his salary ... 6000/30 days and that daily value
  is their 8 hour value". Approved leave, free days and an unfinished today are
  never counted. A day with no scan cannot also be late, so the same day is
  never charged twice.
* **Grace:** `max(0, late − grace)` is NOT in the formulas. It is applied once
  per day at measurement time from each role's **Maximum Late Time (min)** and
  **Leaving Grace (min)** in Attendance → Role & Time. A role with 20 minutes
  of Leaving Grace whose member left 25 minutes early is charged 5 minutes.
* **Cap:** one day's late + early minutes are capped at 480, so a bad day can
  never cost more than one day's wage. Exceptions and free days stay free.

## 2. Matching the Excel you used before

Your sheet (FANA CAFÉ & RESTAURANT PLC, Payroll Sheet, July 2018 E.C) computes:

| Column | Formula |
| --- | --- |
| 11% | BasicSalary × 11% (employer pension) |
| Gross Salary | BasicSalary + Transport + OT |
| Taxable Salary | Gross Salary − Transport (transport is not taxed) |
| Income tax | the approved Ethiopian brackets on Taxable Salary |
| P.C 7 % | BasicSalary × 7% (employee pension) |
| P.C 18% | 11% + 7% (shown, never deducted) |
| Total Deduction | Income tax + P.C 7% + Breakage + attendance deductions |
| Net pay | Gross Salary − Total Deduction |

Our formulas and tax brackets are the same. The difference was **precision**:
Excel displays two decimals but keeps every digit behind them. Rounding tax and
pension separately gave 5,546.84 / 9,040.75 where your sheet says
5,546.83 / 9,040.76 for Almaz Mesfin. `computePayrollMoney` now keeps full
precision and rounds once for display, and half-cents round away from zero like
Excel. 14 real rows from the photograph are checked, column by column, in
`scripts/verify-payroll-excel.ts`.

Two honest notes about that workbook: its status bar says **"Circular
References"**, and two employees with identical numbers (Kelemia Taye and
Meseret Teklay) show different income tax (2,889.68 and 2,779.63). We reproduce
the correct 2,889.68 for both, and a couple of rows differ from the photo by
one cent where the spreadsheet's own total and net pay do not add up. Our
printed sheet is arithmetically consistent.

## 3. Overtime: what the system measures and what you can overrule

The owner's rules (2026-10-28), now in one place:

* **One 1:15 (75 minute) buffer for every kind of overtime.** The first hour
  and a quarter after the shift end is transport and changing clothes. Leaving
  inside it earns nothing; once the person passes it, the **whole** time past
  the shift end is paid, not just the surplus. Shift ends 8:00, OUT 9:00 = no
  overtime. OUT 9:16 = 1 h 16 m.
* **One hour of work is the barrier** for a holiday or a free day. A short
  visit (under 60 minutes from IN to OUT) is not an overtime day.
* **The role's own grace decides the hours.** Maximum Late Time and Leaving
  Grace come from Attendance → Role & Time. With 30 minutes of grace, IN 12:30
  and OUT 9:00 earns 8 hours; with 20 minutes of grace and 30 minutes late, it
  earns 7 h 50 m. Only minutes past the grace are removed.
* **Holiday OT (x2.5):** you register the dates with the Holiday dates button.
  Anyone who works a registered holiday day is paid the holiday formula
  multiplied by the time actually worked, measured with the rules above.
* **Free Week OT (x2):** anyone who works on a free day or free period from
  their own file is paid the free-week formula on the same measured hours.
* **Shift OT (x1.5):** the time worked **beyond the length of the person's own
  shift** (IN to OUT) is Shift OT once it passes the 1:15 buffer. If a person
  works on their free day but their IN fits another role's shift and no shift
  of their own, it is treated as covering that shift and paid as Shift OT
  instead of Free Week OT. A day is only ever one kind of overtime, so nothing
  is paid twice.
* **NO automatic overtime money (2026-11-07).** The clock-out scan no longer
  writes a paid Shift OT row by itself (`AUTO_SHIFT_OT_ENABLED = false` in
  `src/lib/attendance-overtime.ts`). Staying past the shift, or being sent in
  early, only turns the paper sheet's box **violet** so you can see it. Money
  is paid only for the overtime you enter by hand (Attendance → Overtime, or the
  OT cell of a payroll row).
* **Weekday names** appear beside every overtime date (Monday, Tuesday, ...).
* **Category history:** the three kind buttons filter the Overtime page, which
  lists everyone (including those with zero), so you can see who got which OT
  with their name, type and date. Clicking a person prefills the manual form.
* **Manual overtime is a plain amount.** When a supervisor knows something the
  scanner cannot see, they pick person + day + kind + shift and type the hours;
  leaving the hours box empty uses the worked time from that day's scan. A
  typed row wins over the automatic measurement for that day.
* **"Don't give" (was Remove):** if overtime was given wrongly, the row stays
  in the history marked *Not given* but its hours are excluded from salary and
  cannot quietly come back under another kind. **Give again** restores it.
  Only an admin can make that decision, and it is stored in
  `attendance_ot_exclusions` keyed by person + day + kind.

### 3b. Which shift a scan belongs to (2026-11-07)

The **closest shift start** decides, on the 24 hour dial. Shifts 12:00 and
20:00: a scan at 06:00 is 6 h from 12:00 and 2 h from 20:00, so it is the 20:00
shift and on time. The old 30/60/120 minute windows are gone, so a waiter sent
in two hours early is no longer written down as hours late on the morning
shift. A night shift is measured around midnight too (a 02:00 scan is 4 h from
a 22:00 start and 10 h from a 12:00 start). The extra hours are marked, never
paid automatically:

* **Sent in early** (more than 1:15 before his own start): the IN box is violet
  and says **Early 2h**.
* **Stayed up to the next shift** (his OUT is nearer the next shift's leaving
  time than his own): the OUT box is violet and says **Stayed next shift**.
  A 12:00-18:00 person who leaves at 21:30 with an 18:00-23:00 shift after him
  is marked, not called an early out.
* **A free day** from the person's own file is never the red Absent box: it is
  violet **Free day**. If he comes in anyway the box is blue **Worked free day**.

## 4. The formal printed sheet

Pressing **Print** hides the whole dashboard. Only the paper remains, laid out
like your Excel:

* **FANA CAFÉ & RESTAURANT PLC** / **Payroll Sheet** / **For The Month of
  July 2018 E.C** (the same style as your Excel: the Gregorian month in which
  the Ethiopian month starts, with the Ethiopian year) and **TIN NO
  00 85 22 21 19** on the right. A small line adds the exact Ethiopian month
  name and the Gregorian date range. The company name and TIN are editable in
  Payroll → Formula Settings → "Printed sheet header"; the defaults come from
  your photograph. The printed month and the printed date are both taken from
  the selected payroll month, so re-printing an old month keeps its own date.
* The same columns as the Excel, plus Absence / Late / Early out (the three new
  deductions) so the government can audit Total Deduction. Zero values in
  optional columns are blank, as in the Excel. A totals row sums every column.
* A **Signature** column at the end: employees sign the printed paper before it
  is sent.
* **Prepared by / Checked by / Approved by** lines with the saved names, a
  signature rule and a date, under the table.
* Landscape A3, black on white, repeating column headers, rows never split
  across pages.

## 4b. The cash payroll (2026-11-07)

A second table sits under the TIN payroll, for the people paid in cash who have
no TIN number. It is the owner's own Excel: a title **CASH ON HAND FOR THE MONTH
OF <month>**, then **No. / Employee Name / Net pay / Signature**, a TOTAL line
and Prepared by / Checked by / Approved by blanks. No basic salary, no pension,
no income tax and no transport: those columns exist because the government needs
them, and a cash employee has no TIN, so the money is one number the owner types.

* **Who is in it.** An attendance member (he keeps his fingerprint and stays on
  the paper attendance sheet) or a name typed straight into the table for people
  who do not work regularly and never scan a finger. **New person** types a name
  and a net pay; **From attendance** picks an existing member and pre-fills his
  own monthly take-home as a suggestion. The bin at the end of a row removes him
  again. Clicking a name or a net pay makes that cell editable; renaming a member
  row renames the attendance member too, so both lists always agree.
* **It takes the person OFF the TIN sheet of the same month**, because he is paid
  from the cash box. Next month he is back unless he is added again.
* **Print cash sheet** prints this four column A4 sheet on its own, with its own
  Prepared / Checked / Approved names. It never prints the 18 column TIN sheet.
  The normal Print button never prints the cash sheet.

## 5. Where it lives

| What | Where |
| --- | --- |
| Rates, absence, day cap, 1:15 OT buffer, one-hour barrier, Excel-precision money chain, letterhead defaults | `src/lib/payroll.ts` |
| Role grace measurement, worked-time Shift OT, weekday names, 75 minute OT grace | `src/lib/attendance.ts` (`lateMinutesFor`, `earlyOutMinutesFor`, `workedShiftOtMinutes`, `weekdayName`) |
| Chargeable minutes, the three OT kinds, covered shifts, exclusions, letterhead date/month, row snapshot | `src/app/api/payroll/route.ts` |
| Same money chain in the live preview, formal print sheet, header editor, OT decision | `src/components/rms/PayrollTab.tsx` |
| Overtime category history, weekday dates, "Don't give" / "Give again" | `src/components/rms/AttendanceTab.tsx` |
| Cash payroll rules, title and total | `src/lib/cash-payroll.ts` |
| Cash rows, rename, delete, paid tick, sign-off, printed cash sheet | `src/app/api/payroll/cash/route.ts`, `src/components/rms/CashPayrollPanel.tsx` |
| Auto Shift OT at clock-out (turned OFF on 2026-11-07: the violet mark costs nothing) | `src/lib/attendance-overtime.ts` (`AUTO_SHIFT_OT_ENABLED`) |
| `dont_give` / `give_again` API and `attendance_ot_exclusions` table | `src/app/api/attendance/overtime/route.ts`, `src/db/schema.ts` |
| Formula validation, empty box = off | `src/app/api/payroll/settings/route.ts` |
| One-time seeding of existing databases | `src/db/migrate.ts` (schema `2026-10-28-1`) |
| Minute-rule, payroll, overtime and Excel-parity guards | `scripts/verify-minute-deductions.ts`, `scripts/verify-payroll.ts`, `scripts/verify-attendance-overtime.ts`, `scripts/verify-payroll-excel.ts` |
| Cash payroll rules and its mounted screen | `scripts/verify-cash-payroll.ts`, `scripts/verify-cash-payroll-ui.tsx` |

**Off switch / reset:** emptying any of the three deduction boxes switches that
deduction off permanently; "Reset to the rates the owner gave" restores all
three rules.
