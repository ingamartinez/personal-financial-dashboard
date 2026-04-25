import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { gmailConnections } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { pullForUser, pullAllActiveConnections } from "@/lib/gmail/pull";
import { GATEWAY_IDS } from "@/lib/gmail/registry";
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

// Optional body schema. Absent body = regular cron tick (all users, default
// window). Present body must be a valid JSON object matching this shape.
const PullOptsSchema = z
  .object({
    userId: z.number().int().positive().optional(),
    sinceDays: z.number().int().positive().max(3650).optional(),
    gateways: z.array(z.enum(GATEWAY_IDS)).optional(),
  })
  .strict();

type ParsedOpts = z.infer<typeof PullOptsSchema>;

export async function POST(req: Request) {
  const expected = process.env.CRON_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: "CRON_TOKEN not configured" }, { status: 500 });
  }
  const provided = resolveToken(req);
  if (!provided || !constantTimeEquals(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse optional body. An empty body is treated as "no opts" (regular tick).
  let parsed: ParsedOpts = {};
  const contentType = req.headers.get("content-type") ?? "";
  const rawText = await req.text();
  if (rawText.trim().length > 0) {
    let bodyJson: unknown;
    try {
      bodyJson = JSON.parse(rawText);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const validation = PullOptsSchema.safeParse(bodyJson);
    if (!validation.success) {
      return NextResponse.json(
        { error: "Invalid body", details: validation.error.flatten() },
        { status: 400 },
      );
    }
    parsed = validation.data;
  }

  void contentType; // not used for routing, only for future multipart support

  const { userId, ...pullOpts } = parsed;

  let results;

  if (userId !== undefined) {
    // Single-user mode — verify the user has an active connection first.
    const [connRow] = await db
      .select({ id: gmailConnections.id })
      .from(gmailConnections)
      .where(
        and(
          eq(gmailConnections.userId, userId),
          eq(gmailConnections.status, "active"),
          notDeleted(gmailConnections.deletedAt),
        ),
      )
      .limit(1);

    if (!connRow) {
      log.warn(
        { userId, event: "gmail_pull_http_no_connection" },
        "gmail pull requested for user with no active connection",
      );
      return NextResponse.json(
        { error: "No active Gmail connection for this user" },
        { status: 404 },
      );
    }

    const result = await pullForUser(userId, pullOpts);
    results = [result];
  } else {
    // Fan-out mode — all users with active connections.
    results = await pullAllActiveConnections({}, pullOpts);
  }

  const totalPulled = results.reduce((acc, r) => acc + r.pulled, 0);
  const totalSkipped = results.reduce((acc, r) => acc + r.skipped, 0);
  const withErrors = results.filter((r) => r.errors.length > 0).length;

  // Roll up byGateway across all results.
  const byGateway: Record<string, { pulled: number; skipped: number }> = {};
  for (const r of results) {
    for (const [gId, counts] of Object.entries(r.byGateway)) {
      if (!byGateway[gId]) byGateway[gId] = { pulled: 0, skipped: 0 };
      byGateway[gId].pulled += counts.pulled;
      byGateway[gId].skipped += counts.skipped;
    }
  }

  log.info(
    {
      users: results.length,
      pulled: totalPulled,
      skipped: totalSkipped,
      withErrors,
      userId: userId ?? null,
      sinceDays: pullOpts.sinceDays ?? null,
      gateways: pullOpts.gateways ?? null,
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
    byGateway,
  });
}
