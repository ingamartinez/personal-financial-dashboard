import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { webhookTokens } from "@/lib/db/schema";
import { mintWebhookToken } from "@/lib/webhook-tokens";
import { POST } from "./route";

const TEST_USER_ID = 1;
const TEST_TOKEN_LABEL = "vitest-debug-route";
let TEST_TOKEN = "";
const MARKER = "VITEST_DEBUG_CAPTURE_MARKER";

function makeRequest(init: { body?: string; headers?: Record<string, string> }) {
  return new Request("http://localhost:3100/api/ingest/debug", {
    method: "POST",
    body: init.body,
    headers: init.headers,
  });
}

async function cleanup() {
  await db.execute(sql`
    DELETE FROM ingestion_logs
    WHERE status = 'debug'
      AND payload::text LIKE ${"%" + MARKER + "%"}
  `);
}

describe("POST /api/ingest/debug", () => {
  beforeAll(async () => {
    const { plaintext } = await mintWebhookToken({
      userId: TEST_USER_ID,
      purpose: "debug",
      label: TEST_TOKEN_LABEL,
    });
    TEST_TOKEN = plaintext;
  });
  afterEach(cleanup);
  afterAll(async () => {
    await db
      .delete(webhookTokens)
      .where(
        and(eq(webhookTokens.userId, TEST_USER_ID), eq(webhookTokens.label, TEST_TOKEN_LABEL)),
      );
    await db.$client.end({ timeout: 1 });
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
  });

  it("returns 401 when bearer token does not match any webhook_token row", async () => {
    const res = await POST(
      makeRequest({
        headers: { authorization: "Bearer wrong-token" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("accepts JSON body and persists parsed payload", async () => {
    const body = JSON.stringify({
      marker: MARKER,
      merchant: "RAPPI*BURGER KING",
      amount: "32000",
      card: "Visa ···· 1234",
    });
    const res = await POST(
      makeRequest({
        body,
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          "content-type": "application/json",
        },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; logId: number };
    expect(json.ok).toBe(true);
    expect(json.logId).toBeGreaterThan(0);

    const rows = await db.execute<{ payload: Record<string, unknown> }>(sql`
      SELECT payload FROM ingestion_logs WHERE id = ${json.logId}
    `);
    const payload = rows[0].payload;
    expect(payload.kind).toBe("debug-capture");
    expect(payload.bodyParsed).toEqual({
      marker: MARKER,
      merchant: "RAPPI*BURGER KING",
      amount: "32000",
      card: "Visa ···· 1234",
    });
    const headers = payload.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ***redacted***");
  });

  it("parses form-urlencoded body", async () => {
    const body = `marker=${MARKER}&merchant=STARBUCKS&amount=14500`;
    const res = await POST(
      makeRequest({
        body,
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          "content-type": "application/x-www-form-urlencoded",
        },
      }),
    );
    expect(res.status).toBe(200);
    const { logId } = (await res.json()) as { logId: number };

    const rows = await db.execute<{ payload: Record<string, unknown> }>(sql`
      SELECT payload FROM ingestion_logs WHERE id = ${logId}
    `);
    expect(rows[0].payload.bodyParsed).toEqual({
      marker: MARKER,
      merchant: "STARBUCKS",
      amount: "14500",
    });
  });

  it("stores unparseable body as raw text with bodyParsed=null", async () => {
    const body = `${MARKER} this is not json and not form`;
    const res = await POST(
      makeRequest({
        body,
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          "content-type": "text/plain",
        },
      }),
    );
    expect(res.status).toBe(200);
    const { logId } = (await res.json()) as { logId: number };

    const rows = await db.execute<{ payload: Record<string, unknown> }>(sql`
      SELECT payload FROM ingestion_logs WHERE id = ${logId}
    `);
    expect(rows[0].payload.bodyRaw).toBe(body);
    expect(rows[0].payload.bodyParsed).toBeNull();
  });

  it("rejects payloads larger than 50KB with 413", async () => {
    const body = JSON.stringify({ marker: MARKER, pad: "x".repeat(60 * 1024) });
    const res = await POST(
      makeRequest({
        body,
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          "content-type": "application/json",
        },
      }),
    );
    expect(res.status).toBe(413);
  });
});
