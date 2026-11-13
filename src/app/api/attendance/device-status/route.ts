import { NextResponse } from "next/server";
import { requireStaffOrAdmin } from "@/lib/session";
import { getScannerStatus } from "@/lib/scanner-status";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
};

/**
 * GET /api/attendance/device-status
 *
 * Returns real-time Online / Offline reachability of the ESP32 door scanner so
 * the Admin Attendance header can show whether finger scans placed right now
 * will immediately reach the page (`Online`) or queue locally until Wi-Fi
 * returns (`Offline`).
 */
export async function GET() {
  const auth = await requireStaffOrAdmin();
  if (!auth.ok) return auth.response;

  const status = await getScannerStatus();
  return NextResponse.json(status, { headers: NO_STORE_HEADERS });
}
