import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullResult } from "@/lib/gmail/pull";

// ── Shared mock state (hoisted above module-level const) ──────────────────────
const mocks = vi.hoisted(() => ({
  pullForUser: vi.fn<(userId: number, opts: Record<string, unknown>) => Promise<PullResult>>(),
  pullAllActiveConnections:
    vi.fn<
      (deps: Record<string, unknown>, opts: Record<string, unknown>) => Promise<PullResult[]>
    >(),
  // DB connection lookup: null by default (no active connection found)
  dbResult: null as { id: number } | null,
}));

vi.mock("@/lib/gmail/pull", () => ({
  pullForUser: mocks.pullForUser,
  pullAllActiveConnections: mocks.pullAllActiveConnections,
}));

// Mock the DB connection check. The route calls db.select().from().where().limit(1)
// which returns a single row or undefined. We intercept via a chainable mock.
vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(() => Promise.resolve(mocks.dbResult ? [mocks.dbResult] : [])),
  };
  return { db: chain };
});

// Import the route AFTER mocks are established.
const { POST } = await import("./route");

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  return new Request("http://localhost/api/cron/gmail-pull", {
    method: "POST",
    headers,
    body: bodyStr,
  });
}

function makeEmptyPullResult(userId = 1): PullResult {
  return {
    userId,
    pulled: 0,
    skipped: 0,
    byGateway: {
      mercado_pago: { pulled: 0, skipped: 0 },
      payu: { pulled: 0, skipped: 0 },
      wompi: { pulled: 0, skipped: 0 },
      apple: { pulled: 0, skipped: 0 },
      paypal: { pulled: 0, skipped: 0 },
      bancolombia: { pulled: 0, skipped: 0 },
      arq: { pulled: 0, skipped: 0 },
    },
    errors: [],
    connectionId: 42,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.CRON_TOKEN = VALID_TOKEN;
  mocks.dbResult = null;
  vi.clearAllMocks();
  mocks.pullAllActiveConnections.mockResolvedValue([makeEmptyPullResult(1)]);
  mocks.pullForUser.mockResolvedValue(makeEmptyPullResult(1));
});

// ── Auth tests ────────────────────────────────────────────────────────────────

describe("POST /api/cron/gmail-pull — auth", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const res = await POST(makeRequest({ token: null }));
    expect(res.status).toBe(401);
    // Body parsing must NOT happen before auth
    expect(mocks.pullAllActiveConnections).not.toHaveBeenCalled();
    expect(mocks.pullForUser).not.toHaveBeenCalled();
  });

  it("returns 401 when CRON_TOKEN does not match", async () => {
    const res = await POST(makeRequest({ token: "wrong-token" }));
    expect(res.status).toBe(401);
    expect(mocks.pullAllActiveConnections).not.toHaveBeenCalled();
    expect(mocks.pullForUser).not.toHaveBeenCalled();
  });
});

// ── Body validation tests ─────────────────────────────────────────────────────

