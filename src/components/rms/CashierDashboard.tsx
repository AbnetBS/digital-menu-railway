"use client";

import { isCashierItemLocked, isCashierOrderLocked } from "@/lib/cashier-corrections";
import { useState, useEffect, useRef } from "react";
import {
  Coffee, RefreshCw, LogOut, BellRing, CheckCircle2, XCircle,
  Users, Clock, Image as ImageIcon, Monitor, Printer, AlertTriangle,
} from "lucide-react";
import { Ticket, TicketItem, CafeTable } from "@/types";
import { triggerDesktopNotification } from "@/lib/notifications";
import { formatClock, formatDateTime, groupOrderLines, type OrderLine, waitingLabel } from "@/lib/order-lines";
import { unlockAudio, playDing, playAlarm } from "@/lib/sound";
import { enablePocketAlerts, pushSupported } from "@/lib/push-client";
import PocketAlertsHint from "@/components/rms/PocketAlertsHint";
import PocketAlertsChip from "@/components/rms/PocketAlertsChip";
import OutdoorOrderComposer from "@/components/rms/OutdoorOrderComposer";
import CoffeeNotePanel from "@/components/rms/CoffeeNotePanel";
import UrgentAlertOverlay, { UrgentAlert } from "@/components/rms/UrgentAlertOverlay";
import BillNotificationCard, { BillNotification } from "@/components/rms/BillNotificationCard";
import { usePocketAlerts } from "@/lib/use-pocket-alerts";
import { useStaffT, tNow } from "@/lib/staff-i18n";
import StaffLangToggle from "@/components/rms/StaffLangToggle";

interface StaffLite {
  id: number;
  name: string;
  role: string;
}

interface QueueAdditionLine {
  item: TicketItem;
  addedQuantity: number;
  wholeLineIsNew: boolean;
}

interface PrePrintDisplayLine {
  ids: number[];
  name: string;
  quantity: number;
  price: number;
  notes?: string | null;
  sourceItem: TicketItem | null;
}

