/**
 * Route Handler: /api/admin/queues/[[...slug]]
 *
 * Authenticates via requireAdmin() then reverse-proxies the request to the
 * internal http server that hosts Bull-Board (started in instrumentation.node.ts).
 *
 * Why a reverse proxy instead of direct mounting: Bull-Board's
 * @bull-board/express adapter relies on Express's res.render() (EJS) and
 * streaming static-file responses, which need a real Node Writable Stream.
 * The Web Fetch Request/Response pair Next.js Route Handlers expose can't
 * be made stream-equivalent through Proxy mocking — every prior attempt
 * (#608-#614) failed in subtle ways (res.render undefined, socket.destroy
 * undefined, pipe hanging on backpressure). Spawning a real http.Server
 * and proxying via fetch() lets Bull-Board run natively.
 */

import { requireAdmin } from "@/lib/auth/session";
import { createLogger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = createLogger({ module: "bull-board-route" });
const BASE_PATH = "/api/admin/queues";

function getInternalPort(): number | undefined {
  return (globalThis as unknown as { __findashBullBoardPort?: number }).__findashBullBoardPort;
}

async function handler(req: Request): Promise<Response> {
  try {
    await requireAdmin();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "UNAUTHENTICATED") {
      return Response.json({ error: "Unauthenticated" }, { status: 401 });
    }
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const port = getInternalPort();
  if (!port) {
    log.error(
      { event: "bull_board_port_missing" },
      "bull-board internal server not initialized — instrumentation may have failed",
    );
    return Response.json({ error: "Bull-Board not initialized" }, { status: 503 });
  }

  const url = new URL(req.url);
  const relPath = url.pathname.replace(new RegExp(`^${BASE_PATH}`), "") || "/";
  const targetUrl = `http://127.0.0.1:${port}${relPath}${url.search}`;

  // Strip Next.js / proxy / framework headers that don't make sense on the
  // internal hop. Forward only the application-level ones Bull-Board cares
  // about (cookies for any session work, accept-* for content negotiation).
  const upstreamHeaders = new Headers();
  for (const [key, value] of req.headers.entries()) {
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "connection" || lower === "content-length") continue;
    upstreamHeaders.set(key, value);
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: upstreamHeaders,
      // Body only present for non-GET/HEAD methods; Bull-Board has POST/PATCH
      // endpoints for retry/promote/clean.
      body:
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : Buffer.from(await req.arrayBuffer()),
      redirect: "manual",
    });

    // Pass through status, headers, and body. Strip hop-by-hop headers per
    // RFC 7230 (transfer-encoding, connection) — fetch handles them but
    // Next.js may try to set them too.
    const resHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === "transfer-encoding" || lower === "connection") return;
      resHeaders.set(key, value);
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: resHeaders,
    });
  } catch (err) {
    if (err instanceof Error) {
      log.error(
        {
          errorName: err.name,
          errorMessage: err.message,
          errorStack: err.stack,
          event: "bull_board_proxy_error",
        },
        "bull-board reverse-proxy error",
      );
    } else {
      log.error(
        { errorString: String(err), event: "bull_board_proxy_error" },
        "bull-board reverse-proxy error",
      );
    }
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
