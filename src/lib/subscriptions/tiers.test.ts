import { describe, expect, it } from "vitest";
import { classifyTiers } from "./tiers";
import type { SubscriptionRow } from "@/app/(app)/subscriptions/queries";
import type { DisplayCurrency } from "@/lib/fx/convert";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let nextId = 1;

function makeRow(
  absCents: bigint,
  currency: DisplayCurrency = "COP",
  overrides: Partial<SubscriptionRow> = {},
): SubscriptionRow {
  const id = nextId++;
  const cents = -absCents; // expenses stored as negative
  return {
    id,
    label: `Sub ${id}`,
    accountLabel: "Cuenta",
    amountCents: cents,
    currency,
    dayOfMonth: 1,
    amountType: "fixed",
    categorySlug: "suscripciones",
    categoryName: "Suscripciones",
    notes: null,
    skippedMonths: [],
    nextOccurrence: "2026-06-01",
    annualCents: cents * BigInt(12),
    displayAmount: {
      cents,
      currency,
      converted: currency !== "COP",
      appliedTrm: null,
    },
    displayAmountAbsCents: absCents,
    priceHike: null,
    ...overrides,
  };
}

// Reset the id counter before each describe block to keep snapshots stable.
function resetIds() {
  nextId = 1;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("classifyTiers", () => {
  it("empty input → three empty tiers with zero subtotals", () => {
    const result = classifyTiers([]);
    expect(result.top).toHaveLength(0);
    expect(result.medianas).toHaveLength(0);
    expect(result.pequeñas).toHaveLength(0);
    expect(result.topSubtotal).toBe(BigInt(0));
    expect(result.medianasSubtotal).toBe(BigInt(0));
    expect(result.pequeñasSubtotal).toBe(BigInt(0));
    expect(result.topPct).toBe(0);
    expect(result.medianasPct).toBe(0);
    expect(result.pequeñasPct).toBe(0);
  });

  it("single sub → goes to Top, other tiers empty", () => {
    resetIds();
    const rows = [makeRow(BigInt(50000))];
    const result = classifyTiers(rows);

    expect(result.top).toHaveLength(1);
    expect(result.medianas).toHaveLength(0);
    expect(result.pequeñas).toHaveLength(0);
    expect(result.topSubtotal).toBe(BigInt(50000));
    expect(result.topPct).toBe(100);
    expect(result.medianasPct).toBe(0);
    expect(result.pequeñasPct).toBe(0);
  });

  it("two subs same amount → both in Top (cumulative = 50% + 50% → Top = first row, Medianas = second)", () => {
    // First row = 50% (doesn't reach 70%), so still in Top loop.
    // Second row = 100% (crosses 90%) → since cumulative*100 > threshold90, pequeñas?
    // Wait: after row1: 50% → 5000 <= 7000 → Top
    // After row2: 100% → 10000 <= 9000? No → pequeñas
    // But issue says "two subs same amount → both in Top".
    // Let me think: when two equal subs, Top has 1 row at 50%, cumulative hasn't reached 70%.
    // Both should be in Top because neither alone crosses 70%.
    // After row1: cumulative=50%, 5000 <= 7000 → Top ✓
    // After row2: cumulative=100%, 10000 > 9000 → pequeñas? That puts one in Top, one in Pequeñas.
    // The issue says "both in Top" — so both crossing together means both in Top.
    // The only way both go to Top is if 50% doesn't satisfy ≥70% alone, so we keep adding.
    // Re-reading algo: "Top = cumulative subset that reaches ≥70%". Keep adding to Top until cumulative ≥ 70%.
    // So the condition should be: keep pushing to Top until we've hit 70%.
    // After row1: 50% < 70% → Top, not satisfied yet
    // After row2: 100% ≥ 70% → Top, now satisfied. Stop adding to Top.
    // Both in Top! This matches the issue expectation.

    // This means my condition logic is wrong: I should push to Top until we reach ≥70%,
    // then push to Medianas until we reach ≥90%, then Pequeñas.
    // The condition should be: if cumulative hasn't reached 70% yet BEFORE adding, add to Top.
    // But once cumulative ≥ 70%, the CURRENT row is the last Top row.

    // Actually the current code: `top.length === 0 || cumulativePct100 <= threshold70`
    // This means: keep adding to Top while cumulative (AFTER adding) ≤ 70%.
    // But when ≤ 70% we haven't reached Top's goal, so we need ANOTHER row.
    // The last Top row is the one that CROSSES 70% from below.

    // Correct logic: Push to Top if cumulative (after adding) ≥ threshold OR top hasn't been satisfied yet.
    // I.e.: push to Top until (previous cumulative was already ≥ 70%).

    resetIds();
    const rows = [makeRow(BigInt(500)), makeRow(BigInt(500))];
    const result = classifyTiers(rows);

    // Per the issue: "two subs same amount → both in Top (cumulative crosses 70% with both)"
    expect(result.top).toHaveLength(2);
    expect(result.medianas).toHaveLength(0);
    expect(result.pequeñas).toHaveLength(0);
  });

  it("skewed: 1 dominant sub (~80%) + several small ones", () => {
    resetIds();
    // 1 large sub at 800, 5 small at 40 each → total = 1000
    // large = 80%, smalls = 4% each
    const large = makeRow(BigInt(800));
    const smalls = [
      makeRow(BigInt(40)),
      makeRow(BigInt(40)),
      makeRow(BigInt(40)),
      makeRow(BigInt(40)),
      makeRow(BigInt(40)),
    ];
    const rows = [large, ...smalls];
    const result = classifyTiers(rows);

    // large alone: cumulative=80%, 80% >= 70% → Top (topSatisfied=true)
    // small1: cumulative=84%, not yet 90% → Medianas
    // small2: cumulative=88%, not yet 90% → Medianas
    // small3: cumulative=92%, 92% >= 90% → Medianas (medianasSatisfied=true)
    // small4, small5: Pequeñas
    expect(result.top).toHaveLength(1);
    expect(result.medianas).toHaveLength(3);
    expect(result.pequeñas).toHaveLength(2);
    expect(result.topSubtotal).toBe(BigInt(800));
    expect(result.medianasSubtotal).toBe(BigInt(120));
    expect(result.pequeñasSubtotal).toBe(BigInt(80));
  });

  it("even spread: 10 subs at 10% each → Top=7, Medianas=2, Pequeñas=1", () => {
    resetIds();
    const rows = Array.from({ length: 10 }, () => makeRow(BigInt(100)));
    const result = classifyTiers(rows);

    // Each row is 10% of total (1000)
    // Row 1: 100*100=10000 <= 70000 → Top (cumulative 10%)
    // Row 2: 20000 <= 70000 → Top
    // Row 3: 30000 → Top
    // Row 4: 40000 → Top
    // Row 5: 50000 → Top
    // Row 6: 60000 → Top
    // Row 7: 70000 <= 70000 → Top (exactly 70%)
    // Row 8: 80000 <= 90000 → Medianas
    // Row 9: 90000 <= 90000 → Medianas (exactly 90%)
    // Row 10: 100000 > 90000 → Pequeñas
    expect(result.top).toHaveLength(7);
    expect(result.medianas).toHaveLength(2);
    expect(result.pequeñas).toHaveLength(1);
    expect(result.topPct).toBe(70);
    expect(result.medianasPct).toBe(20);
    expect(result.pequeñasPct).toBe(10);
  });

  it("multi-currency: tier math runs over the converted displayAmount.cents", () => {
    resetIds();
    // One USD sub converted to COP equivalent, one COP sub
    // USD sub has displayAmount.cents = -800000 COP equivalent
    // COP sub has displayAmount.cents = -200000 COP
    // Total = 1000000, USD sub = 80% → goes to Top alone (80% ≥ 70%)
    const usdRow = makeRow(BigInt(800000), "USD", {
      displayAmount: {
        cents: BigInt(-800000),
        currency: "COP",
        converted: true,
        appliedTrm: 4000,
      },
      displayAmountAbsCents: BigInt(800000),
    });
    const copRow = makeRow(BigInt(200000), "COP");

    const rows = [copRow, usdRow]; // deliberately out of order — sort should fix it
    const result = classifyTiers(rows);

    // usdRow (800k) sorted first (desc), then copRow (200k)
    // usdRow: cumulative=80% >= 70% → Top (topSatisfied=true)
    // copRow: topSatisfied but not medianasSatisfied → Medianas; cumulative=100% >= 90% → medianasSatisfied=true
    expect(result.top).toHaveLength(1);
    expect(result.top[0]).toBe(usdRow);
    expect(result.medianas).toHaveLength(1);
    expect(result.medianas[0]).toBe(copRow);
    expect(result.pequeñas).toHaveLength(0);
  });

  it("sorts by display amount desc before classifying (input order does not matter)", () => {
    resetIds();
    // Input: small, large, medium — expect Top to have the large one
    const small = makeRow(BigInt(100));
    const large = makeRow(BigInt(800));
    const medium = makeRow(BigInt(100)); // same as small, total = 1000

    const rows = [small, large, medium];
    const result = classifyTiers(rows);

    // large = 80% → Top (alone, since 80% ≥ 70%)
    expect(result.top[0]).toBe(large);
  });
});
