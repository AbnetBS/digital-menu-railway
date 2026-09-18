export interface MenuItem {
  id: number;
  name: string;
  category: string;
  price: number;
  description: string;
  imageUrl: string;
  isPopular: boolean;
  isAvailable: boolean;
  /** Traditional buna → routed to the buna makers instead of the barista. */
  isBuna?: boolean;
  /**
   * Per-item station override ("barista" | "kitchen" | "buna"). Wins over the
   * category routing, for mixed-crew categories like "Extra Things".
   * Null/undefined = follow the category routing.
   */
  stationOverride?: string | null;
  dietaryTags?: string | null;
  prepTime?: string | null;
  badge?: string | null;
  // Automatic date-ranged sale pricing
  salePrice?: number | null;
  saleStart?: string | null;
  saleEnd?: string | null;
  sortOrder?: number;
}

export type DailyPromotionType =
  | "special_price"
  | "percentage_discount"
  | "fixed_amount_discount"
  | "buy_x_get_y"
  | "buy_x_get_y_discounted"
  | "combo";

export interface DailyPromotionItem {
  menuItemId: number;
  quantity: number;
  /** Only used by Buy X Get Y promotions. */
  role?: "buy" | "get";
}

/**
 * The orderable configuration stored in an announcement's existing
 * `promotion_items` JSON column. It only references real menu items.
 */
export interface DailyPromotion {
  type: DailyPromotionType;
  items: DailyPromotionItem[];
  isActive: boolean;
  startTime?: string | null;
  endTime?: string | null;
  /** Unit price for Special Price; total bundle price for Combo. */
  specialPrice?: number | null;
  discountPercent?: number | null;
  discountAmount?: number | null;
  /** Discount applied to the Get item(s) in Buy X Get Y Discounted. */
  getDiscountPercent?: number | null;
}

export interface Announcement {
  id: number;
  title: string;
  description: string;
  imageUrl?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  /** Parsed from the existing `promotion_items` column; null = display-only. */
  promotionItems?: DailyPromotion | null;
  priority?: number;
  createdAt?: string;
}

export interface Category {
  id: number;
  name: string;
  slug: string;
  icon: string;
  sortOrder?: number;
}

export interface Review {
  id: number;
  customerName: string;
  rating: number;
  reviewText: string;
  reviewDate: string;
  isApproved: boolean;
  isVerified: boolean;
}

export interface GalleryItem {
  id: number;
  title: string;
  category: string;
  imageUrl: string;
  caption?: string;
  sortOrder?: number;
}

export interface SiteSettings {
  cafe_name?: string;
  tagline?: string;
  hero_title?: string;
  hero_subtitle?: string;
  hero_bg_image?: string;
  phone?: string;
  address?: string;
  plus_code?: string;
  opening_hours?: string;
  about_title?: string;
  about_description?: string;
  announcement?: string;
  admin_password?: string;
  [key: string]: string | number | undefined;
}

// ─── RMS TYPES ────────────────────────────────────────────────

export type StaffRole = "waiter" | "cashier";

export interface StaffUser {
  id: number;
  name: string;
  role: StaffRole;
  /** Present on legacy clients only; the API now returns `pinSet` instead. */
  pin?: string;
  /** True when a PIN is set (the raw PIN/hash is never returned). */
  pinSet?: boolean;
  /** True when this person switched their pocket alerts off (off duty). */
  alertsOff?: boolean;
}

export type TableStatus = "available" | "waiting" | "occupied" | "preparing" | "ready-for-payment";

export type TicketStatus =
  | "pending_waiter"
  | "confirmed"
  | "preparing"
  | "ready_for_payment"
  | "completed"
  | "printed"
  | "closed"
  | "paid"
  | "cancelled";

export type TicketOrderType = "dine_in" | "outdoor";
export type OrderHistoryStatus = "done" | "edited_printed" | "edited_cancelled" | "cancelled";

