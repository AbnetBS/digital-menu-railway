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
  // TRADITIONAL BUNA (owner's decision, Sept 2026): flagged items are made by
  // the buna makers at their own place, so an order line for them is routed to
  // the "buna" station whatever category the item sits in. It is a PER-ITEM
  // flag on purpose — "Jebena Buna" lives in the Coffee category next to the
  // macchiato, and only the traditional one leaves the barista's lane.
  isBuna: boolean("is_buna").default(false),
  // PER-ITEM STATION OVERRIDE (owner's decision, Sept 2026): "Extra Things"
  // items belong to different crews — a coffee cup is the barista's, a take
  // away bag is the kitchen's — even though they share one category. When set
  // ("barista" | "kitchen" | "buna") it wins over the category routing, so the
  // owner can point any single item at the crew that actually prepares it.
  // Null = follow the category routing from the Stations tab (the default).
  stationOverride: varchar("station_override", { length: 20 }),
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
  // Optional JSON array of menu-item references that makes this board card orderable.
  // Prices and free-item status are always revalidated on the server at order time.
  promotionItems: text("promotion_items"),
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
  // POCKET OFF-DUTY SWITCH (owner's decision, Sept 2026): staff phones kept
  // ringing at home long after the shift ended. Each person can switch their
  // own alerts off from their app when they finish work ("Off duty") and back
  // on when they return. It is per PERSON, not per device: every phone and
  // tablet subscribed under their name goes silent with that one tap. The
  // next PIN sign-in switches it back on, so a shift can never start silent
  // because somebody forgot. Pushes are filtered on this flag in push.ts.
  notificationsEnabled: boolean("notifications_enabled").notNull().default(true),
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
  // Indoor table bill (default) or cashier-entered outdoor / delivery-style order.
  orderType: varchar("order_type", { length: 20 }).notNull().default("dine_in"),
  // Cashier-entered outdoor info: guest phone, car color, delivery note, etc.
  serviceNote: text("service_note"),
  status: varchar("status", { length: 30 }).notNull().default("new"), // new | preparing | ready_for_payment | completed | paid | cancelled
  paymentMethod: varchar("payment_method", { length: 20 }), // cash | card | online | telebirr | cbe
  // Payment status is SEPARATE from order status (food done ≠ paid).
  // unpaid | paid_cash | paid_telebirr | paid_cbe | paid_card
  paymentStatus: varchar("payment_status", { length: 20 }).notNull().default("unpaid"),
  receiptImage: text("receipt_image"), // base64 photo of card/online payment receipt
  totalAmount: integer("total_amount").notNull().default(0),
  createdBy: varchar("created_by", { length: 100 }), // waiter name / "Customer (QR)"
  confirmedBy: varchar("confirmed_by", { length: 100 }), // who confirmed the order (waiter/cashier)
  // WHEN it was SENT to the crews. This is the release stamp: everything on
  // the bill at that moment goes to the kitchen/barista/buna makers
  // immediately. Anything added AFTER it waits for the cashier's next print,
  // exactly like before.
  //
  // QR HOLD FLOW (owner's decision, Sept 2026): when the CASHIER accepts a
  // guest's QR order she only ACKNOWLEDGES it (confirmedBy is stamped, the
  // alarms stop everywhere) but this stamp is NOT written yet — the guest may
  // still add more items. Her "CONFIRM & SEND" tap (or a waiter's accept,
  // which verifies with the guest in person) writes it and releases the food.
  // A confirmed bill with a null confirmed_at is therefore a HELD bill: the
  // crews see nothing from it until it is sent or printed.
  confirmedAt: timestamp("confirmed_at"),
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
  // Print-queue mode: the cashier keyed this bill into the government EFD/POS
  // and printed the order paper. Re-printed (updated) whenever additions arrive.
  printedAt: timestamp("printed_at"),
  printedBy: varchar("printed_by", { length: 100 }),
  // Print-queue mode: the waiter physically cleared the table, closing the
  // bill. This is a PHYSICAL event (table bussed), deliberately decoupled from
  // payment — the EFD/POS remains the financial system of record.
  closedBy: varchar("closed_by", { length: 100 }),
  // Guest or waiter "we are done — please bring the bill/receipt" request (Group 8).
  // Stamped from the guest's phone or waiter dashboard; cleared by staff.
  // It never changes the order or payment status by itself.
  receiptRequestedAt: timestamp("receipt_requested_at"),
  receiptRequestedBy: varchar("receipt_requested_by", { length: 100 }),
  // Bill-edit audit: WHEN a line on this bill was last corrected (qty, note or
  // removal). A printed bill with items_edited_at AFTER printed_at changed
  // after the EFD receipt went out and must be re-keyed into the EFD.
  itemsEditedAt: timestamp("items_edited_at"),
});

