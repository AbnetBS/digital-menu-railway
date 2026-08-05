import { NextResponse } from "next/server";
import { db } from "@/db";
import { reviews } from "@/db/schema";
import { ensureDbSeeded } from "@/lib/seed-db";
import { ensureTablesExist } from "@/db/migrate";
import { eq, desc } from "drizzle-orm";

export async function GET() {
  await ensureTablesExist();
  await ensureDbSeeded();
  try {
    const list = await db.select().from(reviews).orderBy(desc(reviews.createdAt));
    return NextResponse.json(list);
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
    return NextResponse.json({ success: true, id: Number(id) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