/**
 * One row of the cashier's Coffee Note (owner's decision, Sept 2026): a held
 * outdoor buna sale. While `paidAt` is null the note is only visible in the
 * Coffee Note page — never in the outdoor orders list and never on a station
 * screen. Tapping PAID creates the real outdoor ticket (born paid) and links
 * it back through `ticketId`.
 */
export interface BunaNote {
  id: number;
  /** Daily note number shown in the list (1, 2, 3… restarts each day). */
  seq: number;
  menuItemId?: number | null;
  itemName: string;
  unitPrice: number;
  quantity: number;
  placeNote?: string | null;
  heldBy?: string | null;
  heldAt?: string | null;
  paidAt?: string | null;
  paidBy?: string | null;
  /** The outdoor ticket created at payment (order-history link). */
  ticketId?: number | null;
}

export interface CafeTable {
  id: number;
  name: string;
  sortOrder?: number;
  status?: TableStatus;
  activeTicketId?: number | null;
  activeTicketTotal?: number;
  activeTicketBy?: string | null; // who is handling the open bill (createdBy / confirmedBy)
  /** When the open bill started (Group 8). */
  activeTicketAt?: string | null;
  /**
   * GROUP ORDERS (Sept 2026): true for the pseudo-table card of an open
   * GROUP bill — it behaves like a table everywhere (grid card, bill, add
   * items, payment) but has no row in cafe_tables.
   */
  isGroup?: boolean;
  /** Guest tapped "bring us the bill" from their phone (Group 8). */
  activeTicketReceiptRequestedAt?: string | null;
  /** Waiter or guest who requested the bill. */
  activeTicketReceiptRequestedBy?: string | null;
}

export type PaymentMethod = "cash" | "card" | "online" | "telebirr" | "cbe";

/**
 * Payment status is tracked SEPARATELY from order status (food ready ≠ paid).
 * Values match the cafe's real payment options; "online" is kept for legacy rows.
 */
export type PaymentStatus = "unpaid" | "paid" | "paid_cash" | "paid_telebirr" | "paid_cbe" | "paid_card";

export interface TicketItem {
  id: number;
  ticketId: number;
  menuItemId?: number | null;
  name: string;
  category?: string | null;
  price: number;
  quantity: number;
  notes?: string | null;
  removed: boolean;
  /** Which crew makes it: "kitchen" (food) or "barista" (drinks/cake). */
  stationName?: string | null;
  /** Crew progress: pending → accepted → done. */
  stationStatus?: string | null;
  /** WHO last pressed Accept/Done on this line (crew-action audit). */
  stationStatusBy?: string | null;
  /** WHEN they pressed it (crew-action audit). */
  stationStatusAt?: string | null;
  createdAt?: string;
  idempotencyKey?: string | null;
}

export interface TicketAuditEvent {
  id: number;
  eventType: string;
  actorName?: string | null;
  actorRole?: string | null;
  source?: string | null;
  itemId?: number | null;
  itemName?: string | null;
  fromValue?: string | null;
  toValue?: string | null;
  details?: string | null;
  createdAt?: string | null;
  label?: string | null;
  detail?: string | null;
}

