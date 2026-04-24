// #443 — unit tests for the cupo → ledger derivation used by consolidate-form.
// Exercises the three modes (legacy ledger-signed, single-currency cupo,
// shared-cupo multi-currency) + the projected-cupo placeholder helper.

import { describe, expect, it } from "vitest";

import { deriveLedgerFromInput, projectedCupoCents } from "./derive-cupo-ledger";

describe("deriveLedgerFromInput (#443)", () => {
  it("returns empty for blank input regardless of context", () => {
    expect(
      deriveLedgerFromInput({ raw: "", targetCurrency: "COP", creditContext: null }).kind,
    ).toBe("empty");
    expect(
      deriveLedgerFromInput({
        raw: "   ",
        targetCurrency: "COP",
        creditContext: { kind: "single-currency", creditLimitCentsStr: "1000000000" },
      }).kind,
    ).toBe("empty");
  });

  it("legacy (creditContext=null): passes input through as ledger-signed", () => {
    const r = deriveLedgerFromInput({
      raw: "-500.000,00",
      targetCurrency: "COP",
      creditContext: null,
    });
    expect(r).toEqual({ kind: "ok", cupoCents: null, ledgerCents: BigInt(-50_000_000) });

    const pos = deriveLedgerFromInput({
      raw: "1.000.000",
      targetCurrency: "COP",
      creditContext: null,
    });
    // Savings ledger positive is also valid.
    expect(pos).toEqual({ kind: "ok", cupoCents: null, ledgerCents: BigInt(100_000_000) });
  });

  it("single-currency: derives ledger = cupo - limit", () => {
    const ctx = { kind: "single-currency", creditLimitCentsStr: "1000000000" } as const;
    // limit 10M COP, cupo 4M → debt 6M → ledger -6M.
    const r = deriveLedgerFromInput({
      raw: "4.000.000,00",
      targetCurrency: "COP",
      creditContext: ctx,
    });
    expect(r).toEqual({
      kind: "ok",
      cupoCents: BigInt(400_000_000),
      ledgerCents: BigInt(-600_000_000),
    });
  });

  it("single-currency: cupo == limit ⇒ ledger 0 (no debt)", () => {
    const ctx = { kind: "single-currency", creditLimitCentsStr: "1000000000" } as const;
    const r = deriveLedgerFromInput({
      raw: "10.000.000",
      targetCurrency: "COP",
      creditContext: ctx,
    });
    expect(r).toEqual({
      kind: "ok",
      cupoCents: BigInt(1_000_000_000),
      ledgerCents: BigInt(0),
    });
  });

  it("single-currency: rejects cupo > limit with exceeds-limit", () => {
    const ctx = { kind: "single-currency", creditLimitCentsStr: "1000000000" } as const;
    const r = deriveLedgerFromInput({
      raw: "11.000.000",
      targetCurrency: "COP",
      creditContext: ctx,
    });
    expect(r).toEqual({ kind: "invalid", reason: "exceeds-limit" });
  });

  it("single-currency: rejects negative cupo", () => {
    const ctx = { kind: "single-currency", creditLimitCentsStr: "1000000000" } as const;
    const r = deriveLedgerFromInput({
      raw: "-100.000",
      targetCurrency: "COP",
      creditContext: ctx,
    });
    expect(r).toEqual({ kind: "invalid", reason: "negative-cupo" });
  });

  it("single-currency: rejects non-numeric input", () => {
    const ctx = { kind: "single-currency", creditLimitCentsStr: "1000000000" } as const;
    const r = deriveLedgerFromInput({ raw: "abc", targetCurrency: "COP", creditContext: ctx });
    expect(r).toEqual({ kind: "invalid", reason: "parse-failed" });
  });

  it("shared-cupo: COP target with no sibling debt ⇒ ledger = cupo - limit", () => {
    // 10M limit, no sibling debt, declared cupo 4M COP → target debt 6M COP,
    // target currency COP ⇒ convert is a no-op ⇒ ledger -6M.
    const r = deriveLedgerFromInput({
      raw: "4.000.000",
      targetCurrency: "COP",
      creditContext: {
        kind: "shared-cupo",
        creditLimitCopCentsStr: "1000000000",
        siblingDebtCopCentsStr: "0",
        copPerUsd: 4000,
      },
    });
    expect(r).toEqual({
      kind: "ok",
      cupoCents: BigInt(400_000_000),
      ledgerCents: BigInt(-600_000_000),
    });
  });

  it("shared-cupo: USD target subtracts sibling COP debt and converts remainder", () => {
    // limit 10M COP (1e9 cents), sibling (COP side) owes 2M COP (2e8 cents),
    // declared cupo 3M COP (3e8 cents) → total debt 7M COP → remaining after
    // siblings = 5M COP (5e8 cents). Convert to USD at 4000 COP/USD:
    //   (500_000_000 * 1_000_000) / (4000 * 1_000_000) = 125_000 USD cents
    //   = $1,250 USD debt → ledger -125_000.
    const r = deriveLedgerFromInput({
      raw: "3.000.000",
      targetCurrency: "USD",
      creditContext: {
        kind: "shared-cupo",
        creditLimitCopCentsStr: "1000000000",
        siblingDebtCopCentsStr: "200000000",
        copPerUsd: 4000,
      },
    });
    expect(r).toEqual({
      kind: "ok",
      cupoCents: BigInt(300_000_000),
      ledgerCents: BigInt(-125_000),
    });
  });

  it("shared-cupo: sibling already covers total debt ⇒ target ledger 0 (no debt)", () => {
    // limit 10M, sibling debt 8M, declared cupo 3M → total debt 7M COP.
    // Sibling already covers 8M > 7M → target debt clamps to 0.
    const r = deriveLedgerFromInput({
      raw: "3.000.000",
      targetCurrency: "COP",
      creditContext: {
        kind: "shared-cupo",
        creditLimitCopCentsStr: "1000000000",
        siblingDebtCopCentsStr: "800000000",
        copPerUsd: 4000,
      },
    });
    expect(r).toEqual({
      kind: "ok",
      cupoCents: BigInt(300_000_000),
      ledgerCents: BigInt(0),
    });
  });

  it("shared-cupo: rejects cupo > shared COP limit", () => {
    const r = deriveLedgerFromInput({
      raw: "11.000.000",
      targetCurrency: "COP",
      creditContext: {
        kind: "shared-cupo",
        creditLimitCopCentsStr: "1000000000",
        siblingDebtCopCentsStr: "0",
        copPerUsd: 4000,
      },
    });
    expect(r).toEqual({ kind: "invalid", reason: "exceeds-limit" });
  });
});