export default function CashierDashboard() {
  const { t: L, rich: Lr, td: Ld } = useStaffT();
  const [staffName, setStaffName] = useState("");
  const [staffList, setStaffList] = useState<StaffLite[]>([]);
  const [selectedName, setSelectedName] = useState("");
  const [pin, setPin] = useState("");
  const [loginError, setLoginError] = useState("");

  const [tables, setTables] = useState<CafeTable[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  // "Printed Today" / "Printed Yesterday" — her daily archive, filled at PRINT
  // time (see loadHistory). Both days stay in state so switching between them
  // is instant; `historyDay` picks which one renders.
  const [historyToday, setHistoryToday] = useState<Ticket[]>([]);
  const [historyYesterday, setHistoryYesterday] = useState<Ticket[]>([]);
  const [historyDay, setHistoryDay] = useState<"today" | "yesterday">("today");
  const [receiptModal, setReceiptModal] = useState<string | null>(null);
  // GROUP 12: clickable bill cards — the expanded bill (Printed Today / queue).
  const [billModal, setBillModal] = useState<Ticket | null>(null);
  // Additions cards have two views: ONLY the new items (default) or the full
  // bill for context; this is the set of cards currently showing the full bill.
  const [fullBillOpen, setFullBillOpen] = useState<Set<number>>(new Set());
  // The queue line being fixed in the item editor (note / qty / remove).
  const [editTarget, setEditTarget] = useState<{ item: TicketItem } | null>(null);
  const [outdoorComposerOpen, setOutdoorComposerOpen] = useState(false);
  // ── COFFEE NOTE (owner's decision, Sept 2026) ──
  // The held outdoor-buna tab. `coffeeHeld` feeds the badge on the Coffee Note
  // button (refreshed with the history cadence); the panel itself loads its
  // own rows when opened.
  const [coffeeNoteOpen, setCoffeeNoteOpen] = useState(false);
  const [coffeeHeld, setCoffeeHeld] = useState(0);
  // Per printed bill, which lines are NEW right now — including a waiter or
  // customer adding MORE quantity to an already-existing row. This keeps
  // "Tea x4" readable as "Tea • NEW +2 on the existing line" until she prints.
  const additionLinesRef = useRef<Map<number, Map<number, number>>>(new Map());
  const ticketSnapshotRef = useRef<Map<number, Map<number, number>>>(new Map());

  // ── GROUP 9: PRINT-QUEUE MODE ──
  // Fana's real workflow: the cashier's ONLY system job is one click per order —
  // she keys the bill into the government EFD/POS on her desktop, prints the
  // order paper, and taps ✓ PRINTED here. Payment tracking stays in the EFD
  // world; waiters close bills by tapping "Table cleared". Mode comes from the
  // owner's Settings tab (cashier_mode), defaulting to print-queue.
  const [printQueueMode, setPrintQueueMode] = useState(true);
  const modeRef = useRef(true);
  // Which queue cards have the ✗ Problem panel open (cancel / correction).
  const [problemOpen, setProblemOpen] = useState<Set<number>>(new Set());

  // ── CONNECTION INDICATOR (Group 3) ──
  // Reflects REAL backend communication (fetch success/failure), NOT the browser's
  // internet status. Lets the cashier tell "no new orders" from "we're not talking
  // to the server" at a glance.
  const [connStatus, setConnStatus] = useState<"online" | "offline">("online");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  // ── RING BELL + DESKTOP POPUP ALERT SYSTEM ──
  const [alertsOn, setAlertsOn] = useState(false);
  // STALE-CLOSURE FIX: the SSE handler is built once (deps [staffName]) and
  // froze whatever `alertsOn` was at that moment, so enabling alerts later
  // never reached it and the counter tablet stayed silent. Reads use the ref.
  const alertsOnRef = useRef(false);
  const [toast, setToast] = useState("");

  // ── GUEST EVENTS TAKE OVER THE SCREEN ──
  // The tablet lives behind the counter, often face down or asleep. A guest
  // ordering, adding dishes, or asking for the bill therefore gets a full
  // screen with one big button that keeps re-ringing until it is pressed.
  const [urgent, setUrgent] = useState<UrgentAlert | null>(null);
  // Top right corner bill request notifications (3:4 aspect ratio dark card)
  const [dismissedBillNotifs, setDismissedBillNotifs] = useState<Set<string>>(new Set());
  /** Guest events already answered here, so they never pop up again. */
  const answeredRef = useRef<Set<string>>(new Set());
  /** Tickets already seen at all (a brand new one = a fresh guest order). */
  const knownTicketsRef = useRef<Set<number>>(new Set());
  /** Ticket id -> guest-added submission count since the last print. */
  const customerAddOnsRef = useRef<Map<number, number>>(new Map());
  /** Ticket id -> staff-added submission count since the last print. */
  const staffAddOnsRef = useRef<Map<number, number>>(new Map());
  /**
   * Outdoor tickets already announced as READY, so each one rings exactly
   * once. Cleared when the ticket stops being ready (new items landed) or
   * leaves the active list, so the next ready moment rings again.
   */
  const outdoorReadyAnnouncedRef = useRef<Set<number>>(new Set());
  /** Tickets whose guest already asked for the bill. */
  const billAskedRef = useRef<Set<number>>(new Set());
  /**
   * The big button on the guest alert confirms an order. `setStatus` is
   * defined further down, so the alert reaches it through this ref (kept in
   * step by an effect right after that definition).
   */
  const setStatusRef = useRef<(id: number, status: string) => void>(() => {});
  // Always points at the CURRENT loaders for the SSE + push relays.
  const loadAllRef = useRef<() => void>(() => {});
  const loadHistoryRef = useRef<() => void>(() => {});

  // Refs follow the latest render from an effect (never during render).
  useEffect(() => {
    alertsOnRef.current = alertsOn;
  }, [alertsOn]);
  const seenEventsRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);

  useEffect(() => {
    const saved = sessionStorage.getItem("fana_cashier");
    // A restored session means the cashier is on shift: alerts default to ON.
    const on = localStorage.getItem("fana_alerts") === "1" || !!saved;
    setAlertsOn(on);
    alertsOnRef.current = on;
    if (on) localStorage.setItem("fana_alerts", "1");
    if (saved) setStaffName(JSON.parse(saved).name);
    fetch("/api/staff?public=1")
      .then((r) => r.json())
      .then((d) => setStaffList(d.filter((s: StaffLite) => s.role === "cashier")))
      .catch(() => {});
    // Owner switch: print-queue (EFD workflow) vs full payment recording.
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => {
        const mode = String(s.cashier_mode ?? "print-queue") === "full" ? false : true;
        setPrintQueueMode(mode);
        modeRef.current = mode;
      })
      .catch(() => {});
  }, []);

  // One-time unlock: browsers need a user click before sound + desktop popups can play
  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 4000);
  };

  const enableAlerts = async () => {
    unlockAudio();
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    localStorage.setItem("fana_alerts", "1");
    setAlertsOn(true);
    alertsOnRef.current = true;
    // (Re)arm pocket alerts too, then ring a sample so she KNOWS the device is
    // armed instead of guessing.
    if (pushSupported()) {
      await enablePocketAlerts();
      void pocket.refreshStatus();
    }
    playAlarm();
    triggerDesktopNotification({ title: tNow("Fana Cafe • Cashier"), message: tNow("🔔 Ring bell + desktop + pocket alerts are now ON for this device!") });
  };

  const customerAddsOf = (t: Ticket) => t.unprintedCustomerSubmissions || 0;
  const staffAddsOf = (t: Ticket) => t.unprintedStaffSubmissions || 0;
  const totalAddsOf = (t: Ticket) => t.unprintedSubmissions || 0;
  const isOutdoor = (t: Ticket) => t.orderType === "outdoor";
  /**
   * GROUP ORDERS (owner's decision, Sept 2026): when the seating does not
   * match the table grid (chairs dragged around, shared tables, no table at
   * all), the waiter bills each group of people on its own auto-numbered
   * GROUP bill. They ride the outdoor flow but the badge must tell the truth.
   */
  const isGroup = (t: Ticket) => isOutdoor(t) && /^GROUP \d+$/i.test(String(t.tableName || ""));
  const outdoorBadge = (t: Ticket) => (isGroup(t) ? L("👥 Group") : L("Outdoor"));
  /**
   * An outdoor order is ready when every live line that needs crew completion is
   * done. Buna is the exception: the buna makers use a read-only request list,
   * so the cashier's ✓ PRINTED tap clears their line instead of waiting for a
   * station Done tap. This lets a buna-only outdoor order show Mark Delivered
   * as soon as it is printed, and mixed orders wait only for the other crews.
   */
  const outdoorReady = (t: Ticket) => {
    const live = (t.items || []).filter((item) => !item.removed);
    if (live.length === 0) return false;
    return live.every((item) => {
      if (item.stationName === "buna") {
        if (item.stationStatus === "done") return true;
        if (!t.printedAt) return false;
        const printedMs = new Date(t.printedAt).getTime() || 0;
        const createdMs = item.createdAt ? new Date(item.createdAt).getTime() || 0 : 0;
        return printedMs > 0 && createdMs <= printedMs;
      }
      return item.stationStatus === "done";
    });
  };
  const isGuestTopUp = (t: Ticket) =>
    customerAddOnsRef.current.has(t.id) && customerAddsOf(t) > (customerAddOnsRef.current.get(t.id) || 0);

  const eventMessage = (t: Ticket): string | null => {
    // A guest waiting for the bill outranks whatever the status says.
    if (t.receiptRequestedAt) return tNow("🧾 BILL REQUESTED • {tableName} • {totalAmount} ETB", { tableName: t.tableName, totalAmount: t.totalAmount });
    // Additions to an already-printed bill are their own event. A guest top-up
    // keeps the guest-grade wording; a waiter top-up is quieter and reads as a
    // correction to an existing bill, not a brand-new guest event.
    if (t.status === "printed" && totalAddsOf(t) > 0) {
      if (customerAddsOf(t) > 0) {
        return tNow("🍽 GUEST ADDED ITEMS • {tableName} • print receipt #2", { tableName: t.tableName });
      }
      if (staffAddsOf(t) > 0) {
        return tNow("✎ WAITER ADDED ITEMS • {tableName} • mark the existing bill NEW", { tableName: t.tableName });
      }
      return tNow("⚠ ITEMS ADDED • {tableName} • print receipt #2", { tableName: t.tableName });
    }
    // The money/closing steps (ready to pay, payment completed, bill settled,
    // table cleared) are deliberately missing: they update the screen but ring
    // nobody. Payment lives in the EFD/POS, and constant ringing for it is the
    // fastest way to make staff ignore the alerts that DO matter.
    const m: Record<string, string> = {
      pending_waiter: tNow("🍽 New QR order • {tableName} • {totalAmount} ETB • needs confirmation", { tableName: t.tableName, totalAmount: t.totalAmount }),
      preparing: tNow("👨‍🍳 Preparing • {tableName}", { tableName: t.tableName }),
      printed: tNow("🖨 Printed • {tableName}", { tableName: t.tableName }),
    };
    // QR HOLD FLOW: a confirmed bill with no release stamp is HELD (she
    // accepted it; the crews see nothing yet) — a different message from the
    // real "to print" cards.
    if (t.status === "confirmed") {
      return t.confirmedAt
        ? tNow("🧾 TO PRINT • {tableName} • {totalAmount} ETB", { tableName: t.tableName, totalAmount: t.totalAmount })
        : tNow("⏸ ACCEPTED & HELD • {tableName} • {totalAmount} ETB • send when the guest finishes", { tableName: t.tableName, totalAmount: t.totalAmount });
    }
    return m[t.status] || null;
  };

  // The staff cookie lives 12 hours (one shift). When it dies mid-service the
  // API answers 401 — going back to the login screen WITH an explanation beats
  // a silently frozen queue showing bills that already moved on. Declared up
  // here so every loader below can call it.
  const expireSession = () => {
    try {
      sessionStorage.removeItem("fana_cashier");
    } catch {}
    setPin("");
    setLoginError(tNow("Your session ended. Log in again to keep the queue live."));
    setStaffName("");
  };

  const loadAll = async () => {
    // GROUP 10 FIX: this used to return early while the tab was hidden (screen
    // off, tablet on the counter) — exactly when the alarm matters most — so it
    // never rang. SSE messages only arrive when something CHANGED, so we always
    // process them; the sound and vibration fire even with the screen off.
    try {
      const [tRes, tkRes] = await Promise.all([fetch("/api/tables"), fetch("/api/tickets?active=1")]);
      // A 401 is not "offline" — the shift session ended, and waiting changes
      // nothing. Back to the login screen instead of a frozen queue.
      if (tRes.status === 401 || tkRes.status === 401) return expireSession();
      // Connection indicator: ONLINE only when the backend actually answered both
      // polled endpoints; a failed/thrown fetch flips it to OFFLINE immediately.
      const backendOk = tRes.ok && tkRes.ok;
      setConnStatus(backendOk ? "online" : "offline");
      if (backendOk) setLastUpdated(new Date().toLocaleTimeString());
      if (tRes.ok) setTables(await tRes.json());
      if (tkRes.ok) {
      // PERFORMANCE (Group 1): poll ONLY the small active-orders payload every 8s —
      // paid history is fetched separately on a slow 60s timer (loadHistory below),
      // so we never re-download hundreds of old bills just to find new orders.
      const active: Ticket[] = await tkRes.json();

      // Printed-bill additions are not always a brand-new row. If a waiter adds
      // more of the SAME pending line, the DB folds it into that existing row
      // and only the quantity grows. Keep a per-ticket diff in memory so the
      // queue can still say "NEW +2" on the existing line until she prints.
      const previousTicketSnapshot = ticketSnapshotRef.current;
      const carriedAdditionLines = additionLinesRef.current;
      const nextAdditionLines = new Map<number, Map<number, number>>();
      const nextTicketSnapshot = new Map<number, Map<number, number>>();
      for (const t of active) {
        const perTicketSnapshot = new Map<number, number>();
        const visibleItems = (t.items || []).filter((i) => !i.removed);
        const previousItems = previousTicketSnapshot.get(t.id) || new Map<number, number>();
        const carried = carriedAdditionLines.get(t.id) || new Map<number, number>();
        const nextForTicket = new Map<number, number>();
        for (const i of visibleItems) {
          const qty = Number(i.quantity) || 0;
          perTicketSnapshot.set(i.id, qty);
          if (t.status !== "printed" || totalAddsOf(t) <= 0) continue;
          const prevQty = previousItems.get(i.id);
          const wholeLineIsNew = !!i.createdAt && !!t.printedAt && new Date(i.createdAt).getTime() > new Date(t.printedAt).getTime();
          let addedQuantity = 0;
          if (prevQty !== undefined && qty > prevQty) addedQuantity += qty - prevQty;
          if (prevQty === undefined && wholeLineIsNew) addedQuantity += qty;
          if (addedQuantity === 0) addedQuantity = carried.get(i.id) || 0;
          if (addedQuantity > 0) nextForTicket.set(i.id, addedQuantity);
        }
        nextTicketSnapshot.set(t.id, perTicketSnapshot);
        if (nextForTicket.size > 0) nextAdditionLines.set(t.id, nextForTicket);
      }

      // ── EVENT DETECTION: any order action (QR order, confirmation, payment request, payment done)
      const newEvents: Ticket[] = [];
      // Outdoor orders that JUST became ready (every station tapped Done) and
      // have not been announced yet — the runner moment (see below).
      const freshReady: Ticket[] = [];
      for (const t of active) {
        // The key is the fingerprint of "something the cashier must react to".
        // receiptRequestedAt is part of it now: a guest asking for the bill does
        // NOT change the status, so that event used to slip past her silently.
        // Customer-vs-waiter additions are split too, because only the guest's
        // own top-up should take over the whole screen.
        const cooked = (t.items || []).filter((i) => !i.removed && i.stationStatus === "done").length;
        const key = `${t.id}:${t.status}:${t.unprintedSubmissions || 0}:${t.unprintedCustomerSubmissions || 0}:${t.unprintedStaffSubmissions || 0}:${t.receiptRequestedAt ? 1 : 0}:${cooked}`;
        if (!seenEventsRef.current.has(key)) {
          seenEventsRef.current.add(key);
          newEvents.push(t);
        }
        if (isOutdoor(t) && outdoorReady(t) && !outdoorReadyAnnouncedRef.current.has(t.id)) {
          freshReady.push(t);
        }
      }

      if (initializedRef.current && alertsOnRef.current && newEvents.length > 0) {
        // A card entering HER print queue gets the full alarm; anything else
        // (status moves, cleared tables…) gets the standard ring.
        // Only guest-originated events take over the whole screen. A waiter
        // adding to an existing bill is still visible immediately, but as a
        // quieter "NEW on this bill" update instead of a guest emergency.
        const loudEvents = newEvents.filter((t) => eventMessage(t) !== null);
        const needsMe = loudEvents.some(
          (t) =>
            (t.status === "confirmed" && !!t.confirmedAt) ||
            t.status === "pending_waiter" ||
            !!t.receiptRequestedAt ||
            isGuestTopUp(t)
        );
        if (needsMe) playAlarm();
        else if (loudEvents.length > 0) playDing();

        // Which of these came from a GUEST? Those are the unpredictable ones
        // that deserve the full-screen alarm, not just a line in the list.
        const isWaiterBill = (t: Ticket) =>
          !!t.receiptRequestedAt && !!String(t.receiptRequestedBy || "").trim();
        const isGuestBill = (t: Ticket) =>
          !!t.receiptRequestedAt && !String(t.receiptRequestedBy || "").trim();
        const guestEvent = newEvents.find(
          (t) =>
            (t.status === "pending_waiter" && !knownTicketsRef.current.has(t.id)) ||
            (isGuestBill(t) && !billAskedRef.current.has(t.id)) ||
            isGuestTopUp(t)
        );
        if (guestEvent) {
          const isBill = isGuestBill(guestEvent) && !billAskedRef.current.has(guestEvent.id);
          const isNew = guestEvent.status === "pending_waiter" && !knownTicketsRef.current.has(guestEvent.id);
          const id = `${guestEvent.id}:${isBill ? "bill" : isNew ? "order" : `add${guestEvent.unprintedCustomerSubmissions || 0}`}`;
          if (!answeredRef.current.has(id)) {
            // Guest bill request keeps the full-screen overlay.
            // Waiter "Bill" taps use the 3:4 paper note in the top-right instead.
            if (!isWaiterBill(guestEvent)) {
              setUrgent({
                id,
                kind: isBill ? "bill" : isNew ? "order" : "added",
                ticketId: guestEvent.id,
                table: guestEvent.tableName,
                detail: isBill
                  ? tNow("{totalAmount} ETB • guest asked for the bill", { totalAmount: guestEvent.totalAmount })
                  : isNew
                  ? tNow("{totalAmount} ETB • new QR order", { totalAmount: guestEvent.totalAmount })
                  : tNow("{totalAmount} ETB • guest added items", { totalAmount: guestEvent.totalAmount }),
                actionLabel: isBill ? tNow("OPEN BILL") : isNew ? tNow("✓ ACCEPT ORDER") : tNow("GOT IT"),
                onAction: isNew ? () => setStatusRef.current(guestEvent.id, "confirmed") : undefined,
              });
            }
          }
        }
        const first = loudEvents[0];
        if (first) {
          triggerDesktopNotification({
            title: tNow("Fana Cafe • Cashier Alert"),
            message: eventMessage(first) || tNow("{tableName} updated", { tableName: first.tableName }),
            tag: `fana-cashier-${first.id}`,
          });
        }
      }

      // ── OUTDOOR READY: the runner moment ──
      // Every station with work on an outdoor order tapped Done. The cashier
      // is often mid-print on something else, so — exactly like a guest
      // order, a guest top-up or a bill request — this takes over the whole
      // screen with one big button until she answers it, and rings exactly
      // once. Dine-in tables are deliberately excluded: food ready there is
      // the owning waiter's walk, not the cashier's.
      if (initializedRef.current && alertsOnRef.current && freshReady.length > 0) {
        playAlarm();
        const firstReady = freshReady[0];
        const readyId = `ready-${firstReady.id}`;
        if (!answeredRef.current.has(readyId)) {
          setUrgent({
            id: readyId,
            kind: "ready",
            ticketId: firstReady.id,
            table: firstReady.tableName,
            detail: tNow("{totalAmount} ETB • everything is done • send someone to pick it up", { totalAmount: firstReady.totalAmount }),
            actionLabel: tNow("GOT IT"),
          });
        }
        triggerDesktopNotification({
          title: tNow("Fana Cafe • Outdoor ready"),
          message: tNow("🔔 READY TO DELIVER • {tableName} • send someone to pick it up", { tableName: firstReady.tableName }),
          tag: `fana-cashier-ready-${firstReady.id}`,
        });
      }
      // Remember what this refresh looked like, so the same guest event is
      // never announced twice.
      additionLinesRef.current = nextAdditionLines;
      ticketSnapshotRef.current = nextTicketSnapshot;
      for (const t of active) {
        knownTicketsRef.current.add(t.id);
        customerAddOnsRef.current.set(t.id, customerAddsOf(t));
        staffAddOnsRef.current.set(t.id, staffAddsOf(t));
        if (t.receiptRequestedAt) billAskedRef.current.add(t.id);
        else billAskedRef.current.delete(t.id);
        if (isOutdoor(t) && outdoorReady(t)) outdoorReadyAnnouncedRef.current.add(t.id);
        else {
          // Not ready (or not outdoor): a NEW ready moment later must ring
          // again, so forget both the announcement and the old answer.
          outdoorReadyAnnouncedRef.current.delete(t.id);
          answeredRef.current.delete(`ready-${t.id}`);
        }
      }
      for (const id of [...customerAddOnsRef.current.keys()]) {
        if (!active.some((t) => t.id === id)) {
          customerAddOnsRef.current.delete(id);
          staffAddOnsRef.current.delete(id);
          billAskedRef.current.delete(id);
          outdoorReadyAnnouncedRef.current.delete(id);
          answeredRef.current.delete(`ready-${id}`);
        }
      }
      initializedRef.current = true;

      // ── ANOTHER DEVICE ANSWERED ──
      // Once the order is accepted (or the additions printed, or the bill
      // request cleared) this screen's full-page takeover has nothing left to
      // ask for and closes by itself: the cashier's accept on ONE device stops
      // the alarm on ALL of them.
      setUrgent((cur) => {
        if (!cur || cur.ticketId == null) return cur;
        const t = active.find((x) => x.id === cur.ticketId);
        if (!t) return null; // the bill left the active list (cleared/paid/cancelled)
        if (cur.kind === "order") return t.status === "pending_waiter" ? cur : null;
        if (cur.kind === "bill") return t.receiptRequestedAt ? cur : null;
        // "ready" closes itself once the order is not ready anymore (new items
        // landed) — otherwise it stays until she presses GOT IT.
        if (cur.kind === "ready") return isOutdoor(t) && outdoorReady(t) ? cur : null;
        return customerAddsOf(t) > 0 ? cur : null; // "added" is guest-only now
      });

      setTickets(active);
      }
    } catch {
      // Fetch threw (network down, backend unreachable) → show OFFLINE clearly.
      setConnStatus("offline");
    }
  };

  // "Printed Today" / "Printed Yesterday" panels — loaded on login + every
  // refresh (NOT on the 8s hot loop, and it may skip while the tab is hidden
  // to save data).
  // GROUP 12: in print-queue mode this is the cashier's DAILY CROSS-CHECK
  // against the EFD receipt count, so it must count HER action — the print —
  // not the waiter's table-clear. ?printedToday=1 returns every bill whose
  // printedAt is today (any status: freshly printed, crew working, or later
  // cleared), newest print first, WITH items so a tap opens the full bill.
  // ?printedDate=<yesterday> loads the same list for yesterday, because the
  // morning shift sometimes has to re-check last night's receipts.
  // A bill enters here the moment she taps ✓ PRINTED and STAYS after
  // the waiter clears the table (it was printed today — she still needs it
  // for the end-of-shift receipt count). Full mode keeps "Recently Paid".
  const loadHistory = async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    // Coffee Note badge: how many outdoor buna notes are on hold right now.
    // Fire-and-forget — a hiccup must never disturb the history load.
    fetch("/api/buna-notes")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { held?: unknown[] } | null) => {
        if (d && Array.isArray(d.held)) setCoffeeHeld(d.held.length);
      })
      .catch(() => {});
    if (modeRef.current) {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
      const [todayRes, yesterdayRes] = await Promise.all([
        fetch("/api/tickets?printedToday=1"),
        fetch(`/api/tickets?printedDate=${yesterday}`),
      ]);
      if (todayRes.status === 401 || yesterdayRes.status === 401) return expireSession();
      if (todayRes.ok) setHistoryToday(sortedPrintedToday(await todayRes.json()));
      if (yesterdayRes.ok) setHistoryYesterday(await yesterdayRes.json());
    } else {
      const r = await fetch("/api/tickets?paid=1&limit=12");
      if (r.status === 401) return expireSession();
      if (r.ok) setHistoryToday(await r.json());
    }
  };

  // Printed Today ordering: a bill with NEW items waiting for her next print
  // sorts to the very top (it is on her to-do list too); everything else is
  // newest print first.
  const sortedPrintedToday = (rows: Ticket[]): Ticket[] =>
    [...rows].sort((a, b) => {
      const aw = totalAddsOf(a) > 0 ? 1 : 0;
      const bw = totalAddsOf(b) > 0 ? 1 : 0;
      if (aw !== bw) return bw - aw;
      return new Date(b.printedAt || b.updatedAt || 0).getTime() - new Date(a.printedAt || a.updatedAt || 0).getTime();
    });

  useEffect(() => {
    loadAllRef.current = loadAll;
    loadHistoryRef.current = loadHistory;
  });

  // POCKET MODE: keeps this device subscribed (self-healing) and rings the
  // alarm the moment a push lands, even if the SSE stream was frozen.
  const pocket = usePocketAlerts({
    active: !!staffName,
    onAlert: () => {
      loadAllRef.current();
      loadHistoryRef.current();
    },
  });

  useEffect(() => {
    if (staffName) {
      loadAll();
      loadHistory();
      // REALTIME (SSE): the server pushes a "refresh" signal only when an
      // order/payment changes, instead of polling every 8s/60s.
      //
      // WATCHDOG: the counter tablet sleeps, the socket dies, and EventSource
      // does not always reconnect by itself. Rebuild the stream whenever it is
      // CLOSED so her queue is never quietly frozen.
      let es: EventSource | null = null;
      let stopped = false;

      const connect = () => {
        if (stopped) return;
        try {
          es?.close();
        } catch {
          /* ignore */
        }
        es = new EventSource("/api/realtime?channel=orders");
        es.onmessage = () => {
          loadAllRef.current();
          loadHistoryRef.current();
        };
        es.onerror = () => {
          loadAllRef.current();
        };
      };

      connect();

      const revive = () => {
        if (stopped) return;
        if (!es || es.readyState === 2 /* CLOSED */) connect();
        loadAllRef.current();
      };
      const watchdog = setInterval(() => {
        if (!es || es.readyState === 2) connect();
      }, 30000);
      // Refresh immediately when the tab becomes visible again (user action).
      const onVisible = () => {
        if (!document.hidden) revive();
      };
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("online", revive);
      return () => {
        stopped = true;
        clearInterval(watchdog);
        es?.close();
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("online", revive);
      };
    }
  }, [staffName]);

  const login = async () => {
    setLoginError("");
    // A LOGIN tap with no answer at all (offline, server restarting) used to do
    // nothing whatsoever, so the crew kept re-typing a PIN that was fine.
    const r = await fetch("/api/staff/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: selectedName, pin, role: "cashier" }),
    }).catch(() => null);
    if (!r) {
      setLoginError(tNow("Network error. Try again."));
      return;
    }
    const d = await r.json().catch(() => null);
    if (r.ok && d?.success) {
      setStaffName(d.staff.name);
      sessionStorage.setItem("fana_cashier", JSON.stringify(d.staff));
      // GROUP 10: the login tap unlocks audio AND arms pocket notifications —
      // the cashier's phone/tablet rings even when the browser is closed.
      unlockAudio();
      localStorage.setItem("fana_alerts", "1");
      setAlertsOn(true);
      alertsOnRef.current = true;
      void enablePocketAlerts().then((res) => {
        void pocket.refreshStatus();
        if (res === "denied") {
          // notifications blocked in the browser — the in-app alarm still works
          console.warn("Pocket notifications blocked by the browser settings");
        }
      });
    } else {
      setLoginError(tNow("Wrong name or PIN. Ask admin for your PIN."));
    }
  };

  const logout = () => {
    sessionStorage.removeItem("fana_cashier");
    fetch("/api/staff/login", { method: "DELETE" }).catch(() => {});
    setStaffName("");
    setPin("");
  };

  const setStatus = async (id: number, status: string) => {
    const r = await fetch("/api/tickets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        status,
        // Record who confirms the order (ignored server-side unless status === "confirmed").
        confirmedBy: staffName,
      }),
    });
    // A tap that did nothing must SAY so: another staff member may have moved
    // the bill a second earlier (409), or the session ended (401). The reload
    // below then shows the true state either way.
    if (r.status === 401) return expireSession();
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      showToast(d?.error || tNow("That tap did not go through. Try again."));
    }
    loadAll();
  };

  useEffect(() => {
    setStatusRef.current = setStatus;
  });

  const removeItem = async (itemId: number) => {
    const r = await fetch(`/api/tickets/items?id=${itemId}`, { method: "DELETE" });
    if (r.status === 401) return expireSession();
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      showToast(d?.error || tNow("Could not remove that item. Try again."));
    }
    loadAll();
  };

  const updateItemQty = async (item: TicketItem, qty: number) => {
    const r = await fetch("/api/tickets/items", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: item.id, quantity: qty }),
    });
    if (r.status === 401) return expireSession();
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      showToast(d?.error || tNow("Could not update that item. Try again."));
    }
    loadAll();
  };

  /**
   * The guest tapped "bring us the bill" from their own phone (Group 8). Once the
   * receipt has physically reached the table, clear the flag so the badge stops
   * shouting. This touches ONLY receipt_requested_at — never a status or a price.
   */
  const clearReceiptRequest = async (t: Ticket) => {
    try {
      const r = await fetch("/api/tickets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: t.id, receiptRequested: false }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        showToast(d?.error || tNow("Could not clear the bill request. Try again."));
      }
    } catch {
      showToast(tNow("Network error. Try again."));
    }
    loadAll();
  };

  const markPaid = async (t: Ticket) => {
    // Release the table AND record that it is paid. No payment-method options
    // (owner's decision): keep any historical paid_* status, otherwise "paid".
    const derived =
      t.paymentStatus && t.paymentStatus !== "unpaid" ? t.paymentStatus : "paid";
    const r = await fetch("/api/tickets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: t.id,
        status: "paid",
        paymentStatus: derived,
        // GROUP 5 audit: record WHICH cashier verified & released this bill.
        verifiedBy: staffName || "(cashier)",
      }),
    });
    if (r.status === 401) return expireSession();
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      showToast(d?.error || tNow("Could not mark this bill paid. Try again."));
    }
    loadAll();
  };

  const cancelTicket = async (id: number) => {
    if (confirm(L("Cancel this whole order/bill?"))) await setStatus(id, "cancelled");
  };

  const closeOutdoorOrder = async (t: Ticket) => {
    if (!confirm(L("Mark {tableName} delivered and close it?", { tableName: t.tableName }))) return;
    const r = await fetch("/api/tickets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: t.id, status: "closed", closedBy: staffName || "(cashier)" }),
    });
    if (r.status === 401) return expireSession();
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      showToast(d?.error || tNow("Could not close this outdoor order. Try again."));
    }
    loadAll();
    loadHistory();
  };

  // ── GROUP 9 (print-queue): the cashier's ONE click per order. She keys the
  // bill into the government EFD/POS, the order paper prints on her desktop,
  // and this tap moves the card out of her queue. Payment is not recorded here
  // by design — the EFD/POS remains the financial system of record.
  const markPrinted = async (t: Ticket) => {
    const r = await fetch("/api/tickets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: t.id, status: "printed", printedBy: staffName || "(cashier)" }),
    });
    if (r.status === 401) return expireSession();
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      showToast(d?.error || tNow("Could not mark this bill printed. Try again."));
    }
    loadAll();
    loadHistory();
  };

  // ── QR HOLD FLOW: release a HELD bill to the crews. Her plain accept of a
  // guest's QR order only acknowledged it (the alarms stopped everywhere, the
  // crews saw nothing — the guest may still add items). THIS tap sends the
  // whole bill to the kitchen/barista/buna/juice makers; afterwards the card
  // becomes a normal ✓ PRINTED card, exactly like a waiter-sent order.
  const confirmAndSend = async (t: Ticket) => {
    const r = await fetch("/api/tickets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: t.id, send: true, confirmedBy: staffName || "(cashier)" }),
    });
    if (r.status === 401) return expireSession();
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      showToast(d?.error || tNow("Could not send this bill. Try again."));
    }
    loadAll();
  };

  // Rare path: something is wrong with the order (item unavailable, wrong
  // table…) — reveals the correction tools (remove item / cancel order).
  const toggleProblem = (id: number) => {
    setProblemOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // GROUP 12: additions to an already-printed bill. One EFD-only cutoff rule —
  // item.createdAt <= ticket.printedAt was on the printed receipt; everything
  // newer is NOT printed yet. Her TO PRINT card shows ONLY those new items
  // (she keys just the new items into the EFD and prints the second receipt),
  // never the whole bill again. When a waiter adds MORE quantity to an already
  // existing pending row, there is no new row to inspect — the quantity just
  // grows. `additionLinesRef` carries that diff so the queue can still mark the
  // existing row as NEW until the cashier prints it.
  const isNewUnprinted = (item: TicketItem, t: Ticket): boolean => {
    if (item.removed) return false;
    if (!item.createdAt || !t.printedAt) return false;
    return new Date(item.createdAt).getTime() > new Date(t.printedAt).getTime();
  };
  const addedQuantityFor = (ticketId: number, itemId: number) => additionLinesRef.current.get(ticketId)?.get(itemId) || 0;
  const newItemsOf = (t: Ticket): QueueAdditionLine[] =>
    (t.items || [])
      .filter((i) => !i.removed)
      .flatMap((item) => {
        const wholeLineIsNew = isNewUnprinted(item, t);
        const addedQuantity = wholeLineIsNew ? item.quantity : addedQuantityFor(t.id, item.id);
        if (addedQuantity <= 0) return [];
        return [{ item, addedQuantity, wholeLineIsNew }];
      });
  const isAdditionCard = (t: Ticket): boolean =>
    t.status === "printed" && totalAddsOf(t) > 0;
  const additionSourceLabel = (t: Ticket): string =>
    customerAddsOf(t) > 0 && staffAddsOf(t) > 0
      ? L("guest + waiter")
      : customerAddsOf(t) > 0
      ? L("guest")
      : staffAddsOf(t) > 0
      ? L("waiter")
      : L("order");
  const groupedPrePrintItems = (items: TicketItem[]): PrePrintDisplayLine[] => {
    const visible = items.filter((i) => !i.removed);
    const grouped = groupOrderLines(visible as OrderLine[]);
    return grouped.map((line) => ({
      ids: line.ids,
      name: line.name,
      quantity: line.quantity,
      price: Number(line.price ?? 0),
      notes: line.notes,
      sourceItem: line.ids.length === 1 ? visible.find((i) => i.id === line.ids[0]) || null : null,
    }));
  };

  const isItemLocked = (item: TicketItem, ticket: Ticket) => isCashierItemLocked(item, ticket);
  const isOrderLocked = (ticket: Ticket) => isCashierOrderLocked(ticket);
  const editTicket = tickets.find((t) => t.id === editTarget?.item.ticketId);
  const liveEditItem = editTicket?.items?.find((i) => i.id === editTarget?.item.id);
  const canKeepEditing = !!editTicket && !!liveEditItem && !isItemLocked(liveEditItem, editTicket);

  const statusPill = (t: Ticket) =>
    outdoorReady(t)
      ? { label: L("READY TO DELIVER"), cls: "bg-emerald-600 text-white" }
      : t.status === "printed"
      ? { label: L("PRINTED • IN PROGRESS"), cls: "bg-amber-500 text-black" }
      : t.status === "confirmed"
      ? { label: L("TO PRINT"), cls: "bg-sky-600 text-white" }
      : { label: t.status.replace(/_/g, " ").toUpperCase(), cls: "bg-stone-700 text-stone-100" };

  // Expanded queue card: the full bill for context, with the NEW items marked.
  const toggleFullBill = (id: number) => {
    setFullBillOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /* ── LOGIN ── */
  if (!staffName) {
    return (
      <div className="relative min-h-screen bg-[#1C120F] flex items-center justify-center p-4 text-white">
        <StaffLangToggle compact className="absolute top-3 right-3" />
        <div className="bg-[#2C1B17] border border-[#C9A227]/40 rounded-3xl p-8 w-full max-w-sm space-y-6 shadow-2xl">
          <div className="text-center space-y-2">
            <div className="w-14 h-14 rounded-2xl bg-[#C9A227] text-[#2C1B17] flex items-center justify-center mx-auto">
              <Monitor className="w-7 h-7" />
            </div>
            <h1 className="font-serif text-2xl font-bold text-amber-100">{L("Cashier Login")}</h1>
            <p className="text-xs text-stone-400">{L("Enter your name and PIN given by the admin.")}</p>
          </div>
          {loginError && (
            <div className="bg-rose-900/60 border border-rose-500 text-rose-200 text-xs p-3 rounded-xl">{loginError}</div>
          )}
          <div className="space-y-4">
            <select
              value={selectedName}
              onChange={(e) => setSelectedName(e.target.value)}
              className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-sm text-white"
            >
              <option value="">{L("Select your name...")}</option>
              {staffList.map((s) => (
                <option key={s.id} value={s.name}>{s.name}</option>
              ))}
            </select>
            <input
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="••••"
              className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-sm text-white text-center tracking-[0.5em]"
            />
            <button
              onClick={login}
              disabled={!selectedName || !pin}
              className="w-full bg-gradient-to-r from-[#C9A227] to-[#B8921F] text-[#2C1B17] font-black text-sm uppercase py-4 rounded-xl disabled:opacity-40"
            >
              {L("Login as Cashier")}
            </button>
            <a href="/" className="block text-center text-xs text-[#C9A227] hover:underline">{L("← Back to public website")}</a>
          </div>
        </div>
      </div>
    );
  }

  const activeTickets = tickets;
  const pendingCount = tickets.filter((t) => t.status === "pending_waiter").length;
  const newCount = tickets.filter((t) => t.status === "confirmed").length;
  const payCount = tickets.filter((t) => t.status === "ready_for_payment" || t.status === "completed").length;

  const billNotifications: BillNotification[] = tickets
    .filter((t) => Boolean(t.receiptRequestedAt))
    .map((t) => ({
      id: `${t.id}:${t.receiptRequestedAt}`,
      ticketId: t.id,
      tableName: t.tableName,
      waiterName: t.receiptRequestedBy || t.confirmedBy || t.createdBy || L("Waiter"),
      receiptRequestedAt: t.receiptRequestedAt,
      totalAmount: t.totalAmount,
    }))
    .filter((notif) => !dismissedBillNotifs.has(notif.id));

  // ── GROUP 9 (print-queue): what the cashier's queue is made of ──
  // Orders that were SENT to the crews but nobody keyed into the EFD yet,
  // plus already-printed bills that received ADDITIONS since the last print
  // (the old paper world's "print a second receipt" — now one re-print).
  // QR HOLD FLOW: a confirmed bill with NO release stamp is HELD — accepted
  // (alarms stopped) but not sent, because the guest may still add items.
  // Held bills sit in their own section with a CONFIRM & SEND button and are
  // NOT printable until they are sent.
  const waitingConfirm = tickets.filter((t) => t.status === "pending_waiter");
  const heldCards = tickets.filter((t) => t.status === "confirmed" && !t.confirmedAt && !t.printedAt);
  const toPrint = tickets.filter((t) => t.status === "confirmed" && (!!t.confirmedAt || !!t.printedAt));
  const addedCards = tickets.filter((t) => t.status === "printed" && totalAddsOf(t) > 0);
  const printQueue = [...addedCards, ...toPrint];
  const outdoorTickets = tickets.filter((t) => isOutdoor(t));

  // Which archive list renders below the tables: today's prints or yesterday's.
  const history = historyDay === "today" ? historyToday : historyYesterday;

  // Board tile labels mean different things per mode. In print-queue mode the
  // board is the cashier's ambient awareness: rose = an order is waiting to be
  // keyed into the EFD, orange = printed and the crew is working on it.
  const boardLabel = (s?: string) => {
    if (s === "available") return L("Free");
    if (printQueueMode) {
      if (s === "waiting") return L("Confirm");
      if (s === "preparing") return L("In progress");
      if (s === "ready-for-payment") return L("Bill");
      return L("TO PRINT");
    }
    if (s === "waiting") return L("Waiting");
    if (s === "ready-for-payment") return L("Pay");
    if (s === "preparing") return L("Kitchen");
    return L("Busy");
  };

  const statusMeta: Record<string, { label: string; cls: string }> = {
    pending_waiter: { label: L("⏳ NEEDS CONFIRMATION"), cls: "bg-violet-600 text-white" },
    confirmed: { label: L("🔔 CONFIRMED • NEW"), cls: "bg-amber-500 text-black" },
    preparing: { label: L("👨‍🍳 Preparing"), cls: "bg-orange-600 text-white" },
    ready_for_payment: { label: L("💳 Payment Requested"), cls: "bg-purple-600 text-white" },
    completed: { label: L("✓ Paid (verify)"), cls: "bg-emerald-600 text-white" },
  };

  // No payment-method options (owner's decision): a bill is either paid or it
  // isn't. Historical paid_cash / paid_telebirr / ... statuses still read as paid.
  const paymentStatusLabel = (s?: string | null) =>
    s && s !== "unpaid" ? L("✓ PAID") : L("✗ UNPAID");

  const paymentStatusCls = (s?: string | null) =>
    s && s !== "unpaid" ? "bg-emerald-600 text-white" : "bg-rose-600 text-white";

  // Cashier can correct/record whether the bill was paid (separate from order status).
  const setPaymentStatus = async (id: number, paymentStatus: string) => {
    try {
      const r = await fetch("/api/tickets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, paymentStatus }),
      });
      if (!r.ok) {
        // The server refuses a locked correction with its own explanation —
        // show THAT, so the cashier knows why the switch did not move.
        const d = await r.json().catch(() => null);
        showToast(d?.error || tNow("Could not save the payment status. Try again."));
        loadAll();
        return;
      }
    } catch {
      showToast(tNow("Network error. Try again."));
      loadAll();
      return;
    }
    loadAll();
  };

  return (
    <div className="min-h-screen bg-[#14100C] text-white pb-10">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-[#2C1B17]/95 backdrop-blur border-b border-[#C9A227]/30 px-4 md:px-8 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[#C9A227] flex items-center justify-center">
            <Coffee className="w-5 h-5 text-[#2C1B17]" />
          </div>
          <div>
            <h1 className="font-serif font-bold text-amber-100 leading-none">{L("Fana Cafe • Cashier")}</h1>
            <p className="text-[10px] text-stone-400">{L("{staffName} • coordinating waiters & kitchen", { staffName })}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* CONNECTION INDICATOR (Group 3) — real backend communication, not browser internet */}
          <div
            className={`flex flex-col items-end ${
              connStatus === "online"
                ? "text-emerald-300"
                : "text-rose-300"
            }`}
            title={connStatus === "online" ? L("Connected • last updated {lastUpdated}", { lastUpdated: lastUpdated || L("just now") }) : L("Lost contact with the server • reconnecting")}
          >
            <span className={`flex items-center gap-1.5 text-[10px] font-black px-2.5 py-1 rounded-full border ${
              connStatus === "online"
                ? "bg-emerald-900/40 border-emerald-500/40"
                : "bg-rose-900/60 border-rose-500/60 animate-pulse"
            }`}>
              <span className={`w-2 h-2 rounded-full ${connStatus === "online" ? "bg-emerald-400" : "bg-rose-400"}`} />
              {connStatus === "online" ? L("ONLINE") : L("OFFLINE • RECONNECTING")}
            </span>
            {lastUpdated && (
              <span className="text-[9px] text-stone-500 mt-0.5">{L("last updated {lastUpdated}", { lastUpdated })}</span>
            )}
          </div>
          <PocketAlertsChip
            status={pocket.status}
            busy={pocket.busy}
            onArm={pocket.arm}
            onTest={pocket.test}
            onToast={showToast}
            notificationsEnabled={pocket.notificationsEnabled}
            onSetNotificationsEnabled={pocket.setNotificationsEnabled}
          />
          {/* RING BELL enable button — click once on each cashier device */}
          <button
            onClick={enableAlerts}
            className={`text-[10px] font-black px-3 py-1.5 rounded-full flex items-center gap-1.5 transition ${
              alertsOn
                ? "bg-emerald-600 text-white"
                : "bg-[#C9A227] text-[#2C1B17] animate-pulse"
            }`}
            title={alertsOn ? L("Ring bell + desktop alerts enabled") : L("Click once to enable ring bell & desktop alerts")}
          >
            <BellRing className="w-3.5 h-3.5" />
            {alertsOn ? L("ALERTS ON") : L("🔔 ENABLE ALERTS")}
          </button>
          {printQueueMode ? (
            <>
              {printQueue.length > 0 && (
                <span className="bg-amber-500 text-black text-[10px] font-black px-2.5 py-1 rounded-full animate-pulse flex items-center gap-1">
                  <Printer className="w-3 h-3" /> {L("{length} TO PRINT", { length: printQueue.length })}
                </span>
              )}
              {waitingConfirm.length > 0 && (
                <span className="bg-violet-600 text-white text-[10px] font-black px-2.5 py-1 rounded-full flex items-center gap-1">
                  <BellRing className="w-3 h-3" /> {L("{length} WAITER", { length: waitingConfirm.length })}
                </span>
              )}
              {heldCards.length > 0 && (
                <span className="bg-sky-600 text-white text-[10px] font-black px-2.5 py-1 rounded-full flex items-center gap-1">
                  <Clock className="w-3 h-3" /> {L("{length} HELD", { length: heldCards.length })}
                </span>
              )}
            </>
          ) : (
            <>
              {pendingCount > 0 && (
                <span className="bg-violet-600 text-white text-[10px] font-black px-2.5 py-1 rounded-full animate-pulse flex items-center gap-1">
                  <BellRing className="w-3 h-3" /> {L("{pendingCount} TO CONFIRM", { pendingCount })}
                </span>
              )}
              {newCount > 0 && (
                <span className="bg-amber-500 text-black text-[10px] font-black px-2.5 py-1 rounded-full animate-pulse flex items-center gap-1">
                  <BellRing className="w-3 h-3" /> {L("{newCount} NEW", { newCount })}
                </span>
              )}
              {payCount > 0 && (
                <span className="bg-purple-600 text-white text-[10px] font-black px-2.5 py-1 rounded-full">{L("{payCount} PAY", { payCount })}</span>
              )}
            </>
          )}
          <StaffLangToggle compact />
          <button onClick={() => { loadAll(); loadHistory(); }} className="p-2 rounded-xl bg-white/10 text-amber-200" title={L("Refresh")}>
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={logout} className="p-2 rounded-xl bg-rose-600/80 text-white" title={L("Logout")}>
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Toast */}
      {/* Full-screen guest alert (new order / added items / bill request) */}
      <UrgentAlertOverlay
        alert={urgent}
        onClose={() =>
          setUrgent((cur) => {
            if (cur) answeredRef.current.add(cur.id);
            return null;
          })
        }
      />

      {/* Top Right Corner Modern Notification Card for Bill Requests (3:4 aspect ratio dark card) */}
      {billNotifications.length > 0 && (
        <div className="fixed top-4 right-4 z-50 flex flex-col items-end gap-3 pointer-events-auto max-w-[calc(100vw-2rem)]">
          {billNotifications.slice(0, 2).map((notif) => (
            <BillNotificationCard
              key={notif.id}
              notification={notif}
              onDismiss={(id) => {
                setDismissedBillNotifs((prev) => new Set(prev).add(id));
              }}
            />
          ))}
          {billNotifications.length > 2 && (
            <div className="bg-[#2C1B17] border border-[#C9A227]/40 px-3 py-1 rounded-full text-xs font-bold text-amber-200">
              {L("+{n} more bill requests", { n: billNotifications.length - 2 })}
            </div>
          )}
        </div>
      )}

      {toast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-emerald-600 text-white text-xs font-bold px-4 py-2.5 rounded-full shadow-2xl max-w-[90vw] text-center">
          {toast}
        </div>
      )}

      <div className="max-w-[1700px] mx-auto p-4 md:p-6 space-y-8">
        {/* iPhone pocket-mode instruction (Android needs nothing) */}
        <PocketAlertsHint />

        <section className="bg-[#2C1B17] border border-violet-500/30 rounded-3xl p-4 md:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xs font-bold uppercase tracking-widest text-violet-300/90">{L("Outdoor Orders")}</h2>
              <p className="text-xs text-stone-400 mt-1">
                {L("Cashier-only flow for delivery / outside orders, plus the 👥 group orders waiters take when the seating does not match the tables. The moment every station taps Done, this screen takes over with an alarm so you can send someone to pick it up.")}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setOutdoorComposerOpen(true)}
                className="bg-violet-600 hover:bg-violet-500 text-white text-xs font-black px-4 py-3 rounded-2xl"
              >
                {L("+ New Outdoor Order")}
              </button>
            </div>
          </div>
          {outdoorTickets.length === 0 ? (
            <div className="bg-[#241714] border border-stone-800 rounded-2xl p-4 text-xs text-stone-500">
              {L("No active outdoor orders right now.")}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {outdoorTickets.map((t) => {
                const meta = statusPill(t);
                const items = t.items || [];
                const visible = items.filter((item) => !item.removed);
                const problem = problemOpen.has(t.id);
                const orderLocked = isOrderLocked(t);
                return (
                  <div key={t.id} className="bg-[#241714] border border-violet-500/30 rounded-2xl p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-serif font-black text-lg text-amber-100">{t.tableName}</p>
                          <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300 border border-violet-500/40">
                            {outdoorBadge(t)}
                          </span>
                        </div>
                        <p className="text-[11px] font-bold text-stone-300 mt-1">
                          {L("{value}{reduce} item(s)", { value: t.orderNumber ? `#${t.orderNumber} • ` : "", reduce: visible.reduce((sum, item) => sum + item.quantity, 0) })}
                        </p>
                        {t.serviceNote && <p className="text-[11px] font-bold text-sky-300 mt-1">📍 {t.serviceNote}</p>}
                      </div>
                      <div className="text-right shrink-0">
                        <span className={`inline-block text-[10px] font-black px-2.5 py-1 rounded-full uppercase ${meta.cls}`}>
                          {meta.label}
                        </span>
                        <p className="font-serif font-black text-xl text-[#C9A227] mt-2">{t.totalAmount} ETB</p>
                      </div>
                    </div>
                    <div className="bg-[#3D2314] rounded-xl divide-y divide-stone-800">
                      {items.map((i) => (
                        <div key={i.id} className={`p-2.5 text-xs flex items-center justify-between gap-2 ${i.removed ? "opacity-40 line-through" : ""}`}>
                          <div className="flex-1 min-w-0">
                            <p className="font-bold text-amber-100 truncate">
                              {i.name} <span className="text-stone-300 font-bold">({i.price} ETB)</span>
                            </p>
                            {i.notes && <p className="text-[11px] font-semibold text-amber-300 italic">📝 {i.notes}</p>}
                            <p className="text-[10px] font-bold text-stone-400 mt-0.5">
                              × {i.quantity}
                              {i.stationStatus === "done"
                                ? L(" • done")
                                : i.stationStatus === "accepted"
                                ? L(" • preparing")
                                : L(" • pending")}
                            </p>
                          </div>
                          {!i.removed && !isItemLocked(i, t) && (
                            <button
                              onClick={() => setEditTarget({ item: i })}
                              className="px-2 py-1 bg-[#C9A227]/15 text-[#C9A227] border border-[#C9A227]/40 rounded text-[10px] font-black hover:bg-[#C9A227] hover:text-black shrink-0"
                              title={L("Fix this item's note or quantity, or remove it.")}
                            >
                              {L("✎ Edit")}
                            </button>
                          )}
                          {!orderLocked && problem && !i.removed && !isItemLocked(i, t) ? (
                            <button
                              onClick={() => removeItem(i.id)}
                              className="px-2 py-1 bg-rose-900/60 text-rose-300 rounded text-[10px] font-bold hover:bg-rose-700 hover:text-white shrink-0"
                              title={L("Remove (wrong item)")}
                            >
                              {L("Remove")}
                            </button>
                          ) : null}
                          {i.removed && <span className="text-[10px] font-bold text-rose-400">{L("REMOVED")}</span>}
                        </div>
                      ))}
                      {visible.length === 0 && <p className="p-3 text-center text-xs text-stone-500">{L("All items removed. Cancel the order if it was sent by mistake.")}</p>}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => setBillModal(t)}
                        className="flex-1 min-w-[110px] bg-white/10 hover:bg-white/20 text-stone-100 text-xs font-black py-2.5 rounded-xl"
                      >
                        {L("View Bill")}
                      </button>
                      {t.status === "confirmed" && (
                        <button
                          onClick={() => markPrinted(t)}
                          className="flex-1 min-w-[110px] bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black py-2.5 rounded-xl"
                        >
                          {L("✓ Printed")}
                        </button>
                      )}
                      {t.status === "printed" && outdoorReady(t) && (
                        <button
                          onClick={() => closeOutdoorOrder(t)}
                          className="flex-1 min-w-[130px] bg-amber-500 hover:bg-amber-400 text-[#2C1B17] text-xs font-black py-2.5 rounded-xl"
                        >
                          {L("Mark Delivered")}
                        </button>
                      )}
                      {!orderLocked && (
                        <button
                          onClick={() => toggleProblem(t.id)}
                          className={`px-3 py-2.5 rounded-xl text-xs font-bold flex items-center gap-1.5 shrink-0 ${
                            problem ? "bg-rose-600 text-white" : "bg-rose-900/60 text-rose-300 hover:bg-rose-700 hover:text-white"
                          }`}
                        >
                          <AlertTriangle className="w-4 h-4" /> {L("Problem")}
                        </button>
                      )}
                    </div>
                    {!orderLocked && problem && (
                      <div className="bg-rose-950/40 border border-rose-800 rounded-xl px-3 py-2 text-[11px] text-rose-200 space-y-2">
                        <p>{Lr("Wrong item? Use <b>Remove</b> on a line above, or cancel the whole outdoor order:", { b: (s) => <strong>{s}</strong> })}</p>
                        <button
                          onClick={() => cancelTicket(t.id)}
                          className="bg-rose-700 hover:bg-rose-600 text-white text-[11px] font-black px-3 py-2 rounded-xl"
                        >
                          {L("✗ Cancel whole order")}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* TABLE OVERVIEW */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-widest text-amber-200/80 mb-3 flex items-center gap-2">
            <Users className="w-4 h-4 text-[#C9A227]" /> {L("Tables Overview")}
          </h2>
          <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-10 gap-2">
            {tables.map((t) => (
              <div
                key={t.id}
                className={`rounded-xl p-3 text-center border-2 ${
                  t.status === "available"
                    ? "border-emerald-500/50 bg-emerald-950/30"
                    : t.status === "waiting"
                    ? "border-violet-500/60 bg-violet-950/30"
                    : t.status === "ready-for-payment"
                    ? "border-amber-400 bg-amber-950/30"
                    : t.status === "preparing"
                    ? "border-orange-500/60 bg-orange-950/30"
                    : "border-rose-500/50 bg-rose-950/30"
                }`}
              >
                <p className="text-[11px] font-bold text-amber-100">{t.name}</p>
                <p
                  className={`text-[9px] font-extrabold uppercase mt-1 ${
                    t.status === "available"
                      ? "text-emerald-400"
                      : t.status === "waiting"
                      ? "text-violet-400"
                      : t.status === "ready-for-payment"
                      ? "text-amber-300"
                      : t.status === "preparing"
                      ? "text-orange-400"
                      : "text-rose-400"
                  }`}
                >
                  {boardLabel(t.status)}
                </p>
                {/* Group 8/9: the guest asked for the bill — the cashier keys the
                    final receipt into the EFD, so this is HER action item. */}
                {t.activeTicketReceiptRequestedAt && (
                  <p className="text-[9px] font-black text-emerald-300 mt-1">{L("🧾 BILL!")}</p>
                )}
                {!printQueueMode || t.status === "available" ? null : (
                  <p className="text-[9px] text-stone-500 mt-0.5">{t.activeTicketTotal ?? 0} ETB</p>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* ═══ GROUP 9: PRINT-QUEUE MODE — the cashier's whole job, one click per order ═══ */}
        {printQueueMode && (
          <>
            {/* QR orders still waiting for a WAITER to verify — deliberately NOT
                in the print queue: the cashier must never key an order into the
                EFD before a waiter has physically confirmed it with the guest. */}
            {waitingConfirm.length > 0 && (
              <section>
                <h2 className="text-xs font-bold uppercase tracking-widest text-violet-300/80 mb-3 flex items-center gap-2">
                  <Users className="w-4 h-4 text-violet-400" /> {L("Waiting for waiter confirmation ({length})", { length: waitingConfirm.length })}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {waitingConfirm.map((t) => (
                    <div key={t.id} className="bg-[#241714] border border-violet-700/60 rounded-2xl p-4 flex items-center justify-between gap-3">
                      <div className="min-w-0 space-y-0.5">
                        <p className="font-serif font-bold text-amber-100">
                          {t.tableName}
                          {t.orderNumber && <span className="ml-1.5 text-[10px] font-black text-stone-400">#{t.orderNumber}</span>}
                        </p>
                        <p className="text-xs font-bold text-stone-300">{L("🕒 arrived {clock} • {totalAmount} ETB", { clock: formatClock(t.createdAt), totalAmount: t.totalAmount })}</p>
                        <p className="text-xs font-bold text-violet-300 truncate">{L("by")} {t.createdBy || L("Customer (QR)")}</p>
                      </div>
                      <button
                        onClick={() => setStatus(t.id, "confirmed")}
                        className="shrink-0 bg-violet-600 hover:bg-violet-500 text-white text-[10px] font-black px-3 py-2.5 rounded-xl"
                        title={L("Only if the waiter already verified it with the guest. Normally the waiter does this. The bill is then HELD until you tap CONFIRM & SEND")}
                      >
                        {L("✓ Accept (holds it)")}
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ═══ QR HOLD FLOW — accepted but NOT sent yet ═══
                The cashier acknowledged the guest's QR order (the alarms stopped
                on every device), but the crews see NOTHING from this bill: the
                guest may still add items from their phone, and every addition
                lands here too. When they finish, her CONFIRM & SEND releases
                the whole bill at once — and only then does the normal
                ✓ PRINTED step appear on the card. */}
            {heldCards.length > 0 && (
              <section>
                <h2 className="text-xs font-bold uppercase tracking-widest text-sky-300/80 mb-3 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-sky-400" /> {L("Held • accepted, waiting for your CONFIRM & SEND ({length})", { length: heldCards.length })}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {heldCards.map((t) => {
                    const items = t.items || [];
                    const visible = items.filter((i) => !i.removed);
                    const groupedVisible = groupedPrePrintItems(items);
                    const problem = problemOpen.has(t.id);
                    const orderLocked = isOrderLocked(t);
                    return (
                      <div key={t.id} className="bg-[#241714] border-2 border-sky-500/70 rounded-2xl p-4 space-y-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="space-y-0.5">
                            <p className="font-serif font-bold text-xl text-amber-100">
                              {t.tableName}
                              {t.orderNumber && (
                                <span className="ml-2 align-middle text-[10px] font-black bg-stone-800 border border-[#C9A227]/40 text-[#C9A227] px-2 py-0.5 rounded-full">
                                  #{t.orderNumber}
                                </span>
                              )}
                            </p>
                            <p className="text-xs font-bold text-stone-300 flex items-center gap-1">
                              <Clock className="w-3.5 h-3.5 text-[#C9A227]" /> {L("arrived {clock} • waiting {waitingLabel}", { clock: formatClock(t.createdAt), waitingLabel: Ld(waitingLabel(t.createdAt)) })}
                            </p>
                            <p className="text-xs font-bold text-stone-300 truncate">{L("by")} {t.createdBy || L("Customer (QR)")}</p>
                          </div>
                          <div className="text-right shrink-0">
                            <span className="inline-block text-[11px] font-black px-2.5 py-1 rounded-full bg-sky-500 text-black">{L("⏸ HELD")}</span>
                            <p className="font-serif font-black text-2xl text-[#C9A227] mt-1">{t.totalAmount} ETB</p>
                            <p className="text-[11px] font-bold text-stone-300">{L("{reduce} items • nothing sent yet", { reduce: visible.reduce((s, i) => s + i.quantity, 0) })}</p>
                          </div>
                        </div>

                        <p className="text-xs font-bold text-sky-300 bg-sky-950/40 border border-sky-700/40 rounded-xl px-3 py-2">
                          {L("Accepted. The kitchen, barista, buna and juice makers do NOT have this order yet. If the guest is still ordering, wait; when they finish tap CONFIRM & SEND.")}
                        </p>

                        <div className="bg-[#3D2314] rounded-xl divide-y divide-stone-800">
                          {groupedVisible.map((line) => {
                            const sourceItem = line.sourceItem;
                            return (
                            <div key={line.ids.join("-")} className="p-2.5 text-xs flex items-center justify-between gap-2">
                              <div className="flex-1 min-w-0">
                                <p className="font-bold text-amber-100 truncate">
                                  {line.name} <span className="text-stone-300 font-bold">({line.price} ETB)</span>
                                </p>
                                {line.notes && <p className="text-[11px] font-semibold text-amber-300 italic">📝 {line.notes}</p>}
                                {line.ids.length > 1 && (
                                  <p className="text-[10px] font-black text-sky-300 mt-0.5">
                                    {L("Combined on cashier side • same item added again")}
                                  </p>
                                )}
                              </div>
                              <div className="text-right shrink-0">
                                <p className="font-extrabold text-amber-100">× {line.quantity}</p>
                                <p className="text-[10px] font-black text-[#C9A227]">{line.price * line.quantity} ETB</p>
                              </div>
                              {sourceItem && !isItemLocked(sourceItem, t) ? (
                                <button
                                  onClick={() => setEditTarget({ item: sourceItem })}
                                  className="px-2 py-1 bg-[#C9A227]/15 text-[#C9A227] border border-[#C9A227]/40 rounded text-[10px] font-black hover:bg-[#C9A227] hover:text-black shrink-0"
                                  title={L("Fix this item's note or quantity, or remove it. Saving never prints • the card stays in your queue.")}
                                >
                                  {L("✎ Edit")}
                                </button>
                              ) : null}
                              {!orderLocked && problem && sourceItem && !isItemLocked(sourceItem, t) ? (
                                <button
                                  onClick={() => removeItem(sourceItem.id)}
                                  className="px-2 py-1 bg-rose-900/60 text-rose-300 rounded text-[10px] font-bold hover:bg-rose-700 hover:text-white shrink-0"
                                  title={L("Remove (unavailable)")}
                                >
                                  {L("Remove")}
                                </button>
                              ) : null}
                            </div>
                            );})}
                          {visible.length === 0 && <p className="p-3 text-center text-xs text-stone-500">{L("All items removed.")}</p>}
                        </div>

                        <div className="flex gap-2 pt-1">
                          <button
                            onClick={() => confirmAndSend(t)}
                            className="flex-1 bg-sky-600 hover:bg-sky-500 text-white text-sm font-black py-4 rounded-xl flex items-center justify-center gap-2"
                            title={L("Sends this order to the kitchen/barista/buna/juice makers now. Afterwards key it into the EFD and tap ✓ PRINTED")}
                          >
                            <CheckCircle2 className="w-5 h-5" /> {L("✓ CONFIRM & SEND")}
                          </button>
                          {!orderLocked && (
                            <button
                              onClick={() => toggleProblem(t.id)}
                              className={`px-4 py-4 rounded-xl text-xs font-bold flex items-center gap-1.5 shrink-0 ${
                                problem ? "bg-rose-600 text-white" : "bg-rose-900/60 text-rose-300 hover:bg-rose-700 hover:text-white"
                              }`}
                            >
                              <AlertTriangle className="w-4 h-4" /> {L("Problem")}
                            </button>
                          )}
                        </div>
                        {!orderLocked && problem && (
                          <div className="bg-rose-950/40 border border-rose-800 rounded-xl px-3 py-2 text-[11px] text-rose-200 space-y-2">
                            <p>{Lr("Use <b>Remove</b> on an item above if it is unavailable, or cancel the whole order:", { b: (s) => <strong>{s}</strong> })}</p>
                            <button
                              onClick={() => cancelTicket(t.id)}
                              className="bg-rose-700 hover:bg-rose-600 text-white text-[11px] font-black px-3 py-2 rounded-xl"
                            >
                              {L("✗ Cancel whole order")}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* THE PRINT QUEUE — key the card into the EFD, print the order paper, tap ✓ PRINTED */}
            <section>
              <h2 className="text-xs font-bold uppercase tracking-widest text-amber-200/80 mb-3 flex items-center gap-2">
                <Printer className="w-4 h-4 text-[#C9A227]" /> {L("To Print ({length}) → key into EFD → print → tap ✓", { length: printQueue.length })}
              </h2>
              {printQueue.length === 0 ? (
                <div className="bg-[#2C1B17] border border-stone-800 rounded-2xl p-8 text-center text-stone-500 text-sm">
                  {L("Nothing to print. Orders the waiters send appear here instantly.")}
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {printQueue.map((t) => {
                    const added = isAdditionCard(t);
                    const items = t.items || [];
                    const visible = items.filter((i) => !i.removed);
                    const groupedVisible = groupedPrePrintItems(items);
                    // GROUP 12: additions card — by default she keys ONLY the
                    // new, not-yet-printed items into the EFD (receipt #2).
                    // The full bill is one tap away for context (new items
                    // highlighted); the default view and print action are
                    // about the NEW items only. A merged top-up stays on the
                    // existing line as NEW +N until she prints.
                    const newItems = added ? newItemsOf(t) : visible.map((item) => ({ item, addedQuantity: item.quantity, wholeLineIsNew: true }));
                    const showFullBill = fullBillOpen.has(t.id);
                    const newTotal = newItems.reduce((s, line) => s + line.item.price * line.addedQuantity, 0);
                    const newCount = newItems.reduce((s, line) => s + line.addedQuantity, 0);
                    const problem = problemOpen.has(t.id);
                    const orderLocked = isOrderLocked(t);
                    return (
                      <div key={t.id} className={`bg-[#2C1B17] rounded-2xl border-2 p-4 space-y-3 ${added ? "border-amber-400" : "border-[#C9A227]/70"}`}>
                        {/* header */}
                        <div className="flex items-start justify-between gap-2">
                          <div className="space-y-0.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-serif font-bold text-xl text-amber-100">{t.tableName}</p>
                              {t.orderNumber && (
                                <span className="align-middle text-[10px] font-black bg-stone-800 border border-[#C9A227]/40 text-[#C9A227] px-2 py-0.5 rounded-full">
                                  #{t.orderNumber}
                                </span>
                              )}
                              {isOutdoor(t) && (
                                <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300 border border-violet-500/40">
                                  {outdoorBadge(t)}
                                </span>
                              )}
                            </div>
                            <p className="text-xs font-bold text-stone-300 flex items-center gap-1">
                              <Clock className="w-3.5 h-3.5 text-[#C9A227]" /> {t.confirmedBy ? L("by {confirmedBy}", { confirmedBy: t.confirmedBy }) : L("by {createdBy}", { createdBy: t.createdBy || L("waiter") })}
                            </p>
                            <p className="text-xs font-bold text-stone-300">
                              {L("🕒 arrived {clock} • waiting {waitingLabel}", { clock: formatClock(t.createdAt), waitingLabel: Ld(waitingLabel(t.createdAt)) })}
                            </p>
                            {t.serviceNote && <p className="text-[11px] font-bold text-sky-300">📍 {t.serviceNote}</p>}
                          </div>
                          <div className="text-right shrink-0">
                            {added ? (
                              <span className="inline-block text-[11px] font-black px-2.5 py-1 rounded-full bg-amber-400 text-black animate-pulse">
                                {L(newCount === 1 ? "⚠ {newCount} NEW item on existing bill • {additionSourceLabel}" : "⚠ {newCount} NEW items on existing bill • {additionSourceLabel}", { newCount, additionSourceLabel: additionSourceLabel(t) })}
                              </span>
                            ) : (
                              <span className="inline-block text-[11px] font-black px-2.5 py-1 rounded-full bg-amber-500 text-black">{L("🔔 NEW ORDER")}</span>
                            )}
                            {added ? (
                              <>
                                <p className="font-serif font-black text-2xl text-amber-400 mt-1">{newTotal} ETB</p>
                                <p className="text-[11px] font-bold text-stone-300">{L("new items only • whole bill {totalAmount} ETB", { totalAmount: t.totalAmount })}</p>
                              </>
                            ) : (
                              <>
                                <p className="font-serif font-black text-2xl text-[#C9A227] mt-1">{t.totalAmount} ETB</p>
                                <p className="text-[11px] font-bold text-stone-300">{L("{reduce} items", { reduce: visible.reduce((s, i) => s + i.quantity, 0) })}</p>
                              </>
                            )}
                          </div>
                        </div>

                        {added && (
                          <p className="text-xs font-bold text-amber-300 bg-amber-950/40 border border-amber-700/40 rounded-xl px-3 py-2">
                            {L(newCount === 1
                              ? "This bill was already printed. Key ONLY the new item below into the EFD and print receipt #2. If the waiter added more to an existing line, it stays on that same line as NEW. The crews already have them • your ✓ only records the print."
                              : "This bill was already printed. Key ONLY the new items below into the EFD and print receipt #2. If the waiter added more to an existing line, it stays on that same line as NEW. The crews already have them • your ✓ only records the print.")}
                          </p>
                        )}

                        {t.receiptRequestedAt && (
                          <div className="flex items-center justify-between gap-2 bg-amber-500/15 border border-amber-500/40 rounded-xl px-3 py-2">
                            <p className="text-[11px] font-black text-amber-200">
                              {t.receiptRequestedBy
                                ? L("📝 {receiptRequestedBy} asked for the bill at {clock}", { receiptRequestedBy: t.receiptRequestedBy, clock: formatClock(t.receiptRequestedAt) })
                                : L("🧾 Guest asked for the bill at {clock}", { clock: formatClock(t.receiptRequestedAt) })}
                            </p>
                            <button
                              onClick={() => clearReceiptRequest(t)}
                              className="shrink-0 text-[10px] font-bold px-2 py-1 rounded-lg bg-black/30 text-emerald-200 hover:bg-black/50"
                              title={L("Clear the request (bill already handed over)")}
                            >
                              {L("Clear")}
                            </button>
                          </div>
                        )}

                        {/* items — the list she reads while keying into the EFD.
                            Additions card: ONLY new items by default; the full
                            bill expands on demand with the new items highlighted.
                            Corrections only appear when ✗ Problem is open. */}
                        <div className="bg-[#3D2314] rounded-xl divide-y divide-stone-800">
                          {added ? (
                            (showFullBill
                              ? visible.map((item) => ({
                                  item,
                                  addedQuantity: addedQuantityFor(t.id, item.id),
                                  wholeLineIsNew: added && isNewUnprinted(item, t),
                                }))
                              : newItems
                            ).map((line) => {
                              const i = line.item;
                              const isNew = line.wholeLineIsNew || line.addedQuantity > 0;
                              return (
                                <div
                                  key={i.id}
                                  className={`p-2.5 text-xs flex items-center justify-between gap-2 ${
                                    i.removed ? "opacity-40 line-through" : isNew ? "bg-amber-400/15" : ""
                                  }`}
                                >
                                  <div className="flex-1 min-w-0">
                                    <p className="font-bold text-amber-100 truncate">
                                      {showFullBill && isNew ? <span className="text-amber-300 font-black">{L("NEW •")} </span> : null}
                                      {i.name} <span className="text-stone-300 font-bold">({i.price} ETB)</span>
                                    </p>
                                    {line.addedQuantity > 0 && (
                                      <p className="text-[11px] font-black text-amber-300 mt-0.5">
                                        {line.wholeLineIsNew ? L("NEW line") : L("NEW on existing line • +{addedQuantity}", { addedQuantity: line.addedQuantity })}
                                      </p>
                                    )}
                                    {i.notes && <p className="text-[11px] font-semibold text-amber-300 italic">📝 {i.notes}</p>}
                                  </div>
                                  <span className="font-extrabold text-amber-100 shrink-0">
                                    × {showFullBill ? i.quantity : line.addedQuantity}
                                  </span>
                                  {!i.removed && !isItemLocked(i, t) && (
                                    <button
                                      onClick={() => setEditTarget({ item: i })}
                                      className="px-2 py-1 bg-[#C9A227]/15 text-[#C9A227] border border-[#C9A227]/40 rounded text-[10px] font-black hover:bg-[#C9A227] hover:text-black shrink-0"
                                      title={L("Fix this item's note or quantity, or remove it. Saving never prints • the card stays in your queue.")}
                                    >
                                      {L("✎ Edit")}
                                    </button>
                                  )}
                                  {!orderLocked && problem && !i.removed && !isItemLocked(i, t) ? (
                                    <button
                                      onClick={() => removeItem(i.id)}
                                      className="px-2 py-1 bg-rose-900/60 text-rose-300 rounded text-[10px] font-bold hover:bg-rose-700 hover:text-white shrink-0"
                                      title={L("Remove (unavailable)")}
                                    >
                                      {L("Remove")}
                                    </button>
                                  ) : null}
                                </div>
                              );
                            })
                          ) : (
                            groupedVisible.map((line) => {
                              const sourceItem = line.sourceItem;
                              return (
                              <div key={line.ids.join("-")} className="p-2.5 text-xs flex items-center justify-between gap-2">
                                <div className="flex-1 min-w-0">
                                  <p className="font-bold text-amber-100 truncate">
                                    {line.name} <span className="text-stone-300 font-bold">({line.price} ETB)</span>
                                  </p>
                                  {line.notes && <p className="text-[11px] font-semibold text-amber-300 italic">📝 {line.notes}</p>}
                                  {line.ids.length > 1 && (
                                    <p className="text-[10px] font-black text-sky-300 mt-0.5">
                                      {L("Combined on cashier side • same item added again")}
                                    </p>
                                  )}
                                </div>
                                <div className="text-right shrink-0">
                                  <p className="font-extrabold text-amber-100">× {line.quantity}</p>
                                  <p className="text-[10px] font-black text-[#C9A227]">{line.price * line.quantity} ETB</p>
                                </div>
                                {sourceItem && !isItemLocked(sourceItem, t) ? (
                                  <button
                                    onClick={() => setEditTarget({ item: sourceItem })}
                                    className="px-2 py-1 bg-[#C9A227]/15 text-[#C9A227] border border-[#C9A227]/40 rounded text-[10px] font-black hover:bg-[#C9A227] hover:text-black shrink-0"
                                    title={L("Fix this item's note or quantity, or remove it. Saving never prints • the card stays in your queue.")}
                                  >
                                    {L("✎ Edit")}
                                  </button>
                                ) : null}
                                {!orderLocked && problem && sourceItem && !isItemLocked(sourceItem, t) ? (
                                  <button
                                    onClick={() => removeItem(sourceItem.id)}
                                    className="px-2 py-1 bg-rose-900/60 text-rose-300 rounded text-[10px] font-bold hover:bg-rose-700 hover:text-white shrink-0"
                                    title={L("Remove (unavailable)")}
                                  >
                                    {L("Remove")}
                                  </button>
                                ) : null}
                              </div>
                              );})
                          )}
                          {visible.length === 0 && <p className="p-3 text-center text-xs text-stone-500">{L("All items removed.")}</p>}
                        </div>

                        {added && (
                          <button
                            onClick={() => toggleFullBill(t.id)}
                            className="w-full text-xs font-black py-2 rounded-xl bg-stone-800/80 text-amber-200 hover:bg-stone-700 flex items-center justify-center gap-1.5"
                          >
                            {showFullBill
                              ? L("▲ Show new items only")
                              : L("▾ View full bill for context ({reduce} items • {totalAmount} ETB)", { reduce: visible.reduce((s, i) => s + i.quantity, 0), totalAmount: t.totalAmount })}
                          </button>
                        )}

                        {/* the two buttons that are her entire job */}
                        <div className="flex gap-2 pt-1">
                          <button
                            onClick={() => markPrinted(t)}
                            className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-black py-4 rounded-xl flex items-center justify-center gap-2"
                            title={
                              added
                                ? L("Prints receipt #2 for the NEW items only. The crews already have them • this tap only records the EFD print")
                                : L("Records that the EFD receipt is printed. The crews received this order when it was sent")
                            }
                          >
                            <Printer className="w-5 h-5" /> {L("✓ PRINTED")}
                          </button>
                          {!orderLocked && (
                            <button
                              onClick={() => toggleProblem(t.id)}
                              className={`px-4 py-4 rounded-xl text-xs font-bold flex items-center gap-1.5 shrink-0 ${
                                problem ? "bg-rose-600 text-white" : "bg-rose-900/60 text-rose-300 hover:bg-rose-700 hover:text-white"
                              }`}
                            >
                              <AlertTriangle className="w-4 h-4" /> {L("Problem")}
                            </button>
                          )}
                        </div>
                        {!orderLocked && problem && (
                          <div className="bg-rose-950/40 border border-rose-800 rounded-xl px-3 py-2 text-[11px] text-rose-200 space-y-2">
                            <p>{Lr("Use <b>Remove</b> on an item above if it is unavailable, or cancel the whole order:", { b: (s) => <strong>{s}</strong> })}</p>
                            <button
                              onClick={() => cancelTicket(t.id)}
                              className="bg-rose-700 hover:bg-rose-600 text-white text-[11px] font-black px-3 py-2 rounded-xl"
                            >
                              {L("✗ Cancel whole order")}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}

        {/* ═══ FULL-PAYMENT MODE — the original cashier workflow ═══ */}
        {!printQueueMode && (
        <>
        {/* ACTIVE TICKETS */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-widest text-amber-200/80 mb-3">
            {L("Active Orders ({length})", { length: activeTickets.length })}
          </h2>
          {activeTickets.length === 0 ? (
            <div className="bg-[#2C1B17] border border-stone-800 rounded-2xl p-8 text-center text-stone-500 text-sm">
              {L("No active orders. Tickets sent by waiters appear here instantly.")}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {activeTickets.map((t) => {
                const items = (t.items || []);
                const visible = items.filter((i) => !i.removed);
                const meta = statusMeta[t.status] || statusMeta.new;
                return (
                  <div
                    key={t.id}
                    className={`bg-[#2C1B17] rounded-2xl border-2 p-4 space-y-3 ${
                      t.status === "pending_waiter" ? "border-violet-500/70 animate-pulse" : t.status === "confirmed" ? "border-amber-400/70" : t.status === "completed" ? "border-emerald-500/70" : t.status === "ready_for_payment" ? "border-purple-500/60" : t.status === "preparing" ? "border-orange-500/60" : "border-stone-700"
                    }`}
                  >
                    {/* header */}
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-serif font-bold text-lg text-amber-100">{t.tableName}</p>
                          {t.orderNumber && (
                            <span className="align-middle text-[10px] font-black bg-stone-800 border border-[#C9A227]/40 text-[#C9A227] px-2 py-0.5 rounded-full">
                              #{t.orderNumber}
                            </span>
                          )}
                          {isOutdoor(t) && (
                            <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300 border border-violet-500/40">
                              {outdoorBadge(t)}
                            </span>
                          )}
                        </div>
                        <p className="text-xs font-bold text-stone-300 flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5 text-[#C9A227]" /> {t.confirmedBy ? L("by {confirmedBy}", { confirmedBy: t.confirmedBy }) : L("by {createdBy}", { createdBy: t.createdBy || L("waiter") })}
                        </p>
                        {/* When the order ARRIVED and how long the table has been
                            waiting — the question staff keep asking. */}
                        <p className="text-xs font-bold text-stone-300">
                          {L("🕒 arrived {clock} • waiting {waitingLabel}", { clock: formatClock(t.createdAt), waitingLabel: Ld(waitingLabel(t.createdAt)) })}
                        </p>
                        {t.serviceNote && <p className="text-[11px] font-bold text-sky-300">📍 {t.serviceNote}</p>}
                      </div>
                      <div className="text-right">
                        <span className={`inline-block text-[10px] font-black px-2.5 py-1 rounded-full ${meta.cls}`}>{meta.label}</span>
                        <p className="font-serif font-black text-xl text-[#C9A227] mt-1">{t.totalAmount} ETB</p>
                      </div>
                    </div>

                    {/* The guest tapped "bring us the bill" on their own phone.
                        Arrives instantly over the realtime orders channel. */}
                    {t.receiptRequestedAt && (
                      <div className="flex items-center justify-between gap-2 bg-emerald-500/15 border border-emerald-500/50 rounded-xl px-3 py-2">
                        <p className="text-[11px] font-black text-emerald-300">
                          {L("🧾 Guest asked for the bill at {clock}", { clock: formatClock(t.receiptRequestedAt) })}
                        </p>
                        <button
                          onClick={() => clearReceiptRequest(t)}
                          className="shrink-0 text-[10px] font-bold px-2 py-1 rounded-lg bg-black/30 text-emerald-200 hover:bg-black/50"
                          title={L("Clear the request (bill already handed over)")}
                        >
                          {L("Clear")}
                        </button>
                      </div>
                    )}

                    {/* items (editable: qty adjust + remove) */}
                    <div className="bg-[#3D2314] rounded-xl divide-y divide-stone-800">
                      {items.map((i) => (
                        <div key={i.id} className={`p-2.5 text-xs flex items-center justify-between gap-2 ${i.removed ? "opacity-40 line-through" : ""}`}>
                          <div className="flex-1 min-w-0">
                            <p className="font-bold text-amber-100 truncate">{i.name}</p>
                            {i.notes && <p className="text-[10px] text-amber-300 italic">📝 {i.notes}</p>}
                          </div>
                          {!i.removed && !isItemLocked(i, t) ? (
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button onClick={() => updateItemQty(i, Math.max(1, i.quantity - 1))} className="w-6 h-6 bg-white/10 rounded text-xs">−</button>
                              <span className="font-extrabold w-4 text-center">{i.quantity}</span>
                              <button onClick={() => updateItemQty(i, i.quantity + 1)} className="w-6 h-6 bg-[#C9A227] text-black rounded text-xs font-bold">+</button>
                              <button
                                onClick={() => removeItem(i.id)}
                                className="ml-1 px-2 py-1 bg-rose-900/60 text-rose-300 rounded text-[10px] font-bold hover:bg-rose-700 hover:text-white"
                                title={L("Remove (unavailable)")}
                              >
                                {L("Remove")}
                              </button>
                            </div>
                          ) : (
                            <span className="text-[10px] font-bold text-stone-400">{i.removed ? L("REMOVED") : `× ${i.quantity}`}</span>
                          )}
                        </div>
                      ))}
                      {visible.length === 0 && <p className="p-3 text-center text-xs text-stone-500">{L("All items removed.")}</p>}
                    </div>

                    {/* payment info — paid or not (separate from order status).
                        No method options: historical paid_cash / paid_telebirr /
                        ... statuses read as paid and stay untouched unless changed. */}
                    {(t.status === "ready_for_payment" || t.status === "completed") && (
                      <div className="bg-black/30 rounded-xl p-3 border border-stone-700 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold text-xs text-stone-200">{L("Payment collected at the counter")}</span>
                          <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${paymentStatusCls(t.paymentStatus)}`}>
                            {paymentStatusLabel(t.paymentStatus)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <select
                            value={t.paymentStatus && t.paymentStatus !== "unpaid" ? "paid" : "unpaid"}
                            onChange={(e) => setPaymentStatus(t.id, e.target.value)}
                            className="bg-[#2C1B17] border border-stone-700 rounded-lg px-2 py-1.5 text-[11px] font-bold text-white flex-1"
                            title={L("Record whether this bill was paid (order status is separate)")}
                          >
                            <option value="unpaid">{L("Unpaid")}</option>
                            <option value="paid">{L("Paid")}</option>
                          </select>
                          {t.status === "completed" && (
                            <button
                              onClick={async () => {
                                // fetch receipt photo ON DEMAND — saves ~70KB × 100s of polling transfers per day
                                const r = await fetch(`/api/tickets/receipt?id=${t.id}`);
                                const d = await r.json();
                                if (d.receiptImage) setReceiptModal(d.receiptImage);
                              }}
                              className="flex items-center gap-1 text-[11px] font-bold text-sky-300 bg-sky-900/40 px-2.5 py-1.5 rounded-lg hover:bg-sky-800 shrink-0"
                            >
                              <ImageIcon className="w-3.5 h-3.5" /> {L("Receipt Photo")}
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* actions per status */}
                    <div className="flex flex-wrap gap-2 pt-1">
                      {t.status === "pending_waiter" && (
                        <>
                          <div className="w-full bg-violet-950/60 border border-violet-700 rounded-xl px-3 py-2 text-[11px] text-violet-200">
                            {Lr("📣 Action: tell a waiter, <b>\"Go to {tableName} and confirm this order\"</b>, or confirm it yourself below.", { b: (s) => <strong>{s}</strong> }, { tableName: t.tableName })}
                          </div>
                          <button
                            onClick={() => setStatus(t.id, "confirmed")}
                            className="flex-1 bg-violet-600 hover:bg-violet-500 text-white text-xs font-black py-2.5 rounded-xl"
                          >
                            {L("✓ Confirm Order (Customer Verified)")}
                          </button>
                        </>
                      )}
                      {t.status === "confirmed" && (
                        <button onClick={() => setStatus(t.id, "preparing")} className="flex-1 bg-orange-600 hover:bg-orange-500 text-white text-xs font-black py-2.5 rounded-xl">
                          {L("Accept → Kitchen / Barista / Pastry")}
                        </button>
                      )}
                      {t.status === "preparing" && (
                        <span className="flex-1 text-center text-[11px] text-sky-300 bg-sky-950/60 py-2.5 rounded-xl border border-sky-800">
                          {L("Preparing • waiter will request payment when customer finishes")}
                        </span>
                      )}
                      {t.status === "completed" && (
                        <button onClick={() => markPaid(t)} className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black py-2.5 rounded-xl flex items-center justify-center gap-2">
                          <CheckCircle2 className="w-4 h-4" /> {L("Mark PAID & Release Table")}
                        </button>
                      )}
                      {!isOrderLocked(t) && (
                        <button onClick={() => cancelTicket(t.id)} className="px-3 py-2.5 bg-rose-900/60 text-rose-300 text-xs font-bold rounded-xl hover:bg-rose-700 hover:text-white flex items-center gap-1">
                          <XCircle className="w-3.5 h-3.5" /> {L("Cancel")}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        </>
        )}

        {/* HISTORY — print-queue mode: "Printed Today" fills the moment she
            prints (cross-check vs the EFD receipt count), and "Printed
            Yesterday" keeps last night's pile one tap away for the morning
            re-check; full mode: "Recently Paid". Every card opens the full
            bill (items, qty, prices, total). */}
        <section>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            {printQueueMode ? (
              <>
                <button
                  onClick={() => setHistoryDay("today")}
                  className={`text-[10px] font-black px-3 py-1.5 rounded-full flex items-center gap-1.5 transition ${
                    historyDay === "today" ? "bg-emerald-600 text-white" : "bg-[#2C1B17] border border-stone-700 text-stone-300 hover:bg-white/10"
                  }`}
                >
                  <Printer className="w-3 h-3" /> {L("PRINTED TODAY ({length})", { length: historyToday.length })}
                </button>
                <button
                  onClick={() => setHistoryDay("yesterday")}
                  className={`text-[10px] font-black px-3 py-1.5 rounded-full flex items-center gap-1.5 transition ${
                    historyDay === "yesterday" ? "bg-emerald-600 text-white" : "bg-[#2C1B17] border border-stone-700 text-stone-300 hover:bg-white/10"
                  }`}
                  title={L("Every bill printed yesterday, in case the morning needs to re-check last night's receipts")}
                >
                  {L("🕘 PRINTED YESTERDAY ({length})", { length: historyYesterday.length })}
                </button>
              </>
            ) : (
              <h2 className="text-xs font-bold uppercase tracking-widest text-stone-400">
                {L("Recently Paid ({length})", { length: history.length })}
              </h2>
            )}
          </div>
          {history.length === 0 ? (
            <p className="text-xs font-bold text-stone-500">
              {printQueueMode ? L("Bills appear here the moment you tap ✓ PRINTED. Tap any card to check the whole bill against the EFD receipt.") : L("Paid bills will appear here after you mark them Paid.")}
            </p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {history.map((t) => {
                const waiting = printQueueMode && (t.unprintedSubmissions || 0) > 0;
                const cleared = t.status === "closed";
                // A line on this bill was corrected AFTER the EFD receipt went
                // out: the EFD total no longer matches the system total until
                // she re-keys it. Independent of new-item additions ("waiting"
                // above) — a corrected line is not a new submission, so it
                // needs its own flag or the drift goes unnoticed.
                const editedAfterPrint =
                  printQueueMode &&
                  t.status === "printed" &&
                  !!t.printedAt && !!t.itemsEditedAt &&
                  new Date(t.itemsEditedAt).getTime() > new Date(t.printedAt).getTime();
                return (
                  <button
                    key={t.id}
                    onClick={() => setBillModal(t)}
                    className={`text-left bg-[#241714] rounded-xl p-3 flex items-center justify-between gap-2 transition hover:bg-[#2e1d18] active:scale-[0.98] ${
                      waiting ? "border-2 border-amber-400 animate-pulse" : "border border-stone-800"
                    }`}
                    title={L("Tap to see the full bill")}
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="text-sm font-black text-amber-100">{t.tableName}</p>
                        {isOutdoor(t) && (
                          <span className="text-[9px] font-black uppercase px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300 border border-violet-500/40">
                            {outdoorBadge(t)}
                          </span>
                        )}
                      </div>
                      {printQueueMode ? (
                        <p className="text-[11px] font-bold text-stone-300 truncate flex items-center gap-1">
                          <Printer className="w-3 h-3 text-[#C9A227] shrink-0" /> {L("printed {clock} •", { clock: formatClock(t.printedAt) })} {t.printedBy || L("cashier")}
                        </p>
                      ) : (
                        <p className="text-[11px] font-bold text-stone-300 flex items-center gap-1">{L("✓ Paid")}</p>
                      )}
                      {/* Group 8: table, date, time and waiter on every history card. */}
                      <p className="text-[11px] font-bold text-stone-300 truncate">🕒 {formatDateTime(printQueueMode ? (t.printedAt || t.createdAt) : (t.closedAt || t.updatedAt || t.createdAt))}</p>
                      <p className="text-[11px] font-bold text-[#D8B93E] truncate">👤 {t.confirmedBy || t.createdBy || L("staff")}</p>
                      {t.serviceNote && <p className="text-[10px] font-bold text-sky-300 truncate">📍 {t.serviceNote}</p>}
                      {printQueueMode && (
                        cleared ? (
                          <p className="text-[10px] font-black text-stone-400 uppercase">{L("✓ cleared {value}", { value: t.closedAt ? formatClock(t.closedAt) : "" })}</p>
                        ) : waiting ? (
                          <p className="text-[10px] font-black text-amber-300 uppercase">{L("⚠ new item waiting")}</p>
                        ) : (
                          <p className="text-[10px] font-black text-emerald-400 uppercase">{L("● open")}</p>
                        )
                      )}
                      {printQueueMode && editedAfterPrint && (
                        <p className="text-[10px] font-black text-sky-300 uppercase">{L("✎ edited after print • re-key EFD")}</p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-black text-emerald-400">{t.totalAmount} ETB</p>
                      {!printQueueMode && <span className="text-[9px] font-black text-emerald-600 uppercase">{L("PAID")}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* BILL DETAIL MODAL — every item with name, qty, unit price, line total,
          and the bill total. Opened from Printed Today cards (and anywhere a
          printed bill needs a cross-check against the EFD receipt). */}
      {billModal && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setBillModal(null)}
        >
          <div
            className="bg-[#2C1B17] border-2 border-[#C9A227]/50 rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-[#2C1B17] border-b border-stone-800 px-5 py-4 flex items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-serif font-black text-xl text-amber-100">{billModal.tableName}</h3>
                  {billModal.orderType === "outdoor" && (
                    <span className="text-[10px] font-black uppercase px-2.5 py-1 rounded-full bg-violet-500/20 text-violet-300 border border-violet-500/40">
                      {outdoorBadge(billModal)}
                    </span>
                  )}
                </div>
                <p className="text-xs font-bold text-stone-300 mt-0.5">
                  {billModal.orderNumber ? `#${billModal.orderNumber} • ` : ""}
                  {billModal.printedAt
                    ? L("printed {dateTime} • by {printedBy}", { dateTime: formatDateTime(billModal.printedAt), printedBy: billModal.printedBy || L("cashier") })
                    : L("arrived {dateTime} • by {confirmedBy}", { dateTime: formatDateTime(billModal.createdAt), confirmedBy: billModal.confirmedBy || billModal.createdBy || L("staff") })}
                </p>
                <p className="text-xs font-bold text-stone-300">
                  {billModal.status === "closed"
                    ? L("✓ cleared {value}", { value: billModal.closedAt ? formatDateTime(billModal.closedAt) : "" })
                    : (billModal.unprintedSubmissions || 0) > 0
                    ? L("⚠ new items waiting for your next print")
                    : L("● open bill")}
                </p>
                {billModal.serviceNote && <p className="text-xs font-bold text-sky-300">📍 {billModal.serviceNote}</p>}
              </div>
              <button onClick={() => setBillModal(null)} className="p-2 rounded-lg bg-white/10 text-stone-300 hover:bg-white/20 shrink-0" title={L("Close")}>
                <XCircle className="w-5 h-5" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div className="bg-[#3D2314] rounded-xl divide-y divide-stone-800">
                {(billModal.items || []).filter((i) => !i.removed).map((i) => {
                  const isNew = !!billModal.printedAt && !!i.createdAt &&
                    new Date(i.createdAt).getTime() > new Date(billModal.printedAt!).getTime();
                  return (
                    <div key={i.id} className={`p-3 flex items-center justify-between gap-3 ${isNew ? "bg-amber-400/15" : ""}`}>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-amber-100 truncate">
                          {isNew && <span className="text-amber-300 font-black">{L("NEW •")} </span>}
                          {i.name}
                        </p>
                        <p className="text-xs font-semibold text-stone-300">{i.quantity} × {i.price} ETB</p>
                        {i.notes && <p className="text-[11px] font-semibold text-amber-300 italic mt-0.5">📝 {i.notes}</p>}
                      </div>
                      <span className="text-sm font-black text-[#C9A227] shrink-0">{i.price * i.quantity} ETB</span>
                    </div>
                  );
                })}
              </div>
              <div className="bg-[#3D2314] border border-[#C9A227]/40 rounded-xl px-4 py-3 flex items-center justify-between">
                <span className="text-sm font-black text-stone-200">{L("Bill total")}</span>
                <span className="font-serif font-black text-2xl text-[#C9A227]">{billModal.totalAmount} ETB</span>
              </div>
              <button
                onClick={() => setBillModal(null)}
                className="w-full py-3 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 text-sm font-black"
              >
                {L("Close")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ITEM EDITOR — fix a wrong QR/waiter line on the queue card. Saving
          only corrects the bill; it never prints (hold without printing). */}
      {editTarget && canKeepEditing && (
        <EditItemModal
          item={editTarget.item}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            loadAll();
            loadHistory();
          }}
        />
      )}

      <OutdoorOrderComposer
        open={outdoorComposerOpen}
        cashierName={staffName}
        onClose={() => setOutdoorComposerOpen(false)}
        onSent={(message) => {
          showToast(message);
          loadAll();
          loadHistory();
        }}
      />

      {/* COFFEE NOTE: the held outdoor-buna tab. A paid note creates an
          outdoor ticket straight into history, so "paid" also refreshes the
          history lists (Printed Today / Recently Paid) and the held badge. */}
      <CoffeeNotePanel
        open={coffeeNoteOpen}
        cashierName={staffName}
        onClose={() => setCoffeeNoteOpen(false)}
        onChanged={(kind) => {
          if (kind === "paid") {
            loadAll();
            loadHistory();
          } else {
            loadHistory();
          }
        }}
      />

      {/* receipt image modal */}
      {receiptModal && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" onClick={() => setReceiptModal(null)}>
          <img src={receiptModal} alt={L("Payment receipt")} className="max-h-[85vh] max-w-full rounded-2xl border border-[#C9A227]" />
        </div>
      )}
    </div>
  );
}

/**
 * CASHIER ITEM EDITOR (owner, Sept 2026) — fix a wrong QR/waiter line right on
 * the queue card: the note, the quantity, or remove the line entirely. Save
 * writes the correction and recomputes the bill; it NEVER prints — the card
 * simply stays in her queue until she taps ✓ PRINTED herself. (Holding without
 * printing is the default here: there is no print path out of this dialog.)
 */
function EditItemModal({ item, onClose, onSaved }: { item: TicketItem; onClose: () => void; onSaved: () => void }) {
  const { t: L } = useStaffT();
  const [qty, setQty] = useState(item.quantity);
  const [notes, setNotes] = useState(item.notes || "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const quantity = Math.max(1, Math.min(100, Math.floor(Number(qty) || 1)));
    setSaving(true);
    try {
      const r = await fetch("/api/tickets/items", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id, quantity, notes: notes.slice(0, 500) }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        alert(d?.error || L("Could not update item"));
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(L("Remove \"{name}\" x{quantity} from the bill?\n\nThe bill total updates at once. The crew is told only if they already started it.", { name: item.name, quantity: item.quantity }))) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/tickets/items?id=${item.id}`, { method: "DELETE" });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        alert(d?.error || L("Could not remove item"));
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-[#2C1B17] border-2 border-[#C9A227]/50 rounded-2xl w-full max-w-sm p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="font-serif font-black text-lg text-amber-100">{L("✎ Fix item")}</h3>
          <p className="text-xs font-bold text-stone-300 mt-0.5">{L("{name} • {price} ETB each", { name: item.name, price: item.price })}</p>
        </div>
        <div className="flex items-center gap-3 bg-[#3D2314] rounded-xl p-3">
          <span className="text-xs font-bold text-stone-300 flex-1">{L("Quantity")}</span>
          <button onClick={() => setQty(Math.max(1, qty - 1))} className="w-9 h-9 bg-white/10 rounded-xl text-lg font-black">−</button>
          <span className="text-lg font-black text-[#C9A227] w-8 text-center">{qty}</span>
          <button onClick={() => setQty(Math.min(100, qty + 1))} className="w-9 h-9 bg-[#C9A227] text-black rounded-xl text-lg font-black">+</button>
        </div>
        <div>
          <label className="block text-xs font-bold text-amber-200 mb-1">{L("Note for the crew")}</label>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={L("No Sugar, Extra Mayo, Less Spicy...")}
            className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white"
          />
        </div>
        <div className="bg-[#3D2314] border border-[#C9A227]/40 rounded-xl px-4 py-2.5 flex items-center justify-between">
          <span className="text-xs font-black text-stone-200">{L("Line total")}</span>
          <span className="font-serif font-black text-xl text-[#C9A227]">{item.price * qty} ETB</span>
        </div>
        <p className="text-[11px] font-bold text-stone-400">
          {L("Saving only fixes the bill • it never prints. The card stays in your queue until you tap ✓ PRINTED.")}
        </p>
        <div className="flex gap-2">
          <button
            onClick={save}
            disabled={saving}
            className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-black py-3 rounded-xl disabled:opacity-40"
          >
            {saving ? L("Saving...") : L("✓ Save (hold • no print)")}
          </button>
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-3 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 text-sm font-black disabled:opacity-40"
          >
            {L("Cancel")}
          </button>
        </div>
        <button
          onClick={remove}
          disabled={saving}
          className="w-full py-2.5 rounded-xl bg-rose-900/60 text-rose-300 text-xs font-black hover:bg-rose-700 hover:text-white disabled:opacity-40"
        >
          {L("✗ Remove this item from the bill")}
        </button>
      </div>
    </div>
  );
}
