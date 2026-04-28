// Tests for the slo-alerts BullMQ worker.
// The processor is tested directly — no Worker instantiation needed for unit tests.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoist shared mock references so they work inside vi.mock factories.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  checkAndAlertSlos: vi.fn(),
}));

vi.mock("@/lib/observability/slo-alerts", () => ({
  checkAndAlertSlos: mocks.checkAndAlertSlos,
}));

import type { Job } from "bullmq";
import { sloAlertsProcessor, type SloAlertsJobData } from "./slo-alerts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(data: SloAlertsJobData = {}): Job<SloAlertsJobData> {
  return { id: "test-job-slo-alerts", data } as unknown as Job<SloAlertsJobData>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sloAlertsProcessor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("calls checkAndAlertSlos and logs the decision summary", async () => {
    mocks.checkAndAlertSlos.mockResolvedValueOnce([{ action: "noop", sloKey: "parse_success" }]);

    await sloAlertsProcessor(makeJob());

    expect(mocks.checkAndAlertSlos).toHaveBeenCalledOnce();
  });

  it("handles a fired alert without throwing", async () => {
    mocks.checkAndAlertSlos.mockResolvedValueOnce([{ action: "fire", sloKey: "parse_success" }]);

    await expect(sloAlertsProcessor(makeJob())).resolves.toBeUndefined();
  });

  it("handles a resolved alert without throwing", async () => {
    mocks.checkAndAlertSlos.mockResolvedValueOnce([{ action: "resolve", sloKey: "parse_success" }]);

    await expect(sloAlertsProcessor(makeJob())).resolves.toBeUndefined();
  });

  it("handles an empty decisions array without throwing", async () => {
    mocks.checkAndAlertSlos.mockResolvedValueOnce([]);

    await expect(sloAlertsProcessor(makeJob())).resolves.toBeUndefined();
  });

  it("propagates checkAndAlertSlos errors for BullMQ retry", async () => {
    mocks.checkAndAlertSlos.mockRejectedValueOnce(new Error("Telegram API unreachable"));

    await expect(sloAlertsProcessor(makeJob())).rejects.toThrow("Telegram API unreachable");
  });
});
