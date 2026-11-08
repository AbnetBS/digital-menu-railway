# Deduction Report: the supervisor decides, the system never does

Owner, 2026-11-08, twice in one evening:

> "when someone is late or absent it comes there, abnet late 30 min, deduct /
> dont deduct. dont deduct if they come with reasonable way"

> "for overtime and absent and late and early out it waits for the supervisor
> confirmation"

That is the whole rule, and the whole of this document. Everything below exists
so that **no money moves until a person presses a button**.

## 1. The screen

`Admin → Attendance → Decide deductions` (the tab is called **Deduction Report**).

It replaced the old `Open Kiosk /attendance` link, which the owner does not use
("they are not using that tab"). The door tablet still lives at `/attendance` for
the people who scan at it; the admin just no longer has a button for it. The
report is also reachable from the warning band on the Payroll page.

Every row is one event, in the shape the owner dictated:

```
abnet - late 30 min              [ Deduct ]  [ Do not deduct ]
abnet - absent today             [ Deduct ]  [ Do not deduct ]
abnet - absent yesterday         [ Deduct ]  [ Do not deduct ]
abnet - left early 20 min        [ Deduct ]  [ Do not deduct ]
abnet - overtime 2 h             [ Add overtime ]  [ Do not add ]
```

The button says **Add overtime** rather than Deduct on an overtime row, because
on that row the money goes the other way. Both labels exist in English and
Amharic.

A month selector, an employee filter, and a "Waiting for me (n)" counter sit on
top. The same count is the badge on the Attendance tab's button, so the
supervisor sees the size of the job before opening it.

## 2. Three states, and only one of them is money

| State | What it means | Lateness / early out / absence | Overtime |
| --- | --- | --- | --- |
| `pending` | nobody decided | costs nothing | pays nothing |
| `approved` | the supervisor pressed Deduct / Add overtime | charged | paid |
| `denied` | Do not deduct: the reasonable excuse | not charged, reason kept | not paid, reason kept |

A decided row cannot be pressed again: the two buttons become one label, so a
double tap can never take two days' pay.

## 3. Where the decision is stored

One ledger row per (month, person, day, kind):

```
payroll_deduction_decisions(period_key, member_id, attendance_date, event_type,
                            decision, decided_by, reason, minutes, overtime_type)
```

A **missing** row is `pending`. That is deliberate: no decision means no row, so
a month nobody reviewed cannot be charged by accident.

The two tables payroll already used are kept in step, so nothing that reads them
breaks:

* `payroll_exceptions` still means "do not deduct" (the legacy excuse table).
* `attendance_ot_exclusions` is "do not add" for an overtime row.
* `attendance_overtime` with `source = 'supervisor'` is an overtime row that was
  added; its `minutes` are the hours that were approved.

Every press is also written to `payroll_audit` as `attendance_decision` with the
name of the person who pressed it, so "who let this one go" is answerable later.

## 4. How payroll reads it

`src/app/api/payroll/route.ts` builds the money in one place, and every input it
feeds to `computePayrollMoney` now comes from a decision:

```ts
const chargedLate    = decidedDeduct("lateness");
const chargedEarly   = decidedDeduct("early_out");
const chargedAbsence = decidedDeduct("absence");
const deductibleLate = lateLogs.filter((l) => chargedLate.has(l.date) && !l.isFree);
```

* `LateMinutes` = the chargeable minutes of the days where somebody pressed
  **Deduct** only. A pending day contributes `0`.
* `EarlyOutMinutes` = the same for early departures.
* `UnapprovedAbsences` = absences that were pressed **Deduct**.
  `ApprovedAbsences` = the rest (an excuse, or still undecided): the absence
  formula is `BasicSalary / 30 * UnapprovedAbsences`, so those cost `0`.
* Overtime: a typed row, a measured row and an automatic holiday row all earn
  `0` until the supervisor presses **Add overtime**. Only the approved minutes
  are paid, clamped to the measured hours (`Math.min(minutes, approvedMinutes)`),
  so pressing Add can never invent more overtime than was measured.

The payroll page shows an amber band while rows are still waiting:

> "4 attendance rows are waiting for a decision. They are not deducted and no
> overtime is paid until you press Deduct or Do not deduct on the Deduction
> Report."

## 5. What counts as an event

* **Lateness**: `lateMinutesFor(role shift, clock in)`, i.e. the minutes past the
  role's own *Maximum Late Time*, so the grace the owner typed is already
  removed. 08:40 in against 08:00 with 30 minutes grace is **10 min**.
* **Early out**: `earlyOutMinutesFor(role shift, clock out)`, past *Leaving
  Grace*.
* **Absence**: a day with no scan, but only when
  * the day is **over** (today is never an absence: the shift may not have
    started),
  * the day is not one of the person's free days,
  * the day is not a registered holiday,
  * the day is **after the person became an employee** (an employment start, a
    first scan, or the moment the row was created, whichever is earliest). A
    person hired on the 20th is not absent for the 19 days before that.
* **Overtime**: an overtime row (typed on the Overtime tab, measured at the door,
  or stamped on a holiday registration).

