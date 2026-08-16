import { NextResponse } from "next/server";
import { db } from "@/db";
import { tickets } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireStaffOrAdmin } from "@/lib/session";

/**
 * Lightweight: fetch ONLY the receipt photo for a specific order (on-demand when someone clicks "View Receipt").
 * Prevents receipt photos from re-transferring on every polling cycle.
 */
export async function GET(request: Request) {
  const __auth = await requireStaffOrAdmin();
  if (!__auth.ok) return __auth.response;
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });
  const rows = await db.select({ receiptImage: tickets.receiptImage }).from(tickets).where(eq(tickets.id, Number(id)));
  return NextResponse.json({ receiptImage: rows[0]?.receiptImage ?? null })
    .headers.set("Cache-Control", "public, max-age=31536000, immutable");
}
