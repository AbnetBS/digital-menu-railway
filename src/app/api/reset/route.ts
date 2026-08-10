import { NextResponse } from "next/server";
import { db } from "@/db";
import { tickets, ticketItems, menuItems, announcements, galleryItems, cafeTables, siteSettings } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { invalidateDbSeeded } from "@/lib/seed-db";
import { DEFAULT_TABLES } from "@/lib/initial-data";
import { eq } from "drizzle-orm";

async function setFlag(key: string, value: string) {
  const rows = await db.select().from(siteSettings).where(eq(siteSettings.key, key));
  if (rows.length > 0) {
    await db.update(siteSettings).set({ value }).where(eq(siteSettings.key, key));
  } else {
    await db.insert(siteSettings).values({ key, value });
  }
}

/**
 * POST /api/reset — Admin-only "Factory Reset" operations.
 * Body: { action: "orders" | "menu" | "announcements" | "gallery" | "tables" }
 * Used ONCE before go-live to clear all test data so the cafe starts from a clean zero.
 */
export async function POST(request: Request) {
  await ensureTablesExist();
  try {
    const { action } = await request.json();

    // Tables may have been emptied → let the seed memo re-run on the next read
    // (it respects the *_reset_flag settings this route sets).
    invalidateDbSeeded();

    switch (action) {
      case "orders": {
        // Clears ALL bills + items + payment receipts → reports go back to 0
        await db.delete(ticketItems);
        await db.delete(tickets);
        return NextResponse.json({ success: true, message: "All orders, bills & receipt photos deleted. Reports reset to 0." });
      }

      case "menu": {
        // Clears every menu item (names + photos + prices + sale rules) → owner re-adds real menu
        await db.delete(menuItems);
        await setFlag("menu_reset_flag", "on"); // block the demo seed from restoring test dishes
        return NextResponse.json({ success: true, message: "All menu items & their photos deleted. Menu is now empty for your real dishes." });
      }

      case "announcements": {
        await db.delete(announcements);
        await setFlag("announcements_reset_flag", "on");
        return NextResponse.json({ success: true, message: "All Daily Board announcements deleted." });
      }

      case "gallery": {
        await db.delete(galleryItems);
        await setFlag("gallery_reset_flag", "on");
        return NextResponse.json({ success: true, message: "All gallery photos deleted." });
      }

      case "tables": {
        // Fresh 1-10 tables (also removes any dangling bills they carry)
        await db.delete(ticketItems);
        await db.delete(tickets);
        await db.delete(cafeTables);
        await db.insert(cafeTables).values(DEFAULT_TABLES);
        return NextResponse.json({ success: true, message: "Tables reset to the 10 default tables." });
      }

      default:
        return NextResponse.json({ error: "Unknown reset action" }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
