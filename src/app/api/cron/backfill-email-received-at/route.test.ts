import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackfillReport } from "@/lib/gmail/backfill-received-at";

const mocks = vi.hoisted(() => ({
  backfillEmailReceivedAt: vi.fn<(opts: Record<string, unknown>) => Promise<BackfillReport>>(),
}));

vi.mock("@/lib/gmail/backfill-received-at", () => ({
  backfillEmailReceivedAt: mocks.backfillEmailReceivedAt,
}));

const { POST } = await import("./route");

const VALID_TOKEN = "test-cron-token";

function makeRequest(opts: { token?: string | null; body?: unknown }): Request {
  const headers: Record<string, string> = {};
  if (opts.token !== null) {
    headers["authorization"] = `Bearer ${opts.token ?? VALID_TOKEN}`;
  }
  let bodyStr: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    bodyStr = JSON.stringify(opts.body);
  }
  return new Request("http://localhost/api/cron/backfill-email-received-at", {
    method: "POST",
    headers,
    body: bodyStr,
  });
}

function emptyReport(dryRun = false): BackfillReport {
  return {
    dryRun,
    totals: { total: 0, fetched: 0, receiptsUpdated: 0, txsUpdated: 0, errors: 0 },
    perUser: [],
  };
}

beforeEach(() => {
  process.env.CRON_TOKEN = VALID_TOKEN;
  vi.clearAllMocks();
  mocks.backfillEmailReceivedAt.mockResolvedValue(emptyReport());
});

describe("POST /api/cron/backfill-email-received-at — auth", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const res = await POST(makeRequest({ token: null }));
    expect(res.status).toBe(401);
    expect(mocks.backfillEmailReceivedAt).not.toHaveBeenCalled();
  });

  it("returns 401 when CRON_TOKEN does not match", async () => {
    const res = await POST(makeRequest({ token: "wrong-token" }));
    expect(res.status).toBe(401);
    expect(mocks.backfillEmailReceivedAt).not.toHaveBeenCalled();
  });

  it("returns 500 when CRON_TOKEN is not configured", async () => {
    delete process.env.CRON_TOKEN;
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/cron/backfill-email-received-at — body validation", () => {
  it("accepts empty body and defaults to non-dry-run, all users", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(200);
    expect(mocks.backfillEmailReceivedAt).toHaveBeenCalledOnce();
    const [opts] = mocks.backfillEmailReceivedAt.mock.calls[0];
    expect(opts).toEqual({ dryRun: false });
  });

  it("returns 400 when userId is negative", async () => {
    const res = await POST(makeRequest({ body: { userId: -1 } }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when batchSize exceeds 100", async () => {
    const res = await POST(makeRequest({ body: { batchSize: 101 } }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when sleepMs is negative", async () => {
    const res = await POST(makeRequest({ body: { sleepMs: -1 } }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/cron/backfill-email-received-at — happy path", () => {
  it("forwards options and returns the report", async () => {
    const report: BackfillReport = {
      dryRun: true,
      totals: { total: 5, fetched: 5, receiptsUpdated: 0, txsUpdated: 0, errors: 0 },
      perUser: [{ userId: 1, total: 5, fetched: 5, receiptsUpdated: 0, txsUpdated: 0, errors: 0 }],
    };
    mocks.backfillEmailReceivedAt.mockResolvedValue(report);

    const res = await POST(
      makeRequest({ body: { dryRun: true, userId: 1, batchSize: 50, sleepMs: 100 } }),
    );
    expect(res.status).toBe(200);
    expect(mocks.backfillEmailReceivedAt).toHaveBeenCalledWith({
      dryRun: true,
      userId: 1,
      batchSize: 50,
      sleepMs: 100,
    });
    const json = (await res.json()) as { ok: boolean } & BackfillReport;
    expect(json.ok).toBe(true);
    expect(json.dryRun).toBe(true);
    expect(json.totals.total).toBe(5);
    expect(json.perUser[0].userId).toBe(1);
  });

  it("returns 500 when the backfill function throws", async () => {
    mocks.backfillEmailReceivedAt.mockRejectedValue(new Error("boom"));
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(500);
  });
});
