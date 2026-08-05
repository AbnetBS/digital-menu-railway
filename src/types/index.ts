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

export interface Announcement {
  id: number;
  title: string;
  description: string;
  imageUrl?: string | null;
  startDate?: string | null;
  endDate?: string | null;
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
  pin: string;
}

export type TableStatus = "available" | "waiting" | "occupied" | "preparing" | "ready-for-payment";

export type TicketStatus =
  | "pending_waiter"
  | "confirmed"
  | "preparing"
  | "ready_for_payment"
  | "completed"
  | "paid"
  | "cancelled";

export interface CafeTable {
  id: number;
  name: string;
  sortOrder?: number;
  status?: TableStatus;
  activeTicketId?: number | null;
  activeTicketTotal?: number;
}

export type PaymentMethod = "cash" | "card" | "online";

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
  createdAt?: string;
}

export interface Ticket {
  id: number;
  tableId: number;
  tableName: string;
  status: TicketStatus;
  paymentMethod?: PaymentMethod | null;
  receiptImage?: string | null;
  totalAmount: number;
  createdBy?: string | null;
  closedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
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
