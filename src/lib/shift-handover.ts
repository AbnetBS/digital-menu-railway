/**
 * THE BARISTA HAND-OVER (owner's decision, Sept 2026).
 *
 * The daily-bills checker and the baristas kept arguing: drinks the morning
 * man accepted were finished (or never finished) by the afternoon man, the
 * admin shift sheet and the barista's own "Items sold" never agreed, and
 * items went missing. The owner's answer is a REGISTERED OWNER per shift for
 * the barista lane only (kitchen, juice, buna, waiter and cashier are
 * untouched):
 *
 *   • YOUR FIRST DRINK REGISTERS YOU. Logging in claims nothing. The first
 *     barista who presses ACCEPT on a line becomes that shift's owner for the
 *     day (one row in station_shift_claims). A wrong-PIN login or a tablet
 *     opened by mistake blocks nobody.
 *   • ONE OWNER PER SCREEN. Once the morning owner exists, every other
 *     barista sees a waiting screen instead of the order list; new work is
 *     never "whoever grabs it".
 *   • THE 20-MINUTE WINDOW. At the shift-change hour (the owner's setting,
 *     default 14:00 EAT = 8:00 on the Ethiopian clock) a countdown runs for
 *     20 minutes. During it BOTH the morning owner and the afternoon
 *     candidate see every still-pending line; the moment one of them accepts
 *     a line it leaves the other's screen (per LINE, never per table: what
 *     matters is who sold which macchiato). Who accepts a line finishes it.
 *   • HARD STOP. When the countdown ends the morning owner can no longer
 *     accept: his screen keeps only the lines he accepted until they are done
 *     or the cashier prints, then it goes blank and only his day's sale is
 *     left. New orders wait for the afternoon barista.
 *   • NO DOUBLE SHIFT. The morning owner can never also register as the
 *     afternoon owner of the same day.
 *
 * The ADMIN shift report for the barista role reads the same claims and the
 * same per-line attribution, so the cross-checker's paper and the barista's
 * own Items-sold total always agree (see buildShiftReport).
 *
 * This module is deliberately PURE: no database, no Next.js, no React. The
 * API route feeds rows in, the regression test
 * (scripts/verify-shift-handover.ts) feeds fixtures in.
 */
import { etDayKey, etHour, etStartOfDay } from "@/lib/timezone";

/** 20 minutes to hand over, counted down on both barista screens (owner's rule). */
export const HANDOVER_MINUTES = 20;

export type HandoverShift = "morning" | "afternoon";

/** One registered owner: `{ shift, staffName, claimedAt }` (claimedAt = first accept). */
export interface HandoverClaim {
  shift: HandoverShift;
  staffName: string;
  claimedAt: Date | string | null;
}

export type HandoverPhase = "open" | "handover" | "after";

/** Where the day stands relative to the shift-change hour. */
export interface HandoverPhaseInfo {
  phase: HandoverPhase;
  /** The EAT calendar day ("2026-09-28") the claims belong to. */
  dayKey: string | null;
  /** UTC instant the 20-minute window opens (EAT midnight + splitHour). */
  windowStart: Date;
  /** UTC instant the window closes (windowStart + 20 min). */
  windowEnd: Date;
  splitHour: number;
}

/**
 * Which phase is `now` in?
 *   open     → before the shift-change hour: one owner (morning) works alone.
 *   handover → the 20-minute overlap: both can accept still-pending lines.
 *   after    → the morning owner only finishes what he accepted.
 */
export function handoverPhase(now: Date, splitHour: number): HandoverPhaseInfo {
  const dayStart = etStartOfDay(now);
  const windowStart = new Date(dayStart.getTime() + splitHour * 60 * 60 * 1000);
  const windowEnd = new Date(windowStart.getTime() + HANDOVER_MINUTES * 60 * 1000);
  const phase: HandoverPhase = now.getTime() < windowStart.getTime() ? "open" : now.getTime() < windowEnd.getTime() ? "handover" : "after";
  return { phase, dayKey: etDayKey(now), windowStart, windowEnd, splitHour };
}

