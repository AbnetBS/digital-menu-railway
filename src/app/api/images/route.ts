import { NextResponse } from "next/server";
import { db } from "@/db";
import { ensureTablesExist } from "@/db/migrate";
import { sql } from "drizzle-orm";

/**
 * Photo upload endpoint — SAME database (no external signup, zero new provider).
 * POST { dataUrl }: stores the compressed photo inside cdn_images and returns a
 * short self-hosted URL `/api/images/{id}` that browsers fetch ONCE permanently
 * (immutable cache). JSON payloads from this moment carry ~60-char URLs, never photos.
 */
export async function POST(request: Request) {
  await ensureTablesExist(true);
  try {
    const body = await request.json();
    const dataUrl = String(body.dataUrl || "");
    if (!dataUrl.startsWith("data:")) {
      return NextResponse.json({ error: "dataUrl required" }, { status: 400 });
    }

    const mimeMatch = dataUrl.match(/^data:([^;]+);base64,/);
    const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";

    const inserted = await db.execute(
      sql`INSERT INTO cdn_images (mime_type, data, created_at) VALUES (${mime}, ${dataUrl}, now()) RETURNING id`
    );

    // drizzle/node-postgres rows accomodated via .rows or as array depending on driver
    const rows = (inserted as unknown as { rows: Array<{ id: number }> }).rows ?? (inserted as unknown as Array<{ id: number }>);
    const id = rows[0]?.id;

    return NextResponse.json({ url: `/api/images/${id}` });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
