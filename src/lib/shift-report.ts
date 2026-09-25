/**
 * SHIFT REPORT (owner + cross-checker, Sept 2026).
 *
 * The cross-checker found items missing from the bills and had to phone
 * around to learn who handled them. This module answers "who did what, in
 * which shift" for one ROLE and one DATE window:
 *
 *   • MORNING   — every action stamped BEFORE the shift change (default 14:00
 *                 on the 24-hour clock = 8:00 on the Ethiopian clock).
 *   • AFTERNOON — every action stamped at/after the shift change.
 *   • COMBINED  — orders where TWO OR MORE people of the same role took part:
 *                 accepted at 13:55 by the morning waiter, sent/cleared by the
 *                 afternoon one; food accepted by one cook and finished by
 *                 another; a bill accepted by one cashier and printed by
 *                 another. Those orders are listed as "Abel - Alem".
 *
 * A person appears in BOTH shifts when they acted in both. Nothing here reads
 * the database or React: the API route feeds rows in, the regression test
 * feeds fixtures in.
 */
import { etHour, etDayKey } from "@/lib/timezone";

export type ShiftRole = "waiter" | "cashier" | "kitchen" | "barista" | "juice" | "buna";
export const SHIFT_ROLES: ShiftRole[] = ["waiter", "cashier", "kitchen", "barista", "juice", "buna"];
export const SHIFT_ROLE_LABELS: Record<ShiftRole, string> = {
  waiter: "Waiter",
  cashier: "Cashier",
  kitchen: "Kitchen",
  barista: "Barista",
  juice: "Juice Maker",
  buna: "Buna Maker",
};
export const STATION_ROLES: ShiftRole[] = ["kitchen", "barista", "juice", "buna"];
export const isStationRole = (r: ShiftRole) => STATION_ROLES.includes(r);

export type ShiftDate = "today" | "yesterday" | "dayBefore" | "week";
export const SHIFT_DATES: ShiftDate[] = ["today", "yesterday", "dayBefore", "week"];
export const SHIFT_DATE_LABELS: Record<ShiftDate, string> = {
  today: "Today",
  yesterday: "Yesterday",
  dayBefore: "Day Before Yesterday",
  week: "Last 7 Days",
};
export const SHIFT_DATE_START_DAYS_AGO: Record<ShiftDate, number> = { today: 0, yesterday: 1, dayBefore: 2, week: 6 };
export const SHIFT_DATE_LENGTH: Record<ShiftDate, number> = { today: 1, yesterday: 1, dayBefore: 1, week: 7 };

/** 14 = 2:00 PM on the 24-hour clock = 8:00 on the Ethiopian clock. */
export const DEFAULT_SHIFT_SPLIT_HOUR = 14;
export type ShiftName = "morning" | "afternoon";

type Stamp = Date | string | null | undefined;

export interface ShiftTicketRow {
  id: number;
  tableName: string;
  orderNumber: string | null;
  orderType: string;
  status: string;
  totalAmount: number | null;
  serviceNote: string | null;
  createdBy: string | null;
  confirmedBy: string | null;
  confirmedAt: Stamp;
  printedBy: string | null;
  printedAt: Stamp;
  closedBy: string | null;
  closedAt: Stamp;
  verifiedBy: string | null;
  verifiedAt: Stamp;
  createdAt: Stamp;
}
export interface ShiftItemRow {
  id: number;
  ticketId: number;
  name: string;
  price: number;
  quantity: number;
  notes: string | null;
  removed: boolean | null;
  stationName: string | null;
  stationStatus: string | null;
  stationStatusBy: string | null;
  stationStatusAt: Stamp;
  stationAcceptedBy: string | null;
  stationAcceptedAt: Stamp;
  stationDoneBy: string | null;
  stationDoneAt: Stamp;
  createdAt: Stamp;
}
export interface ShiftEventRow {
  ticketId: number;
  eventType: string;
  actorName: string | null;
  actorRole: string | null;
  toValue: string | null;
  details: string | null;
  createdAt: Stamp;
}
export interface ShiftSubmissionRow {
  ticketId: number;
  source: string | null;
  waiterName: string | null;
  lines: number | null;
  createdAt: Stamp;
}

/** One thing one person did on one order. */
export interface ShiftAction {
  name: string;
  at: string;
  shift: ShiftName;
  label: string;
  itemId?: number;
}

