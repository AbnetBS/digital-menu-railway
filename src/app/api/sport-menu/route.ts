import { NextResponse } from "next/server";
import { pool } from "@/db";
import { ensureTablesExist } from "@/db/migrate";
import { readAdminSession, requireAdmin, requireStaffOrAdmin } from "@/lib/session";
import { effectivePrice } from "@/lib/price";
import {
  SPORT_MENU_NAME,
  parseSportCategories,
  parseSportPrices,
  sportCategoryName,
  sportMenuFromRow,
  type SportMenu,
  type SportMenuRow,
  type SportPrice,
} from "@/lib/sport-menu";

/**
 * THE SPORT MENU API (owner, 2026-11-07).
 *
 *   GET    the active sport menu + the whole menu with each item's normal and
 *          match-day price, for the waiter's Sport view. A waiter may read it
 *          (he has to see the price he is charging); a guest never can.
 *   POST   the owner's edits: add a category, set one item's price, set a whole
 *          category at once, remove a category, switch the menu on or off.
 *
 * The ordinary menu, the QR page and the customer checkout never read this
 * table. On a match day a waiter picks Sport in his composer, and the ticket
 * API re-reads the same sport row to write the line prices (see applySportPrices
 * in /api/tickets), so the number on the bill is never the phone's word.
 */

const money = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const toPrice = (n: unknown): number | null => {
  if (n === null || n === undefined || n === "") return null;
  const value = Number(String(n).replace(/,/g, ""));
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) return null;
  return money(value);
};

/** The active sport menu, or the most recent one when none is switched on. */
async function loadSportMenu(activeOnly: boolean): Promise<SportMenu | null> {
  const q = await pool.query<SportMenuRow>(
    activeOnly
      ? "SELECT id,name,active,categories,prices,created_at,updated_at FROM sport_menus WHERE active = true ORDER BY id DESC LIMIT 1"
      : "SELECT id,name,active,categories,prices,created_at,updated_at FROM sport_menus ORDER BY active DESC, id DESC LIMIT 1"
  );
  return q.rows[0] ? sportMenuFromRow(q.rows[0]) : null;
}

/** Create the one sport menu when the owner edits before it exists. */
async function ensureSportMenu(): Promise<SportMenu> {
  const existing = await loadSportMenu(false);
  if (existing) return existing;
  const inserted = await pool.query<SportMenuRow>(
    "INSERT INTO sport_menus(name,active,categories,prices) VALUES($1,true,'[]'::jsonb,'[]'::jsonb) RETURNING id,name,active,categories,prices,created_at,updated_at",
    [SPORT_MENU_NAME]
  );
  return sportMenuFromRow(inserted.rows[0]);
}

async function saveSportMenu(id: number, categories: string[], prices: SportPrice[], active?: boolean): Promise<SportMenu> {
  const q = await pool.query<SportMenuRow>(
    `UPDATE sport_menus
        SET categories = $2::jsonb, prices = $3::jsonb, active = COALESCE($4, active), updated_at = now()
      WHERE id = $1
      RETURNING id,name,active,categories,prices,created_at,updated_at`,
    [id, JSON.stringify(categories), JSON.stringify(prices), active === undefined ? null : active]
  );
  return sportMenuFromRow(q.rows[0]);
}

/** The whole menu with both prices, which is what the Sport view draws. */
async function catalogWithPrices(menu: SportMenu | null) {
  const [items, categories] = await Promise.all([
    pool.query<{ id: number; name: string; category: string; price: number; sale_price: number | null; sale_start: string | null; sale_end: string | null; is_available: boolean }>(
      "SELECT id,name,category,price,sale_price,sale_start,sale_end,is_available FROM menu_items ORDER BY sort_order,id"
    ),
    pool.query<{ id: number; name: string; slug: string }>("SELECT id,name,slug FROM categories ORDER BY sort_order,id"),
  ]);
  const typed = new Map((menu?.prices || []).map((price) => [price.menuItemId, price.sportPrice]));
  const added = new Set(menu?.categories || []);
  return {
    categories: categories.rows.map((c) => ({ id: Number(c.id), name: String(c.name), slug: String(c.slug) })),
    items: items.rows.map((item) => {
      const normal = effectivePrice({
        price: item.price,
        salePrice: item.sale_price,
        saleStart: item.sale_start,
        saleEnd: item.sale_end,
      }).price;
      return {
        id: Number(item.id),
        name: String(item.name),
        category: String(item.category),
        isAvailable: item.is_available !== false,
        regularPrice: money(normal),
        sportPrice: typed.has(Number(item.id)) ? money(typed.get(Number(item.id))) : null,
        categoryAdded: added.has(String(item.category)),
      };
    }),
  };
}

