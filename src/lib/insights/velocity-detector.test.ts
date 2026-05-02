import { describe, expect, it } from "vitest";
import {
  buildVelocityClusters,
  VELOCITY_MIN_CLUSTER_SIZE,
  VELOCITY_WINDOW_MINUTES,
  type VelocityTx,
} from "./velocity-detector";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVelocityTx(
  id: number,
  offsetMinutes: number,
  merchant: string,
  cardKey = "card-A",
): VelocityTx {
  const base = new Date("2026-05-01T10:00:00Z");
  return {
    id,
    occurredAt: new Date(base.getTime() + offsetMinutes * 60_000),
    amountCents: BigInt(-50_000),
    canonicalMerchant: merchant,
    cardKey,
  };
}

// Sentinel prefix to identify test data in description_raw (not used here but
// documents the pattern: __velocity_test_ for real integration tests).

// ---------------------------------------------------------------------------
// Tests — buildVelocityClusters (pure, no DB)
// ---------------------------------------------------------------------------

describe("buildVelocityClusters — basic triggering", () => {
  it("returns no cluster when fewer than 4 distinct merchants", () => {
    const txs: VelocityTx[] = [
      makeVelocityTx(1, 0, "__velocity_test_McDonalds"),
      makeVelocityTx(2, 5, "__velocity_test_BurgerKing"),
      makeVelocityTx(3, 10, "__velocity_test_Subway"),
    ];
    expect(buildVelocityClusters(txs)).toHaveLength(0);
  });

  it("returns a cluster with exactly 4 distinct merchants within 30 min", () => {
    const txs: VelocityTx[] = [
      makeVelocityTx(1, 0, "__velocity_test_McDonalds"),
      makeVelocityTx(2, 5, "__velocity_test_BurgerKing"),
      makeVelocityTx(3, 10, "__velocity_test_Subway"),
      makeVelocityTx(4, 15, "__velocity_test_Dominos"),
    ];
    const clusters = buildVelocityClusters(txs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.clusterSize).toBe(4);
    expect(clusters[0]!.txIds).toHaveLength(4);
    expect(clusters[0]!.cardKey).toBe("card-A");
  });

  it("does NOT fire when 4 merchants span more than 30 minutes", () => {
    const txs: VelocityTx[] = [
      makeVelocityTx(1, 0, "__velocity_test_McDonalds"),
      makeVelocityTx(2, 10, "__velocity_test_BurgerKing"),
      makeVelocityTx(3, 20, "__velocity_test_Subway"),
      makeVelocityTx(4, 35, "__velocity_test_Dominos"), // 35 min > 30
    ];
    expect(buildVelocityClusters(txs)).toHaveLength(0);
  });

  it("counts DISTINCT merchants — 4 txs from same merchant don't trigger", () => {
    const txs: VelocityTx[] = [
      makeVelocityTx(1, 0, "__velocity_test_Rappi"),
      makeVelocityTx(2, 5, "__velocity_test_Rappi"),
      makeVelocityTx(3, 10, "__velocity_test_Rappi"),
      makeVelocityTx(4, 15, "__velocity_test_Rappi"),
    ];
    // 1 distinct merchant (Rappi) — Rappi multi-order protection
    expect(buildVelocityClusters(txs)).toHaveLength(0);
  });

  it("counts DISTINCT merchants — 3 Rappi + 1 other = 2 distinct → no trigger", () => {
    const txs: VelocityTx[] = [
      makeVelocityTx(1, 0, "__velocity_test_Rappi"),
      makeVelocityTx(2, 5, "__velocity_test_Rappi"),
      makeVelocityTx(3, 10, "__velocity_test_Rappi"),
      makeVelocityTx(4, 15, "__velocity_test_McDonalds"),
    ];
    expect(buildVelocityClusters(txs)).toHaveLength(0);
  });
});

