import { NextResponse } from "next/server";
import { canIngest, paywallResponse } from "@/lib/auth/can-ingest";
import { db } from "@/lib/db";
import { ingestionLogs } from "@/lib/db/schema";
import { parseSmsBancolombia } from "@/lib/ingestion/sms-bancolombia";
import { ingestParsed, serializeParsed } from "@/lib/ingestion/sms-pipeline";
import { resolveWebhookAuth } from "@/lib/webhook-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 10 * 1024;

export async function POST(req: Request) {
  const startedAt = new Date();

  const auth = await resolveWebhookAuth({
    authHeader: req.headers.get("authorization"),
    purpose: "sms",
  });
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const gate = await canIngest(auth.userId);
  if (!gate.allowed) return paywallResponse(gate.reason);

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: `Payload too large (max ${MAX_BODY_BYTES} bytes)` },
      { status: 413 },
    );
  }

  let payload: { sender?: unknown; body?: unknown; receivedAt?: unknown };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const sender = typeof payload.sender === "string" ? payload.sender : null;
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  const receivedAt = typeof payload.receivedAt === "string" ? payload.receivedAt : null;

  if (!body) {
    return NextResponse.json({ error: "Missing required field: body" }, { status: 400 });
  }

  const parsed = parseSmsBancolombia(body);
  const outcome = await ingestParsed(auth.userId, parsed);

  await db.insert(ingestionLogs).values({
    userId: auth.userId,
    source: "sms",
    status: outcome.status,
    itemsReceived: 1,
    itemsInserted: outcome.status === "inserted" ? 1 : 0,
    itemsDuplicated: outcome.status === "duplicated" ? 1 : 0,
    errorMessage:
      outcome.status === "error" || outcome.status === "skipped" ? outcome.reason : null,
    payload: {
      sender,
      receivedAt,
      body,
      parsed: serializeParsed(parsed),
      outcome,
    },
    startedAt,
    finishedAt: new Date(),
  });

  return NextResponse.json({ ok: true, ...outcome });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    hint: "POST { sender, body, receivedAt? } with Authorization: Bearer <per-user token from /settings/webhooks>",
  });
}
