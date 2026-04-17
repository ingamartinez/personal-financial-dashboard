import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ingestionLogs } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 50 * 1024;

export async function POST(req: Request) {
  const startedAt = new Date();

  const expectedToken = process.env.INGEST_WEBHOOK_TOKEN;
  if (!expectedToken) {
    return NextResponse.json({ error: "INGEST_WEBHOOK_TOKEN not configured" }, { status: 503 });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const providedToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!providedToken || providedToken !== expectedToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const query = Object.fromEntries(url.searchParams.entries());
  const contentType = req.headers.get("content-type") ?? "";

  const headersRecord: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headersRecord[key] = key.toLowerCase() === "authorization" ? "Bearer ***redacted***" : value;
  });

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: `Payload too large (max ${MAX_BODY_BYTES} bytes)` },
      { status: 413 },
    );
  }

  let bodyParsed: unknown = null;
  let parseError: string | null = null;

  if (rawBody.length > 0) {
    try {
      if (contentType.includes("application/json")) {
        bodyParsed = JSON.parse(rawBody);
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        bodyParsed = Object.fromEntries(new URLSearchParams(rawBody).entries());
      } else {
        try {
          bodyParsed = JSON.parse(rawBody);
        } catch {
          bodyParsed = null;
        }
      }
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
  }

  const [log] = await db
    .insert(ingestionLogs)
    .values({
      source: "apple_pay",
      status: "debug",
      itemsReceived: 0,
      itemsInserted: 0,
      itemsDuplicated: 0,
      payload: {
        kind: "debug-capture",
        method: "POST",
        url: req.url,
        query,
        headers: headersRecord,
        contentType,
        bodyRaw: rawBody,
        bodyParsed,
        parseError,
      },
      startedAt,
      finishedAt: new Date(),
    })
    .returning({ id: ingestionLogs.id });

  return NextResponse.json({ ok: true, logId: log.id });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    hint: "POST any payload with Authorization: Bearer <INGEST_WEBHOOK_TOKEN>",
  });
}