/**
 * One row per ACCEPTED order submission (Group 8).
 *
 * The bill of a table grows over time — the guest orders tea, then orders tea
 * again ten minutes later — and identical pending lines are now folded into the
 * existing row so no screen ever shows "1 Tea, 1 Sandwich, 1 Tea". Folding a
 * line means NOT inserting a row for it, which would have lost the per-row
 * idempotency key that protects against a retried/double-tapped submission.
 * This table records the submission itself, so the duplicate guard keeps working
 * no matter how many of its lines were merged away.
 */
export const orderSubmissions = pgTable("order_submissions", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id").notNull(),
  /** Client-generated submission UUID (the same value as tickets.idempotencyKey). */
  idempotencyKey: varchar("idempotency_key", { length: 64 }).notNull(),
  /** "customer" (QR) or "staff" (waiter/cashier) — who sent this submission. */
  source: varchar("source", { length: 20 }),
  /** Waiter name for staff submissions, null for a guest's own phone. */
  waiterName: varchar("waiter_name", { length: 100 }),
  lines: integer("lines").default(0),
  mergedLines: integer("merged_lines").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

// Persistent audit trail of ticket changes for admin history/reporting.
export const ticketEvents = pgTable("ticket_events", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id").notNull(),
  eventType: varchar("event_type", { length: 50 }).notNull(),
  actorName: varchar("actor_name", { length: 100 }),
  actorRole: varchar("actor_role", { length: 20 }),
  source: varchar("source", { length: 20 }),
  itemId: integer("item_id"),
  itemName: varchar("item_name", { length: 200 }),
  fromValue: text("from_value"),
  toValue: text("to_value"),
  details: text("details"),
  createdAt: timestamp("created_at").defaultNow(),
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
  // Crew-action audit: WHO last pressed Accept/Done on this line and WHEN.
  stationStatusBy: varchar("station_status_by", { length: 100 }),
  stationStatusAt: timestamp("station_status_at"),
  createdAt: timestamp("created_at").defaultNow(),
  // Shared by all rows of one order submission (see tickets.idempotencyKey).
  idempotencyKey: varchar("idempotency_key", { length: 64 }),
});

// ─── COFFEE NOTE (owner's decision, Sept 2026) ──────────────────────────────
// The buna makers also sell traditional coffee OUTDOOR (gate, parking, the
// offices next door) and they do not watch their phones, so those sales must
// never enter the station queues — an outdoor buna order would sit "pending"
// forever. Instead the cashier holds each call here as a numbered note:
//
//   call comes in → Add New (item defaults to Buna, +/− amount, place note)
//   → HOLD → the note waits in the Coffee Note page (invisible to the normal
//   outdoor orders list and to every station screen)
//   → the buna maker settles up → the cashier taps PAID → only THEN is a real
//   outdoor ticket created, straight into order history with the Outdoor
//   corner badge. It is born paid/done, so no station ever sees it.
export const bunaNotes = pgTable("buna_notes", {
  id: serial("id").primaryKey(),
  /** Daily note number shown in the list (1, 2, 3… restarts each day). */
  seq: integer("seq").notNull().default(1),
  /** The menu item this note is for (server-side price authority). */
  menuItemId: integer("menu_item_id"),
  /** Item name snapshot at hold time (default "Buna"). */
  itemName: varchar("item_name", { length: 200 }).notNull(),
  /** Menu price snapshot at hold time. */
  unitPrice: integer("unit_price").notNull().default(0),
  quantity: integer("quantity").notNull().default(1),
  /** "Place" — where it went: gate, office, white car, Ahmed… */
  placeNote: varchar("place_note", { length: 200 }),
  /** Cashier who took the call and held the note. */
  heldBy: varchar("held_by", { length: 100 }),
  heldAt: timestamp("held_at").defaultNow(),
  /** Null = still on hold. Set the moment the cashier taps PAID. */
  paidAt: timestamp("paid_at"),
  paidBy: varchar("paid_by", { length: 100 }),
  /** The outdoor ticket created at payment (the order-history link). */
  ticketId: integer("ticket_id"),
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

// ─── WEB PUSH ("POCKET MODE") ───────────────────────────────────────────────
// One row per staff DEVICE that asked for system notifications. The waiter's
// phone is in her pocket with the browser closed — Web Push is the only way to
// reach it. Role + name come from the staff SESSION (server-side), never from
// the client, so a logged-in waiter can only subscribe AS a waiter.
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: serial("id").primaryKey(),
  endpoint: text("endpoint").notNull(), // push service URL (unique)
  p256dh: text("p256dh").notNull(), // client public key
  auth: text("auth").notNull(), // client auth secret
  role: varchar("role", { length: 20 }).notNull(), // waiter | cashier | kitchen | barista
  name: varchar("name", { length: 100 }), // which staff member's device
  createdAt: timestamp("created_at").defaultNow(),
});
