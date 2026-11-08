/**
 * THE SUPERVISOR'S DECISION (owner, 2026-11-08).
 *
 * "when someone is late or absent it comes there, abnet late 30 min, deduct /
 * dont deduct. dont deduct if they come with reasonable way." And, the same
 * evening, for the other three kinds too: "for overtime and absent and late and
 * early out it waits for the supervisor confirmation".
 *
 * So NOTHING is taken off a salary and nothing is paid on top of one just
 * because a clock or a calendar says so. Every attendance event of a payroll
 * month becomes one ROW on the Attendance report. A row is one of two things
 * until a person decides it:
 *
 *   pending   no decision yet. Costs the employee nothing and pays him nothing.
 *   approved  the supervisor pressed DEDUCT (or ADD, for overtime).
 *   denied    the supervisor pressed DO NOT DEDUCT (or DO NOT ADD): the
 *             reasonable-excuse case. Stays in the history forever.
 *
 * The three tables it feeds are the ones payroll already reads, so this module
 * is the ONLY rule and there is no second opinion anywhere:
 *   • denied lateness / early out / absence -> payroll_exceptions  (excused)
 *   • denied overtime                      -> attendance_ot_exclusions
 *   • approved overtime                    -> attendance_overtime  (source "supervisor")
 *
 * The pure half below (event keys, the summary, the words on the buttons) has
 * no database and no React in it, so the guard script can test it directly and
 * the screen and the server can never disagree about what "pending" means.
 *
 * ONE DELIBERATE EDGE: a day that was never scanned becomes an absence only
 * once the day is over. Today is still being worked, so today never appears as
 * an absence - a person is not absent at 9 in the morning because he has not
 * clocked in yet for the evening shift.
 */

/** What a row can be. `pending` is the absence of a decision, never a default money value. */
export type DecisionStatus = "pending" | "approved" | "denied";

/** The five things a supervisor confirms. Overtime pays; the rest cost. */
export type DecisionKind = "lateness" | "early_out" | "absence" | "overtime" | "shortage";

/** Lateness and early-out are measured in minutes; absence is a whole day. */
export const DECISION_KINDS: readonly DecisionKind[] = ["lateness", "early_out", "absence", "overtime", "shortage"];

/** The kinds on the attendance report: measured from scans, so they can be confirmed. */
export const ATTENDANCE_DECISION_KINDS: readonly DecisionKind[] = ["lateness", "early_out", "absence"];

/** Overtime and breakage are entered on the payroll screen, by a person, already. */
export const MONEY_DECISION_KINDS: readonly DecisionKind[] = ["overtime", "shortage"];

export const isAttendanceDecision = (k: string): k is "lateness" | "early_out" | "absence" =>
  (ATTENDANCE_DECISION_KINDS as readonly string[]).includes(k);

/**
 * Every event of a month has a stable key: `type|member|date`. The same person
 * can be late AND leave early on the same day, and each of the two is its own
 * decision, so the type is part of the key. A payroll month is the scope, so
 * the same day re-read next month cannot inherit a decision by accident.
 */
export type DecisionKey = { memberId: number; date: string; type: DecisionKind };

/** `lateness|12|2026-11-08` — the map key, and what the client echoes back. */
export function decisionKey(k: DecisionKey): string {
  return `${k.type}|${k.memberId}|${k.date}`;
}

/** The one event line the report shows, e.g. "abnet - late 30 min". */
export type DecisionEvent = {
  memberId: number;
  memberName: string;
  date: string;
  /** The Ethiopian date, for the sheet: "Hidar 3, 2019". */
  dateEc: string;
  type: DecisionKind;
  /** Chargeable minutes for lateness and early out; 0 for a whole-day absence. */
  minutes: number;
  status: DecisionStatus;
  /** Who decided, and why. Empty until somebody does. */
  decidedBy: string;
  reason: string;
  /** For overtime rows: the shift and kind, so the screen can say which one. */
  label?: string;
  /** holiday | free_week | shift | night_shift, on an overtime row. */
  overtimeType?: string;
  /** True when a DEDUCT or DO NOT DEDUCT press has already changed the money. */
  affectsMoney: boolean;
};

/**
 * The money a decision unlocks. `approved` on lateness costs a deduction;
 * `approved` on overtime pays. That flip is why the report shows a COUNT of
 * pending rows on the payroll screen: an undecided row is money nobody counted.
 */
