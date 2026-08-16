import { NextResponse } from "next/server";
import { readAdminSession, ADMIN_COOKIE } from "@/lib/session";

export async function GET() {
  const session = await readAdminSession();
  if (session) {
    return NextResponse.json({ authenticated: true });
  }
  return NextResponse.json({ authenticated: false }, { status: 401 });
}

export async function DELETE() {
  const response = NextResponse.json({ success: true, message: "Logged out" });
  response.cookies.delete(ADMIN_COOKIE);
  return response;
}
