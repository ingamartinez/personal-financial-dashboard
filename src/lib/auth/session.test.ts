import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

import { auth } from "@/auth";
import { getSessionUser, getSessionUserOrNull } from "./session";

const mockAuth = auth as unknown as Mock<() => Promise<Session | null>>;

function session(overrides?: Partial<Session["user"]>): Session {
  return {
    user: {
      id: 7,
      email: "ada@example.com",
      name: "Ada Lovelace",
      ...overrides,
    },
    expires: "9999-01-01T00:00:00.000Z",
  };
}

describe("getSessionUser", () => {
  beforeEach(() => {
    mockAuth.mockReset();
  });

  it("throws UNAUTHENTICATED when auth() returns null", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(getSessionUser()).rejects.toThrow("UNAUTHENTICATED");
  });

  it("throws UNAUTHENTICATED when session has no user id", async () => {
    mockAuth.mockResolvedValue({
      user: { email: "x@y.com" },
      expires: "9999-01-01T00:00:00.000Z",
    } as unknown as Session);
    await expect(getSessionUser()).rejects.toThrow("UNAUTHENTICATED");
  });

  it("throws UNAUTHENTICATED when session has no email", async () => {
    mockAuth.mockResolvedValue(session({ email: undefined }));
    await expect(getSessionUser()).rejects.toThrow("UNAUTHENTICATED");
  });

  it("returns the session user when everything is present", async () => {
    mockAuth.mockResolvedValue(session());
    await expect(getSessionUser()).resolves.toEqual({
      id: 7,
      email: "ada@example.com",
      name: "Ada Lovelace",
    });
  });

  it("falls back to email when name is missing", async () => {
    mockAuth.mockResolvedValue(session({ name: null }));
    await expect(getSessionUser()).resolves.toEqual({
      id: 7,
      email: "ada@example.com",
      name: "ada@example.com",
    });
  });
});

describe("getSessionUserOrNull", () => {
  beforeEach(() => {
    mockAuth.mockReset();
  });

  it("returns null when auth() returns null", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(getSessionUserOrNull()).resolves.toBeNull();
  });

  it("returns the user when session is valid", async () => {
    mockAuth.mockResolvedValue(session());
    await expect(getSessionUserOrNull()).resolves.toEqual({
      id: 7,
      email: "ada@example.com",
      name: "Ada Lovelace",
    });
  });
});
