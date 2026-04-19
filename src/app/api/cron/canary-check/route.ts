import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { checkAndAlertCanary } from "@/lib/observability/canary-alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const decision = await checkAndAlertCanary();
  return NextResponse.json({ ok: true, decision });
}
