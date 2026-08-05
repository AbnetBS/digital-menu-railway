import { MenuItem } from "@/types";

/**
 * Automatic scheduled sale pricing.
 * If a sale_price exists AND today is inside [sale_start, sale_end],
 * the sale price is used everywhere (menu, cart, waiter) — otherwise the
 * normal price is used. When the end date passes it automatically reverts;
 * the owner never has to remember to switch it back.
 */
export function effectivePrice(item: Partial<MenuItem>): { price: number; onSale: boolean; savings: number } {
  const base = Number(item.price || 0);
  const sp = item.salePrice ? Number(item.salePrice) : 0;
  if (!sp || sp >= base) return { price: base, onSale: false, savings: 0 };

  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  if (item.saleStart && today < String(item.saleStart)) return { price: base, onSale: false, savings: 0 };
  if (item.saleEnd && today > String(item.saleEnd)) return { price: base, onSale: false, savings: 0 };

  return { price: sp, onSale: true, savings: base - sp };
}
