import { describe, it, expect } from "vitest";
import { canIngest, paywallResponse } from "./can-ingest";

describe("canIngest", () => {
  it("allows in v1 (no-op seam) — any userId returns allowed: true", async () => {
    await expect(canIngest(1)).resolves.toEqual({ allowed: true });
    await expect(canIngest(999)).resolves.toEqual({ allowed: true });
  });
});

describe("paywallResponse", () => {
  it("returns HTTP 402 with { ok: false, status: 'paywall', reason }", async () => {
    const res = paywallResponse("subscription_past_due");
    expect(res.status).toBe(402);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      status: "paywall",
      reason: "subscription_past_due",
    });
  });
});
