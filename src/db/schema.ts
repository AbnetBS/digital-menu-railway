import { pgTable, serial, varchar, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const siteSettings = pgTable("site_settings", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull(),
  icon: varchar("icon", { length: 50 }).notNull(),
  sortOrder: integer("sort_order").default(0),
});

export const menuItems = pgTable("menu_items", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  category: varchar("category", { length: 100 }).notNull(),
  price: integer("price").notNull(),
  description: text("description").notNull(),
  imageUrl: text("image_url").notNull(),
  isPopular: boolean("is_popular").default(false),
  isAvailable: boolean("is_available").default(true),
  dietaryTags: text("dietary_tags"),
  prepTime: varchar("prep_time", { length: 50 }).default("10-15 min"),
  badge: varchar("badge", { length: 50 }),
  // Automatic scheduled sale price (date-range based, reverts automatically)
  salePrice: integer("sale_price"),
  saleStart: varchar("sale_start", { length: 20 }), // YYYY-MM-DD
  saleEnd: varchar("sale_end", { length: 20 }),
  sortOrder: integer("sort_order").default(0),
});

// Daily Board — owner's rotating announcements (promotions, sold-out notes, holiday greetings)
export const announcements = pgTable("announcements", {
  id: serial("id").primaryKey(),
  title: varchar("title", { length: 200 }).notNull(),
  description: text("description").notNull(),
  imageUrl: text("image_url"), // optional
  startDate: varchar("start_date", { length: 20 }), // YYYY-MM-DD
  endDate: varchar("end_date", { length: 20 }),
  priority: integer("priority").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const reviews = pgTable("reviews", {
  id: serial("id").primaryKey(),
  customerName: varchar("customer_name", { length: 100 }).notNull(),
  rating: integer("rating").notNull(),
  reviewText: text("review_text").notNull(),
  reviewDate: varchar("review_date", { length: 50 }).notNull(),
  isApproved: boolean("is_approved").default(false),
  isVerified: boolean("is_verified").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const galleryItems = pgTable("gallery_items", {
  id: serial("id").primaryKey(),
  title: varchar("title", { length: 100 }).notNull(),
  category: varchar("category", { length: 50 }).notNull(),
  imageUrl: text("image_url").notNull(),
  caption: text("caption"),
  sortOrder: integer("sort_order").default(0),
});

// ─── RMS TABLES ──────────────────────────────────────────────

export const staffUsers = pgTable("staff_users", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  role: varchar("role", { length: 20 }).notNull().default("waiter"), // waiter | cashier
  pin: varchar("pin", { length: 100 }).notNull(), // bcrypt hash (60 chars) or legacy plaintext
  createdAt: timestamp("created_at").defaultNow(),
});

export const cafeTables = pgTable("cafe_tables", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 50 }).notNull(),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

// A "ticket" is one open bill attached to a table
export const tickets = pgTable("tickets", {
  id: serial("id").primaryKey(),
  tableId: integer("table_id").notNull(),
  tableName: varchar("table_name", { length: 50 }).notNull(),
  status: varchar("status", { length: 30 }).notNull().default("new"), // new | preparing | ready_for_payment | completed | paid | cancelled
  paymentMethod: varchar("payment_method", { length: 20 }), // cash | card | online | telebirr | cbe
  // Payment status is SEPARATE from order status (food done ≠ paid).
  // unpaid | paid_cash | paid_telebirr | paid_cbe | paid_card
  paymentStatus: varchar("payment_status", { length: 20 }).notNull().default("unpaid"),
  receiptImage: text("receipt_image"), // base64 photo of card/online payment receipt
  totalAmount: integer("total_amount").notNull().default(0),
  createdBy: varchar("created_by", { length: 100 }), // waiter name / "Customer (QR)"
  confirmedBy: varchar("confirmed_by", { length: 100 }), // who confirmed the order (waiter/cashier)
  closedAt: timestamp("closed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  // Guaranteed-unique order number shown to staff/customers (FANA-<ticket id>).
  // Populated at insert from the DB serial → never random → never collides.
  orderNumber: varchar("order_number", { length: 32 }),
  // Idempotency key: a client-generated UUID per order submission. The unique index
  // on (ticket_id, idempotency_key) makes retries/double-taps safe server-side.
  idempotencyKey: varchar("idempotency_key", { length: 64 }),
  // Payment verification audit (Group 5): who marked the bill PAID and when.
  // Set by the cashier's "Mark PAID & Release Table" action (the receipt
  // verification step for digital/card payments). Null for unpaid/cancelled.
  verifiedBy: varchar("verified_by", { length: 100 }),
  verifiedAt: timestamp("verified_at"),
});

export const ticketItems = pgTable("ticket_items", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id").notNull(),
  menuItemId: integer("menu_item_id"),
  name: varchar("name", { length: 200 }).notNull(),
  category: varchar("category", { length: 100 }),
  price: integer("price").notNull(),
  quantity: integer("quantity").notNull().default(1),
  notes: text("notes"), // per-item notes: "No Sugar", "Extra Mayonnaise"
  removed: boolean("removed").default(false), // cashier removed (unavailable)
  // Station routing: which crew handles this item (barista for drinks/juice, kitchen for food/pastry)
  stationName: varchar("station_name", { length: 20 }).default("kitchen"),
  stationStatus: varchar("station_status", { length: 20 }).default("pending"), // pending | accepted | done
  createdAt: timestamp("created_at").defaultNow(),
  // Shared by all rows of one order submission (see tickets.idempotencyKey).
  idempotencyKey: varchar("idempotency_key", { length: 64 }),
});

// ─── AMHARIC AUTO-TRANSLATION CACHE ─────────────────────────────────────────
// Google Translate results for owner-managed content (menu items the owner
// adds, categories, announcements, settings texts) are cached here so each
// unique string is translated ONCE — repeat visits are instant and free.
export const translations = pgTable("translations", {
  id: serial("id").primaryKey(),
  lang: varchar("lang", { length: 10 }).notNull(), // "am"
  sourceHash: varchar("source_hash", { length: 64 }).notNull(), // sha256(sourceText)
  sourceText: text("source_text").notNull(),
  translatedText: text("translated_text").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});