export function decisionIsChargeable(type: DecisionKind, status: DecisionStatus): boolean {
  if (status === "pending") return false;
  return type === "overtime" ? status === "approved" : status === "approved";
}

/**
 * "Never deduct by itself": the payroll inputs for one person may only carry
 * the minutes and days a supervisor APPROVED. This is the single filter every
 * caller must use, so a new screen cannot re-introduce an automatic deduction
 * by summing the raw rows.
 */
export function confirmedForPayroll(events: Array<Pick<DecisionEvent, "type" | "minutes" | "status">>): {
  lateMinutes: number;
  earlyOutMinutes: number;
  unapprovedAbsences: number;
  approvedAbsences: number;
} {
  let lateMinutes = 0;
  let earlyOutMinutes = 0;
  let unapprovedAbsences = 0;
  let approvedAbsences = 0;
  for (const e of events) {
    if (e.type === "lateness") {
      if (e.status === "approved") lateMinutes += Math.max(0, Math.round(Number(e.minutes) || 0));
    } else if (e.type === "early_out") {
      if (e.status === "approved") earlyOutMinutes += Math.max(0, Math.round(Number(e.minutes) || 0));
    } else if (e.type === "absence") {
      if (e.status === "approved") unapprovedAbsences += 1;
      else if (e.status === "denied") approvedAbsences += 1;
    }
  }
  return { lateMinutes, earlyOutMinutes, unapprovedAbsences, approvedAbsences };
}

/** How many rows still need a human, and of which kind. */
export function pendingCounts(events: Array<Pick<DecisionEvent, "type" | "status">>): Record<DecisionKind, number> & { total: number } {
  const out = { lateness: 0, early_out: 0, absence: 0, overtime: 0, shortage: 0, total: 0 };
  for (const e of events) {
    if (e.status !== "pending") continue;
    out[e.type] += 1;
    out.total += 1;
  }
  return out;
}

/**
 * The two buttons of a row. Approving lateness is DEDUCT, but approving
 * overtime is ADD: the same word would be a lie on half the rows, so the
 * label follows the kind.
 */
export type DecisionButtonLabels = { confirm: "Add overtime" | "Deduct"; deny: "Do not add" | "Do not deduct" };

export function decisionButtonLabels(type: DecisionKind): DecisionButtonLabels {
  const pays = type === "overtime";
  return {
    confirm: pays ? "Add overtime" : "Deduct",
    deny: pays ? "Do not add" : "Do not deduct",
  };
}

/**
 * The line the owner dictated: "abnet-late 30 min", "abnet - absent today".
 * It is built here so the screen and the guard script print the same words.
 * `today` and `yesterday` are relative words on purpose: on the report the
 * supervisor is working through the last two days, and a date he has to decode
 * is a decision he postpones.
 */
export function decisionHeadline(
  e: Pick<DecisionEvent, "memberName" | "type" | "minutes" | "date">,
  today: string,
  yesterday: string
): string {
  if (e.type === "lateness") return `${e.memberName} - late ${e.minutes} min`;
  if (e.type === "early_out") return `${e.memberName} - left early ${e.minutes} min`;
  if (e.type === "overtime") return `${e.memberName} - overtime ${moneyHours(e.minutes)}`;
  if (e.type === "shortage") return `${e.memberName} - breakage and shortage`;
  const day = e.date === today ? "today" : e.date === yesterday ? "yesterday" : "on this day";
  return `${e.memberName} - absent ${day}`;
}

/** Minutes as the hours the paper shows: 90 -> "1.5 h". */
export function moneyHours(minutes: number): string {
  const hours = Math.max(0, Number(minutes) || 0) / 60;
  return `${Math.round(hours * 100) / 100} h`;
}

/**
 * The row order the supervisor works in: the most recent day first, and within
 * a day the people in the order the sheet prints them, then lateness before
 * early-out before absence. A stable order means a half-finished review is
 * finished by starting again from the top.
 */
export function sortDecisionEvents<T extends Pick<DecisionEvent, "date" | "memberName" | "type">>(events: T[]): T[] {
  const kindRank = (t: string) => (t === "lateness" ? 0 : t === "early_out" ? 1 : t === "absence" ? 2 : 3);
  return [...events].sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      a.memberName.localeCompare(b.memberName) ||
      kindRank(a.type) - kindRank(b.type)
  );
}
