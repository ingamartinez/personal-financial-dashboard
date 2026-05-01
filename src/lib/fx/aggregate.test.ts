import { describe, expect, it } from "vitest";
import type { TxForConversion } from "./convert";
import { pickBucket, sumByDisplayCurrency, sumByGroupAndDisplayCurrency } from "./aggregate";

const FROZEN_TRM_HISTORICAL = 3676.92; // historical TRM from a 2024 USD purchase
const FROZEN_TRM_RECENT = 4123.45; // a different historical TRM, more recent
const LIVE_TRM_TODAY = 4500; // intentionally different from any frozen rate so
//                              tests can prove frozen TRM, not live, was used.

function txUSD(cents: bigint, frozenTrm: number): TxForConversion {
  return {
    amountCents: cents,
    currency: "USD",
    rawData: {
      fx: {
        originalCurrency: "USD",
        originalAmountCents: cents.toString().replace(/^-/, ""),
        trmToAccountCurrency: frozenTrm,
        trmSource: "statement_frozen",
      },
    },
  };
}

function txCOP(cents: bigint): TxForConversion {
  return { amountCents: cents, currency: "COP", rawData: null };
}

function txUSDMissingTrm(cents: bigint): TxForConversion {
  return { amountCents: cents, currency: "USD", rawData: null };
}

describe("sumByDisplayCurrency — native mode", () => {
  it("returns one bucket per native currency, no conversion", () => {
    const rows: TxForConversion[] = [
      txCOP(BigInt(-100000)),
      txCOP(BigInt(-50000)),
      txUSD(BigInt(-2500), FROZEN_TRM_HISTORICAL),
    ];
    const buckets = sumByDisplayCurrency(rows, "native");
    expect(buckets).toHaveLength(2);

    const cop = pickBucket(buckets, "COP");
    expect(cop.cents).toBe(BigInt(-150000));
    expect(cop.txCount).toBe(2);
    expect(cop.missingTrmCount).toBe(0);

    const usd = pickBucket(buckets, "USD");
    expect(usd.cents).toBe(BigInt(-2500));
    expect(usd.txCount).toBe(1);
    expect(usd.missingTrmCount).toBe(0);
  });

  it("does not count missing TRM in native mode (no conversion needed)", () => {
    const rows: TxForConversion[] = [txUSDMissingTrm(BigInt(-1000))];
    const buckets = sumByDisplayCurrency(rows, "native");
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.currency).toBe("USD");
    expect(buckets[0]!.missingTrmCount).toBe(0);
  });
});

describe("sumByDisplayCurrency — all-cop mode", () => {
  it("converts USD rows using FROZEN TRM, not live", () => {
    // 1 USD = 100 cents. Historical TRM 3676.92 → 367.692 COP cents per USD cent.
    // tx amountCents = -10000 (= -$100 USD) → expected COP cents = -10000 * 3676.92 / 1 = -36769200 (cents).
    const rows: TxForConversion[] = [
      txUSD(BigInt(-10000), FROZEN_TRM_HISTORICAL),
      txCOP(BigInt(-50000)),
    ];
    const buckets = sumByDisplayCurrency(rows, "all-cop");
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.currency).toBe("COP");

    // -10000 * 3676920000 / 1000000 = -36769200
    const expectedConvertedUsd = BigInt(-36769200);
    const expectedTotal = expectedConvertedUsd + BigInt(-50000);
    expect(buckets[0]!.cents).toBe(expectedTotal);
    expect(buckets[0]!.txCount).toBe(2);
    expect(buckets[0]!.missingTrmCount).toBe(0);
  });

  it("uses each tx's OWN frozen TRM (different rates do not pool)", () => {
    const rows: TxForConversion[] = [
      txUSD(BigInt(-10000), FROZEN_TRM_HISTORICAL), // 100 USD @ 3676.92 → -36,769,200
      txUSD(BigInt(-10000), FROZEN_TRM_RECENT), //    100 USD @ 4123.45 → -41,234,500
    ];
    const buckets = sumByDisplayCurrency(rows, "all-cop");
    expect(buckets).toHaveLength(1);
    // Each tx converted with its own TRM, then summed.
    expect(buckets[0]!.cents).toBe(BigInt(-36769200) + BigInt(-41234500));

    // Sanity: the result must NOT match what we'd get from live TRM applied uniformly.
    const wrongIfLiveTrmUsed =
      (BigInt(-20000) * BigInt(LIVE_TRM_TODAY * 1_000_000)) / BigInt(1_000_000);
    expect(buckets[0]!.cents).not.toBe(wrongIfLiveTrmUsed);
  });

  it("flags rows with missing TRM but still includes them at original value", () => {
    const rows: TxForConversion[] = [
      txUSD(BigInt(-10000), FROZEN_TRM_HISTORICAL),
      txUSDMissingTrm(BigInt(-5000)),
    ];
    const buckets = sumByDisplayCurrency(rows, "all-cop");
    // The missing-TRM row stays in USD → distinct bucket from converted COP.
    expect(buckets).toHaveLength(2);
    const usd = pickBucket(buckets, "USD");
    expect(usd.cents).toBe(BigInt(-5000));
    expect(usd.missingTrmCount).toBe(1);

    const cop = pickBucket(buckets, "COP");
    expect(cop.cents).toBe(BigInt(-36769200));
    expect(cop.missingTrmCount).toBe(0);
  });
});

