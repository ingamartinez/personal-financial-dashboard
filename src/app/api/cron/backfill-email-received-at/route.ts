import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { backfillEmailReceivedAt } from "@/lib/gmail/backfill-received-at";
import { createLogger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// #553 — one-shot HTTP trigger to populate email_receipts.email_received_at
// from Gmail's internalDate for legacy receipts ingested before #545.
//
// Lives as a cron route (not a script) because googleapis is bundled inside
// .next/chunks by Turbopack and isn't reachable from external scripts.

const log = createLogger({ module: "api/cron/backfill-email-received-at" });

const BodySchema = z.object({
  dryRun: z.boolean().optional().default(false),
  userId: z.number().int().positive().optional(),
  batchSize: z.number().int().positive().max(100).optional(),
  sleepMs: z.number().int().min(0).max(60_000).optional(),
});

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

  let payload: z.infer<typeof BodySchema>;
  try {
    const body = await req.json().catch(() => ({}));
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid body", details: parsed.error.format() },
        { status: 400 },
      );
    }
    payload = parsed.data;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  try {
    const report = await backfillEmailReceivedAt(payload);
    log.info(
      {
        dryRun: report.dryRun,
        userIdFilter: payload.userId ?? null,
        ...report.totals,
        event: "backfill_received_at_http_completed",
      },
      "email_received_at backfill via HTTP cron",
    );
    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    log.error(
      { err, payload, event: "backfill_received_at_http_failed" },
      "email_received_at backfill route threw",
    );
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
