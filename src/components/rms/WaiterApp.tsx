"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Coffee, Plus, Minus, Send, ArrowLeft, RefreshCw, CreditCard,
  Camera, CheckCircle2, ClipboardList, Search, X, Users, LogOut, BellRing,
} from "lucide-react";
import { MenuItem, Ticket, TicketItem, CafeTable } from "@/types";
import PocketAlertsHint from "@/components/rms/PocketAlertsHint";
import PocketAlertsChip from "@/components/rms/PocketAlertsChip";
import UrgentAlertOverlay, { UrgentAlert } from "@/components/rms/UrgentAlertOverlay";
import MatchDayComposer from "@/components/rms/MatchDayComposer";
import { usePocketAlerts } from "@/lib/use-pocket-alerts";
import { formatClock, formatDateTime, waitingLabel } from "@/lib/order-lines";
import { compressImage, optimizeImageUrl, FALLBACK_FOOD_IMAGE } from "@/lib/image-utils";
import { effectivePrice } from "@/lib/price";
import { ticketOwner } from "@/lib/alerts";
import { unlockAudio, playAlarm, playDing, speakTableReady } from "@/lib/sound";
import { enablePocketAlerts, pushSupported } from "@/lib/push-client";
import { triggerDesktopNotification } from "@/lib/notifications";
import { useRef } from "react";

interface StaffLite {
  id: number;
  name: string;
  role: string;
}

interface CartEntry {
  menuItemId: number;
  name: string;
  category: string;
  price: number;
  quantity: number;
  notes: string;
}

type View = "login" | "tables" | "order" | "bill" | "payment";

/** One traditional-buna line waiting for (or being made by) the buna makers. */
interface BunaLine {
  id: number;
  ticketId: number;
  tableName: string;
  name: string;
  quantity: number;
  notes?: string | null;
  stationStatus: "pending" | "accepted" | "done";
  createdAt?: string | null;
}

