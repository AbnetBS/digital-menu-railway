import { NextResponse } from "next/server";
import { ensureDbSeeded } from "@/lib/seed-db";
import { ensureTablesExist } from "@/db/migrate";

export async function GET() {
  await ensureTablesExist();
  const result = await ensureDbSeeded();
  if (result.success) {
    return NextResponse.json({ status: "success", message: "Database initialized successfully" });
  }
  return NextResponse.json({ status: "error", error: result.error }, { status: 500 });
}

export async function POST() {
  await ensureTablesExist();
  const result = await ensureDbSeeded();
  return NextResponse.json(result);
}
