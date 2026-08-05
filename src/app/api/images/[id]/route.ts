import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";

/**
 * Serve ONE photo by ID — the browser caches it FOREVER (immutable).
 * This is what kills the repeated base64 flood: photo transfers once per device, never again.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const numId = Number(id);
    if (!numId) return NextResponse.json({ error: "Invalid image id" }, { status: 400 });

    const rows = await db.execute(
      sql`SELECT mime_type, data FROM cdn_images WHERE id = ${numId} LIMIT 1`
    );

    const list = (rows as unknown as { rows: Array<{ mime_type: string; data: string }> }).rows ?? (rows as unknown as Array<{ mime_type: string; data: string }>);
    const row = list[0];
    if (!row?.data) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const base64 = row.data.includes(",") ? row.data.split(",")[1] : row.data;
    const buffer = Buffer.from(base64, "base64");

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": row.mime_type || "image/jpeg",
        "Content-Length": String(buffer.length),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
