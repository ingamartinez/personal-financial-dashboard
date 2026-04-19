import { describe, it, expect } from "vitest";
import {
  CANARY_AGREEMENT_THRESHOLD,
  CANARY_MIN_SAMPLES,
  decideCanaryAction,
} from "./canary-alerts";

function stats(rate: number | null, total: number) {
  const agrees = rate === null ? 0 : Math.round(rate * total);
  return { rate, total, disagrees: total - agrees };
}

describe("decideCanaryAction", () => {
  it("no-ops when there are no samples", () => {
    const d = decideCanaryAction(stats(null, 0), null);
    expect(d.action).toBe("noop");
    if (d.action === "noop") expect(d.reason).toBe("insufficient_samples");
  });

  it("no-ops when samples are below minimum", () => {
    const d = decideCanaryAction(stats(0.5, CANARY_MIN_SAMPLES - 1), null);
    expect(d.action).toBe("noop");
    if (d.action === "noop") expect(d.reason).toBe("insufficient_samples");
  });

  it("no-ops when healthy and no active alert", () => {
    const d = decideCanaryAction(stats(0.98, 50), null);
    expect(d.action).toBe("noop");
    if (d.action === "noop") expect(d.reason).toBe("healthy");
  });

  it("fires when rate dips below threshold and no alert is active", () => {
    const d = decideCanaryAction(stats(0.9, 50), null);
    expect(d.action).toBe("fire");
  });

  it("does not re-fire when an alert is already active (dedup)", () => {
    const d = decideCanaryAction(stats(0.9, 50), { id: 42 });
    expect(d.action).toBe("noop");
    if (d.action === "noop") expect(d.reason).toBe("already_alerted");
  });

  it("resolves an active alert when rate recovers to threshold", () => {
    const d = decideCanaryAction(stats(CANARY_AGREEMENT_THRESHOLD, 50), { id: 42 });
    expect(d.action).toBe("resolve");
    if (d.action === "resolve") expect(d.alertId).toBe(42);
  });

  it("resolves when rate recovers above threshold", () => {
    const d = decideCanaryAction(stats(0.99, 50), { id: 7 });
    expect(d.action).toBe("resolve");
  });

  it("treats rate exactly at threshold as healthy", () => {
    const d = decideCanaryAction(stats(CANARY_AGREEMENT_THRESHOLD, 100), null);
    expect(d.action).toBe("noop");
  });

  it("fires at exact min-samples boundary when below threshold", () => {
    const d = decideCanaryAction(stats(0.5, CANARY_MIN_SAMPLES), null);
    expect(d.action).toBe("fire");
  });
});