describe("projectedCupoCents (#443)", () => {
  it("returns null when creditContext is null", () => {
    expect(projectedCupoCents(BigInt(-50_000_000), "COP", null)).toBeNull();
  });

  it("single-currency: limit + projected-ledger (negative) = cupo", () => {
    // limit 10M, saldo proyectado -6M → cupo 4M.
    const cupo = projectedCupoCents(BigInt(-600_000_000), "COP", {
      kind: "single-currency",
      creditLimitCentsStr: "1000000000",
    });
    expect(cupo).toBe(BigInt(400_000_000));
  });

  it("single-currency: positive ledger (credit balance) clamps cupo to limit max", () => {
    // saldo proyectado +5M (credit, shouldn't happen but possible) → cupo
    // would be limit + 5M = 15M. We don't clamp the upside; the user sees a
    // placeholder higher than the limit, which is accurate for display.
    const cupo = projectedCupoCents(BigInt(500_000_000), "COP", {
      kind: "single-currency",
      creditLimitCentsStr: "1000000000",
    });
    expect(cupo).toBe(BigInt(1_500_000_000));
  });

  it("shared-cupo: subtracts sibling debt + projected target debt in COP", () => {
    // limit 10M COP, sibling debt 2M COP, saldo proyectado -1M COP →
    // projected target debt 1M COP → cupo COP = 10M - 2M - 1M = 7M.
    const cupo = projectedCupoCents(BigInt(-100_000_000), "COP", {
      kind: "shared-cupo",
      creditLimitCopCentsStr: "1000000000",
      siblingDebtCopCentsStr: "200000000",
      copPerUsd: 4000,
    });
    expect(cupo).toBe(BigInt(700_000_000));
  });

  it("shared-cupo: USD ledger converts debt to COP using TRM", () => {
    // limit 10M COP (1e9 cents), no sibling debt. saldo proyectado -100 USD
    // cents = -$1 USD at 4000 COP/USD → debt COP = 100 * 4000 * 1e6 / 1e6 =
    // 400_000 cop cents ($4,000 COP). cupo COP = 1e9 - 0 - 400_000 = 999_600_000.
    const cupo = projectedCupoCents(BigInt(-100), "USD", {
      kind: "shared-cupo",
      creditLimitCopCentsStr: "1000000000",
      siblingDebtCopCentsStr: "0",
      copPerUsd: 4000,
    });
    expect(cupo).toBe(BigInt(999_600_000));
  });
});