The measured minutes are always visible, even before a decision, so the row can
say "late 30 min" while it waits.

## 6. Twenty groups by default

The same evening: *"create 20 groups by default... if they want more they will
add more"*. The Groups composer and the Sport grid now show **GROUP 1 … GROUP
20** as cards from the first minute, whether or not a bill exists on them:

* tapping a card with a bill opens that group's bill (another round),
* tapping an empty card starts that number's bill,
* GROUP 21, 22, 23 still exist on a wild night, and a group above 20 keeps its
  card,
* "Another group" still takes the next free number.

The number is **always** stamped by the server. The client may only *ask*
(`groupNumber: 12`), and the server honours the request only while 12 is still
free today, under the same advisory lock that numbers every group bill. Two
waiters who both tap GROUP 12 get 12 and 13, never one bill twice.

`src/lib/group-grid.ts` holds the pure helpers (`DEFAULT_GROUP_COUNT`,
`groupNumbersForGrid`) with no database import, because the waiter's phone
imports them; the transaction that stamps the number stays in
`src/lib/group-orders.ts`.

## 7. The Excel, column by column

The payroll money chain is unchanged (`src/lib/payroll.ts`), and it reproduces
the owner's October 2019 E.C. sheet exactly. Verified live against the running
app, row 556 of the sheet:

| Column | The sheet | The system |
| --- | --- | --- |
| Basic Salary | 5,342.47 | 5,342.47 |
| 11% | 587.67 | 587.67 |
| Transport Allowance | 600.00 | 600.00 |
| OT | (blank) | 0.00 |
| Gross Salary | 5,942.47 | 5,942.47 |
| Taxable salary | 5,342.47 | 5,342.47 |
| Income tax | 568.49 | 568.49 |
| P.C 7 % | 373.97 | 373.97 |
| P.C 18% | 961.64 | 961.64 |
| Total Deduction | 942.47 | 942.47 |
| **Net pay** | **5,000.00** | **5,000.00** |

The other row on the sheet with a partial transport allowance (9,497.06 basic +
192.00 transport) also matches every column, to 7,500.00 net.

**One bug found and fixed while checking this**, and it mattered for the very
first real payroll: *proration*. The factor was computed from `created`, which is
the first fingerprint scan, so somebody whose first scan was on the 5th had his
whole month paid at 20% (1,096.00 instead of 5,480.00 on a 6,000 salary). It is
now prorated only when the owner typed an employment start inside the month, or
the person was terminated. A full month is a full month.

## 8. Guards

`npx tsx scripts/verify-attendance-decisions.ts` (in `npm test`) pins:

* a pending event costs nothing and pays nothing, for all four kinds;
* only an approved lateness/early out/absence reaches the payroll inputs;
* only an approved overtime is paid, and never more than was measured;
* today is never an absence, a free day is never an absence, nobody is absent
  before he was hired;
* the ledger is the decision and every press is audited;
* the kiosk link is gone from the admin and the report is in its place;
* the payroll page warns while rows are waiting;
* 20 groups by default, ordered, never duplicated, above 20 allowed, and the
  server honours a tapped number only while it is free.

`scripts/verify-group-orders-ui.tsx` mounts the real composer in jsdom and
clicks through the 20-slot grid, including the `groupNumber` payload.
`scripts/verify-payroll-excel.ts` pins the sheet, column by column, including the
full-month rule.

## 9. Live proof (2026-11-08, local database, all rows deleted afterwards)

```
# a 6,000 salary, one 15 min lateness, one absence, nothing decided
basic=6000 gross=6600 lateDed=0 absDed=0 net=5480 | pending={"lateness":3,"absence":1,"total":4}

# press Deduct on the 15 min lateness and on the absence
basic=6000 gross=6600 lateDed=6.25 absDed=200 net=5273.75

# press Do not deduct (doctor appointment) on another lateness
it leaves the deduction at 0 for that day and keeps the reason

# a 2 h shift overtime, before and after Add overtime
otPay=0   → Add overtime →   otPay=75.00   (2 h * 6000/30/8 * 1.5)
pressing Add twice: still 75.00
pressing Do not add afterwards: back to 0.00

# a tapped default slot
ask GROUP 20 (free) → GROUP 20      ask GROUP 1 (taken) → GROUP 9
```

## 10. Files

| File | What it is |
| --- | --- |
| `src/lib/attendance-decisions.ts` | the pure rule: keys, states, the summary, the button labels, the headline |
| `src/lib/attendance-month-events.ts` | builds a month's events with their decisions (server only) |
| `src/app/api/attendance/decisions/route.ts` | GET the report, POST one decision |
| `src/components/rms/DeductionReportPanel.tsx` | the screen |
| `src/components/rms/AttendanceTab.tsx` | the tab and the badge (the kiosk link is gone) |
| `src/app/api/payroll/route.ts` | charges only what was approved |
| `src/lib/group-grid.ts` | 20 default groups, pure |
| `src/lib/group-orders.ts` | stamps the number under the advisory lock |
| `scripts/verify-attendance-decisions.ts` | the guard |