export interface ShiftOrderCard {
  ticketId: number;
  tableName: string;
  orderNumber: string | null;
  orderType: string;
  status: string;
  totalAmount: number;
  serviceNote: string | null;
  createdAt: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  /**
   * The waiter who CREATED and sent the order (display only). A waiter's own
   * order is sent straight to the stations and never "accepted", so
   * `confirmedBy` stays empty for it: the card shows "Sent by <name>" instead
   * of a blank "Accepted by". Never used for totals, Combined or flags.
   */
  sentBy: string | null;
  sentAt: string | null;
  printedBy: string | null;
  printedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  /** Every action by people of the selected role on this order (in range). */
  actions: ShiftAction[];
  /** Distinct people of the role who took part. ≥2 → COMBINED. */
  people: string[];
  combined: boolean;
  items: Array<{
    id: number;
    name: string;
    price: number;
    quantity: number;
    notes: string | null;
    removed: boolean;
    stationName: string | null;
    stationStatus: string | null;
    acceptedBy: string | null;
    acceptedAt: string | null;
    doneBy: string | null;
    doneAt: string | null;
    createdAt: string | null;
    /** Added after the cashier's last print (not on the EFD paper yet). */
    afterPrint: boolean;
    /** Line of the selected station (for station roles). */
    mine: boolean;
  }>;
  /** Warnings the cross-checker should look at first. */
  flags: string[];
  timeline: Array<{ at: string | null; actor: string | null; role: string | null; text: string }>;
}

export interface ShiftPersonRow {
  name: string;
  orders: number;
  amount: number;
  ticketIds: number[];
  firstAt: string | null;
  lastAt: string | null;
}

export interface ShiftReport {
  role: ShiftRole;
  date: ShiftDate;
  splitHour: number;
  morning: ShiftPersonRow[];
  afternoon: ShiftPersonRow[];
  combined: Array<{ names: string[]; label: string; orders: number; amount: number; ticketIds: number[] }>;
  orders: Record<number, ShiftOrderCard>;
  totals: { orders: number; amount: number; flagged: number; people: number };
}

const iso = (d: Stamp): string | null => {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? null : x.toISOString();
};
const clean = (s: string | null | undefined) => String(s || "").trim();

export function shiftOf(at: Stamp, splitHour = DEFAULT_SHIFT_SPLIT_HOUR): ShiftName {
  const d = at instanceof Date ? at : new Date(String(at));
  return etHour(d) < splitHour ? "morning" : "afternoon";
}

export interface BuildInput {
  role: ShiftRole;
  date: ShiftDate;
  splitHour?: number;
  /** EAT day keys ("2026-09-24") inside the selected window. */
  dayKeys: string[];
  tickets: ShiftTicketRow[];
  items: ShiftItemRow[];
  events: ShiftEventRow[];
  submissions: ShiftSubmissionRow[];
  /** name → role from the staff accounts. */
  staffRoles: Record<string, string>;
}

const EVENT_TEXT: Record<string, string> = {
  ticket_created: "Order created",
  submission_added: "Items added",
  ticket_sent: "Sent to stations",
  ticket_printed: "Printed (EFD)",
  bill_requested: "Bill requested",
  item_removed: "Item removed",
  item_quantity_changed: "Quantity changed",
  item_notes_changed: "Note changed",
  item_edited: "Item edited",
};

/** Plain words for a status change that carries no note of its own. */
const STATUS_TEXT: Record<string, string> = {
  confirmed: "Order accepted",
  printed: "Printed (EFD)",
  preparing: "Preparing",
  ready_for_payment: "Bill requested",
  completed: "Marked paid",
  paid: "Marked paid",
  closed: "Table cleared",
  cancelled: "Order cancelled",
};

/**
 * The one-time audit BACKFILL (db/migrate.ts) stamped old bills with
 * technical notes such as "Legacy confirmation backfill". Staff reading a
 * timeline need plain words, so each known note maps to what happened.
 */
export const LEGACY_EVENT_TEXT: Record<string, string> = {
  "Legacy bill existed before audit logging": "Order created",
  "Legacy confirmation backfill": "Order accepted",
  "Legacy print backfill": "Printed (EFD)",
  "Legacy bill edit happened before detailed audit logging": "Bill edited",
  "Legacy table-cleared backfill": "Table cleared",
  "Legacy payment backfill": "Marked paid",
  "Legacy cancellation backfill": "Order cancelled",
};

/** True for a note written by the old backfill (never shown as-is). */
export function isLegacyAuditNote(details: string | null | undefined): boolean {
  const d = String(details || "").trim();
  return !!d && (d in LEGACY_EVENT_TEXT || (/^legacy\b/i.test(d) && /backfill|before (detailed )?audit logging/i.test(d)));
}

