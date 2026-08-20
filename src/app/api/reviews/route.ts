import { NextResponse } from "next/server";
import { db } from "@/db";
import { reviews } from "@/db/schema";
import { ensureTablesExist } from "@/db/migrate";
import { eq, desc } from "drizzle-orm";
import { PUBLIC_CACHE_CONTROL } from "@/lib/cache";
import { requireAdmin, readAdminSession } from "@/lib/session";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

const REVIEW_LIMIT = 5;
const REVIEW_WINDOW_MS = 60 * 60 * 1000;

export async function GET(request: Request) {
  await ensureTablesExist();
  try {
    // Only approved reviews are public. Unapproved reviews are pending
    // moderation and must never be served to unauthenticated callers (they may
    // contain private/unwanted content the owner has not yet chosen to publish).
    // The admin moderation screen is authenticated and passes ?all=1 to see the
    // full list, including pending reviews.
    const admin = await readAdminSession();
    const { searchParams } = new URL(request.url);
    const all = admin ? searchParams.get("all") === "1" : false;
    const limit = Math.min(1000, Math.max(1, Number(searchParams.get("limit") || 100)));

    // Public callers only ever see approved reviews; admins may see the full
    // list (including pending) for moderation.
    const list = admin
      ? await db.select().from(reviews).orderBy(desc(reviews.createdAt)).limit(all ? 1000 : limit)
      : await db.select().from(reviews).where(eq(reviews.isApproved, true)).orderBy(desc(reviews.createdAt)).limit(limit);
    return NextResponse.json(list, { status: 200, headers: { "Cache-Control": PUBLIC_CACHE_CONTROL } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const rl = checkRateLimit(`review-submit:${getClientIp(request)}`, REVIEW_LIMIT, REVIEW_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many review submissions. Please try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } }
    );
  }

  await ensureTablesExist();
  try {
    const body = await request.json();

    // Validate the star rating server-side: it must be an integer from 1 to 5.
    const rating = Number(body.rating);
    if (!Number.isFinite(rating) || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      return NextResponse.json({ error: "Rating must be a whole number from 1 to 5" }, { status: 400 });
    }

    // Bound name and text so an unauthenticated client cannot store arbitrarily
    // large rows (customer_name is varchar(100); review_text is unbounded text).
    const customerName = String(body.customerName || "").trim().slice(0, 100);
    const reviewText = String(body.reviewText || "").trim().slice(0, 2000);
    if (!customerName || !reviewText) {
      return NextResponse.json({ error: "Name and review text required" }, { status: 400 });
    }

    const todayStr = new Date().toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

    const newRev = await db
      .insert(reviews)
      .values({
        customerName,
        rating,
        reviewText,
        reviewDate: todayStr,
        isApproved: false, // pending admin approval before public display
        isVerified: true,
      })
      .returning();

    return NextResponse.json(newRev[0]);
  } catch (error) {
    // Customer-facing endpoint: don't leak raw DB errors to guests.
    console.error("[reviews POST] review submission failed:", error);
    return NextResponse.json({ error: "Couldn't submit right now. Please tell a waiter." }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const __auth = await requireAdmin();
  if (!__auth.ok) return __auth.response;
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
  const __auth = await requireAdmin();
  if (!__auth.ok) return __auth.response;
  await ensureTablesExist();
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "ID required" }, { status: 400 });
    }
    await db.delete(reviews).where(eq(reviews.id, Number(id)));
    return NextResponse.json({ success: true, id: Number(id) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
