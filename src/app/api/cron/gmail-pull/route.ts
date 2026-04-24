import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { pullAllActiveConnections } from "@/lib/gmail/pull";
import { createLogger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same handler shape as canary-check: CRON_TOKEN bearer, no session. Useful
// for manual invocation from ops, for health probes, and for a future
// external scheduler (e.g. DO scheduled function) if we ever move off
// in-process node-cron.

const log = createLogger({ module: "api/cron/gmail-pull" });

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function resolveToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

export async function POST(req: Request) {
  const expected = process.env.CRON_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: "CRON_TOKEN not configured" }, { status: 500 });
  }
  const provided = resolveToken(req);
  if (!provided || !constantTimeEquals(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results = await pullAllActiveConnections();
  const totalPulled = results.reduce((acc, r) => acc + r.pulled, 0);
  const totalSkipped = results.reduce((acc, r) => acc + r.skipped, 0);
  const withErrors = results.filter((r) => r.errors.length > 0).length;
  log.info(
    {
      users: results.length,
      pulled: totalPulled,
      skipped: totalSkipped,
      withErrors,
      event: "gmail_pull_http_tick",
    },
    "gmail pull via HTTP cron",
  );

  return NextResponse.json({
    ok: true,
    users: results.length,
    pulled: totalPulled,
    skipped: totalSkipped,
    errorUsers: withErrors,
  });
}