/** One readable timeline line for an audit event. */
export function timelineText(e: Pick<ShiftEventRow, "eventType" | "toValue" | "details">): string {
  const d = String(e.details || "").trim();
  if (d && !isLegacyAuditNote(d)) return d;
  if (d && LEGACY_EVENT_TEXT[d]) return LEGACY_EVENT_TEXT[d];
  if (EVENT_TEXT[e.eventType]) return EVENT_TEXT[e.eventType];
  if (e.eventType === "status_changed" && e.toValue && STATUS_TEXT[e.toValue]) return STATUS_TEXT[e.toValue];
  const words = String(e.eventType || "").replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Update";
}

/** Placeholder names that are not a person ("Customer (QR)", "Waiter"...). */
const NOT_A_PERSON = /^(customer\b.*|\(.*\)|admin|waiter|cashier|staff|system|guest)$/i;
const personName = (s: string | null | undefined) => {
  const n = clean(s);
  return n && !NOT_A_PERSON.test(n) ? n : "";
};
const stampMs = (d: Stamp) => {
  const x = d instanceof Date ? d.getTime() : new Date(String(d)).getTime();
  return Number.isNaN(x) ? 0 : x;
};

/**
 * WHO SENT IT (display only): the waiter whose own order created the bill
 * (first submission is a staff one), else whoever released it to the
 * stations ("ticket_sent"), else the first staff submission, else a real
 * person in `createdBy`.
 */
export function orderSender(
  t: Pick<ShiftTicketRow, "createdBy" | "createdAt">,
  submissions: ShiftSubmissionRow[],
  events: ShiftEventRow[]
): { name: string | null; at: string | null } {
  const subs = submissions.slice().sort((a, b) => stampMs(a.createdAt) - stampMs(b.createdAt));
  const first = subs[0];
  if (first && first.source === "staff" && personName(first.waiterName)) {
    return { name: personName(first.waiterName), at: iso(first.createdAt) };
  }
  const sent = events
    .filter((e) => e.eventType === "ticket_sent" && personName(e.actorName))
    .sort((a, b) => stampMs(a.createdAt) - stampMs(b.createdAt))[0];
  if (sent) return { name: personName(sent.actorName), at: iso(sent.createdAt) };
  const staffSub = subs.find((s) => s.source === "staff" && personName(s.waiterName));
  if (staffSub) return { name: personName(staffSub.waiterName), at: iso(staffSub.createdAt) };
  const creator = personName(t.createdBy);
  return creator ? { name: creator, at: iso(t.createdAt) } : { name: null, at: null };
}

