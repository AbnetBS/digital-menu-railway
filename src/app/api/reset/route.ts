import { NextResponse } from "next/server";
import { db } from "@/db";
import { tickets, ticketItems, menuItems, announcements, galleryItems, cafeTables, siteSettings } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { DEFAULT_TABLES } from "@/lib/initial-data";
import { eq } from "drizzle-orm";
import { deleteOrphanedCdnImages } from "@/lib/image-store";
import { publish, CHANNELS } from "@/lib/realtime";
import { requireAdmin } from "@/lib/session";

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
  const __auth = await requireAdmin();
  if (!__auth.ok) return __auth.response;
  await ensureTablesExist();
  try {
    const { action } = await request.json();

    // Each reset action sets the matching *_reset_flag so the explicit seed
    // (/api/setup, /api/seed) never restores data the owner intentionally cleared.

    switch (action) {
      case "orders": {
        // Clears ALL bills + items + payment receipts → reports go back to 0
        const receiptRefs = await db.select({ receiptImage: tickets.receiptImage }).from(tickets);
        await db.delete(ticketItems);
        await db.delete(tickets);
        await deleteOrphanedCdnImages(receiptRefs.map((t) => t.receiptImage));
        publish(CHANNELS.orders);
        return NextResponse.json({ success: true, message: "All orders, bills & receipt photos deleted. Reports reset to 0." });
      }

      case "menu": {
        // Clears every menu item (names + photos + prices + sale rules) → owner re-adds real menu
        const imageRefs = await db.select({ imageUrl: menuItems.imageUrl }).from(menuItems);
        await db.delete(menuItems);
        await setFlag("menu_reset_flag", "on"); // block the demo seed from restoring test dishes
        await deleteOrphanedCdnImages(imageRefs.map((m) => m.imageUrl));
        publish(CHANNELS.orders);
        return NextResponse.json({ success: true, message: "All menu items & their photos deleted. Menu is now empty for your real dishes." });
      }

      case "announcements": {
        const imageRefs = await db.select({ imageUrl: announcements.imageUrl }).from(announcements);
        await db.delete(announcements);
        await setFlag("announcements_reset_flag", "on");
        await deleteOrphanedCdnImages(imageRefs.map((a) => a.imageUrl));
        publish(CHANNELS.orders);
        return NextResponse.json({ success: true, message: "All Daily Board announcements deleted." });
      }

      case "gallery": {
        const imageRefs = await db.select({ imageUrl: galleryItems.imageUrl }).from(galleryItems);
        await db.delete(galleryItems);
        await setFlag("gallery_reset_flag", "on");
        await deleteOrphanedCdnImages(imageRefs.map((g) => g.imageUrl));
        publish(CHANNELS.orders);
        return NextResponse.json({ success: true, message: "All gallery photos deleted." });
      }

      case "tables": {
        // Fresh 1-10 tables (also removes any dangling bills they carry)
        const receiptRefs = await db.select({ receiptImage: tickets.receiptImage }).from(tickets);
        await db.delete(ticketItems);
        await db.delete(tickets);
        await db.delete(cafeTables);
        await db.insert(cafeTables).values(DEFAULT_TABLES);
        await deleteOrphanedCdnImages(receiptRefs.map((t) => t.receiptImage));
        publish(CHANNELS.orders);
        return NextResponse.json({ success: true, message: "Tables reset to the 10 default tables." });
      }

      default:
        return NextResponse.json({ error: "Unknown reset action" }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
