import { NextResponse } from "next/server";
import { subscribe, CHANNELS } from "@/lib/realtime";
import { deviceAllowed } from "@/lib/attendance-device";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/attendance/events?channel=device
 *
 * Server-Sent Events endpoint for the ESP32 door device. The scanner opens
 * this stream ONCE and then does NO polling at all: when the admin queues a
 * fingerprint enrollment (POST /api/attendance/biometrics) or a mapping is
 * added (POST /api/attendance/mappings), the server publishes to the device
 * channel and the ESP32 is told instantly. Between events the connection is
 * idle (only a keep-alive comment every 25 s), so there is zero traffic
 * until something actually happens.
 *
 * Auth: the same device token as the mappings endpoint
 * (ATTENDANCE_DEVICE_TOKEN, sent as `x-attendance-device` or ?device=).
 * With no token configured the endpoint is as open as the clock endpoint,
 * so an already-flashed scanner keeps working after an update.
 */
export async function GET(request: Request) {
  if (!deviceAllowed(request)) {
    return NextResponse.json({ error: "Device not allowed" }, { status: 401 });
  }

  const channel = CHANNELS.device;
  const encoder = new TextEncoder();
  let unsub: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;

  const cleanup = () => {
    if (keepalive) clearInterval(keepalive);
    if (unsub) unsub();
    keepalive = null;
    unsub = null;
  };

  const stream = new ReadableStream({
    start(controller) {
      const enqueue = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // stream closed
        }
      };
      unsub = subscribe(channel, enqueue);
      enqueue(": connected\n\n");
      keepalive = setInterval(() => enqueue(": ping\n\n"), 25000);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
