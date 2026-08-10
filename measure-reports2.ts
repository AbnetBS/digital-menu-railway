/**
 * ITEM 2 measurement (fixed stub — snake_case like real pg).
 * Synthetic 30-day history: 9,000 tickets (300/day), 3 items each = 27,000 items.
 * ~300 of those tickets are "today" (revenue).
 */
import { Pool } from "pg";

let stmts: string[] = [];
let rowsPerStmt: number[] = [];
const orig = Pool.prototype.query as any;

function genTickets(n: number, now: Date) {
  return Array.from({ length: n }, (_, i) => {
    // ~300 per day across 30 days → hours 0..720
    const ageHours = i * (720 / n); // spread over 30 days
    const d = new Date(now.getTime() - ageHours * 3600e3);
    const status = i % 4 === 0 ? "cancelled" : i % 4 === 1 ? "confirmed" : "paid";
    return {
      id: i + 1, table_id: (i % 40) + 1, table_name: `Table ${(i % 40) + 1}`,
      status, payment_method: "cash", payment_status: status === "paid" ? "paid_cash" : "unpaid",
      receipt_image: i % 10 === 0 ? "data:image/jpeg;base64,xxxx" : null,
      total_amount: 120 + (i % 50) * 10, created_by: "Waiter",
      closed_at: d.toISOString(), created_at: d.toISOString(), updated_at: d.toISOString(),
      order_number: `FANA-${i + 1}`, idempotency_key: null,
    };
  });
}
function genItems(tickets: number[]) {
  const rows: any[] = [];
  for (const tid of tickets) for (let k = 0; k < 3; k++) {
    rows.push({ id: tid * 10 + k, ticket_id: tid, menu_item_id: k + 1, name: `Item ${k % 8 + 1}`, category: ["coffee", "food", "juice"][k % 3], price: 45 + k * 10, quantity: 1, notes: "", removed: false, station_name: k % 2 ? "kitchen" : "barista", station_status: "done", created_at: new Date().toISOString(), idempotency_key: null });
  }
  return rows;
}

Pool.prototype.query = function (this: any, text: unknown) {
  const sql = typeof text === "string" ? text : (text as { text?: string })?.text || "";
  stmts.push(sql);
  if (/from "tickets"/.test(sql)) {
    const rows = genTickets(9000, new Date());
    rowsPerStmt.push(rows.length);
    return Promise.resolve({ rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] });
  }
  if (/from "ticket_items"/.test(sql)) {
    // items query is scoped with IN (...); extract ids from the stub's parameterized
    // values is not possible here, so generate items for ALL 9000 (worst case for
    // before) — for after, the route only issues the query with a small id list,
    // so we approximate by generating for as many ids as we can't know: use the
    // values array when provided.
    const values = (arguments.length > 1 ? arguments[1] : undefined) as unknown[] | undefined;
    const ids = (values || []).filter((v): v is number => typeof v === "number");
    const rows = genItems(ids.length > 0 ? ids : Array.from({ length: 9000 }, (_, i) => i + 1));
    rowsPerStmt.push(rows.length);
    return Promise.resolve({ rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] });
  }
  if (/from "categories"/.test(sql)) {
    const rows = [{ id: 1, name: "Coffee", slug: "coffee", icon: "Coffee", sort_order: 1 }, { id: 2, name: "All Items", slug: "all", icon: "Utensils", sort_order: 0 }];
    rowsPerStmt.push(rows.length);
    return Promise.resolve({ rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] });
  }
  return Promise.resolve({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] });
};

async function main() {
  (globalThis as any).__fanaMigrateDone = true;
  const route = await import("./src/app/api/reports/route");
  stmts = []; rowsPerStmt = [];
  const res = await route.GET();
  const body = await res.json();
  const totalRows = rowsPerStmt.reduce((a, b) => a + b, 0);
  const itemStmts = stmts.map((s, i) => (/from "ticket_items"/.test(s) ? rowsPerStmt[i] : 0));
  const itemRows = itemStmts.reduce((a, b) => a + b, 0);
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  console.log("STATEMENTS:", stmts.length, "| item queries:", itemStmts.filter((r) => true).length, "| item rows read:", itemRows);
  console.log("TOTAL ROWS READ:", totalRows);
  console.log("RESPONSE:", (bytes / 1024).toFixed(1), "KB | todayOrders:", body.todayOrders, "| history:", body.orderHistory?.length, "| popular:", body.popularItems?.length, "| ERROR:", body.error || "none");
}
main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
