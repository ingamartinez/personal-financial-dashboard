import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { POST } from "./route";

const TEST_TOKEN = "test-token-vitest-debug-capture";
const MARKER = "VITEST_DEBUG_CAPTURE_MARKER";

function makeRequest(init: {
  body?: string;
  headers?: Record<string, string>;
}) {
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
  beforeEach(() => {
    process.env.INGEST_WEBHOOK_TOKEN = TEST_TOKEN;
  });
  afterEach(cleanup);
  afterAll(async () => {
    delete process.env.INGEST_WEBHOOK_TOKEN;
    await db.$client.end({ timeout: 1 });
  });

  it("returns 503 when INGEST_WEBHOOK_TOKEN is not configured", async () => {
    delete process.env.INGEST_WEBHOOK_TOKEN;
    const res = await POST(
      makeRequest({
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      }),
    );
    expect(res.status).toBe(503);
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
  });

  it("returns 401 when bearer token does not match", async () => {
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
