/**
 * ROLE ALERT MATRIX - who must be woken, for which action.
 *
 * The complaint behind this file: "every action made for the role must have a
 * notification and an alarm". Before, only a handful of moments pushed a phone
 * (a new QR order, a print, a bill request). Everything else changed silently,
 * so a waiter whose phone was in her pocket, or who was using another app,
 * simply never learned that her food was ready, that an order was cancelled,
 * or that the cashier removed an item from her table's bill.
 *
 * Every event now lands here, in ONE pure table, so:
 *   • no route can forget an event (a regression test walks this matrix),
 *   • the wording staff read is consistent,
 *   • the actor never rings their own phone (see `withoutActor`).
 *
 * This module is deliberately PURE: no database, no web-push, no Next.js. It
 * takes a plain description of what happened and returns the alerts to send,
 * which makes the whole matrix testable without a server.
 */

export type StaffRole = "waiter" | "cashier" | "kitchen" | "barista";

export const STATION_ROLES: StaffRole[] = ["kitchen", "barista"];
export const ALL_STAFF_ROLES: StaffRole[] = ["waiter", "cashier", "kitchen", "barista"];

export interface RoleAlert {
  roles: StaffRole[];
  title: string;
  body: string;
  /** Same-tag alerts replace each other; add an event suffix to ring twice. */
  tag: string;
  /**
   * Someone must ACT: the phone keeps the notification on the lock screen and
   * re-rings it until it is answered. Non-urgent alerts inform ("table paid")
   * and fade on their own.
   */
  urgent: boolean;
  /** Extra rings while nobody reacts (0 for informational alerts). */
  repeat: number;
}

export interface TicketAlertInfo {
  id: number;
  tableName: string;
  totalAmount?: number | null;
  /** Present for pending bills so staff know what they are walking to. */
  orderNumber?: string | null;
}

const money = (t: TicketAlertInfo) =>
  typeof t.totalAmount === "number" && t.totalAmount > 0 ? ` • ${t.totalAmount} ETB` : "";

/**
 * A ticket moved to a new status. `confirmed` is the moment the food is
 * released, so it wakes the stations, the cashier and the waiter at once.
 * `printed` and `preparing` deliberately do NOT wake the stations: by then the
 * crew is already cooking, and a re-print must never re-ring them for food
 * they already have.
 */
export function ticketStatusAlerts(status: string, t: TicketAlertInfo): RoleAlert[] {
  const table = t.tableName;
  switch (status) {
    case "pending_waiter":
      return [
        {
          roles: ["waiter"],
          title: "🍽 Order needs confirmation",
          body: `${table}${money(t)} • tap to confirm`,
          tag: `fana-pending-${t.id}`,
          urgent: true,
          repeat: 2,
        },
      ];

    // ONE TAP FEEDS EVERYBODY. Accepting an order used to reach the cashier
    // only, and the crew waited for her print. Now the same tap reaches the
    // kitchen, the barista and the cashier at the same second.
    case "confirmed":
      return [
        {
          roles: STATION_ROLES,
          title: "👨‍🍳 New order to cook",
          body: `${table} • accepted • start now`,
          tag: `fana-cook-${t.id}`,
          urgent: true,
          repeat: 2,
        },
        {
          roles: ["cashier"],
          title: "🧾 To print",
          body: `${table}${money(t)} • key it into the EFD and print`,
          tag: `fana-print-${t.id}`,
          urgent: true,
          repeat: 2,
        },
        {
          roles: ["waiter"],
          title: "✓ Order accepted",
          body: `${table} • kitchen, barista and cashier all have it`,
          tag: `fana-confirmed-${t.id}`,
          urgent: false,
          repeat: 0,
        },
      ];

    case "printed":
      return [
        {
          roles: ["waiter"],
          title: "🖨 Bill printed",
          body: `${table} • the EFD receipt is out`,
          tag: `fana-printed-${t.id}`,
          urgent: false,
          repeat: 0,
        },
      ];

    case "preparing":
      return [
        {
          roles: ["waiter"],
          title: "👨‍🍳 Kitchen accepted",
          body: `${table} • the order is being prepared`,
          tag: `fana-preparing-${t.id}`,
          urgent: false,
          repeat: 0,
        },
      ];

    case "ready_for_payment":
      return [
        {
          roles: ["cashier"],
          title: "💳 Payment requested",
          body: `${table}${money(t)} • the guest is ready to pay`,
          tag: `fana-pay-${t.id}`,
          urgent: true,
          repeat: 2,
        },
        {
          roles: ["waiter"],
          title: "💳 Bill time",
          body: `${table}${money(t)} • take the bill to the table`,
          tag: `fana-pay-w-${t.id}`,
          urgent: true,
          repeat: 2,
        },
      ];

    case "completed":
      return [
        {
          roles: ["cashier"],
          title: "✓ Payment completed",
          body: `${table}${money(t)} • verify it and mark Paid`,
          tag: `fana-completed-${t.id}`,
          urgent: true,
          repeat: 1,
        },
        {
          roles: ["waiter"],
          title: "✓ Guest paid",
          body: `${table} • payment recorded`,
          tag: `fana-completed-w-${t.id}`,
          urgent: false,
          repeat: 0,
        },
      ];

    case "paid":
      return [
        {
          roles: ["waiter", "cashier"],
          title: "✓ Bill settled",
          body: `${table}${money(t)} • the bill is closed`,
          tag: `fana-paid-${t.id}`,
          urgent: false,
          repeat: 0,
        },
      ];

    case "closed":
      return [
        {
          roles: ["cashier"],
          title: "✓ Table cleared",
          body: `${table} • free for new guests`,
          tag: `fana-closed-${t.id}`,
          urgent: false,
          repeat: 0,
        },
        {
          roles: STATION_ROLES,
          title: "✓ Table cleared",
          body: `${table} • nothing more to prepare`,
          tag: `fana-closed-s-${t.id}`,
          urgent: false,
          repeat: 0,
        },
      ];

    case "cancelled":
      // The one event everybody must hear immediately: food already on a pan
      // has to stop, and the bill must not be printed or served.
      return [
        {
          roles: ALL_STAFF_ROLES,
          title: "⛔ ORDER CANCELLED",
          body: `${table} • stop preparing and do not serve`,
          tag: `fana-cancelled-${t.id}`,
          urgent: true,
          repeat: 3,
        },
      ];

    default:
      return [];
  }
}