export async function GET(request: Request) {
  // A waiter reads the prices he charges; the owner reads them to edit. The
  // public menu and the QR checkout never reach this route.
  const auth = await requireStaffOrAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  const scope = new URL(request.url).searchParams.get("scope");
  try {
    const menu = await loadSportMenu(scope === "admin" ? false : true);
    const catalog = await catalogWithPrices(menu);
    // `canEdit` lets the sheet show the owner's editor on his own device and
    // the read-only price list on a waiter's phone, without a probe write.
    const who = await readAdminSession();
    return NextResponse.json({ menu, ...catalog, canEdit: Boolean(who), serverTime: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  await ensureTablesExist();
  const body = await request.json().catch(() => ({}));
  const action = String(body.action || "");

  try {
    const menu = await ensureSportMenu();
    const categories = [...menu.categories];
    let prices = [...menu.prices];
    let active: boolean | undefined;

    if (action === "add_category") {
      const slug = String(body.category || "").trim();
      if (!slug) throw new Error("Choose the category first");
      const exists = await pool.query("SELECT 1 FROM categories WHERE slug=$1", [slug]);
      if (exists.rows.length === 0) throw new Error("That category is not in the menu");
      if (!categories.includes(slug)) categories.push(slug);
    } else if (action === "remove_category") {
      const slug = String(body.category || "").trim();
      const at = categories.indexOf(slug);
      if (at >= 0) categories.splice(at, 1);
      // Its typed prices go with it: the ordinary menu price applies again.
      prices = prices.filter((price) => price.category !== slug);
    } else if (action === "set_price") {
      const menuItemId = Number(body.menuItemId);
      const sportPrice = toPrice(body.sportPrice);
      if (!Number.isInteger(menuItemId) || menuItemId < 1) throw new Error("Menu item required");
      if (sportPrice === null) throw new Error("Type the match-day price as a number");
      const item = await pool.query<{ category: string; price: number }>(
        "SELECT category,price FROM menu_items WHERE id=$1",
        [menuItemId]
      );
      if (!item.rows[0]) throw new Error("That item is no longer on the menu");
      const slug = String(item.rows[0].category);
      // Setting a price on an item of a category the owner opened from the
      // catalogue (rather than the picker) adds the category too, so the price
      // can never be saved somewhere the Sport view would not use it.
      if (!categories.includes(slug)) categories.push(slug);
      prices = prices.filter((price) => price.menuItemId !== menuItemId);
      prices.push({
        menuItemId,
        regularPrice: Math.max(0, Math.round(Number(item.rows[0].price) || 0)),
        sportPrice: Math.round(sportPrice),
        category: slug,
      });
    } else if (action === "clear_price") {
      const menuItemId = Number(body.menuItemId);
      if (!Number.isInteger(menuItemId) || menuItemId < 1) throw new Error("Menu item required");
      prices = prices.filter((price) => price.menuItemId !== menuItemId);
    } else if (action === "set_category_prices") {
      // One save for a whole category: the price box in the "add category"
      // panel can raise everything at once, and the per-item boxes still win
      // afterwards if the owner tweaks one drink.
      const slug = String(body.category || "").trim();
      const rows = Array.isArray(body.rows) ? (body.rows as Array<Record<string, unknown>>) : [];
      if (!slug) throw new Error("Category required");
      if (!categories.includes(slug)) categories.push(slug);
      for (const row of rows) {
        const menuItemId = Number(row.menuItemId);
        if (!Number.isInteger(menuItemId) || menuItemId < 1) continue;
        const price = toPrice(row.sportPrice);
        if (price === null) continue;
        const item = await pool.query<{ category: string }>("SELECT category FROM menu_items WHERE id=$1", [menuItemId]);
        prices = prices.filter((existing) => existing.menuItemId !== menuItemId);
        prices.push({
          menuItemId,
          regularPrice: Math.max(0, Math.round(Number(row.regularPrice) || 0)),
          sportPrice: Math.round(price),
          category: String(item.rows[0]?.category || slug),
        });
      }
    } else if (action === "set_active") {
      active = Boolean(body.active);
    } else if (action === "rename") {
      const name = String(body.name || "").trim();
      if (!name) throw new Error("Give the menu a name");
      await pool.query("UPDATE sport_menus SET name=$1, updated_at=now() WHERE id=$2", [name.slice(0, 80), menu.id]);
    } else if (action === "create") {
      // A fresh list (a different match day) without losing the last one.
      const inserted = await pool.query<SportMenuRow>(
        "INSERT INTO sport_menus(name,active,categories,prices) VALUES($1,true,'[]'::jsonb,'[]'::jsonb) RETURNING id,name,active,categories,prices,created_at,updated_at",
        [String(body.name || SPORT_MENU_NAME).slice(0, 80)]
      );
      const created = sportMenuFromRow(inserted.rows[0]);
      const catalog = await catalogWithPrices(created);
      return NextResponse.json({ success: true, menu: created, ...catalog });
    } else {
      throw new Error("Unknown sport menu action");
    }

    const saved = await saveSportMenu(menu.id, parseSportCategories(categories), parseSportPrices(prices), active);
    await pool.query("INSERT INTO payroll_audit(period_key,action,detail) VALUES('sport', $1, $2::jsonb)", [
      `sport_${action}`,
      JSON.stringify({ menuId: saved.id, categories: saved.categories.length, prices: saved.prices.length, active: saved.active }),
    ]);
    const catalog = await catalogWithPrices(saved);
    return NextResponse.json({
      success: true,
      menu: saved,
      ...catalog,
      message:
        action === "add_category"
          ? `${sportCategoryName(catalog.categories, String(body.category || ""))} added. Type the match-day price for each item.`
          : action === "remove_category"
            ? "Category removed. Its items are back to the normal price."
            : action === "set_active"
              ? active
                ? "Sport prices are on. Waiters charging from Sport now use them."
                : "Sport prices are off. Every item is back to the normal price."
              : "Sport menu saved.",
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
