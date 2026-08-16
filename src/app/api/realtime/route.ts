import { subscribe, CHANNELS } from "@/lib/realtime";
import { requireStaffOrAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/realtime?channel=orders
 *
 * Server-Sent Events endpoint. A staff device opens this stream once after
 * login and keeps it open; whenever a mutation route publishes to the channel,
 * the server pushes `data: refresh` here, and the client re-fetches its data.
 * Between events the connection is idle (only a lightweight keep-alive comment
 * every 25s), so there is NO polling and NO database traffic until something
 * actually changes.
 */
export async function GET(request: Request) {
  const auth = await requireStaffOrAdmin();
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);
  const channel = searchParams.get("channel") === CHANNELS.orders ? CHANNELS.orders : CHANNELS.orders;

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
