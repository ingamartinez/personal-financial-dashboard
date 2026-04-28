/**
 * Route Handler: /api/admin/queues/[[...slug]]
 *
 * Serves the Bull-Board SPA (HTML entry + JSON API + static assets).
 * Enforces requireAdmin() BEFORE the Express app ever sees the request.
 *
 * The [[...slug]] catch-all matches:
 *   /api/admin/queues              → Bull-Board entry point
 *   /api/admin/queues/static/*     → CSS / JS / images
 *   /api/admin/queues/api/*        → Bull-Board JSON API
 *   /api/admin/queues/queue/*      → queue detail SPA route
 */

import { type IncomingMessage, type ServerResponse } from "http";
import { Readable } from "stream";
import { requireAdmin } from "@/lib/auth/session";
import { getBullBoardApp } from "@/lib/queue/bull-board";
import { createLogger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = createLogger({ module: "bull-board-route" });

// ---------------------------------------------------------------------------
// Bridge: Next.js Request → Node.js IncomingMessage / ServerResponse
// ---------------------------------------------------------------------------

/**
 * Converts a Fetch API `Request` into a Node.js `IncomingMessage`-compatible
 * object and a mock `ServerResponse` that collects status, headers, and body.
 * Returns a `Response` after Express finishes handling the request.
 */
async function bridgeToExpress(req: Request): Promise<Response> {
  const app = getBullBoardApp();
  const url = new URL(req.url);

  // Strip the /api/admin/queues prefix so Express sees paths relative to "/"
  const relPath = url.pathname.replace(/^\/api\/admin\/queues/, "") || "/";
  const fullUrl = relPath + (url.search ?? "");

  return new Promise<Response>((resolve, reject) => {
    // --- Mock IncomingMessage ---
    // Use a Readable stream so Express can pipe it without crashing.
    const nodeReq = new Readable({
      read() {
        /* intentionally empty — body is pushed below */
      },
    }) as unknown as IncomingMessage;

    (nodeReq as unknown as Record<string, unknown>).method = req.method;
    (nodeReq as unknown as Record<string, unknown>).url = fullUrl;
    (nodeReq as unknown as Record<string, unknown>).headers = Object.fromEntries(
      req.headers.entries(),
    );
    (nodeReq as unknown as Record<string, unknown>).socket = {
      remoteAddress: "127.0.0.1",
      encrypted: false,
    };

    // Push request body into the stream
    (async () => {
      try {
        if (req.body) {
          const reader = req.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            (nodeReq as unknown as Readable).push(value);
          }
        }
        (nodeReq as unknown as Readable).push(null);
      } catch (err) {
        log.error({ err, event: "bridge_body_error" }, "error reading request body");
        reject(err as Error);
      }
    })().catch(reject);

    // --- Mock ServerResponse ---
    let statusCode = 200;
    const responseHeaders = new Headers();
    const chunks: Buffer[] = [];

    const nodeRes = new Proxy({} as ServerResponse, {
      get(_target, prop: string) {
        switch (prop) {
          case "statusCode":
            return statusCode;
          case "setHeader":
            return (name: string, value: string | string[]) => {
              responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
            };
          case "getHeader":
            return (name: string) => responseHeaders.get(name) ?? undefined;
          case "removeHeader":
            return (name: string) => responseHeaders.delete(name);
          case "write":
            return (chunk: Buffer | string) => {
              chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
              return true;
            };
          case "end":
            return (chunk?: Buffer | string) => {
              if (chunk) {
                chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
              }
              resolve(
                new Response(Buffer.concat(chunks), {
                  status: statusCode,
                  headers: responseHeaders,
                }),
              );
            };
          case "writeHead":
            return (code: number, headers?: Record<string, string>) => {
              statusCode = code;
              if (headers) {
                for (const [k, v] of Object.entries(headers)) {
                  responseHeaders.set(k, v);
                }
              }
            };
          // Express inspects these on the response object
          case "headersSent":
            return false;
          case "finished":
            return false;
          case "writable":
            return true;
          case "socket":
            return { encrypted: false };
          default:
            return undefined;
        }
      },
      set(_target, prop: string, value: unknown) {
        if (prop === "statusCode") {
          statusCode = value as number;
        }
        return true;
      },
    });

    app(nodeReq, nodeRes as unknown as ServerResponse);
  });
}

// ---------------------------------------------------------------------------
// Route exports — all methods forwarded to the Express bridge
// ---------------------------------------------------------------------------

async function handler(req: Request): Promise<Response> {
  try {
    await requireAdmin();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "UNAUTHENTICATED") {
      return Response.json({ error: "Unauthenticated" }, { status: 401 });
    }
    // FORBIDDEN or anything else
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    return await bridgeToExpress(req);
  } catch (err) {
    log.error({ err, event: "bull_board_handler_error" }, "bull-board handler error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
