import { getSessionUserOrNull } from "@/lib/auth/session";
import { subscribe, type AppEvent } from "@/lib/events/bus";
import { createLogger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = createLogger({ module: "sse-stream-me" });

const HEARTBEAT_MS = 30_000;

export async function GET(req: Request) {
  const session = await getSessionUserOrNull();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { id: userId, role } = session;
  log.info({ userId, role, event: "sse_subscribed" }, "SSE client subscribed");

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      safeEnqueue(`: hello\n\n`);

      const onEvent = (event: AppEvent) => {
        // notification:created carries an explicit audience that overrides the
        // default userId-scoped delivery. audience: "admin" goes ONLY to admin
        // sessions — even if event.userId matches a non-admin session, that
        // user must not receive an admin-only notification.
        if (event.type === "notification:created" && event.audience === "admin") {
          if (role !== "admin") return;
        } else if (event.userId !== userId) {
          return;
        }

        safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
      };

      const unsubscribe = subscribe(onEvent);

      const heartbeat = setInterval(() => {
        safeEnqueue(`: heartbeat\n\n`);
      }, HEARTBEAT_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        log.info({ userId, role, event: "sse_disconnected" }, "SSE client disconnected");
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
