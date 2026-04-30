// Unit test for Wave 3 gmail_connected emitter (#662).
// Exercises the happy path of the OAuth callback and verifies
// that emitNotification is called exactly once with the expected shape.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as emitModule from "@/lib/notifications/emit";

// ── hoisted shared state ──────────────────────────────────────────────────

const { mockGetSessionUserOrNull, mockSelectLimit, mockTransactionFn } = vi.hoisted(() => {
  const mockSelectLimit = vi.fn().mockResolvedValue([{ id: 42 }]);
  const txInsertOnConflict = vi.fn().mockResolvedValue([]);
  const txInsertValues = vi.fn().mockReturnValue({ onConflictDoUpdate: txInsertOnConflict });
  const txInsert = vi.fn().mockReturnValue({ values: txInsertValues });
  const txUpdateWhere = vi.fn().mockResolvedValue([]);
  const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere });
  const txUpdate = vi.fn().mockReturnValue({ set: txUpdateSet });
  const txMock = { insert: txInsert, update: txUpdate };
  const mockTransactionFn = vi
    .fn()
    .mockImplementation(async (cb: (tx: typeof txMock) => unknown) => cb(txMock));
  return {
    mockGetSessionUserOrNull: vi.fn(),
    mockSelectLimit,
    mockTransactionFn,
  };
});

// ── module mocks ──────────────────────────────────────────────────────────

vi.mock("@/lib/auth/session", () => ({
  getSessionUserOrNull: mockGetSessionUserOrNull,
}));

vi.mock("@/lib/gmail/oauth-state", () => ({
  verifyOAuthState: vi.fn().mockReturnValue({ userId: 1 }),
  InvalidOAuthStateError: class InvalidOAuthStateError extends Error {},
}));

vi.mock("@/lib/gmail/client", () => ({
  GMAIL_SCOPES: ["https://www.googleapis.com/auth/gmail.readonly"],
  newOAuth2ClientForFlow: vi.fn().mockReturnValue({
    getToken: vi.fn().mockResolvedValue({
      tokens: {
        access_token: "acc",
        refresh_token: "ref",
        expiry_date: Date.now() + 3_600_000,
        scope: "https://www.googleapis.com/auth/gmail.readonly",
      },
    }),
    setCredentials: vi.fn(),
  }),
}));

vi.mock("googleapis", () => ({
  google: {
    oauth2: vi.fn().mockReturnValue({
      userinfo: {
        get: vi.fn().mockResolvedValue({ data: { email: "test@gmail.com" } }),
      },
    }),
  },
}));

vi.mock("@/lib/crypto/gmail-cipher", () => ({
  gmailCipher: {
    encrypt: vi.fn((v: string) => `enc:${v}`),
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: mockSelectLimit,
        }),
      }),
    }),
    transaction: mockTransactionFn,
  },
}));

// ── tests ─────────────────────────────────────────────────────────────────

describe("Gmail OAuth callback — gmail_connected emitter", () => {
  const sessionUser = { id: 1, email: "user@findash.local", name: "User" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionUserOrNull.mockResolvedValue(sessionUser);
    mockSelectLimit.mockResolvedValue([{ id: 42 }]);
    process.env.AUTH_URL = "http://localhost:3100";
  });

  it("emits gmail_connected once with correct shape on successful OAuth", async () => {
    const spy = vi.spyOn(emitModule, "emitNotification").mockResolvedValue({ id: 999 });

    const { GET } = await import("./route");
    const url = "http://localhost:3100/api/integrations/gmail/oauth/callback?code=CODE&state=STATE";
    const req = new Request(url);

    await GET(req as Parameters<typeof GET>[0]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      sessionUser.id,
      expect.objectContaining({
        type: "gmail_connected",
        entityId: "42",
        priority: "low",
        title: "Gmail conectado",
        actionUrl: "/settings/integrations",
      }),
    );
    expect(spy.mock.calls[0]![1].metadata).toMatchObject({
      gmailEmail: "test@gmail.com",
      connectionId: 42,
    });
  });

  it("does NOT emit when session is missing", async () => {
    mockGetSessionUserOrNull.mockResolvedValue(null);
    const spy = vi.spyOn(emitModule, "emitNotification").mockResolvedValue({ id: 999 });

    const { GET } = await import("./route");
    const url = "http://localhost:3100/api/integrations/gmail/oauth/callback?code=CODE&state=STATE";
    const req = new Request(url);

    await GET(req as Parameters<typeof GET>[0]);

    expect(spy).not.toHaveBeenCalled();
  });
});
