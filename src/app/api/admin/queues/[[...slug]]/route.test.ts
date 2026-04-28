/**
 * Smoke tests for the Bull-Board route handler.
 *
 * Verifies auth enforcement without touching Redis or Express.
 * All external dependencies (auth, bull-board app) are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock requireAdmin — controls the auth gate
// ---------------------------------------------------------------------------

const mockRequireAdmin = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  requireAdmin: mockRequireAdmin,
}));

// ---------------------------------------------------------------------------
// Mock getBullBoardApp — prevents Express + Redis from initializing in tests
// ---------------------------------------------------------------------------

const mockExpressApp = vi.fn().mockImplementation((_req: unknown, res: Record<string, unknown>) => {
  // Simulate a minimal Express response for the success path.
  // Express sets res.statusCode directly rather than calling writeHead,
  // then calls res.end() to finish the response.
  (res as { statusCode: number }).statusCode = 200;
  if (typeof res.end === "function") {
    (res.end as (body: string) => void)("<html><body>bull-board</body></html>");
  }
});

vi.mock("@/lib/queue/bull-board", () => ({
  getBullBoardApp: () => mockExpressApp,
  BULL_BOARD_BASE_PATH: "/api/admin/queues",
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

    // The Express app must NOT be called
    expect(mockExpressApp).not.toHaveBeenCalled();
  });

  it("returns 401 when requireAdmin throws UNAUTHENTICATED", async () => {
    mockRequireAdmin.mockRejectedValue(new Error("UNAUTHENTICATED"));

    const res = await GET(makeRequest());
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body).toMatchObject({ error: "Unauthenticated" });

    expect(mockExpressApp).not.toHaveBeenCalled();
  });

  it("calls the Express app when requireAdmin resolves (admin user)", async () => {
    mockRequireAdmin.mockResolvedValue({
      id: 1,
      email: "admin@example.com",
      role: "admin",
      active: true,
    });

    const res = await GET(makeRequest());

    // The Express bridge was invoked
    expect(mockExpressApp).toHaveBeenCalledOnce();
    // Status is whatever the mock Express app returned (200).
    // If the bridge throws internally, the route returns 500 — debug if so.
    const body = await res.json().catch(() => null);
    expect({ status: res.status, body }).toMatchObject({ status: 200 });
  });

  it("does not expose the dashboard to non-admin role (FORBIDDEN path)", async () => {
    mockRequireAdmin.mockRejectedValue(new Error("FORBIDDEN"));

    const res = await GET(makeRequest("/api/admin/queues/api/queues"));
    expect(res.status).toBe(403);
    expect(mockExpressApp).not.toHaveBeenCalled();
  });
});