describe("buildVelocityClusters — card key isolation", () => {
  it("does NOT merge txs from different cards into the same cluster", () => {
    const txs: VelocityTx[] = [
      makeVelocityTx(1, 0, "__velocity_test_A", "card-A"),
      makeVelocityTx(2, 5, "__velocity_test_B", "card-A"),
      makeVelocityTx(3, 10, "__velocity_test_C", "card-B"), // different card
      makeVelocityTx(4, 15, "__velocity_test_D", "card-B"), // different card
    ];
    // card-A has 2 distinct, card-B has 2 distinct → neither reaches threshold 4
    expect(buildVelocityClusters(txs)).toHaveLength(0);
  });

  it("detects clusters independently on each card", () => {
    const card = (k: string) => k;
    const txsA: VelocityTx[] = [
      makeVelocityTx(1, 0, "__velocity_test_A1", card("card-A")),
      makeVelocityTx(2, 5, "__velocity_test_A2", card("card-A")),
      makeVelocityTx(3, 10, "__velocity_test_A3", card("card-A")),
      makeVelocityTx(4, 15, "__velocity_test_A4", card("card-A")),
    ];
    const txsB: VelocityTx[] = [
      makeVelocityTx(5, 0, "__velocity_test_B1", card("card-B")),
      makeVelocityTx(6, 5, "__velocity_test_B2", card("card-B")),
      makeVelocityTx(7, 10, "__velocity_test_B3", card("card-B")),
      makeVelocityTx(8, 15, "__velocity_test_B4", card("card-B")),
    ];
    const clusters = buildVelocityClusters([...txsA, ...txsB]);
    expect(clusters).toHaveLength(2);
    const keys = clusters.map((c) => c.cardKey).sort();
    expect(keys).toEqual(["card-A", "card-B"]);
  });
});

describe("buildVelocityClusters — cluster metadata", () => {
  it("records correct firstTxId and lastTxId", () => {
    const txs: VelocityTx[] = [
      makeVelocityTx(10, 0, "__velocity_test_M1"),
      makeVelocityTx(20, 8, "__velocity_test_M2"),
      makeVelocityTx(30, 16, "__velocity_test_M3"),
      makeVelocityTx(40, 24, "__velocity_test_M4"),
    ];
    const [cluster] = buildVelocityClusters(txs);
    expect(cluster).toBeDefined();
    expect(cluster!.firstTxId).toBe(10);
    expect(cluster!.lastTxId).toBe(40);
  });

  it("includes all 4 txIds in the cluster", () => {
    const txs: VelocityTx[] = [
      makeVelocityTx(1, 0, "__velocity_test_M1"),
      makeVelocityTx(2, 7, "__velocity_test_M2"),
      makeVelocityTx(3, 14, "__velocity_test_M3"),
      makeVelocityTx(4, 21, "__velocity_test_M4"),
    ];
    const [cluster] = buildVelocityClusters(txs);
    expect(cluster!.txIds.sort()).toEqual([1, 2, 3, 4]);
  });

  it("windowMinutes reflects actual elapsed time in the cluster", () => {
    const txs: VelocityTx[] = [
      makeVelocityTx(1, 0, "__velocity_test_M1"),
      makeVelocityTx(2, 5, "__velocity_test_M2"),
      makeVelocityTx(3, 10, "__velocity_test_M3"),
      makeVelocityTx(4, 17, "__velocity_test_M4"), // 17 min elapsed
    ];
    const [cluster] = buildVelocityClusters(txs);
    // ceil(17 * 60000 / 60000) = 17
    expect(cluster!.windowMinutes).toBe(17);
  });
});

describe("buildVelocityClusters — boundary conditions", () => {
  it("triggers at exactly 30 minutes boundary (inclusive window)", () => {
    const txs: VelocityTx[] = [
      makeVelocityTx(1, 0, "__velocity_test_M1"),
      makeVelocityTx(2, 10, "__velocity_test_M2"),
      makeVelocityTx(3, 20, "__velocity_test_M3"),
      makeVelocityTx(4, 30, "__velocity_test_M4"), // exactly 30 min
    ];
    // window = 30 min exactly = windowMs, so NOT > windowMs
    const clusters = buildVelocityClusters(txs);
    expect(clusters).toHaveLength(1);
  });

  it("does not trigger with 0 txs", () => {
    expect(buildVelocityClusters([])).toHaveLength(0);
  });

  it("detects a cluster when 5 distinct merchants appear — reports clusterSize >= 4", () => {
    // The sliding-window algorithm emits the cluster as soon as threshold is met
    // (at distinct count=4), then advances left past the cluster. A 5th tx may
    // or may not extend the same cluster depending on window state. What matters
    // is that at least one cluster of size >= 4 is found.
    const txs: VelocityTx[] = [
      makeVelocityTx(1, 0, "__velocity_test_M1"),
      makeVelocityTx(2, 5, "__velocity_test_M2"),
      makeVelocityTx(3, 10, "__velocity_test_M3"),
      makeVelocityTx(4, 15, "__velocity_test_M4"),
      makeVelocityTx(5, 20, "__velocity_test_M5"),
    ];
    const clusters = buildVelocityClusters(txs);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    expect(clusters[0]!.clusterSize).toBeGreaterThanOrEqual(4);
  });

  it("exported constants match spec", () => {
    expect(VELOCITY_MIN_CLUSTER_SIZE).toBe(4);
    expect(VELOCITY_WINDOW_MINUTES).toBe(30);
  });
});