/** An accept stamped at `at` registers the acceptor in THIS shift. */
export function claimShiftFor(at: Date | string, splitHour: number): HandoverShift {
  return etHour(at) < splitHour ? "morning" : "afternoon";
}

/** What one logged-in barista may see and do right now. */
export interface BaristaViewerRule {
  /** Still-pending (nobody accepted yet) lines appear on his screen. */
  seesPending: boolean;
  /** He may press Accept on a still-pending line right now. */
  canAcceptPending: boolean;
  /** The shift he already owns today, if any (he pressed Accept earlier). */
  myShift: HandoverShift | null;
}

/**
 * The visibility/action rule for one barista, given today's owners.
 *
 * Before any owner exists (a quiet start to the day) every logged-in barista
 * sees the big board: somebody must be able to accept the first drink, and
 * that first accept is what makes him the owner. From then on the board is
 * his alone. The afternoon candidate gets his own first accept during (or
 * after) the window. The morning owner keeps accepting through the window
 * (the afternoon man may be late), then hard-stops.
 */
export function baristaViewer(input: {
  name: string;
  phase: HandoverPhase;
  morningOwner: string | null;
  afternoonOwner: string | null;
}): BaristaViewerRule {
  const name = String(input.name || "").trim();
  const isMorning = !!input.morningOwner && input.morningOwner === name;
  const isAfternoon = !!input.afternoonOwner && input.afternoonOwner === name;
  const myShift: HandoverShift | null = isMorning ? "morning" : isAfternoon ? "afternoon" : null;
  if (isMorning) {
    // Hard stop: after the window his Accept dies; his own lines stay until
    // they are done or the cashier prints.
    const open = input.phase !== "after";
    return { seesPending: open, canAcceptPending: open, myShift };
  }
  if (isAfternoon) {
    // Already registered: his board is live until the day ends.
    return { seesPending: true, canAcceptPending: true, myShift };
  }
  // A candidate: nobody owns the relevant shift yet, so he may accept the
  // first drink and take it. Otherwise he waits on the standby screen.
  if (input.phase === "open") {
    const open = !input.morningOwner;
    return { seesPending: open, canAcceptPending: open, myShift };
  }
  const open = !input.afternoonOwner;
  return { seesPending: open, canAcceptPending: open, myShift };
}

/**
 * May this barista REGISTER as a shift owner with the accept he is about to
 * stamp? The one hard ban: no double shifts — the morning owner can never
 * become the afternoon owner of the same day.
 */
export function canRegisterClaim(input: {
  name: string;
  claimShift: HandoverShift;
  morningOwner: string | null;
  afternoonOwner: string | null;
}): { ok: boolean; reason: "double-shift" | "taken" | null; holder?: string } {
  if (input.claimShift === "afternoon" && input.morningOwner && input.morningOwner === input.name) {
    return { ok: false, reason: "double-shift" };
  }
  const holder = input.claimShift === "morning" ? input.morningOwner : input.afternoonOwner;
  if (holder && holder !== input.name) return { ok: false, reason: "taken", holder };
  return { ok: true, reason: null };
}

/* ─── PER-LINE OWNERSHIP (who accepted / finished this drink) ────────────── */

const clean = (s: string | null | undefined): string => String(s ?? "").trim();

/** The smallest shape of a station line this module reads. */
export interface OwnedLine {
  stationStatus?: string | null;
  stationStatusBy?: string | null;
  stationAcceptedBy?: string | null;
  stationDoneBy?: string | null;
}

/**
 * WHO owns this line? The permanent audit columns win; lines stamped before
 * they existed fall back to the last tap — the exact rule the crew's
 * Items-sold tab uses, so the board, the tab and the admin paper never
 * disagree about whose drink it is.
 */