export interface Ticket {
  id: number;
  tableId: number;
  tableName: string;
  orderType?: TicketOrderType | null;
  serviceNote?: string | null;
  status: TicketStatus;
  paymentMethod?: PaymentMethod | null;
  paymentStatus?: PaymentStatus | null;
  receiptImage?: string | null;
  totalAmount: number;
  createdBy?: string | null;
  closedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  orderNumber?: string | null;
  confirmedBy?: string | null;
  /**
   * When the order was SENT to the crews (the release stamp). A confirmed
   * bill with a null confirmedAt is HELD: the cashier accepted the guest's QR
   * order (alarms stopped) but nothing goes to the kitchen/barista/buna
   * makers until she taps CONFIRM & SEND.
   */
  confirmedAt?: string | null;
  verifiedBy?: string | null;
  verifiedAt?: string | null;
  /** Print-queue mode: cashier keyed the bill into the EFD/POS and printed it. */
  printedAt?: string | null;
  printedBy?: string | null;
  /** Print-queue mode: waiter physically cleared the table (ticket closed). */
  closedBy?: string | null;
  /**
   * Print-queue mode: order submissions accepted AFTER the last print — every
   * value > 0 re-queues an already-printed ticket so the cashier prints again
   * (the "TABLE 5 — ADDED" card). Computed server-side in GET /api/tickets.
   */
  unprintedSubmissions?: number;
  /** Of those waiting submissions, how many came from the guest's own phone. */
  unprintedCustomerSubmissions?: number;
  /** Of those waiting submissions, how many were keyed by staff. */
  unprintedStaffSubmissions?: number;
  /** Guest asked for the bill/receipt (Group 8). Null until they tap it. */
  receiptRequestedAt?: string | null;
  /** Waiter or guest who requested the bill. */
  receiptRequestedBy?: string | null;
  /** WHEN a line on this bill was last corrected (bill-edit audit). */
  itemsEditedAt?: string | null;
  /** Admin-only derived history status from the persistent audit trail. */
  historyStatus?: OrderHistoryStatus;
  historyStatusLabel?: string;
  historyChangeSummary?: string | null;
  auditTrail?: TicketAuditEvent[];
  items?: TicketItem[];
}

export interface WaiterRankingRow {
  name: string;
  acceptedOrders: number;
  directOrders: number;
  totalActions: number;
}

export interface WaiterOrderRecord {
  waiterName: string;
  kind: "accepted" | "direct";
  ticketId: number;
  tableName: string;
  orderNumber?: string | null;
  orderType?: TicketOrderType | null;
  serviceNote?: string | null;
  status: string;
  totalAmount: number;
  happenedAt?: string | null;
  createdAt?: string | null;
  confirmedAt?: string | null;
  printedAt?: string | null;
  detail?: string | null;
}

export interface ReportData {
  todayRevenue: number;
  yesterdayRevenue: number;
  weeklyRevenue: number;
  monthlyRevenue: number;
  todayOrders: number;
  yesterdayOrders: number;
  weekOrders: number;
  monthOrders: number;
  averageOrderValue: number;
  orderHistory?: Ticket[];
  popularItems: Array<{ name: string; quantity: number; revenue: number }>;
  categorySales: Array<{ category: string; quantity: number; revenue: number }>;
  paymentStats: Array<{ method: string; count: number; revenue: number }>;
  receipts: Array<{ id: number; tableName: string; method: string; receiptImage?: string; totalAmount: number; closedAt?: string | null }>;
  hourlySales?: Array<{ hour: number; orders: number; revenue: number }>;
  peakHour?: { hour: number; orders: number; revenue: number } | null;
  /**
   * CROSS-CHECK BY STATION (selected period) — the paper world's four stacks:
   * everything the barista, the kitchen, the buna makers and the juice maker
   * each sold in the period, so the cross-checker can add the four piles and
   * compare with the EFD receipts.
   */
  stationSales?: Array<{ station: string; orders: number; quantity: number; revenue: number }>;
  /** Full per-station item breakdown for the selected period (name, units, ETB). */
  stationItems?: Array<{ station: string; name: string; quantity: number; revenue: number }>;
  /** Total of the selected period's printed (EFD) bills — the number to compare against the receipt pile. */
  printedTodayTotal?: number;
  /** Every bill printed in the selected period (any status except cancelled), newest first, with items. */
  printedToday?: Ticket[];
  /** Which period this response describes (echoes ?period=, defaults to "today"). */
  period?: "today" | "yesterday" | "week" | "month";
  /** Plain-language label for the selected period, e.g. "Today" or "Last 7 Days". */
  periodLabel?: string;
  /** Total item units sold in the selected period (non-removed lines). */
  totalItems?: number;
  /** Waiter ranking for the selected interval. */
  waiterRanking?: WaiterRankingRow[];
  /** Click-through order list backing the waiter ranking section. */
  waiterOrders?: WaiterOrderRecord[];
  /** True when the printed-bills archive was capped (long periods only). */
  archiveCapped?: boolean;
  /** How many printed bills the selected period has in total (before any cap). */
  archiveTotal?: number;
}