export interface StationProgressInfo extends TicketAlertInfo {
  /** kitchen | barista */
  station: string;
  itemName: string;
  quantity: number;
  /** True when this was the LAST unfinished item of the whole order. */
  wholeOrderReady: boolean;
}

/**
 * The crew touched an item. "Done" is the alert waiters were missing entirely:
 * food went cold on the pass because nobody told them it was ready.
 */
export function stationProgressAlerts(stationStatus: string, info: StationProgressInfo): RoleAlert[] {
  const crew = info.station === "barista" ? "Barista" : "Kitchen";
  if (stationStatus === "done") {
    return [
      {
        roles: ["waiter"],
        title: info.wholeOrderReady ? "🔔 ORDER READY TO SERVE" : "🔔 Ready to serve",
        body: info.wholeOrderReady
          ? `${info.tableName} • the whole order is ready, pick it up`
          : `${info.tableName} • ${info.itemName} x${info.quantity} is ready`,
        tag: `fana-ready-${info.id}-${info.itemName}`,
        urgent: true,
        repeat: 2,
      },
    ];
  }
  if (stationStatus === "accepted") {
    return [
      {
        roles: ["waiter"],
        title: `👨‍🍳 ${crew} started`,
        body: `${info.tableName} • ${info.itemName} x${info.quantity} is being prepared`,
        tag: `fana-started-${info.id}-${info.itemName}`,
        urgent: false,
        repeat: 0,
      },
    ];
  }
  return [];
}

export interface ItemChangeInfo extends TicketAlertInfo {
  itemName: string;
  /** kitchen | barista | "" when the line has no station. */
  station?: string | null;
  /** Only for quantity edits. */
  fromQuantity?: number;
  toQuantity?: number;
}

/** An item was removed from a live bill (out of stock, guest changed mind). */
export function itemRemovedAlerts(info: ItemChangeInfo): RoleAlert[] {
  const stationRoles = stationRoleFor(info.station);
  const alerts: RoleAlert[] = [
    {
      roles: ["waiter"],
      title: "✗ Item removed",
      body: `${info.tableName} • ${info.itemName} is off the bill, tell the guest`,
      tag: `fana-item-removed-${info.id}-${info.itemName}`,
      urgent: true,
      repeat: 1,
    },
  ];
  if (stationRoles.length > 0) {
    alerts.push({
      roles: stationRoles,
      title: "✗ Do not prepare",
      body: `${info.tableName} • ${info.itemName} was removed from the order`,
      tag: `fana-item-removed-s-${info.id}-${info.itemName}`,
      urgent: true,
      repeat: 1,
    });
  }
  return alerts;
}

/** A quantity was corrected on a live bill. */
export function itemQuantityAlerts(info: ItemChangeInfo): RoleAlert[] {
  const stationRoles = stationRoleFor(info.station);
  const change = `${info.itemName}: ${info.fromQuantity} to ${info.toQuantity}`;
  const alerts: RoleAlert[] = [
    {
      roles: ["waiter"],
      title: "✎ Quantity changed",
      body: `${info.tableName} • ${change}`,
      tag: `fana-item-qty-${info.id}-${info.itemName}`,
      urgent: false,
      repeat: 0,
    },
  ];
  if (stationRoles.length > 0) {
    alerts.push({
      roles: stationRoles,
      title: "✎ Quantity changed",
      body: `${info.tableName} • ${change}`,
      tag: `fana-item-qty-s-${info.id}-${info.itemName}`,
      urgent: true,
      repeat: 1,
    });
  }
  return alerts;
}

/** The guest asked for the bill from their own phone. */
export function billRequestAlerts(t: TicketAlertInfo): RoleAlert[] {
  return [
    {
      roles: ["waiter", "cashier"],
      title: "🧾 Bill requested",
      body: `${t.tableName}${money(t)} • the guest asked for the bill`,
      tag: `fana-bill-${t.id}`,
      urgent: true,
      repeat: 2,
    },
  ];
}

function stationRoleFor(station?: string | null): StaffRole[] {
  if (station === "barista") return ["barista"];
  if (station === "kitchen") return ["kitchen"];
  return [];
}

/**
 * Never ring the person who just did the thing. Push subscriptions are stored
 * per ROLE, so the actor's role is dropped from the recipients: the cashier
 * printing a bill does not make her own tablet scream at her.
 */
export function withoutActor(alerts: RoleAlert[], actorRole?: string | null): RoleAlert[] {
  if (!actorRole) return alerts;
  return alerts
    .map((a) => ({ ...a, roles: a.roles.filter((r) => r !== actorRole) }))
    .filter((a) => a.roles.length > 0);
}
