/**
 * ITEM 2 measurement — /api/reports row-read comparison.
 * Stub returns realistic synthetic rows (9,000 tickets / 27,000 items over 30 days,
 * ~300 today) and counts rows read per query + statements.
 */
import { Pool } from "pg";

let rowsRead: number[] = []; // per-statement rows
let stmts: string[] = [];
const orig = Pool.prototype.query as any;

function genTickets(n: number, now: Date) {
  return Array.from({ length: n }, (_, i) => {
    const ageHours = (i % 720) * 0.5; // 0..~15 days
    const d = new Date(now.getTime() - ageHours * 3600e3);
    const status = i % 4 === 0 ? "cancelled" : i % 4 === 1 ? "confirmed" : "paid";
    return {
      id: i + 1, tableId: (i % 40) + 1, tableName: `Table ${(i % 40) + 1}`,
      status, paymentMethod: "cash", paymentStatus: status === "paid" ? "paid_cash" : "unpaid",
      receiptImage: i % 10 === 0 ? "data:image/jpeg;base64,xxxx" : null,
      totalAmount: 120 + (i % 50) * 10, createdBy: "Waiter",
      closedAt: d.toISOString(), createdAt: d.toISOString(), updatedAt: d.toISOString(),
      orderNumber: `FANA-${i + 1}`, idempotencyKey: null,
    };
  });
}
function genItems(tickets: Array<{ id: number }>, per = 3) {
  const rows: any[] = [];
  for (const t of tickets) for (let k = 0; k < per; k++) {
    rows.push({ id: t.id * 10 + k, ticketId: t.id, menuItemId: k + 1, name: `Item ${k % 8 + 1}`, category: ["coffee", "food", "juice"][k % 3], price: 45 + k * 10, quantity: 1, notes: "", removed: false, stationName: k % 2 ? "kitchen" : "barista", stationStatus: "done", createdAt: new Date().toISOString(), idempotencyKey: null });
  }
  return rows;
}

Pool.prototype.query = function (this: any, text: unknown) {
  const sql = typeof text === "string" ? text : (text as { text?: string })?.text || "";
  stmts.push(sql);
  if (/from "tickets"/.test(sql)) {
    const rows = genTickets(9000, new Date());
    rowsRead.push(rows.length);
    return Promise.resolve({ rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] });
  }
  if (/from "ticket_items"/.test(sql)) {
    const rows = genItems(Array.from({ length: 9000 }, (_, i) => ({ id: i + 1 })), 3);
    rowsRead.push(rows.length);
    return Promise.resolve({ rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] });
  }
  if (/from "categories"/.test(sql)) {
    const rows = [{ id: 1, name: "Coffee", slug: "coffee", icon: "Coffee", sortOrder: 1 }, { id: 2, name: "All Items", slug: "all", icon: "Utensils", sortOrder: 0 }];
    rowsRead.push(rows.length);
    return Promise.resolve({ rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] });
  }
  return Promise.resolve({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] });
};

async function main() {
  (globalThis as any).__fanaMigrateDone = true;
  const route = await import("./src/app/api/reports/route");
  stmts = []; rowsRead = [];
  const res = await route.GET();
  const body = await res.json();
  const totalRows = rowsRead.reduce((a, b) => a + b, 0);
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  console.log("STATEMENTS:", stmts.length, "| item-statements:", stmts.filter((s) => /from "ticket_items"/.test(s)).length);
  console.log("ROWS READ:", totalRows, "(tickets:", rowsRead[0], "+ items:", rowsRead.filter((_, i) => /from "ticket_items"/.test(stmts[i])).reduce((a, b) => a + b, 0), ")");
  console.log("RESPONSE:", (bytes / 1024).toFixed(1), "KB | history tickets:", body.orderHistory?.length, "| popular:", body.popularItems?.length);
}
main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