export default function WaiterApp({ role = "waiter" }: { role?: "waiter" | "buna" }) {
  // ── WHO IS THIS SCREEN FOR? ──
  // The buna makers take orders exactly like a waiter when the room is full, so
  // they get the SAME app, with two differences (owner's decision, Sept 2026):
  //   1. their phone rings only for THEIR work — a traditional-buna line
  //      arriving, or food ready on a table THEY accepted — never for a QR
  //      order, a guest top-up or a bill request;
  //   2. they never close a bill (the waiter clears the table).
  const isBuna = role === "buna";
  const roleLabel = isBuna ? "Buna Maker" : "Waiter";
  const sessionKey = `fana_${role}`;
  const alertsKey = `fana_alerts_${role}`;

  // Auth
  const [staffName, setStaffName] = useState<string>("");
  const [staffList, setStaffList] = useState<StaffLite[]>([]);
  const [selectedName, setSelectedName] = useState("");
  const [pin, setPin] = useState("");
  const [loginError, setLoginError] = useState("");

  // Data
  const [tables, setTables] = useState<CafeTable[]>([]);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [activeTicket, setActiveTicket] = useState<Ticket | null>(null);

  // ── THE BUNA LANE (buna makers only) ──
  // Their own work, pinned above the table grid: every traditional-buna line
  // released to them, with Accept / Done exactly like the station screens.
  // Nothing here rings on its own — the push from the server does that, so the
  // phone in a pocket and the strip on screen stay in step.
  const [bunaLines, setBunaLines] = useState<BunaLine[]>([]);

  // UI
  const [view, setView] = useState<View>("login");
  const [selectedTable, setSelectedTable] = useState<CafeTable | null>(null);
  // ⚽ MATCH DAY (owner's decision, Sept 2026): the composer for groups
  // clustered on chairs around the screen — spot label instead of a table.
  const [matchComposerOpen, setMatchComposerOpen] = useState(false);
  const [cart, setCart] = useState<CartEntry[]>([]);
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState("");

  // ── BILL EDITOR (owner, Sept 2026): a wrong dish, a wrong qty or a forgotten
  // note is fixed right on the bill — no walk to the cashier, no
  // cancel-and-start-again. Only dishes the crew has NOT started yet.
  const [editingItemId, setEditingItemId] = useState<number | null>(null);
  const [editQty, setEditQty] = useState(1);
  const [editNotes, setEditNotes] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  // ── IDEMPOTENCY (Group 1): one key per order submission, reused on retries so a
  //    double-tap / WiFi retry can NEVER duplicate items on the table bill.
  const pendingKeyRef = useRef("");
  const lastCartSigRef = useRef("");

  useEffect(() => {
    const sig = JSON.stringify(cart);
    if (pendingKeyRef.current && lastCartSigRef.current && sig !== lastCartSigRef.current) {
      pendingKeyRef.current = ""; // cart edited after a failure → new submission
    }
  }, [cart]);

  const newSubmissionKey = () =>
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Payment (full mode only — print-queue mode hides these screens entirely).
  // The owner removed payment-method options: the EFD receipt is the proof of
  // payment, so the waiter just collects and confirms, with an optional photo.
  const [receiptImage, setReceiptImage] = useState("");
  const [receiptEnabled, setReceiptEnabled] = useState(true);
  // GROUP 9 (print-queue): payments live in the EFD/POS world — the waiter's
  // closing action becomes "Table cleared", and the payment screens are hidden.
  const [printQueueMode, setPrintQueueMode] = useState(true);
  const [categories, setCategories] = useState<Array<{ slug: string; name: string }>>([
    { slug: "all", name: "All" },
  ]);

  // ── GUEST EVENTS TAKE OVER THE SCREEN ──
  // A guest ordering, topping up, or asking for the bill cannot be predicted,
  // so it does not get a small toast: it gets a full screen with one big
  // button that keeps re-ringing until the waiter presses it.
  const [urgent, setUrgent] = useState<UrgentAlert | null>(null);
  /** Guest events already answered on this device, so they never come back. */
  const answeredRef = useRef<Set<string>>(new Set());

  // Ring bell alerts (new QR orders + guest top-ups)
  const [alertsOn, setAlertsOn] = useState(false);
  // STALE-CLOSURE FIX: the SSE handler below is created once (deps [staffName])
  // and captured `alertsOn` as it was at that moment. Turning alerts on later
  // (the bell button, or the localStorage read landing in a later render) never
  // reached the captured copy, so the alarm stayed switched off forever. Every
  // alert check now reads the ref, which is always current.
  const alertsOnRef = useRef(false);
  const seenPendingRef = useRef<Set<number>>(new Set());
  const alertsInitRef = useRef(false);
  // Per-ticket live item-unit baseline: a guest adding dishes to an EXISTING
  // bill changes item counts, never the ticket ID — so new-ticket detection
  // alone stays silent while the bill grows. Any increase over this baseline
  // rings the alarm. Ticket ID → sum of quantities of non-removed lines
  // (units, not rows: folding two teas into one line still grows the units).
  const itemCountRef = useRef<Map<number, number>>(new Map());
  // Units this device just sent itself (ticket ID + total units). The waiter
  // keying items herself must NOT ring her own phone — the next refresh
  // consumes this credit once, so only units BEYOND her own send alarm her.
  const ownAddRef = useRef<{ ticketId: number; units: number } | null>(null);
  // ROLE EVENTS THAT RING: besides new orders and guest top-ups, the waiter
  // hears food going READY on her own tables, a guest asking for the bill on
  // her own tables, and a short ding when somebody else confirms an order.
  // A cancellation is shown silently; printed/preparing/started/removed never
  // ring at all (owner: noise). Each of these needs its own memory of the last
  // refresh, otherwise the same event would ring forever (or never).
  /** Ticket id -> last seen status. */
  const statusRef = useRef<Map<number, string>>(new Map());
  /** Item ids already announced as ready, so a done dish rings exactly once. */
  const readyRef = useRef<Set<number>>(new Set());
  /** Tickets whose guest already asked for the bill. */
  const billAskedRef = useRef<Set<number>>(new Set());
  /** Status changes THIS waiter just made, so she never alarms herself. */
  const ownStatusRef = useRef<Set<string>>(new Set());
  const noteOwnStatus = (ticketId: number, status: string) => {
    ownStatusRef.current.add(`${ticketId}:${status}`);
  };
  // Always points at the CURRENT loadTables (the SSE handler and the service
  // worker relay are created once and would otherwise call a stale copy).
  const loadTablesRef = useRef<() => void>(() => {});
  /** Latest tables, for callbacks created in older renders. */
  const tablesRef = useRef<CafeTable[]>([]);

  // Keep the refs in step with the latest render (in an effect, never during
  // render) so every callback below reads today's values, not login-time ones.
  useEffect(() => {
    alertsOnRef.current = alertsOn;
  }, [alertsOn]);

  useEffect(() => {
    tablesRef.current = tables;
  }, [tables]);

  useEffect(() => {
    const saved = sessionStorage.getItem(sessionKey);
    // A restored session is a working waiter: alerts default to ON. (Before,
    // alerts depended purely on a localStorage flag, so a device that had it
    // cleared showed a logged-in waiter whose phone never rang.)
    const on = localStorage.getItem(alertsKey) === "1" || !!saved;
    setAlertsOn(on);
    alertsOnRef.current = on;
    if (on) localStorage.setItem(alertsKey, "1");
    if (saved) {
      const s = JSON.parse(saved);
      setStaffName(s.name);
      setView("tables");
    }
    fetch("/api/staff?public=1")
      .then((r) => r.json())
      // Each screen only ever lists its OWN crew, so a buna maker cannot be
      // picked on the waiter screen (or the other way round) by mistake.
      .then((d) => setStaffList(d.filter((s: StaffLite) => s.role === role)))
      .catch(() => {});
    // Read owner switches: receipt-photo requirement + cashier workflow mode
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => {
        setReceiptEnabled(String(s.receipt_enabled ?? "true") !== "false");
        setPrintQueueMode(String(s.cashier_mode ?? "print-queue") !== "full");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (staffName) {
      loadAll();
      // REALTIME (SSE): instead of polling every 8s, the server pushes a
      // "refresh" signal only when an order/table actually changes. This keeps
      // the network and database idle until something real happens.
      //
      // WATCHDOG: a phone in a pocket has its background tab throttled and its
      // sockets dropped, and EventSource does not always recover on its own
      // (a proxy timeout leaves it CLOSED). If that happened, the waiter got
      // no refresh and no alarm until she opened the app. We now rebuild the
      // stream whenever it is closed, and re-check on visibility/online. The
      // service worker push is the second, independent safety net.
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
        es.onmessage = () => loadTablesRef.current();
        es.onerror = () => {
          // On a dropped connection the browser auto-reconnects; refresh once to
          // make sure nothing was missed while disconnected.
          loadTablesRef.current();
        };
      };

      connect();

      const revive = () => {
        if (stopped) return;
        if (!es || es.readyState === 2 /* CLOSED */) connect();
        loadTablesRef.current();
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

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  };

  const enableAlerts = async () => {
    unlockAudio();
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    localStorage.setItem(alertsKey, "1");
    setAlertsOn(true);
    alertsOnRef.current = true;
    // Also (re)subscribe this phone to pocket alerts and ring a sample so the
    // waiter KNOWS the device is armed, then refresh the status chip.
    if (pushSupported()) {
      const res = await enablePocketAlerts();
      void pocket.refreshStatus();
      if (res === "denied") {
        showToast("Notifications are blocked. Allow them in your browser settings.");
      }
    }
    playAlarm();
    showToast("🔔 Alerts ON • pocket notifications armed");
  };

  /** Plain-language line for a status somebody else moved the ticket to. */
  const statusMoveLabel = (status: string, tableName: string): string => {
    // The money/closing steps (ready to pay, paid, settled, table cleared) are
    // deliberately NOT here: they never ring and never notify. Their cards
    // still update on screen; they simply do not wake a phone in a pocket.
    // "printed" and "preparing" are NOT here either (owner: noise — the waiter
    // has nowhere to walk for either, so they update the screen silently).
    const map: Record<string, string> = {
      confirmed: `✓ ${tableName}: order confirmed`,
      cancelled: `⛔ ${tableName}: ORDER CANCELLED, do not serve`,
    };
    return map[status] || "";
  };

  /**
   * OWNER-ONLY alarms (owner's decision, Sept 2026): "food ready" and "bill
   * requested" ring just the waiter who accepted/sent the table — never the
   * whole team. Tickets nobody owns yet (a QR order nobody accepted) still
   * ring every waiter on duty, because any of them can walk over.
   */
  const ringsMe = (t: Ticket): boolean => {
    const owner = ticketOwner(t.confirmedBy, t.createdBy);
    return !owner || owner === staffName;
  };

  /** Jump straight to a table's bill (used by the full-screen guest alert). */
  const openTicketById = async (ticketId: number) => {
    const r = await fetch("/api/tickets?active=1");
    if (!r.ok) return;
    const all: Ticket[] = await r.json();
    const tk = all.find((x) => x.id === ticketId);
    if (!tk) return;
    setSelectedTable(tablesRef.current.find((t) => t.activeTicketId === ticketId) || null);
    setCart([]);
    setActiveTicket(tk);
    setView("bill");
  };

  /**
   * Show the full-screen alert for a guest event. The newest event wins, and
   * anything already answered on this device stays closed.
   */
  const raiseUrgent = (a: UrgentAlert) => {
    if (answeredRef.current.has(a.id)) return;
    setUrgent(a);
  };

  const closeUrgent = () => {
    setUrgent((cur) => {
      if (cur) answeredRef.current.add(cur.id);
      return null;
    });
  };

  // The staff cookie lives 12 hours (one shift). When it dies mid-service the
  // API answers 401 — going back to the login screen WITH an explanation beats
  // a silently frozen board showing tables that already turned over. Declared
  // up here so every loader below can call it.
  const expireSession = () => {
    try {
      sessionStorage.removeItem(sessionKey);
    } catch {}
    setPin("");
    setLoginError("Your session ended. Log in again to keep serving tables.");
    setStaffName("");
    setView("login");
  };

  const loadTables = async () => {
    // GROUP 10 FIX: this used to return early while the screen was off / the
    // tab hidden — which is exactly when a phone sits in a pocket — so the
    // alarm NEVER rang. SSE messages arrive on change (not polling), so we
    // always process them now; sound and vibration fire even with the screen
    // off as long as the tab is alive.
    const r = await fetch("/api/tables");
    if (r.status === 401) return expireSession();
    if (r.ok) setTables(await r.json());

    // Ring bell when a NEW customer QR order (pending_waiter) appears on any table,
    // AND when a guest adds items to an EXISTING bill (any status: pending,
    // confirmed, printed). Additions never create a ticket ID — they only grow
    // the item units — so each ticket's live unit count is diffed against the
    // baseline from the previous refresh.
    const tkRes = await fetch("/api/tickets?active=1");
    if (tkRes.status === 401) return expireSession();
    if (tkRes.ok) {
      const all: Ticket[] = await tkRes.json();
      const pending = all.filter((t) => t.status === "pending_waiter");
      const fresh = pending.filter((t) => !seenPendingRef.current.has(t.id));
      fresh.forEach((t) => seenPendingRef.current.add(t.id));

      // Guest top-up detection: count live (non-removed) units per ticket and
      // compare with the last refresh. This device's OWN sends are credited
      // back (ownAddRef) so the waiter never alarms herself — only units
      // beyond her own keying count as a guest addition.
      const added: Ticket[] = [];
      for (const t of all) {
        const units = (t.items || [])
          .filter((i) => !i.removed)
          .reduce((s, i) => s + (Number(i.quantity) || 0), 0);
        const prev = itemCountRef.current.get(t.id);
        itemCountRef.current.set(t.id, units);
        let ownUnits = 0;
        if (ownAddRef.current && ownAddRef.current.ticketId === t.id) {
          ownUnits = ownAddRef.current.units;
          ownAddRef.current = null;
        }
        if (alertsInitRef.current && prev !== undefined && units - ownUnits > prev) {
          added.push(t);
        }
      }
      // Forget baselines for tickets that left the active list (paid/closed) so
      // the map cannot grow forever and a re-seated table starts clean.
      for (const id of [...itemCountRef.current.keys()]) {
        if (!all.some((t) => t.id === id)) itemCountRef.current.delete(id);
      }

      // ── READY TO SERVE / STATUS MOVES / BILL REQUESTS ──
      // These are the events that previously changed in total silence.
      const readyItems: Array<{ ticket: Ticket; name: string; quantity: number }> = [];
      const statusMoves: Array<{ ticket: Ticket; from: string; to: string }> = [];
      const billAsks: Ticket[] = [];
      for (const t of all) {
        // Food finished by the kitchen/barista — but only MY tables ring me.
        const mine = ringsMe(t);
        for (const i of t.items || []) {
          if (i.removed) continue;
          const done = i.stationStatus === "done";
          if (done && !readyRef.current.has(i.id)) {
            readyRef.current.add(i.id);
            if (alertsInitRef.current && mine) readyItems.push({ ticket: t, name: i.name, quantity: i.quantity });
          }
          if (!done) readyRef.current.delete(i.id); // sent back to the pan
        }
        // Status moves made by somebody else (cashier printed, order cancelled).
        const prevStatus = statusRef.current.get(t.id);
        statusRef.current.set(t.id, t.status);
        const ownKey = `${t.id}:${t.status}`;
        if (ownStatusRef.current.has(ownKey)) {
          ownStatusRef.current.delete(ownKey);
        } else if (alertsInitRef.current && prevStatus !== undefined && prevStatus !== t.status) {
          statusMoves.push({ ticket: t, from: prevStatus, to: t.status });
        }
        // Guest tapped "bring the bill" on their own phone — only MY tables
        // ring me (another waiter's guest is her walk, not mine). The buna
        // makers are skipped entirely: the receipt is a floor job, and their
        // phone must stay quiet for everything but their own buna work.
        if (t.receiptRequestedAt) {
          if (!billAskedRef.current.has(t.id)) {
            billAskedRef.current.add(t.id);
            if (alertsInitRef.current && mine && !isBuna) billAsks.push(t);
          }
        } else {
          billAskedRef.current.delete(t.id);
        }
      }
      for (const id of [...statusRef.current.keys()]) {
        if (!all.some((t) => t.id === id)) {
          statusRef.current.delete(id);
          billAskedRef.current.delete(id);
        }
      }

      // Silent statuses: the money and closing steps ring nobody (see
      // statusMoveLabel). Dropping them here keeps even the short ding away.
      // A cancellation is shown, never sounded: only the kitchen and barista
      // are rung for it (they may have a pan on the fire). She reads it as a
      // quiet line on her screen. For the BUNA MAKERS every status move made by
      // somebody else is quiet: their phone is reserved for their own work.
      const quietMoves = statusMoves.filter((m) => m.to === "cancelled" || isBuna);
      const loudMoves = isBuna
        ? []
        : statusMoves.filter(
            (m) => m.to !== "cancelled" && statusMoveLabel(m.to, m.ticket.tableName) !== ""
          );
      const quietLabel =
        quietMoves.length > 0 ? statusMoveLabel(quietMoves[0].to, quietMoves[0].ticket.tableName) : "";
      if (alertsInitRef.current && quietLabel) {
        showToast(quietLabel);
      }
      if (alertsInitRef.current && alertsOnRef.current && (readyItems.length > 0 || billAsks.length > 0 || loudMoves.length > 0)) {
        // Ready food is ACT NOW, but the SOUND is spoken English instead of
        // the generic bell: "Table 5 is ready" so the waiter who sent it
        // hears which table to walk to. A bill request still uses the bell.
        // A status move somebody else made is information: a short ring.
        if (readyItems.length > 0) {
          const tables = [...new Set(readyItems.map((r) => r.ticket.tableName))];
          speakTableReady(tables);
        } else if (billAsks.length > 0) {
          playAlarm();
        } else {
          playDing();
        }

        if (readyItems.length > 0) {
          const r = readyItems[0];
          const more = readyItems.length > 1 ? ` (+${readyItems.length - 1} more)` : "";
          triggerDesktopNotification({
            title: "Fana Cafe • Ready to serve",
            message: `🔔 ${r.ticket.tableName}: ${r.name} x${r.quantity} is ready${more} • pick it up!`,
            tag: `fana-waiter-ready-${r.ticket.id}-${Date.now()}`,
          });
          showToast(`🔔 READY: ${r.ticket.tableName} • ${r.name}${more}`);
        }
        if (billAsks.length > 0) {
          const b = billAsks[0];
          raiseUrgent({
            id: `bill-${b.id}-${b.receiptRequestedAt || ""}`,
            kind: "bill",
            table: b.tableName,
            detail: `${b.totalAmount} ETB • take the receipt over`,
            actionLabel: "OPEN BILL",
            onAction: () => void openTicketById(b.id),
          });
          triggerDesktopNotification({
            title: "Fana Cafe • Bill requested",
            message: `🧾 ${b.tableName} asked for the bill • ${b.totalAmount} ETB`,
            tag: `fana-waiter-bill-${b.id}`,
          });
          if (readyItems.length === 0) showToast(`🧾 ${b.tableName} asked for the bill`);
        }
        if (loudMoves.length > 0 && readyItems.length === 0 && billAsks.length === 0) {
          const m = loudMoves[0];
          const label = statusMoveLabel(m.to, m.ticket.tableName);
          if (label) {
            triggerDesktopNotification({
              title: "Fana Cafe • Order update",
              message: label,
              tag: `fana-waiter-status-${m.ticket.id}-${m.to}`,
            });
            showToast(label);
          }
        }
      }

      // A QR order or a guest top-up is a FLOOR event: the waiters walk to the
      // table. The buna makers are deliberately excluded — their phone rings
      // for their own buna lines and for food ready on their own tables, so a
      // guest ordering a macchiato three tables away never wakes them.
      if (alertsInitRef.current && alertsOnRef.current && !isBuna && (fresh.length > 0 || added.length > 0)) {
        playAlarm();
        if (fresh.length > 0) {
          const t0 = fresh[0];
          raiseUrgent({
            id: `order-${t0.id}`,
            kind: "order",
            table: t0.tableName,
            detail: `${t0.totalAmount} ETB • new QR order`,
            actionLabel: "OPEN & ACCEPT",
            onAction: () => void openTicketById(t0.id),
          });
          triggerDesktopNotification({
            title: "Fana Cafe • Waiter Alert",
            message: `🍽 New order request • ${t0.tableName} • ${t0.totalAmount} ETB • go confirm!`,
            tag: `fana-waiter-${t0.id}`,
          });
          showToast(`🔔 New order request: ${t0.tableName}`);
        }
        if (added.length > 0) {
          const t0 = added[0];
          const stillPending = t0.status === "pending_waiter";
          raiseUrgent({
            id: `added-${t0.id}-${Date.now()}`,
            kind: "added",
            table: t0.tableName,
            detail: `${t0.totalAmount} ETB • guest added items`,
            actionLabel: stillPending ? "OPEN & ACCEPT" : "OPEN BILL",
            onAction: () => void openTicketById(t0.id),
          });
          triggerDesktopNotification({
            title: "Fana Cafe • Waiter Alert",
            message: stillPending
              ? `🍽 Guest added items • ${t0.tableName} • ${t0.totalAmount} ETB • go confirm!`
              : `🍽 Guest added items • ${t0.tableName} • ${t0.totalAmount} ETB • check the bill!`,
            tag: `fana-waiter-add-${t0.id}-${Date.now()}`,
          });
          if (fresh.length === 0) {
            showToast(
              stillPending
                ? `🔔 ${t0.tableName}: guest added items • go confirm!`
                : `🔔 ${t0.tableName}: guest added items`
            );
          }
        }
      }
      alertsInitRef.current = true;
    }
  };

  const loadAll = async () => {
    loadTables();
    if (isBuna) void loadBunaLane();
    const m = await fetch("/api/menu");
    if (m.ok) setMenu(await m.json());
    const cr = await fetch("/api/categories");
    if (cr.ok) {
      const cats = (await cr.json()) as Array<{ slug: string; name: string }>;
      setCategories(cats.map((c) => ({ slug: c.slug, name: c.name })));
    }
  };

  /**
   * The buna makers' own lane. Same API the kitchen and barista screens use, so
   * a line released to them appears here the moment the order is accepted (and
   * the release rule — nothing shows before the bill is accepted/printed — is
   * inherited from the server, not re-implemented here).
   */
  const loadBunaLane = async () => {
    try {
      const r = await fetch("/api/station-items?station=buna");
      if (r.status === 401) return expireSession();
      if (!r.ok) return;
      const data = (await r.json()) as Array<{
        id: number;
        tableName: string;
        items: Array<{
          id: number;
          name: string;
          quantity: number;
          notes?: string | null;
          stationStatus: "pending" | "accepted" | "done";
          createdAt?: string | null;
        }>;
      }>;
      setBunaLines(
        data.flatMap((t) =>
          t.items.map((i) => ({
            id: i.id,
            ticketId: t.id,
            tableName: t.tableName,
            name: i.name,
            quantity: i.quantity,
            notes: i.notes,
            stationStatus: i.stationStatus,
            createdAt: i.createdAt,
          }))
        )
      );
    } catch {
      /* the lane is a convenience view; never break the screen over it */
    }
  };

  /** Accept / Done on one buna line — the same call the station screens make. */
  const setBunaStatus = async (line: BunaLine, status: "accepted" | "done") => {
    await fetch("/api/station-items", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: line.id, stationStatus: status }),
    });
    void loadBunaLane();
  };

  useEffect(() => {
    loadTablesRef.current = loadTables;
  });

  // POCKET MODE: keeps this phone subscribed (self-healing, no login needed),
  // and turns every push that lands while the app is open into the loud in-app
  // alarm plus an instant refresh, even if the SSE stream was frozen.
  const pocket = usePocketAlerts({
    active: !!staffName,
    onAlert: () => loadTablesRef.current(),
  });

  const login = async () => {
    setLoginError("");
    const r = await fetch("/api/staff/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: selectedName, pin, role }),
    });
    const d = await r.json();
    if (r.ok && d.success) {
      setStaffName(d.staff.name);
      sessionStorage.setItem(sessionKey, JSON.stringify(d.staff));
      setView("tables");
      // GROUP 10: the login tap is the ONE user gesture browsers demand —
      // unlock the loud alarm AND arm pocket notifications right here, so the
      // waiter never has to find a separate "enable" button.
      unlockAudio();
      localStorage.setItem(alertsKey, "1");
      setAlertsOn(true);
      alertsOnRef.current = true;
      void enablePocketAlerts().then((res) => {
        void pocket.refreshStatus();
        if (res === "denied") {
          showToast("Notifications blocked. Allow them in the browser to hear pocket alerts.");
        }
      });
    } else {
      setLoginError("Wrong name or PIN. Ask admin for your PIN.");
    }
  };

  const logout = () => {
    sessionStorage.removeItem(sessionKey);
    fetch("/api/staff/login", { method: "DELETE" }).catch(() => {});
    setStaffName("");
    setView("login");
    setPin("");
  };

  const openTable = async (t: CafeTable) => {
    setSelectedTable(t);
    setCart([]);
    if (t.activeTicketId) {
      const r = await fetch("/api/tickets?active=1");
      const all: Ticket[] = await r.json();
      const tk = all.find((x) => x.id === t.activeTicketId);
      if (tk) {
        setActiveTicket(tk);
        setView("bill");
        return;
      }
    }
    setActiveTicket(null);
    setView("order");
  };

  const addToCart = (item: MenuItem) => {
    if (!item.isAvailable) return;
    setCart((prev) => {
      const existing = prev.find((c) => c.menuItemId === item.id);
      if (existing) {
        return prev.map((c) => (c.menuItemId === item.id ? { ...c, quantity: c.quantity + 1 } : c));
      }
      return [...prev, { menuItemId: item.id, name: item.name, category: item.category, price: effectivePrice(item).price, quantity: 1, notes: "" }];
    });
  };

  const cartTotal = cart.reduce((s, c) => s + c.price * c.quantity, 0);

  const sendOrder = async () => {
    if (cart.length === 0 || !selectedTable || sending) return;
    if (!pendingKeyRef.current) pendingKeyRef.current = newSubmissionKey();
    lastCartSigRef.current = JSON.stringify(cart);
    setSending(true);
    const r = await fetch("/api/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tableId: selectedTable.id,
        waiterName: staffName,
        idempotencyKey: pendingKeyRef.current,
        items: cart.map((c) => ({
          menuItemId: c.menuItemId,
          name: c.name,
          category: c.category,
          price: c.price,
          quantity: c.quantity,
          notes: c.notes,
        })),
      }),
    });
    setSending(false);
    if (r.ok) {
      const d = await r.json();
      pendingKeyRef.current = "";
      // Suppression credit: these units are MINE, not the guest's — the next
      // refresh carries them, and the addition detector credits them back so
      // my own keying never rings my phone. Accumulated in case two sends land
      // before a refresh runs.
      const unitsSent = cart.reduce((s, c) => s + (Number(c.quantity) || 0), 0);
      const sentTicketId = (d as { id?: unknown })?.id;
      if (typeof sentTicketId === "number" && unitsSent > 0) {
        ownAddRef.current = {
          ticketId: sentTicketId,
          units: (ownAddRef.current?.ticketId === sentTicketId ? ownAddRef.current.units : 0) + unitsSent,
        };
      }
      setCart([]);
      showToast(d.duplicate ? "✓ Already sent • not sent twice" : d.merged ? "✓ Items added to the table bill" : "✓ Order sent to cashier");
      await loadTables();
      onGoBack();
    } else if (r.status === 401) {
      expireSession();
    } else {
      showToast("Failed to send order. Press Send again, it will not duplicate.");
    }
  };

  const refreshTicket = async () => {
    if (!activeTicket) return;
    const r = await fetch("/api/tickets?active=1");
    if (r.ok) {
      const all: Ticket[] = await r.json();
      const tk = all.find((x) => x.id === activeTicket.id);
      if (tk) setActiveTicket(tk);
    }
  };

  /** Only dishes the crew has NOT started yet can be fixed by the waiter. */
  const itemEditable = (item: TicketItem): boolean =>
    !item.removed && (!item.stationStatus || item.stationStatus === "pending");

  /** Bills at/after the payment stage belong to the cashier, not the editor. */
  const billEditable =
    !!activeTicket && ["pending_waiter", "confirmed", "printed", "preparing"].includes(activeTicket.status);

  const startEditItem = (item: TicketItem) => {
    setEditingItemId(item.id);
    setEditQty(item.quantity);
    setEditNotes(item.notes || "");
  };

  /** Units I changed myself must not ring my own phone as a "guest addition". */
  const creditOwnUnits = (ticketId: number, units: number) => {
    if (units <= 0) return;
    ownAddRef.current = {
      ticketId,
      units: (ownAddRef.current?.ticketId === ticketId ? ownAddRef.current.units : 0) + units,
    };
  };

  const saveEditedItem = async (item: TicketItem) => {
    const qty = Math.max(1, Math.min(100, Math.floor(Number(editQty) || 1)));
    setEditSaving(true);
    try {
      const r = await fetch("/api/tickets/items", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id, quantity: qty, notes: editNotes.slice(0, 500) }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        showToast(d?.error || "Could not update item");
        return;
      }
      if (activeTicket && qty > item.quantity) creditOwnUnits(activeTicket.id, qty - item.quantity);
      setEditingItemId(null);
      showToast("✓ Item updated");
      await refreshTicket();
      loadTables();
    } finally {
      setEditSaving(false);
    }
  };

  const removeTicketItem = async (item: TicketItem) => {
    const okToRemove = confirm(
      `Remove "${item.name}" x${item.quantity} from the bill?\n\nThe kitchen has not started it yet, so nothing is wasted.`
    );
    if (!okToRemove) return;
    const r = await fetch(`/api/tickets/items?id=${item.id}`, { method: "DELETE" });
    if (r.ok) {
      setEditingItemId(null);
      showToast("✓ Item removed from the bill");
      await refreshTicket();
      loadTables();
    } else {
      showToast("Could not remove item");
    }
  };

  const requestPayment = async () => {
    if (!activeTicket) return;
    const r = await fetch("/api/tickets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: activeTicket.id, status: "ready_for_payment" }),
    });
    if (r.status === 401) return expireSession();
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      showToast(d?.error || "Could not move this bill. Try again.");
      loadTables();
      return;
    }
    noteOwnStatus(activeTicket.id, "ready_for_payment");
    setView("payment");
    loadTables();
  };

  const confirmPayment = async () => {
    if (!activeTicket) return;
    setSending(true);
    const r = await fetch("/api/tickets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: activeTicket.id,
        status: "completed",
        // No payment-method options (owner's decision): paid is paid — the EFD
        // receipt is the proof. The cashier still verifies and releases the table.
        paymentMethod: null,
        paymentStatus: "paid",
        receiptImage: receiptImage || "",
      }),
    });
    if (r.status === 401) {
      setSending(false);
      return expireSession();
    }
    if (!r.ok) {
      setSending(false);
      const d = await r.json().catch(() => ({}));
      showToast(d?.error || "Could not complete payment. Try again.");
      loadTables();
      return;
    }
    noteOwnStatus(activeTicket.id, "completed");
    setSending(false);
    setActiveTicket(null);
    setSelectedTable(null);
    setReceiptImage("");
    showToast("✓ Payment completed • cashier will verify and release the table");
    setView("tables");
    loadTables();
  };

  const onGoBack = () => {
    setSelectedTable(null);
    setActiveTicket(null);
    setCart([]);
    setView("tables");
  };

  // ── GROUP 9 (print-queue): the waiter's closing action. The guest paid at the
  // counter (EFD/POS), the guests left, and she has PHYSICALLY cleared the
  // table — one tap closes the bill and frees the table for the next guests.
  // Deliberately decoupled from payment: the waiter never needs to know how or
  // when the bill was settled.
  const clearTable = async () => {
    if (!activeTicket) return;
    // Guard: food still being prepared — warn, don't silently block.
    const cooking = (activeTicket.items || []).filter(
      (i) => !i.removed && i.stationStatus && i.stationStatus !== "done"
    );
    if (cooking.length > 0) {
      const okToClear = confirm(
        `The crews are still preparing ${cooking.length} item(s) for ${activeTicket.tableName}. The station lists will drop them.\n\nClear the table anyway?`
      );
      if (!okToClear) return;
    }
    const r = await fetch("/api/tickets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: activeTicket.id, status: "closed", closedBy: staffName }),
    });
    if (r.status === 401) return expireSession();
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      showToast(d?.error || "Could not clear this table. Try again.");
      loadTables();
      return;
    }
    noteOwnStatus(activeTicket.id, "closed");
    showToast(`✓ ${activeTicket.tableName} is free for new guests`);
    setActiveTicket(null);
    setSelectedTable(null);
    setView("tables");
    loadTables();
  };

  const filteredMenu = useMemo(
    () =>
      menu.filter(
        (m) =>
          (category === "all" || m.category === category) &&
          m.name.toLowerCase().includes(search.toLowerCase())
      ),
    [menu, category, search]
  );

  const billItems = (activeTicket?.items || []).filter((i) => !i.removed);
  const billTotal = billItems.reduce((s, i) => s + i.price * i.quantity, 0);

  // Group 9: plain-language status for the bill header, per workflow mode.
  const ticketStatusLabel = (s: string) =>
    printQueueMode
      ? s === "pending_waiter"
        ? "Waiting for your confirmation"
        : s === "confirmed"
        ? // QR HOLD FLOW: a confirmed bill without a release stamp is HELD —
          // the cashier accepted it but has not sent it to the crews yet.
          activeTicket?.confirmedAt
          ? "Sent • cashier will print it in the EFD"
          : "Accepted • held until the cashier sends it"
        : s === "printed"
        ? "Printed • crew is preparing"
        : s === "preparing"
        ? "In progress"
        : s === "ready_for_payment"
        ? "Bill requested"
        : s === "completed"
        ? "Payment stage"
        : s.replace(/_/g, " ")
      : s.replace(/_/g, " ");

  const statusChip = (status?: string) =>
    status === "waiting"
      ? "bg-violet-600 text-white"
      : status === "ready-for-payment"
      ? "bg-amber-500 text-black"
      : status === "preparing"
      ? "bg-orange-600 text-white"
      : status === "occupied"
      ? "bg-rose-600 text-white"
      : "bg-emerald-600 text-white";

  const statusLabel = (status?: string) =>
    status === "available"
      ? "Available"
      : status === "waiting"
      ? "⏳ Confirm Order"
      : status === "ready-for-payment"
      ? "Pay Requested"
      : status === "preparing"
      ? "👨‍🍳 Preparing"
      : "Occupied";

  const confirmOrder = async () => {
    if (!activeTicket) return;
    const r = await fetch("/api/tickets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: activeTicket.id, status: "confirmed", confirmedBy: staffName }),
    });
    if (r.status === 401) return expireSession();
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      showToast(d?.error || "Could not accept this order. Try again.");
      loadTables();
      return;
    }
    noteOwnStatus(activeTicket.id, "confirmed");
    showToast("✓ Accepted • the crews with items on it, and the cashier, all have it");
    onGoBack();
    loadTables();
  };

  /* ── LOGIN SCREEN ─────────────────────────────────────────── */
  if (view === "login") {
    return (
      <div className="min-h-screen bg-[#1C120F] flex items-center justify-center p-4 text-white">
        <div className="bg-[#2C1B17] border border-[#C9A227]/40 rounded-3xl p-8 w-full max-w-sm space-y-6 shadow-2xl">
          <div className="text-center space-y-2">
            <div className="w-14 h-14 rounded-2xl bg-[#C9A227] text-[#2C1B17] flex items-center justify-center mx-auto">
              <Users className="w-7 h-7" />
            </div>
            <h1 className="font-serif text-2xl font-bold text-amber-100">{roleLabel} Login</h1>
            <p className="text-xs text-stone-400">Enter your name and PIN given by the admin.</p>
          </div>

          {loginError && (
            <div className="bg-rose-900/60 border border-rose-500 text-rose-200 text-xs p-3 rounded-xl">{loginError}</div>
          )}

          <div className="space-y-4">
            <div>
              <label className="text-xs font-bold text-amber-200 block mb-1">Your Name</label>
              <select
                value={selectedName}
                onChange={(e) => setSelectedName(e.target.value)}
                className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-sm text-white"
              >
                <option value="">Select your name...</option>
                {staffList.map((s) => (
                  <option key={s.id} value={s.name}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-bold text-amber-200 block mb-1">PIN</label>
              <input
                type="password"
                inputMode="numeric"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder="••••"
                className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-sm text-white text-center tracking-[0.5em]"
              />
            </div>
            <button
              onClick={login}
              disabled={!selectedName || !pin}
              className="w-full bg-gradient-to-r from-[#C9A227] to-[#B8921F] text-[#2C1B17] font-black text-sm uppercase py-4 rounded-xl disabled:opacity-40"
            >
              Login as {roleLabel}
            </button>
            <a href="/" className="block text-center text-xs text-[#C9A227] hover:underline">← Back to public website</a>
          </div>
        </div>
      </div>
    );
  }

  /* ── MAIN WAITER SHELL ────────────────────────────────────── */
  return (
    <div className="min-h-screen bg-[#1C120F] text-white pb-24">
      {/* Top Bar */}
      <div className="sticky top-0 z-30 bg-[#2C1B17]/95 backdrop-blur border-b border-[#C9A227]/30 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-[#C9A227] flex items-center justify-center">
            <Coffee className="w-4 h-4 text-[#2C1B17]" />
          </div>
          <div>
            <p className="text-xs font-bold text-amber-100 leading-none">{staffName}</p>
            <p className="text-[10px] text-stone-400">{roleLabel} • Fana Cafe</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <PocketAlertsChip
            status={pocket.status}
            busy={pocket.busy}
            onArm={pocket.arm}
            onTest={pocket.test}
            onToast={showToast}
            notificationsEnabled={pocket.notificationsEnabled}
            onSetNotificationsEnabled={pocket.setNotificationsEnabled}
          />
          <button
            onClick={enableAlerts}
            className={`p-2 rounded-xl transition ${alertsOn ? "bg-emerald-600 text-white" : "bg-[#C9A227] text-[#2C1B17] animate-pulse"}`}
            title={alertsOn ? "Ring bell alerts ON" : "Enable ring bell alerts"}
          >
            <BellRing className="w-4 h-4" />
          </button>
          <button onClick={loadAll} className="p-2 rounded-xl bg-white/10 text-amber-200" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={logout} className="p-2 rounded-xl bg-rose-600/80 text-white" title="Logout">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Full-screen guest alert (new order / added items / bill request) */}
      <UrgentAlertOverlay alert={urgent} onClose={closeUrgent} />

      {/* ⚽ MATCH DAY composer — spot label instead of a table number. */}
      <MatchDayComposer
        open={matchComposerOpen}
        waiterName={staffName}
        onClose={() => setMatchComposerOpen(false)}
        onSent={(message) => {
          showToast(message);
          loadTables();
        }}
      />

      {/* Toast */}
      {toast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-emerald-600 text-white text-xs font-bold px-4 py-2.5 rounded-full shadow-2xl">
          {toast}
        </div>
      )}

      {/* ── TABLES VIEW ── */}
      {view === "tables" && (
        <div className="p-4 space-y-4 max-w-3xl mx-auto">
          <PocketAlertsHint />

          {/* ── MY BUNA ── the makers' own work, above the table grid ── */}
          {isBuna && (
            <div className="bg-[#2C1B17] border-2 border-rose-500/40 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-serif font-bold text-rose-200 text-sm flex items-center gap-2">
                  🫖 My Buna
                  {bunaLines.filter((l) => l.stationStatus !== "done").length > 0 && (
                    <span className="text-[10px] font-black bg-rose-600 text-white rounded-full px-2 py-0.5">
                      {bunaLines.filter((l) => l.stationStatus !== "done").length} to make
                    </span>
                  )}
                </h2>
                <button
                  onClick={() => void loadBunaLane()}
                  className="p-1.5 rounded-lg bg-white/10 text-rose-200"
                  title="Refresh"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>

              {bunaLines.length === 0 ? (
                <p className="text-[11px] text-stone-500 text-center py-3">
                  No traditional buna right now. Your phone rings the moment an order with buna is accepted.
                </p>
              ) : (
                <div className="space-y-2 divide-y divide-stone-800">
                  {[...bunaLines]
                    .sort((a, b) => {
                      const rank = (s: string) => (s === "pending" ? 0 : s === "accepted" ? 1 : 2);
                      return rank(a.stationStatus) - rank(b.stationStatus);
                    })
                    .map((line) => (
                      <div
                        key={line.id}
                        className={`pt-2 flex items-center justify-between gap-3 text-xs ${
                          line.stationStatus === "done" ? "opacity-50" : ""
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <p
                            className={`font-bold ${
                              line.stationStatus === "done" ? "text-stone-500 line-through" : "text-amber-100"
                            }`}
                          >
                            {line.name} <span className="text-[#C9A227]">x{line.quantity}</span>
                          </p>
                          <p className="text-[11px] font-bold text-stone-300 mt-0.5">
                            {line.tableName} • waiting {waitingLabel(line.createdAt)}
                          </p>
                          {line.notes && (
                            <p
                              className={`text-[11px] font-semibold mt-1 px-2 py-1 rounded-lg bg-amber-950/50 border border-amber-700/40 ${
                                line.stationStatus === "done" ? "text-stone-500 line-through" : "text-amber-200"
                              }`}
                            >
                              📝 {line.notes}
                            </p>
                          )}
                        </div>
                        {line.stationStatus === "pending" && (
                          <button
                            onClick={() => void setBunaStatus(line, "accepted")}
                            className="shrink-0 px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-black uppercase transition"
                          >
                            Accept ✓
                          </button>
                        )}
                        {line.stationStatus === "accepted" && (
                          <button
                            onClick={() => void setBunaStatus(line, "done")}
                            className="shrink-0 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black uppercase transition flex items-center gap-1"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" /> Done
                          </button>
                        )}
                        {line.stationStatus === "done" && (
                          <span className="shrink-0 text-[10px] font-black text-emerald-400 bg-emerald-950/60 px-2.5 py-1 rounded-full uppercase border border-emerald-700">
                            ✓ Done
                          </span>
                        )}
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
          <div className="flex items-center justify-between">
            <h1 className="font-serif text-xl font-bold text-amber-100">Select Table</h1>
            <div className="flex gap-3 text-[10px]">
              <span className="flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" />Free</span>
              <span className="flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-full bg-violet-500 inline-block" />Waiting</span>
            <span className="flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block" />{printQueueMode ? "Sent" : "Busy"}</span>
              <span className="flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" />{printQueueMode ? "Bill" : "Pay"}</span>
            </div>
          </div>

          {/* ⚽ MATCH DAY: on football nights the chairs move to the screen and
              table numbers stop describing reality. One tap opens the composer
              that takes the order with a spot label ("Screen front", "Ahmed's
              group") — normal station + cashier flow, its own bill per group. */}
          <button
            onClick={() => setMatchComposerOpen(true)}
            className="w-full bg-gradient-to-r from-emerald-800 to-emerald-600 border-2 border-emerald-400/60 rounded-2xl p-4 flex items-center justify-between gap-3 text-left active:scale-[0.99] transition"
          >
            <div className="min-w-0">
              <p className="font-serif font-black text-amber-100 text-sm">⚽ Match Day Order</p>
              <p className="text-[11px] font-bold text-emerald-100/80 leading-snug mt-0.5">
                Guests on chairs around the screen? Take the order with a spot label instead of a table number.
              </p>
            </div>
            <span className="shrink-0 text-[10px] font-black uppercase bg-emerald-400 text-emerald-950 px-3 py-2 rounded-xl">
              Open
            </span>
          </button>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {tables.map((t) => (
              <button
                key={t.id}
                onClick={() => openTable(t)}
                className={`rounded-2xl p-5 text-left border-2 transition active:scale-95 ${
                  t.status === "available"
                    ? "border-emerald-500/60 bg-emerald-950/40"
                    : t.status === "ready-for-payment"
                    ? "border-amber-400 bg-amber-950/40"
                    : "border-rose-500/60 bg-rose-950/30"
                }`}
              >
                <p className="font-serif font-bold text-lg text-amber-100">{t.name}</p>
                <span className={`inline-block mt-2 text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full ${statusChip(t.status)}`}>
                  {printQueueMode
                    ? t.status === "available"
                      ? "Available"
                      : t.status === "waiting"
                      ? "Confirm Order"
                      : t.status === "preparing"
                      ? "👨‍🍳 In Progress"
                      : t.status === "ready-for-payment"
                      ? "Bill Requested"
                      : "Sent to Cashier"
                    : t.status === "available"
                    ? "Available"
                    : t.status === "ready-for-payment"
                    ? "Pay Requested"
                    : t.status === "preparing"
                    ? "Preparing"
                    : "Occupied"}
                </span>
                {t.activeTicketTotal ? (
                  <p className="text-xs font-bold text-stone-200 mt-1">{t.activeTicketTotal} ETB open</p>
                ) : null}
                {t.activeTicketBy ? (
                  <p className="text-[11px] text-[#D8B93E] mt-1 font-black">👤 {t.activeTicketBy}</p>
                ) : null}
                {t.activeTicketAt ? (
                  <p className="text-[11px] text-stone-300 mt-0.5 font-bold">
                    🕒 since {formatClock(t.activeTicketAt)} • {waitingLabel(t.activeTicketAt)}
                  </p>
                ) : null}
                {t.activeTicketReceiptRequestedAt ? (
                  <p className="text-[11px] text-emerald-300 mt-1 font-black">🧾 bill requested</p>
                ) : null}
              </button>
            ))}
          </div>

          <div className="bg-[#2C1B17] border border-stone-800 rounded-2xl p-4">
            <p className="text-xs text-stone-400 leading-relaxed">
              {printQueueMode ? (
                <>
                  Tap a <span className="text-emerald-400 font-bold">green table</span> to take a new order.
                  When the guests leave and you have cleared the table, open its bill and tap{" "}
                  <span className="text-emerald-400 font-bold">Table Cleared</span> • it turns green for the next guests.
                </>
              ) : (
                <>
                  Tap a <span className="text-emerald-400 font-bold">green table</span> to start a new order.
                  Tap an <span className="text-rose-400 font-bold">occupied table</span> to view its bill, add more items, or request payment.
                </>
              )}
            </p>
          </div>
        </div>
      )}

      {/* ── ORDER VIEW (create/add items) ── */}
      {view === "order" && selectedTable && (
        <div className="max-w-3xl mx-auto">
          <div className="px-4 py-3 flex items-center gap-3 border-b border-stone-800">
            <button onClick={onGoBack} className="p-2 rounded-xl bg-white/10"><ArrowLeft className="w-4 h-4" /></button>
            <div className="flex-1">
              <h2 className="font-serif font-bold text-amber-100 text-lg leading-none">{selectedTable.name}</h2>
              <p className="text-[11px] text-stone-400">{activeTicket ? "Adding items to existing bill" : "New order"}</p>
            </div>
            {activeTicket && (
              <button onClick={() => setView("bill")} className="text-xs bg-[#C9A227]/20 text-[#C9A227] px-3 py-1.5 rounded-lg font-bold">
                View Bill
              </button>
            )}
          </div>

          {/* search + categories */}
          <div className="p-4 space-y-3 sticky top-[57px] bg-[#1C120F] z-20">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search menu..."
                className="w-full bg-[#2C1B17] border border-stone-700 rounded-xl pl-9 pr-3 py-2.5 text-sm"
              />
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {categories.map((c) => (
                <button
                  key={c.slug}
                  onClick={() => setCategory(c.slug)}
                  className={`px-3.5 py-1.5 rounded-full text-xs font-bold whitespace-nowrap ${
                    category === c.slug ? "bg-[#C9A227] text-[#2C1B17]" : "bg-[#2C1B17] text-stone-300"
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </div>

          {/* menu grid */}
          <div className="px-4 grid grid-cols-2 gap-3 pb-40">
            {filteredMenu.map((m) => {
              const inCart = cart.find((c) => c.menuItemId === m.id);
              const out = !m.isAvailable;
              return (
                <div
                  key={m.id}
                  // GROUP 10 (staff request): the WHOLE card adds the food —
                  // image, title, price, any part of it. Staff kept tapping the
                  // photo first; now that works.
                  onClick={() => addToCart(m)}
                  role="button"
                  tabIndex={out ? -1 : 0}
                  onKeyDown={(e) => {
                    if (!out && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      addToCart(m);
                    }
                  }}
                  className={`bg-[#2C1B17] rounded-2xl overflow-hidden border transition relative ${out ? "border-stone-800 opacity-50" : "border-stone-700 active:scale-95 active:border-[#C9A227] cursor-pointer"}`}
                >
                  <div className="relative">
                    <img src={optimizeImageUrl(m.imageUrl, 300, 200)} alt={m.name} className="w-full h-24 object-cover bg-stone-900" onError={(e) => { const el = e.currentTarget; if (!el.src.includes("placeholder")) el.src = FALLBACK_FOOD_IMAGE; }} />
                    {inCart && (
                      <span className="absolute top-1.5 right-1.5 bg-[#C9A227] text-[#2C1B17] text-[10px] font-black w-6 h-6 rounded-full flex items-center justify-center shadow-lg">
                        {inCart.quantity}
                      </span>
                    )}
                  </div>
                  <div className="p-2.5 space-y-1">
                    <p className="text-xs font-bold text-amber-100 leading-tight line-clamp-2">{m.name}</p>
                    <p className="text-[11px] text-[#C9A227] font-extrabold">{effectivePrice(m).onSale ? <span><span className="line-through text-stone-500 text-[10px]">{m.price} </span>{effectivePrice(m).price}</span> : m.price} ETB</p>
                    {out ? (
                      <span className="text-[10px] font-bold text-rose-400 bg-rose-900/40 px-2 py-0.5 rounded">Unavailable</span>
                    ) : (
                      <span className="w-full mt-1 bg-[#C9A227] text-[#2C1B17] text-[11px] font-extrabold py-1.5 rounded-lg flex items-center justify-center gap-1 pointer-events-none">
                        <Plus className="w-3 h-3" /> {inCart ? `In cart (${inCart.quantity})` : "Add • tap anywhere"}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* cart bottom sheet */}
          {cart.length > 0 && (
            <div className="fixed bottom-0 left-0 right-0 z-40 bg-[#2C1B17] border-t-2 border-[#C9A227] p-4 max-w-3xl mx-auto space-y-3">
              <div className="max-h-40 overflow-y-auto space-y-2">
                {cart.map((c) => (
                  <div key={c.menuItemId} className="bg-[#3D2314] rounded-xl p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-amber-100 flex-1 truncate">{c.name}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <button onClick={() => setCart(cart.map((x) => x.menuItemId === c.menuItemId ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x))} className="w-6 h-6 bg-white/10 rounded-md flex items-center justify-center"><Minus className="w-3 h-3" /></button>
                        <span className="font-extrabold text-[#C9A227] w-4 text-center">{c.quantity}</span>
                        <button onClick={() => setCart(cart.map((x) => x.menuItemId === c.menuItemId ? { ...x, quantity: x.quantity + 1 } : x))} className="w-6 h-6 bg-[#C9A227] text-black rounded-md flex items-center justify-center"><Plus className="w-3 h-3" /></button>
                        <button onClick={() => setCart(cart.filter((x) => x.menuItemId !== c.menuItemId))} className="text-rose-400 pl-1"><X className="w-4 h-4" /></button>
                      </div>
                    </div>
                    <input
                      value={c.notes}
                      onChange={(e) => setCart(cart.map((x) => (x.menuItemId === c.menuItemId ? { ...x, notes: e.target.value } : x)))}
                      placeholder="Note: No Sugar, Extra Mayo, Less Spicy..."
                      className="w-full bg-black/30 border border-stone-700 rounded-lg px-2 py-1 text-[11px] text-stone-300"
                    />
                  </div>
                ))}
              </div>
              <button
                onClick={sendOrder}
                disabled={sending}
                className="w-full bg-gradient-to-r from-[#C9A227] to-[#B8921F] text-[#2C1B17] font-black text-sm uppercase py-3.5 rounded-xl flex items-center justify-center gap-2 shadow-xl"
              >
                <Send className="w-4 h-4" />
                {sending ? "Sending..." : `Send Order • ${cartTotal} ETB`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── BILL VIEW (existing table) ── */}
      {view === "bill" && activeTicket && selectedTable && (
        <div className="p-4 max-w-2xl mx-auto space-y-4">
          <div className="flex items-center gap-3">
            <button onClick={onGoBack} className="p-2 rounded-xl bg-white/10"><ArrowLeft className="w-4 h-4" /></button>
            <div className="flex-1">
              <h2 className="font-serif font-bold text-amber-100 text-lg leading-none">{selectedTable.name} • Bill</h2>
              <p className="text-xs font-bold text-stone-300 capitalize mt-0.5">Status: {ticketStatusLabel(activeTicket.status)}</p>
              {/* Group 8: WHEN the order arrived and WHO sent it — the two things
                  staff keep asking for — plus the guest's own bill request. */}
              <p className="text-xs text-[#D8B93E] font-black mt-0.5">
                🕒 {formatDateTime(activeTicket.createdAt)} • by {activeTicket.confirmedBy || activeTicket.createdBy || "staff"}
              </p>
              {activeTicket.receiptRequestedAt && (
                <p className="mt-1 inline-block text-[10px] font-black text-emerald-300 bg-emerald-950/60 border border-emerald-700 rounded-lg px-2 py-0.5">
                  🧾 Guest asked for the bill at {formatClock(activeTicket.receiptRequestedAt)}
                </p>
              )}
            </div>
            {activeTicket.status !== "ready_for_payment" && (
              <button onClick={() => setView("order")} className="text-xs bg-[#C9A227] text-[#2C1B17] px-3 py-2 rounded-lg font-bold flex items-center gap-1">
                <Plus className="w-3.5 h-3.5" /> Add Items
              </button>
            )}
          </div>

          <div className="bg-[#2C1B17] rounded-2xl border border-stone-800 divide-y divide-stone-800">
            {billItems.map((i) => (
              <div key={i.id} className="p-3.5 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-amber-100 flex-1">{i.name}</span>
                  <span className="font-extrabold text-[#C9A227] shrink-0">{i.price * i.quantity} ETB</span>
                </div>
                {i.notes && <p className="text-[11px] text-amber-300 italic">📝 {i.notes}</p>}
                {/* BILL EDITOR: a wrong dish, a wrong qty or a forgotten note is
                    fixed HERE — no walk to the cashier, no cancel-and-start-again.
                    Only dishes the crew has not started yet; once they are in the
                    pan, changes go through the cashier. */}
                <p className="text-[11px] font-bold text-stone-400">× {i.quantity}</p>
                {billEditable && itemEditable(i) ? (
                  editingItemId === i.id ? (
                    <div className="bg-black/30 border border-[#C9A227]/50 rounded-xl p-2.5 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-bold text-stone-300 flex-1">Qty</span>
                        <button onClick={() => setEditQty(Math.max(1, editQty - 1))} className="w-7 h-7 bg-white/10 rounded-lg flex items-center justify-center"><Minus className="w-3.5 h-3.5" /></button>
                        <span className="text-sm font-extrabold text-[#C9A227] w-6 text-center">{editQty}</span>
                        <button onClick={() => setEditQty(Math.min(100, editQty + 1))} className="w-7 h-7 bg-[#C9A227] text-black rounded-lg flex items-center justify-center"><Plus className="w-3.5 h-3.5" /></button>
                      </div>
                      <input
                        value={editNotes}
                        onChange={(e) => setEditNotes(e.target.value)}
                        placeholder="Note: No Sugar, Extra Mayo, Less Spicy..."
                        className="w-full bg-black/40 border border-stone-700 rounded-lg px-2 py-2 text-xs text-stone-200"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => saveEditedItem(i)}
                          disabled={editSaving}
                          className="flex-1 bg-emerald-600 text-white text-xs font-extrabold py-2 rounded-lg disabled:opacity-40"
                        >
                          {editSaving ? "Saving..." : "✓ Save"}
                        </button>
                        <button
                          onClick={() => removeTicketItem(i)}
                          disabled={editSaving}
                          className="flex-1 bg-rose-700/80 text-white text-xs font-extrabold py-2 rounded-lg disabled:opacity-40"
                        >
                          ✗ Remove
                        </button>
                        <button
                          onClick={() => setEditingItemId(null)}
                          disabled={editSaving}
                          className="px-3 bg-white/10 text-stone-300 text-xs font-bold py-2 rounded-lg"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => startEditItem(i)}
                      className="text-[11px] font-extrabold text-[#C9A227] bg-[#C9A227]/10 border border-[#C9A227]/40 px-3 py-1.5 rounded-lg"
                    >
                      ✎ Edit • note / qty / remove
                    </button>
                  )
                ) : (
                  <p className="text-[11px] text-amber-300/80">
                    {itemEditable(i)
                      ? "Bill is at the payment stage, ask the cashier for changes"
                      : "👨‍🍳 Kitchen started this, ask the cashier for changes"}
                  </p>
                )}
              </div>
            ))}
            {billItems.length === 0 && (
              <p className="p-4 text-xs text-stone-400 text-center">
                All items were removed. If the guests are leaving, ask the cashier to cancel this bill.
              </p>
            )}
          </div>

          <div className="bg-[#2C1B17] rounded-2xl border border-[#C9A227]/40 p-4 flex items-center justify-between">
            <span className="text-sm font-bold text-stone-300">Total Bill</span>
            <span className="font-serif font-black text-2xl text-[#C9A227]">{billTotal} ETB</span>
          </div>

          {activeTicket.status === "pending_waiter" && (
            <button
              onClick={confirmOrder}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-black text-sm uppercase py-4 rounded-xl flex items-center justify-center gap-2"
            >
              <CheckCircle2 className="w-4 h-4" /> Accept & Send → Stations & Cashier
            </button>
          )}

          {printQueueMode ? (
            <>
              {/* Group 9: no payment screens for the waiter — the EFD/POS at the
                  counter is the money system. Her only closing job is physical. */}
              {activeTicket.status === "confirmed" && (
                activeTicket.confirmedAt ? (
                  <div className="w-full bg-[#2C1B17] border border-emerald-500/40 rounded-xl px-4 py-3 text-center text-xs font-bold text-emerald-300">
                    ✓ Sent • the crews are cooking, the cashier is printing
                  </div>
                ) : (
                  <div className="w-full bg-[#2C1B17] border border-sky-500/40 rounded-xl px-4 py-3 text-center text-xs font-bold text-sky-300">
                    ⏸ Accepted • the cashier is holding it until the guest finishes ordering
                  </div>
                )
              )}
              {/* Closing a bill stays a FLOOR job: the buna makers take orders
                  and make buna, but the waiter is the one who clears the table. */}
              {!isBuna &&
                (activeTicket.status === "printed" ||
                  activeTicket.status === "preparing" ||
                  activeTicket.status === "ready_for_payment" ||
                  activeTicket.status === "completed") && (
                  <button
                    onClick={clearTable}
                    className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-black text-sm uppercase py-4 rounded-xl flex items-center justify-center gap-2"
                  >
                    <CheckCircle2 className="w-4 h-4" /> Table Cleared • Free Table
                  </button>
                )}
            </>
          ) : (
            <>
              {activeTicket.status !== "ready_for_payment" && activeTicket.status !== "pending_waiter" && (
                <button
                  onClick={requestPayment}
                  className="w-full bg-amber-500 text-black font-black text-sm uppercase py-4 rounded-xl flex items-center justify-center gap-2"
                >
                  <CreditCard className="w-4 h-4" /> Request Payment
                </button>
              )}

              {activeTicket.status === "ready_for_payment" && (
                <button
                  onClick={() => setView("payment")}
                  className="w-full bg-emerald-600 text-white font-black text-sm uppercase py-4 rounded-xl"
                >
                  Continue to Payment →
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* ── PAYMENT VIEW ── */}
      {view === "payment" && activeTicket && selectedTable && (
        <div className="p-4 max-w-md mx-auto space-y-5">
          <div className="flex items-center gap-3">
            <button onClick={() => setView("bill")} className="p-2 rounded-xl bg-white/10"><ArrowLeft className="w-4 h-4" /></button>
            <h2 className="font-serif font-bold text-amber-100 text-lg">Payment • {selectedTable.name}</h2>
          </div>

          <div className="bg-[#2C1B17] rounded-2xl border border-[#C9A227]/40 p-4 text-center">
            <p className="text-xs text-stone-400">Amount to collect</p>
            <p className="font-serif font-black text-3xl text-[#C9A227]">{billTotal} ETB</p>
          </div>

          <div className="bg-[#2C1B17] rounded-2xl border border-stone-700 p-4">
            <p className="text-xs text-stone-300 leading-relaxed">
              Collect the <strong className="text-white">{billTotal} ETB</strong> from the customer, then confirm below.
              The cashier verifies and releases the table.
            </p>
          </div>

          {receiptEnabled && (
            <div className="bg-[#2C1B17] rounded-2xl border border-stone-700 p-4 space-y-3">
              <p className="text-xs font-bold text-amber-200 flex items-center gap-1.5">
                <Camera className="w-4 h-4 text-[#C9A227]" /> Receipt Photo (optional)
              </p>
              {receiptImage && <img src={receiptImage} alt="Receipt" className="w-full h-40 object-cover rounded-xl border border-stone-600" />}
              <label className="flex items-center justify-center gap-2 w-full bg-white/10 hover:bg-white/20 text-white text-xs font-bold py-2.5 rounded-xl cursor-pointer">
                <Camera className="w-4 h-4" />
                {receiptImage ? "Retake Photo" : "Take Receipt Photo"}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    try {
                      // Compress on device (~4MB → ~70KB). The data-URL stays in
                      // state and is persisted by the server only when the bill is
                      // actually paid — a canceled photo never touches the database.
                      const small = await compressImage(f, 800, 0.65);
                      setReceiptImage(small);
                    } catch {
                      showToast("Could not read that photo. Try again");
                    }
                  }}
                />
              </label>
            </div>
          )}

          <button
            onClick={confirmPayment}
            disabled={sending}
            className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-black text-sm uppercase py-4 rounded-xl disabled:opacity-40"
          >
            {sending ? "Confirming..." : "Confirm Payment"}
          </button>

          <div className="flex items-center gap-2 text-[11px] text-stone-400 bg-[#2C1B17] rounded-xl p-3">
            <ClipboardList className="w-4 h-4 text-[#C9A227] shrink-0" />
            After confirmation, the cashier verifies and marks the order <strong className="text-white">Paid</strong>. The table then becomes Available automatically.
          </div>
        </div>
      )}
    </div>
  );
}