describe("sumByDisplayCurrency — all-usd mode", () => {
  it("converts COP rows to USD using frozen TRM", () => {
    // COP tx with frozen TRM in rawData.fx (set as if the COP tx came from a USD-paired transfer).
    const tx: TxForConversion = {
      amountCents: BigInt(-3676920), // -36,769.20 COP cents (= -$10 USD at TRM 3676.92)
      currency: "COP",
      rawData: {
        fx: {
          originalCurrency: "COP",
          originalAmountCents: "3676920",
          trmToAccountCurrency: FROZEN_TRM_HISTORICAL,
          trmSource: "statement_frozen",
        },
      },
    };
    const buckets = sumByDisplayCurrency([tx], "all-usd");
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.currency).toBe("USD");
    // -3676920 * 1000000 / 3676920000 = -1000 (USD cents = -$10)
    expect(buckets[0]!.cents).toBe(BigInt(-1000));
  });
});

describe("sumByGroupAndDisplayCurrency — root-category aggregation", () => {
  type Row = TxForConversion & { categorySlug: string | null };

  it("groups by categorySlug and converts per row", () => {
    const rows: Row[] = [
      { ...txCOP(BigInt(-30000)), categorySlug: "food" },
      { ...txCOP(BigInt(-20000)), categorySlug: "food" },
      { ...txUSD(BigInt(-5000), FROZEN_TRM_HISTORICAL), categorySlug: "food" },
      { ...txCOP(BigInt(-100000)), categorySlug: "transport" },
      { ...txCOP(BigInt(-7000)), categorySlug: null }, // dropped
    ];

    const grouped = sumByGroupAndDisplayCurrency(rows, "all-cop", (r) => r.categorySlug);
    expect(grouped.size).toBe(2);

    const foodBuckets = grouped.get("food")!;
    expect(foodBuckets).toHaveLength(1);
    expect(foodBuckets[0]!.currency).toBe("COP");
    // 30000 + 20000 + 5000*3676.92 = 50000 + 18384600 = 18434600 (negative)
    expect(foodBuckets[0]!.cents).toBe(BigInt(-30000) + BigInt(-20000) + BigInt(-18384600));
    expect(foodBuckets[0]!.txCount).toBe(3);

    const transportBuckets = grouped.get("transport")!;
    expect(transportBuckets[0]!.cents).toBe(BigInt(-100000));
    expect(transportBuckets[0]!.txCount).toBe(1);
  });

  it("preserves multiple buckets per group when missing TRM forces a fallback bucket", () => {
    type R = TxForConversion & { categorySlug: string };
    const rows: R[] = [
      { ...txUSD(BigInt(-1000), FROZEN_TRM_HISTORICAL), categorySlug: "food" },
      { ...txUSDMissingTrm(BigInt(-500)), categorySlug: "food" },
    ];
    const grouped = sumByGroupAndDisplayCurrency(rows, "all-cop", (r) => r.categorySlug);
    const buckets = grouped.get("food")!;
    expect(buckets).toHaveLength(2);
    const cop = pickBucket(buckets, "COP");
    const usd = pickBucket(buckets, "USD");
    expect(cop.cents).toBe(BigInt(-3676920));
    expect(usd.cents).toBe(BigInt(-500));
    expect(usd.missingTrmCount).toBe(1);
  });
});

describe("pickBucket", () => {
  it("returns a zero-bucket when target is missing", () => {
    const result = pickBucket([], "COP");
    expect(result).toEqual({
      currency: "COP",
      cents: BigInt(0),
      txCount: 0,
      missingTrmCount: 0,
      convertedCount: 0,
    });
  });
});