describe("POST /api/cron/gmail-pull — body validation", () => {
  it("returns 400 when body is not valid JSON", async () => {
    const req = new Request("http://localhost/api/cron/gmail-pull", {
      method: "POST",
      headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        "content-type": "application/json",
      },
      body: "not-json{{{",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Invalid JSON body");
  });

  it("returns 400 for unknown field (strict schema)", async () => {
    const res = await POST(makeRequest({ body: { unknownField: true } }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when userId is negative", async () => {
    const res = await POST(makeRequest({ body: { userId: -1 } }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when userId is zero", async () => {
    const res = await POST(makeRequest({ body: { userId: 0 } }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when sinceDays exceeds 3650", async () => {
    const res = await POST(makeRequest({ body: { sinceDays: 3651 } }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for unknown gateway id", async () => {
    const res = await POST(makeRequest({ body: { gateways: ["wat"] } }));
    expect(res.status).toBe(400);
  });
});

// ── No-body (regular cron tick) ───────────────────────────────────────────────

describe("POST /api/cron/gmail-pull — empty body (regular tick)", () => {
  it("calls pullAllActiveConnections with empty opts and returns ok", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(200);
    expect(mocks.pullAllActiveConnections).toHaveBeenCalledOnce();
    // First arg is deps ({}), second is opts (should be empty or no sinceDays/gateways)
    const [deps, opts] = mocks.pullAllActiveConnections.mock.calls[0];
    expect(deps).toEqual({});
    expect(opts).toEqual({});
    expect(mocks.pullForUser).not.toHaveBeenCalled();
    const json = (await res.json()) as { ok: boolean; users: number };
    expect(json.ok).toBe(true);
    expect(json.users).toBe(1);
  });
});

// ── userId single-user mode ───────────────────────────────────────────────────

describe("POST /api/cron/gmail-pull — userId single-user mode", () => {
  it("calls pullForUser(N, {}) and skips the all-users path", async () => {
    mocks.dbResult = { id: 99 };
    const res = await POST(makeRequest({ body: { userId: 5 } }));
    expect(res.status).toBe(200);
    expect(mocks.pullForUser).toHaveBeenCalledOnce();
    expect(mocks.pullForUser).toHaveBeenCalledWith(5, {});
    expect(mocks.pullAllActiveConnections).not.toHaveBeenCalled();
  });

  it("returns 404 when user has no active connection", async () => {
    mocks.dbResult = null; // no active connection
    const res = await POST(makeRequest({ body: { userId: 5 } }));
    expect(res.status).toBe(404);
    expect(mocks.pullForUser).not.toHaveBeenCalled();
    expect(mocks.pullAllActiveConnections).not.toHaveBeenCalled();
  });

  it("wraps single-user result in array for consistent response shape", async () => {
    mocks.dbResult = { id: 99 };
    mocks.pullForUser.mockResolvedValue({
      ...makeEmptyPullResult(5),
      pulled: 12,
      skipped: 3,
    });
    const res = await POST(makeRequest({ body: { userId: 5 } }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      users: number;
      pulled: number;
      skipped: number;
    };
    expect(json.ok).toBe(true);
    expect(json.users).toBe(1);
    expect(json.pulled).toBe(12);
    expect(json.skipped).toBe(3);
  });
});

// ── Opts forwarding ───────────────────────────────────────────────────────────

describe("POST /api/cron/gmail-pull — opts forwarding", () => {
  it("passes sinceDays and gateways opts to pullAllActiveConnections", async () => {
    const res = await POST(makeRequest({ body: { sinceDays: 365, gateways: ["paypal"] } }));
    expect(res.status).toBe(200);
    expect(mocks.pullAllActiveConnections).toHaveBeenCalledOnce();
    const [, opts] = mocks.pullAllActiveConnections.mock.calls[0];
    expect(opts).toEqual({ sinceDays: 365, gateways: ["paypal"] });
  });

  it("passes sinceDays and gateways to pullForUser when userId is set", async () => {
    mocks.dbResult = { id: 99 };
    const res = await POST(
      makeRequest({ body: { userId: 7, sinceDays: 90, gateways: ["mercado_pago"] } }),
    );
    expect(res.status).toBe(200);
    expect(mocks.pullForUser).toHaveBeenCalledWith(7, {
      sinceDays: 90,
      gateways: ["mercado_pago"],
    });
  });
});

// ── byGateway rollup ──────────────────────────────────────────────────────────

describe("POST /api/cron/gmail-pull — response shape", () => {
  it("includes byGateway rollup in response", async () => {
    const result = makeEmptyPullResult(1);
    result.byGateway.paypal = { pulled: 5, skipped: 2 };
    mocks.pullAllActiveConnections.mockResolvedValue([result]);

    const res = await POST(makeRequest({}));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      byGateway: Record<string, { pulled: number; skipped: number }>;
    };
    expect(json.ok).toBe(true);
    expect(json.byGateway.paypal).toEqual({ pulled: 5, skipped: 2 });
  });
});
