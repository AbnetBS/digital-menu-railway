import { NextResponse } from "next/server";
import { deviceAllowed } from "@/lib/attendance-device";

export const dynamic = "force-dynamic";

/** A fallback for a reader whose first NTP sync is blocked but whose website
 * connection works. The device estimates round-trip uncertainty and still
 * retains unresolvable previous-boot scans for manual review. */
export async function GET(request: Request) {
  if (!deviceAllowed(request)) {
    return NextResponse.json({ error: "Attendance device authorization required" }, { status: 401 });
  }
  const now = Date.now();
  return NextResponse.json(
    { service: "fana-attendance-time-v1", epochSeconds: Math.floor(now / 1000), millisecond: now % 1000 },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
