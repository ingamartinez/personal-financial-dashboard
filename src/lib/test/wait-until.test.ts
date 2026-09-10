import { describe, expect, it } from "vitest";
import { waitUntil } from "./wait-until";

describe("waitUntil", () => {
  it("returns without waiting when the predicate is already true", async () => {
    const started = Date.now();
    await waitUntil(() => true, { timeoutMs: 1_000, intervalMs: 50 });
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("resolves once the predicate becomes true", async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 40);
    await waitUntil(() => ready, { timeoutMs: 500, intervalMs: 10 });
    expect(ready).toBe(true);
  });

  it("throws when the predicate stays false instead of passing after the timeout", async () => {
    const started = Date.now();
    await expect(
      waitUntil(() => false, {
        timeoutMs: 80,
        intervalMs: 10,
        message: "never happened",
      }),
    ).rejects.toThrow("never happened");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(250);
  });
});