export function buildShiftReport(input: BuildInput): ShiftReport {
  const { role, date, dayKeys, staffRoles } = input;
  const splitHour = input.splitHour ?? DEFAULT_SHIFT_SPLIT_HOUR;
  const inRange = (at: Stamp) => {
    const k = etDayKey(at);
    return !!k && dayKeys.includes(k);
  };
  const station = isStationRole(role);

  // Whose role is a name? Staff accounts win; an event's actorRole fills gaps
  // (a renamed or deleted account still has its history).
  const roleOfName = new Map<string, string>();
  for (const [n, r] of Object.entries(staffRoles)) roleOfName.set(clean(n), r);
  for (const e of input.events) {
    const n = clean(e.actorName);
    if (n && e.actorRole && !roleOfName.has(n)) roleOfName.set(n, e.actorRole);
  }
  const isRole = (name: string, fallbackRole?: string | null) => {
    if (!name || /^customer/i.test(name) || /^\(.*\)$/.test(name) || name === "admin") return false;
    const r = roleOfName.get(name) ?? fallbackRole ?? null;
    return r === role;
  };

  const itemsByTicket = new Map<number, ShiftItemRow[]>();
  for (const it of input.items) {
    const a = itemsByTicket.get(it.ticketId) || [];
    a.push(it);
    itemsByTicket.set(it.ticketId, a);
  }
  const eventsByTicket = new Map<number, ShiftEventRow[]>();
  for (const e of input.events) {
    const a = eventsByTicket.get(e.ticketId) || [];
    a.push(e);
    eventsByTicket.set(e.ticketId, a);
  }
  const subsByTicket = new Map<number, ShiftSubmissionRow[]>();
  for (const s of input.submissions) {
    const a = subsByTicket.get(s.ticketId) || [];
    a.push(s);
    subsByTicket.set(s.ticketId, a);
  }

  const orders: Record<number, ShiftOrderCard> = {};

  for (const t of input.tickets) {
    const items = itemsByTicket.get(t.id) || [];
    const events = (eventsByTicket.get(t.id) || []).slice().sort(
      (a, b) => new Date(String(a.createdAt)).getTime() - new Date(String(b.createdAt)).getTime()
    );
    const actions: ShiftAction[] = [];
    const push = (name: string, at: Stamp, label: string, itemId?: number) => {
      const n = clean(name);
      const when = iso(at);
      if (!n || !when || !inRange(when)) return;
      // Same person + same label + same minute = one action (an event and a
      // ticket column often record the same tap).
      const dup = actions.some(
        (a) => a.name === n && a.label === label && a.itemId === itemId && Math.abs(new Date(a.at).getTime() - new Date(when).getTime()) < 60_000
      );
      if (!dup) actions.push({ name: n, at: when, shift: shiftOf(when, splitHour), label, itemId });
    };

    if (station) {
      for (const it of items) {
        if (it.stationName !== role) continue;
        const acc = clean(it.stationAcceptedBy);
        const done = clean(it.stationDoneBy);
        if (acc && isRole(acc, role)) push(acc, it.stationAcceptedAt, `Accepted ${it.name}`, it.id);
        if (done && isRole(done, role)) push(done, it.stationDoneAt, `Done ${it.name}`, it.id);
        // Lines stamped before the accept/done columns existed only know the
        // LAST tap: still show it, so older days are not empty.
        if (!acc && !done) {
          const last = clean(it.stationStatusBy);
          if (last && isRole(last, role)) {
            push(last, it.stationStatusAt, `${it.stationStatus === "done" ? "Done" : "Accepted"} ${it.name}`, it.id);
          }
        }
      }
    } else if (role === "waiter") {
      const conf = clean(t.confirmedBy);
      if (conf && isRole(conf)) push(conf, t.confirmedAt || t.createdAt, t.orderType === "outdoor" ? "Accepted outdoor order" : "Accepted order");
      for (const s of subsByTicket.get(t.id) || []) {
        const n = clean(s.waiterName);
        if (s.source === "staff" && n && isRole(n, "waiter")) push(n, s.createdAt, `Direct send • ${s.lines || 0} line(s)`);
      }
      for (const e of events) {
        const n = clean(e.actorName);
        if (!n || !isRole(n, e.actorRole)) continue;
        if (e.eventType === "submission_added" || e.eventType === "ticket_created") continue; // covered by submissions
        if (e.eventType === "status_changed" && e.toValue === "closed") push(n, e.createdAt, "Cleared table");
        else if (e.eventType === "status_changed") continue;
        else push(n, e.createdAt, EVENT_TEXT[e.eventType] || e.eventType);
      }
      const closer = clean(t.closedBy);
      if (closer && isRole(closer)) push(closer, t.closedAt, "Cleared table");
    } else {
      // cashier
      const conf = clean(t.confirmedBy);
      if (conf && isRole(conf)) push(conf, t.confirmedAt || t.createdAt, "Accepted order");
      for (const e of events) {
        const n = clean(e.actorName);
        if (!n || !isRole(n, e.actorRole)) continue;
        if (e.eventType === "ticket_printed") push(n, e.createdAt, "Printed (EFD)");
        else if (e.eventType === "status_changed" && e.toValue === "cancelled") push(n, e.createdAt, "Cancelled order");
        else if (e.eventType === "status_changed" && (e.toValue === "paid" || e.toValue === "completed")) push(n, e.createdAt, "Marked paid");
        else if (e.eventType === "status_changed") continue;
        else if (e.eventType === "submission_added") push(n, e.createdAt, "Added items");
        else push(n, e.createdAt, EVENT_TEXT[e.eventType] || e.eventType);
      }
      const printer = clean(t.printedBy);
      if (printer && isRole(printer)) push(printer, t.printedAt, "Printed (EFD)");
      const ver = clean(t.verifiedBy);
      if (ver && isRole(ver)) push(ver, t.verifiedAt, "Marked paid");
    }

    if (actions.length === 0) continue;
    actions.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    const people = [...new Set(actions.map((a) => a.name))];

    const printedMs = t.printedAt ? new Date(String(t.printedAt)).getTime() : 0;
    const cardItems = items.map((it) => ({
      id: it.id,
      name: it.name,
      price: it.price || 0,
      quantity: it.quantity || 0,
      notes: it.notes,
      removed: !!it.removed,
      stationName: it.stationName,
      stationStatus: it.stationStatus,
      acceptedBy: it.stationAcceptedBy || (!it.stationDoneBy && it.stationStatus === "accepted" ? it.stationStatusBy : null),
      acceptedAt: iso(it.stationAcceptedAt) || (!it.stationDoneBy && it.stationStatus === "accepted" ? iso(it.stationStatusAt) : null),
      doneBy: it.stationDoneBy || (it.stationStatus === "done" ? it.stationStatusBy : null),
      doneAt: iso(it.stationDoneAt) || (it.stationStatus === "done" ? iso(it.stationStatusAt) : null),
      createdAt: iso(it.createdAt),
      afterPrint: !!printedMs && !!it.createdAt && new Date(String(it.createdAt)).getTime() > printedMs,
      mine: station ? it.stationName === role : true,
    }));

    const flags: string[] = [];
    const live = cardItems.filter((i) => !i.removed);
    if (t.status === "cancelled") flags.push("Order cancelled");
    if (station) {
      const mine = live.filter((i) => i.mine);
      const notDone = mine.filter((i) => i.stationStatus !== "done").length;
      if (notDone > 0 && t.status !== "cancelled") flags.push(`${notDone} line(s) never marked done`);
    } else {
      if (!t.printedAt && t.status !== "cancelled") flags.push("Never printed (not on the EFD)");
      const after = live.filter((i) => i.afterPrint).length;
      if (after > 0 && t.status !== "cancelled") flags.push(`${after} line(s) added after the print`);
    }
    if (cardItems.some((i) => i.removed)) flags.push("Line(s) removed");

    const timeline = events.map((e) => ({
      at: iso(e.createdAt),
      actor: e.actorName,
      role: e.actorRole,
      text: timelineText(e),
    }));
    const sender = orderSender(t, subsByTicket.get(t.id) || [], events);

    orders[t.id] = {
      ticketId: t.id,
      tableName: t.tableName,
      orderNumber: t.orderNumber,
      orderType: t.orderType,
      status: t.status,
      totalAmount: t.totalAmount || 0,
      serviceNote: t.serviceNote,
      createdAt: iso(t.createdAt),
      confirmedBy: t.confirmedBy,
      confirmedAt: iso(t.confirmedAt),
      sentBy: sender.name,
      sentAt: sender.at,
      printedBy: t.printedBy,
      printedAt: iso(t.printedAt),
      closedBy: t.closedBy,
      closedAt: iso(t.closedAt),
      actions,
      people,
      combined: people.length >= 2,
      items: cardItems,
      flags,
      timeline,
    };
  }

  // Station amount = value of the station's own lines; floor roles = bill total.
  const amountOf = (o: ShiftOrderCard) =>
    station
      ? o.items.filter((i) => i.mine && !i.removed).reduce((s, i) => s + i.price * i.quantity, 0)
      : o.totalAmount;

  const bucket = (shift: ShiftName): ShiftPersonRow[] => {
    const map = new Map<string, { ids: Set<number>; ats: string[] }>();
    for (const o of Object.values(orders)) {
      for (const a of o.actions) {
        if (a.shift !== shift) continue;
        const cur = map.get(a.name) || { ids: new Set<number>(), ats: [] };
        cur.ids.add(o.ticketId);
        cur.ats.push(a.at);
        map.set(a.name, cur);
      }
    }
    return [...map.entries()]
      .map(([name, v]) => {
        const ids = [...v.ids].sort((a, b) => b - a);
        const ats = v.ats.sort();
        return {
          name,
          orders: ids.length,
          amount: ids.reduce((s, id) => s + amountOf(orders[id]), 0),
          ticketIds: ids,
          firstAt: ats[0] || null,
          lastAt: ats[ats.length - 1] || null,
        };
      })
      .sort((a, b) => b.orders - a.orders || a.name.localeCompare(b.name));
  };

  const combinedMap = new Map<string, { names: string[]; ids: number[] }>();
  for (const o of Object.values(orders)) {
    if (!o.combined) continue;
    const key = o.people.join(" - ");
    const cur = combinedMap.get(key) || { names: o.people, ids: [] };
    cur.ids.push(o.ticketId);
    combinedMap.set(key, cur);
  }
  const combined = [...combinedMap.entries()]
    .map(([label, v]) => ({
      names: v.names,
      label,
      orders: v.ids.length,
      amount: v.ids.reduce((s, id) => s + amountOf(orders[id]), 0),
      ticketIds: v.ids.sort((a, b) => b - a),
    }))
    .sort((a, b) => b.orders - a.orders || a.label.localeCompare(b.label));

  const all = Object.values(orders);
  return {
    role,
    date,
    splitHour,
    morning: bucket("morning"),
    afternoon: bucket("afternoon"),
    combined,
    orders,
    totals: {
      orders: all.length,
      amount: all.reduce((s, o) => s + amountOf(o), 0),
      flagged: all.filter((o) => o.flags.length > 0).length,
      people: new Set(all.flatMap((o) => o.people)).size,
    },
  };
}
