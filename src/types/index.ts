export interface MenuItem {
  id: number;
  name: string;
  category: string;
  price: number;
  description: string;
  imageUrl: string;
  isPopular: boolean;
  isAvailable: boolean;
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
  /** Guest tapped "bring us the bill" from their phone (Group 8). */
  activeTicketReceiptRequestedAt?: string | null;
}

export type PaymentMethod = "cash" | "card" | "online" | "telebirr" | "cbe";

/**
 * Payment status is tracked SEPARATELY from order status (food ready ≠ paid).
 * Values match the cafe's real payment options; "online" is kept for legacy rows.
 */
export type PaymentStatus = "unpaid" | "paid_cash" | "paid_telebirr" | "paid_cbe" | "paid_card";

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
  createdAt?: string;
  idempotencyKey?: string | null;
}

export interface Ticket {
  id: number;
  tableId: number;
  tableName: string;
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
  /** Guest asked for the bill/receipt (Group 8). Null until they tap it. */
  receiptRequestedAt?: string | null;
  items?: TicketItem[];
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
  categorySales: Array<{ category: string; revenue: number }>;
  paymentStats: Array<{ method: string; count: number; revenue: number }>;
  receipts: Array<{ id: number; tableName: string; method: string; receiptImage?: string; totalAmount: number; closedAt?: string | null }>;
  hourlySales?: Array<{ hour: number; orders: number; revenue: number }>;
  peakHour?: { hour: number; orders: number; revenue: number } | null;
}
