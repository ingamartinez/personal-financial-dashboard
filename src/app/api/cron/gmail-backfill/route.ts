import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  backfillBancolombia,
  backfillBancolombiaDryRun,
  BackfillConnectionError,
} from "@/lib/gmail/backfill";
import { createLogger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// #458 — one-shot backfill trigger for operators / cc-infra scripts. Mirrors
// the bot's /backfill-gmail flow: dry-run is the default, `confirm: true`
// actually writes. The bot is the primary surface for end users; this route
// exists so ops can re-run or backfill other years without touching Telegram.

const log = createLogger({ module: "api/cron/gmail-backfill" });

const BodySchema = z.object({
  userId: z.number().int().positive(),
  from: z.coerce.date(),
  to: z.coerce.date(),
  confirm: z.boolean().optional().default(false),
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
    const parsed = BodySchema.safeParse(await req.json());
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

  if (payload.from >= payload.to) {
    return NextResponse.json({ error: "`from` must be earlier than `to`" }, { status: 400 });
  }

  try {
    if (!payload.confirm) {
      const dryRun = await backfillBancolombiaDryRun(payload.userId, {
        from: payload.from,
        to: payload.to,
      });
      return NextResponse.json({ ok: true, dryRun: true, report: dryRun });
    }

    const report = await backfillBancolombia(payload.userId, {
      from: payload.from,
      to: payload.to,
    });
    log.info(
      {
        userId: payload.userId,
        totalEmails: report.totalEmails,
        inserted: report.inserted,
        matchedExisting: report.matchedExisting,
        errors: report.errors.length,
        event: "gmail_backfill_http_completed",
      },
      "gmail backfill via HTTP cron",
    );
    return NextResponse.json({ ok: true, dryRun: false, report });
  } catch (err) {
    if (err instanceof BackfillConnectionError) {
      return NextResponse.json(
        { error: "gmail_connection_error", reason: err.reason },
        { status: 409 },
      );
    }
    log.error(
      { err, userId: payload.userId, event: "gmail_backfill_http_failed" },
      "gmail backfill route threw",
    );
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
