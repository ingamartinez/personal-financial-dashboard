/**
 * Smoke tests for the Bull-Board route handler.
 *
 * Verifies auth enforcement and the missing-port path. The success path
 * (reverse proxy via fetch) is exercised end-to-end via local browser tests
 * and prod smoke; mocking fetch + the internal http server here adds noise
 * without catching real bugs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock requireAdmin — controls the auth gate
// ---------------------------------------------------------------------------

const mockRequireAdmin = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  requireAdmin: mockRequireAdmin,
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks are in place
// ---------------------------------------------------------------------------

const { GET } = await import("./route");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(path = "/api/admin/queues"): Request {
  return new Request(`http://localhost${path}`, { method: "GET" });
}

type GlobalWithPort = typeof globalThis & { __findashBullBoardPort?: number };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Bull-Board route handler — auth gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 when requireAdmin throws FORBIDDEN", async () => {
    mockRequireAdmin.mockRejectedValue(new Error("FORBIDDEN"));

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body).toMatchObject({ error: "Forbidden" });
  });

  it("returns 401 when requireAdmin throws UNAUTHENTICATED", async () => {
    mockRequireAdmin.mockRejectedValue(new Error("UNAUTHENTICATED"));

    const res = await GET(makeRequest());
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body).toMatchObject({ error: "Unauthenticated" });
  });

  it("does not expose the dashboard to non-admin role on deep paths", async () => {
    mockRequireAdmin.mockRejectedValue(new Error("FORBIDDEN"));

    const res = await GET(makeRequest("/api/admin/queues/api/queues"));
    expect(res.status).toBe(403);
  });
});

describe("Bull-Board route handler — internal server availability", () => {
  const originalPort = (globalThis as GlobalWithPort).__findashBullBoardPort;

  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as GlobalWithPort).__findashBullBoardPort;
  });

  afterEach(() => {
    if (originalPort !== undefined) {
      (globalThis as GlobalWithPort).__findashBullBoardPort = originalPort;
    } else {
      delete (globalThis as GlobalWithPort).__findashBullBoardPort;
    }
  });

  it("returns 503 when the internal Bull-Board port is not set (instrumentation failed)", async () => {
    mockRequireAdmin.mockResolvedValue({
      id: 1,
      email: "admin@example.com",
      role: "admin",
      active: true,
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body).toMatchObject({ error: "Bull-Board not initialized" });
  });
});
