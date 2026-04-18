import { describe, expect, it, vi } from "vitest";

// Mock @/auth so importing ./proxy doesn't pull NextAuth / @/lib/db into the
// test — this is a pure config test for the matcher regex.
vi.mock("@/auth", () => ({
  auth: (handler: unknown) => handler,
}));

import { config } from "./proxy";

// Next.js anchors the matcher against the full pathname. Mirror that here so
// the negative lookahead isn't sidestepped by substring matches.
function matches(path: string): boolean {
  const [pattern] = config.matcher;
  return new RegExp(`^${pattern}$`).test(path);
}

describe("proxy matcher", () => {
  it("runs the proxy on protected app routes", () => {
    for (const path of ["/", "/transactions", "/budgets", "/settings/webhooks"]) {
      expect(matches(path), `${path} should be proxied`).toBe(true);
    }
  });

  it("exempts bearer-token API routes (regression for #200)", () => {
    for (const path of [
      "/api/ingest/sms",
      "/api/ingest/debug",
      "/api/ingest/ocr",
      "/api/fx/refresh",
    ]) {
      expect(matches(path), `${path} must bypass the session proxy`).toBe(false);
    }
  });

  it("exempts /api/health so CD + Cloudflare probes don't hit /login", () => {
    expect(matches("/api/health"), "/api/health must be publicly probeable").toBe(false);
  });

  it("exempts auth, telegram, login/signup, and static assets", () => {
    for (const path of [
      "/api/auth/callback/google",
      "/api/telegram/webhook",
      "/login",
      "/signup",
      "/_next/static/chunks/main.js",
      "/_next/image",
      "/favicon.ico",
      "/logo.png",
      "/icon.svg",
    ]) {
      expect(matches(path), `${path} should be exempt`).toBe(false);
    }
  });
});
