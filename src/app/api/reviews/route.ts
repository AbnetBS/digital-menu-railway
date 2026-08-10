import { NextResponse } from "next/server";
import { db } from "@/db";
import { reviews } from "@/db/schema";
import { ensureDbSeeded, invalidateDbSeeded } from "@/lib/seed-db";
import { ensureTablesExist } from "@/db/migrate";
import { eq, desc } from "drizzle-orm";
import { PUBLIC_CACHE_CONTROL } from "@/lib/cache";

export async function GET(request: Request) {
  await ensureTablesExist();
  await ensureDbSeeded();
  try {
    // GROUP 4 / ITEM 3 — bound the public payload. Reviews grow with every
    // customer submission; the homepage/menu pages only show recent approved
    // ones, so the default is the newest 100. The admin moderation screen
    // passes ?all=1 to see the full list (rare, on-demand).
    const { searchParams } = new URL(request.url);
    const all = searchParams.get("all") === "1";
    const limit = Math.min(1000, Math.max(1, Number(searchParams.get("limit") || 100)));
    const list = await db
      .select()
      .from(reviews)
      .orderBy(desc(reviews.createdAt))
      .limit(all ? 1000 : limit);
    return NextResponse.json(list, { status: 200, headers: { "Cache-Control": PUBLIC_CACHE_CONTROL } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  await ensureTablesExist();
  try {
    const body = await request.json();
    if (!body.customerName || !body.rating || !body.reviewText) {
      return NextResponse.json({ error: "Name, rating and review text required" }, { status: 400 });
    }

    const todayStr = new Date().toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

    const newRev = await db
      .insert(reviews)
      .values({
        customerName: body.customerName,
        rating: Number(body.rating),
        reviewText: body.reviewText,
        reviewDate: todayStr,
        isApproved: false, // pending admin approval before public display
        isVerified: true,
      })
      .returning();

    return NextResponse.json(newRev[0]);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  await ensureTablesExist();
  try {
    const body = await request.json();
    if (!body.id) {
      return NextResponse.json({ error: "Review ID required" }, { status: 400 });
    }

    const updated = await db
      .update(reviews)
      .set({
        isApproved: Boolean(body.isApproved),
        customerName: body.customerName,
        rating: Number(body.rating),
        reviewText: body.reviewText,
      })
      .where(eq(reviews.id, body.id))
      .returning();

    return NextResponse.json(updated[0]);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  await ensureTablesExist();
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "ID required" }, { status: 400 });
    }
    await db.delete(reviews).where(eq(reviews.id, Number(id)));
    invalidateDbSeeded(); // table may now be empty → self-heal on next read
    return NextResponse.json({ success: true, id: Number(id) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
