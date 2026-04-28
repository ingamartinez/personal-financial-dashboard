/**
 * Bull-Board singleton for Next.js App Router.
 *
 * Bull-Board has no official Next.js adapter — the issue's `@bull-board/nextjs`
 * package does not exist on npm. We implement a thin custom adapter that wraps
 * `@bull-board/api` and bridges it to Next.js Route Handlers.
 *
 * Architecture:
 *   - `buildBullBoard()` creates a singleton (Express app via
 *     `@bull-board/express`) that owns the EJS rendering + static-file serving.
 *   - The Route Handler at `/api/admin/queues/[[...slug]]` bridges the incoming
 *     Next.js `Request` into a Node.js `IncomingMessage` and pipes the Express
 *     `ServerResponse` body back as a `NextResponse`.
 *   - `requireAdmin()` is called at the top of the Route Handler, before Express
 *     ever sees the request, so unauthorized traffic never hits the adapter.
 */

import express from "express";
import path from "path";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";

import { createLogger } from "@/lib/logger";
import { getQueueRegistry } from "@/lib/queue";

const log = createLogger({ module: "bull-board" });

// ---------------------------------------------------------------------------
// Singleton — the Express sub-app that owns Bull-Board's EJS + static files.
// Initialized lazily on first request so it doesn't run at build time.
// ---------------------------------------------------------------------------

let _app: ReturnType<typeof express> | null = null;

export const BULL_BOARD_BASE_PATH = "/api/admin/queues";

export function getBullBoardApp(): ReturnType<typeof express> {
  if (_app) return _app;

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BULL_BOARD_BASE_PATH);

  // Register every queue that was created via createQueue() before this call.
  // Right now (before #589 lands) the registry is EMPTY — that's fine; the
  // dashboard just shows an empty state.
  const registry = getQueueRegistry();
  const adapters = [...registry.values()].map((q) => new BullMQAdapter(q));

  createBullBoard({
    queues: adapters,
    serverAdapter,
    options: {
      uiConfig: {
        boardTitle: "Findash Queues",
      },
    },
  });

  // Resolve the UI dist via process.cwd() — NOT require.resolve.
  //
  // Turbopack rewrites require.resolve() at build time to use its own module
  // map. The map handles JS modules but does NOT expose package.json (or any
  // non-bundled file) at runtime, so `require.resolve("@bull-board/ui/...")`
  // throws ResolveMessage at runtime. We tried .ejs (build-time fail), then
  // package.json (runtime fail). process.cwd() is stable: findash starts from
  // the release dir where node_modules lives (in dev `bun run dev` runs from
  // the project root). See memory `nextjs16/bull-board-turbopack`.
  const uiDistPath = path.resolve(process.cwd(), "node_modules/@bull-board/ui/dist");
  serverAdapter.setViewsPath(uiDistPath);
  serverAdapter.setStaticPath("/static", path.join(uiDistPath, "static"));

  const app = express();
  app.use("/", serverAdapter.getRouter());

  log.info({ event: "bull_board_init", queueCount: registry.size }, "bull-board initialized");

  _app = app;
  return _app;
}