export function lineAcceptedOwner(it: OwnedLine): string {
  const acc = clean(it.stationAcceptedBy);
  if (acc) return acc;
  const status = clean(it.stationStatus).toLowerCase();
  if (!clean(it.stationDoneBy) && status === "accepted") return clean(it.stationStatusBy);
  return "";
}

export function lineDoneOwner(it: OwnedLine): string {
  const done = clean(it.stationDoneBy);
  if (done) return done;
  return clean(it.stationStatus).toLowerCase() === "done" ? clean(it.stationStatusBy) : "";
}

export function lineOwner(it: OwnedLine): string {
  return lineAcceptedOwner(it) || lineDoneOwner(it);
}

/* ─── THE LIVE LIST, PER VIEWER ──────────────────────────────────────────── */

/**
 * A line in the viewer's payload. `taken: true` marks a line another barista
 * owns: it is never rendered, but keeping it in the payload lets the screen
 * follow it silently — the line going somewhere is exactly NOT the "an item
 * was removed, stop preparing" alarm.
 */
export type LiveLineView<T> = T & { taken?: boolean };

/**
 * The barista's live list, cut for one pair of eyes:
 *   • pending lines    — visible only when the viewer may accept right now;
 *   • accepted lines   — kept, marked `taken` when someone else owns them
 *                        (invisible on the board, silent for the alarms);
 *   • done lines       — same shadow treatment (the board already hides them).
 * Tickets left with no lines at all drop out.
 */
export function filterBaristaLive<T extends { items: OwnedLine[] }>(
  tickets: T[],
  opts: { name: string; seesPending: boolean }
): Array<{ [K in keyof T]: K extends "items" ? LiveLineView<T["items"][number]>[] : T[K] }> {
  const name = String(opts.name || "").trim();
  const out: Array<{ [K in keyof T]: K extends "items" ? LiveLineView<T["items"][number]>[] : T[K] }> = [];
  for (const t of tickets) {
    const items: LiveLineView<T["items"][number]>[] = [];
    for (const it of t.items) {
      const status = clean(it.stationStatus).toLowerCase();
      if (status === "pending") {
        if (opts.seesPending) items.push(it);
        continue;
      }
      const owner = status === "done" ? lineDoneOwner(it) || lineAcceptedOwner(it) : lineAcceptedOwner(it);
      const taken = !!owner && owner !== name;
      items.push(taken ? { ...it, taken: true } : it);
    }
    if (items.length > 0) out.push({ ...t, items } as { [K in keyof T]: K extends "items" ? LiveLineView<T["items"][number]>[] : T[K] });
  }
  return out;
}

/* ─── THE ADMIN REPORT, BY OWNER ─────────────────────────────────────────── */

/**
 * Which shift bucket does one barista action fall in? When the day has
 * registered OWNERS the bucketing follows the person, not the clock: the
 * morning owner's Done at 14:35 (finishing through the window, exactly as the
 * rules expect) is still MORNING work. Without owners (older days) it falls
 * back to the plain clock split.
 */
export function actionShiftByClaims(input: {
  name: string;
  at: Date | string;
  fallback: HandoverShift;
  claimsByDay: Map<string, Map<string, HandoverShift>> | null;
}): HandoverShift {
  const key = etDayKey(input.at);
  const owners = key ? input.claimsByDay?.get(key) : undefined;
  return owners?.get(input.name) ?? input.fallback;
}

/** dayKey → (name → shift), from the claims the route read for the window. */
export function claimsByDayMap(
  claims: Array<{ dayKey: string; shift: HandoverShift; staffName: string }>
): Map<string, Map<string, HandoverShift>> {
  const map = new Map<string, Map<string, HandoverShift>>();
  for (const c of claims || []) {
    const key = String(c.dayKey || "").trim();
    const name = String(c.staffName || "").trim();
    if (!key || !name) continue;
    const day = map.get(key) || new Map<string, HandoverShift>();
    if (!day.has(name)) day.set(name, c.shift);
    map.set(key, day);
  }
  return map;
}
