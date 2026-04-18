import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

import { auth } from "@/auth";
import { getSessionUser, getSessionUserOrNull, requireAdmin } from "./session";

const mockAuth = auth as unknown as Mock<() => Promise<Session | null>>;

function session(overrides?: Partial<Session["user"]>): Session {
  return {
    user: {
      id: 7,
      email: "ada@example.com",
      name: "Ada Lovelace",
      role: "user",
      active: true,
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

  it("returns the session user (including role and active) when everything is present", async () => {
    mockAuth.mockResolvedValue(session({ role: "admin", active: true }));
    await expect(getSessionUser()).resolves.toEqual({
      id: 7,
      email: "ada@example.com",
      name: "Ada Lovelace",
      role: "admin",
      active: true,
    });
  });

  it("falls back to email when name is missing", async () => {
    mockAuth.mockResolvedValue(session({ name: null }));
    await expect(getSessionUser()).resolves.toEqual({
      id: 7,
      email: "ada@example.com",
      name: "ada@example.com",
      role: "user",
      active: true,
    });
  });

  it("defaults role to 'user' and active to true when token fields missing", async () => {
    mockAuth.mockResolvedValue({
      user: { id: 7, email: "ada@example.com", name: "Ada" },
      expires: "9999-01-01T00:00:00.000Z",
    } as unknown as Session);
    await expect(getSessionUser()).resolves.toMatchObject({
      role: "user",
      active: true,
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

  it("returns the user with role/active when session is valid", async () => {
    mockAuth.mockResolvedValue(session({ role: "admin", active: true }));
    await expect(getSessionUserOrNull()).resolves.toEqual({
      id: 7,
      email: "ada@example.com",
      name: "Ada Lovelace",
      role: "admin",
      active: true,
    });
  });
});

describe("requireAdmin", () => {
  beforeEach(() => {
    mockAuth.mockReset();
  });

  it("throws FORBIDDEN for a non-admin session", async () => {
    mockAuth.mockResolvedValue(session({ role: "user" }));
    await expect(requireAdmin()).rejects.toThrow("FORBIDDEN");
  });

  it("throws UNAUTHENTICATED when there is no session", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(requireAdmin()).rejects.toThrow("UNAUTHENTICATED");
  });

  it("returns the user when role is admin", async () => {
    mockAuth.mockResolvedValue(session({ role: "admin" }));
    await expect(requireAdmin()).resolves.toMatchObject({ role: "admin" });
  });
});
