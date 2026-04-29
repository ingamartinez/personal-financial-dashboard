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
        // Forward if event belongs to this user, or if it is an admin broadcast
        // and the current session has the admin role.
        const isOwn = event.userId === userId;
        const isAdminBroadcast =
          "audience" in event && event.audience === "admin" && role === "admin";

        if (!isOwn && !isAdminBroadcast) return;

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
